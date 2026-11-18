"""Problems of an organization: created by uploading a closed ``.bim.zip``, revised by uploading another.

A problem (``binding_cases``) belongs to an organization. A revision holds its package as a blob, its
digests and its file facts; what the installed toolchain makes of it lives in ``problem_compilations``,
one row per revision and toolchain (``compile_or_get``). Runs and studies name a revision and the
compilation they use, and the database keeps both while anything names them (D3, D5).

No transaction is open while the slow work runs (the compile, writing the blob file): the upload checks
what it can cheaply, ends the read transaction, compiles, writes the file, and then takes the account's
row lock only for the short transaction that checks the quotas and inserts the rows (D13).
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import (
    BindingCase,
    BindingCaseRevision,
    Blob,
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionVersion,
    Job,
    Organization,
    ProblemCompilation,
    ProblemValueOrigin,
    StudyCell,
    User,
    utcnow,
)
from ....integrations import bim
from ....domain.binding_space import BindingSpace
from ....models.errors import api_error
from ....services.entitlements import entitlement_service
from ...plans.application import entitlement_map as ids
from ...plans.application import account_stored_bytes, quotas
from ...shared.application import audit, put_row, read_verified, write_file
from ..domain.compilation import Compilation
from ..domain.digests import is_digest
from ..domain.origin import origin_of
from .compile import compile_package, compile_refusal
from .origins import carried_rows, rows_from

#: The slug pattern of the platform (``models/platform.SLUG``).
SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
PACKAGE_MEDIA_TYPE = "application/vnd.bim+zip"

#: Code and message of a stored revision the installed toolchain does not accept (or reads as another package).
NOT_RECOMPILABLE = "revision_not_recompilable"
NOT_RECOMPILABLE_MESSAGE = (
    "The installed bim-toolchain does not accept the stored package of this revision, so it cannot be compiled "
    "or run with it. The revision is kept unchanged as evidence; correct the source and upload it as a new revision."
)


@dataclass(frozen=True)
class Upload:
    """What an upload came to: the problem, the revision, its compilation, and whether the revision is new."""

    problem: BindingCase
    revision: BindingCaseRevision
    compilation: ProblemCompilation
    created: bool


# -- Looking things up -------------------------------------------------------------------------------


def slug_from_name(name: Any) -> str:
    """A platform slug made from an Instance's ``metadata.name`` (``problem`` when nothing is left of it)."""
    text = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:64].strip("-")
    return text if SLUG.match(text) else "problem"


async def problem_by_ref(session: AsyncSession, organization_id: uuid.UUID, ref: str) -> BindingCase | None:
    """The organization's problem named by ``ref``: its slug or its id."""
    found = await session.scalar(
        select(BindingCase).where(BindingCase.organization_id == organization_id, BindingCase.slug == ref)
    )
    if found is not None:
        return found
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(
        select(BindingCase).where(BindingCase.organization_id == organization_id, BindingCase.id == parsed)
    )


async def revision_by_ref(session: AsyncSession, problem: BindingCase, ref: str) -> BindingCaseRevision | None:
    """The revision of ``problem`` named by ``ref``: its number, its id or its ``sha256-`` package digest."""
    query = select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == problem.id)
    if ref.isdigit():
        return await session.scalar(query.where(BindingCaseRevision.revision == int(ref)))
    if is_digest(ref):
        return await session.scalar(query.where(BindingCaseRevision.package_digest == ref))
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(query.where(BindingCaseRevision.id == parsed))


async def latest_revisions(session: AsyncSession, problem_ids: list[uuid.UUID]) -> dict[uuid.UUID, BindingCaseRevision]:
    """The latest revision of each problem, in one query."""
    if not problem_ids:
        return {}
    newest = (
        select(BindingCaseRevision.binding_case_id, func.max(BindingCaseRevision.revision).label("revision"))
        .where(BindingCaseRevision.binding_case_id.in_(problem_ids))
        .group_by(BindingCaseRevision.binding_case_id)
        .subquery()
    )
    rows = (await session.scalars(
        select(BindingCaseRevision).join(
            newest,
            (BindingCaseRevision.binding_case_id == newest.c.binding_case_id)
            & (BindingCaseRevision.revision == newest.c.revision),
        )
    )).all()
    return {row.binding_case_id: row for row in rows}


async def revision_counts(session: AsyncSession, problem_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """How many revisions each problem has, in one query."""
    if not problem_ids:
        return {}
    rows = await session.execute(
        select(BindingCaseRevision.binding_case_id, func.count(BindingCaseRevision.id))
        .where(BindingCaseRevision.binding_case_id.in_(problem_ids))
        .group_by(BindingCaseRevision.binding_case_id)
    )
    return {problem_id: int(count) for problem_id, count in rows.all()}


def latest_origin_is(origin: str) -> ColumnElement[bool]:
    """A condition on ``BindingCase``: its latest revision came from ``origin``."""
    newest = (
        select(BindingCaseRevision.binding_case_id, func.max(BindingCaseRevision.revision).label("revision"))
        .group_by(BindingCaseRevision.binding_case_id)
        .subquery()
    )
    matching = select(BindingCaseRevision.binding_case_id).join(
        newest,
        and_(
            BindingCaseRevision.binding_case_id == newest.c.binding_case_id,
            BindingCaseRevision.revision == newest.c.revision,
        ),
    ).where(BindingCaseRevision.origin == origin)
    return BindingCase.id.in_(matching)


async def linked_by_composition(
    session: AsyncSession, organization_id: uuid.UUID, ref: str
) -> ColumnElement[bool] | None:
    """A condition on ``BindingCase``: some version of the organization's composition ``ref`` (slug or id) links
    one of its revisions. ``None`` when the organization has no such composition.

    The composition tables are read directly: this module may not import the compositions module.
    """
    composition_id = await session.scalar(
        select(Composition.id).where(Composition.organization_id == organization_id, Composition.slug == ref)
    )
    if composition_id is None:
        try:
            parsed = uuid.UUID(ref)
        except ValueError:
            return None
        composition_id = await session.scalar(
            select(Composition.id).where(Composition.organization_id == organization_id, Composition.id == parsed)
        )
        if composition_id is None:
            return None
    linked = (
        select(BindingCaseRevision.binding_case_id)
        .join(CompositionVersion, CompositionVersion.revision_id == BindingCaseRevision.id)
        .where(CompositionVersion.composition_id == composition_id)
    )
    return BindingCase.id.in_(linked)


async def current_compilations(
    session: AsyncSession, revision_ids: list[uuid.UUID]
) -> dict[uuid.UUID, ProblemCompilation]:
    """The compilation of each revision by the installed toolchain, where one exists, in one query."""
    if not revision_ids:
        return {}
    rows = (await session.scalars(
        select(ProblemCompilation).where(
            ProblemCompilation.revision_id.in_(revision_ids),
            ProblemCompilation.compiler_digest == bim.toolchain_digest(),
        )
    )).all()
    return {row.revision_id: row for row in rows}


async def _compilation_for(session: AsyncSession, revision_id: uuid.UUID, compiler_digest: str) -> ProblemCompilation | None:
    return await session.scalar(
        select(ProblemCompilation).where(
            ProblemCompilation.revision_id == revision_id,
            ProblemCompilation.compiler_digest == compiler_digest,
        )
    )


async def compilation_by_digest(
    session: AsyncSession, revision_id: uuid.UUID, compilation_digest: str
) -> ProblemCompilation | None:
    """The stored compilation of a revision with that ``compilation_digest`` (whichever toolchain made it)."""
    return await session.scalar(
        select(ProblemCompilation).where(
            ProblemCompilation.revision_id == revision_id,
            ProblemCompilation.compilation_digest == compilation_digest,
        )
    )


async def compilation_by_ref(session: AsyncSession, revision_id: uuid.UUID, ref: str) -> ProblemCompilation | None:
    """The stored compilation of a revision named by ``ref``: its id or its ``compilation_digest``."""
    if is_digest(ref):
        return await compilation_by_digest(session, revision_id, ref)
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(
        select(ProblemCompilation).where(ProblemCompilation.id == parsed, ProblemCompilation.revision_id == revision_id)
    )


# -- Compile or get ----------------------------------------------------------------------------------


def _not_recompilable(reason: dict[str, Any]) -> HTTPException:
    return api_error(422, NOT_RECOMPILABLE, NOT_RECOMPILABLE_MESSAGE, reason=reason)


async def store_compilation(
    session: AsyncSession, revision_id: uuid.UUID, compilation: Compilation
) -> ProblemCompilation:
    """Insert what ``compilation`` says about the revision; a concurrent identical insert reselects (D6).

    ``compiler_digest`` is the one the compile result reports, the same source that feeds its
    ``compilationDigest``, so the two unique keys agree within a revision.
    """
    compiler = compilation.compiler_digest or bim.toolchain_digest()
    existing = await _compilation_for(session, revision_id, compiler)
    if existing is not None:
        return existing
    row = ProblemCompilation(
        revision_id=revision_id,
        compiler_digest=compiler,
        compilation_digest=compilation.compilation_digest,
        semantic_digest=compilation.semantic_digest,
        toolchain=dict(compilation.toolchain),
        ir_digest=compilation.ir_digest,
        ir=compilation.ir,
        source_map=compilation.source_map,
        analysis=dict(compilation.analysis),
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        existing = await _compilation_for(session, revision_id, compiler)
        if existing is None:
            raise
        return existing
    return row


async def compile_or_get(
    session: AsyncSession, revision: BindingCaseRevision, *, release_transaction: bool = False
) -> ProblemCompilation:
    """The compilation of ``revision`` by the installed toolchain: the stored one, or a new one (D6).

    The lookup is by ``(revision, compilerDigest)``, because the compilation digest is known only after
    compiling. On a miss the package is read back from its blob and compiled; with ``release_transaction``
    the read transaction is ended first, so no transaction is held across the compile. A toolchain release
    adds a row and never rewrites one. A package the toolchain now refuses, or reads as another package, is
    ``422 revision_not_recompilable``.
    """
    found = await _compilation_for(session, revision.id, bim.toolchain_digest())
    if found is not None:
        return found
    blob = await session.get(Blob, revision.package_blob_id)
    if blob is None:
        raise api_error(409, "content_unavailable", "The stored package of this revision is unavailable.")
    archive = read_verified(blob)
    revision_id, package_digest = revision.id, revision.package_digest
    if release_transaction:
        await session.commit()
    try:
        compilation = await compile_package(archive)
    except HTTPException as exc:
        if exc.status_code >= 500:
            raise
        raise _not_recompilable(compile_refusal(exc).as_dict()) from exc
    if compilation.package_digest != package_digest:
        raise _not_recompilable({
            "code": "revision_identity_changed",
            "message": "The installed toolchain reads the stored package as a different package.",
        })
    return await store_compilation(session, revision_id, compilation)


# -- Uploading -----------------------------------------------------------------------------------------


def _raise(refusal) -> None:
    if refusal is not None:
        raise api_error(refusal.status, refusal.code, refusal.detail, headers=refusal.headers or None, **refusal.extra)


async def _problems_of(session: AsyncSession, user_id: uuid.UUID) -> int:
    return int(await session.scalar(
        select(func.count()).select_from(BindingCase).where(BindingCase.created_by_id == user_id)
    ) or 0)


async def _stored_bytes(session: AsyncSession, user_id: uuid.UUID) -> int:
    """What ``maxRepositoryStorage`` charges the account: every revision it created (D23) and every pricing URL
    it read (``plans.application.account_stored_bytes``)."""
    return await account_stored_bytes(session, user_id)


async def _slug_taken(session: AsyncSession, organization_id: uuid.UUID, slug: str) -> bool:
    return await session.scalar(
        select(BindingCase.id).where(BindingCase.organization_id == organization_id, BindingCase.slug == slug).limit(1)
    ) is not None


def _slug_conflict() -> HTTPException:
    return api_error(409, "slug_conflict", "That problem slug is in use in this organization.")


async def _compile_upload(archive: bytes) -> Compilation:
    compilation = await compile_package(archive)
    _raise(entitlement_service.binding_space_refusal(BindingSpace.from_analysis(compilation.analysis)))
    return compilation


async def _lock_account(session: AsyncSession, user_id: uuid.UUID) -> None:
    # FOR NO KEY UPDATE, like ``jobs.limits.lock_owner``: it serialises the account's uploads without
    # blocking the foreign-key checks of rows that reference the account.
    await session.execute(select(User.id).where(User.id == user_id).with_for_update(key_share=True))


async def _check_storage(session: AsyncSession, actor: User, incoming: int) -> None:
    async def stored() -> int:
        return await _stored_bytes(session, actor.id)

    await entitlement_service.enforce_storage_quota(actor.id, incoming, stored)


def _new_revision(
    problem_id: uuid.UUID, number: int, compilation: Compilation, blob: Blob, size: int,
    actor: User, provenance: dict[str, Any] | None,
) -> BindingCaseRevision:
    return BindingCaseRevision(
        binding_case_id=problem_id,
        revision=number,
        package_digest=compilation.package_digest,
        instance_digest=compilation.instance_digest,
        package_blob_id=blob.id,
        package_size=size,
        document=compilation.instance,
        files=compilation.files,
        resource_digests=compilation.resource_digests,
        provenance=provenance or None,
        origin=origin_of((provenance or {}).get("producer")),
        created_by_id=actor.id,
    )


async def create_problem(
    session: AsyncSession,
    organization: Organization,
    archive: bytes,
    actor: User,
    *,
    slug: str | None = None,
    name: str | None = None,
    description: str | None = None,
    provenance: dict[str, Any] | None = None,
    value_origins: list[dict[str, Any]] | None = None,
) -> Upload:
    """Create a problem of ``organization`` whose revision 1 is ``archive`` (201).

    The slug defaults from the Instance's ``metadata.name``. 409 ``slug_conflict`` when it is taken, 402
    when the account's plan has no room (``maxProblems``, ``maxRepositoryStorage``), 422 with the
    toolchain's diagnostics when the package is refused. ``value_origins`` (a SPHERE import's) are inserted
    with the revision, in its transaction.
    """
    if slug is not None and not SLUG.match(slug):
        raise api_error(422, "invalid_slug", "A slug is 1 to 64 lowercase letters, digits and hyphens.")
    caps = await entitlement_service.caps_or_503(actor.id)
    entitlement_service.require_feature(caps, ids.REPOSITORY)
    # A cheap refusal before compiling; the authoritative one is under the account's lock below.
    _raise(quotas.problems_quota(await _problems_of(session, actor.id), caps))
    if slug is not None and await _slug_taken(session, organization.id, slug):
        raise _slug_conflict()
    organization_id, actor_id = organization.id, actor.id
    await session.commit()

    compilation = await _compile_upload(archive)
    metadata = compilation.instance.get("metadata", {}) if isinstance(compilation.instance.get("metadata"), dict) else {}
    slug = slug or slug_from_name(metadata.get("name"))
    name = (name or str(metadata.get("name") or slug))[:160]
    stored = write_file(archive)

    await _lock_account(session, actor_id)
    _raise(quotas.problems_quota(await _problems_of(session, actor_id), caps))
    await _check_storage(session, actor, len(archive))
    if await _slug_taken(session, organization_id, slug):
        raise _slug_conflict()
    try:
        async with session.begin_nested():
            blob = await put_row(session, organization_id, stored, PACKAGE_MEDIA_TYPE, actor_id)
            problem = BindingCase(
                organization_id=organization_id, slug=slug, name=name,
                description=(description or "")[:2000], created_by_id=actor_id,
            )
            session.add(problem)
            await session.flush()
            revision = _new_revision(problem.id, 1, compilation, blob, len(archive), actor, provenance)
            session.add(revision)
            await session.flush()
            session.add_all(rows_from(revision.id, value_origins or ()))
            compiled = await store_compilation(session, revision.id, compilation)
    except IntegrityError as exc:
        raise _slug_conflict() from exc
    audit(session, actor, "problem.created", "BindingCase", problem.id, organization_id,
           slug=slug, revision=1, packageDigest=compilation.package_digest)
    await session.commit()
    return Upload(problem, revision, compiled, True)


async def add_revision(
    session: AsyncSession,
    problem: BindingCase,
    archive: bytes,
    actor: User,
    *,
    provenance: dict[str, Any] | None = None,
    value_origins: list[dict[str, Any]] | None = None,
    expected_latest: int | None = None,
) -> Upload:
    """Add ``archive`` as the next revision of ``problem`` (201), or answer the revision it already is (200).

    Idempotent on ``(problem, packageDigest)``: the same package, however zipped, is the same revision, and
    nothing is stored for it again (its origins included: the first writer's stay). ``value_origins`` (a SPHERE
    import's) are inserted with a new revision, in its transaction; without them (an editor save, an upload) the
    origins of the predecessor (the latest revision under the problem lock) whose values the new compilation keeps
    are carried (``origins.carried_rows``).

    ``expected_latest`` (a SPHERE apply's base) must be the latest revision when the problem is locked, after the
    digest dedupe: otherwise 409 ``revision_moved`` with the latest number, so a save that landed between the
    caller's read and this insert is never silently built over.
    """
    caps = await entitlement_service.caps_or_503(actor.id)
    entitlement_service.require_feature(caps, ids.REPOSITORY)
    problem_id, organization_id, actor_id = problem.id, problem.organization_id, actor.id
    await session.commit()

    compilation = await _compile_upload(archive)
    existing = await session.scalar(select(BindingCaseRevision).where(
        BindingCaseRevision.binding_case_id == problem_id,
        BindingCaseRevision.package_digest == compilation.package_digest,
    ))
    if existing is not None:
        compiled = await store_compilation(session, existing.id, compilation)
        await session.commit()
        return Upload(problem, existing, compiled, False)
    stored = write_file(archive)

    await _lock_account(session, actor_id)
    await session.execute(select(BindingCase.id).where(BindingCase.id == problem_id).with_for_update())
    await _check_storage(session, actor, len(archive))
    for attempt in range(2):
        existing = await session.scalar(select(BindingCaseRevision).where(
            BindingCaseRevision.binding_case_id == problem_id,
            BindingCaseRevision.package_digest == compilation.package_digest,
        ))
        if existing is not None:
            compiled = await store_compilation(session, existing.id, compilation)
            await session.commit()
            return Upload(problem, existing, compiled, False)
        latest = await session.scalar(
            select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == problem_id)
        )
        # The true predecessor, read under the problem lock: what an editor save or an upload carries origins from.
        predecessor = await session.scalar(select(BindingCaseRevision.id).where(
            BindingCaseRevision.binding_case_id == problem_id, BindingCaseRevision.revision == latest,
        )) if latest else None
        if expected_latest is not None and int(latest or 0) != expected_latest:
            raise api_error(
                409, "revision_moved", "Another revision was added since; preview again on the latest one.",
                latest=int(latest or 0),
            )
        try:
            async with session.begin_nested():
                blob = await put_row(session, organization_id, stored, PACKAGE_MEDIA_TYPE, actor_id)
                revision = _new_revision(problem_id, int(latest or 0) + 1, compilation, blob, len(archive), actor, provenance)
                session.add(revision)
                await session.flush()
                if value_origins is not None:
                    session.add_all(rows_from(revision.id, value_origins))
                elif predecessor is not None:
                    session.add_all(await carried_rows(session, predecessor, revision.id, compilation.ir))
                compiled = await store_compilation(session, revision.id, compilation)
        except IntegrityError:
            # A concurrent identical upload won: the loop answers with its revision.
            if attempt:
                raise
            continue
        break
    problem.updated_at = utcnow()
    audit(session, actor, "problem.revision_created", "BindingCaseRevision", revision.id, organization_id,
           problem=str(problem_id), revision=revision.revision, packageDigest=compilation.package_digest)
    await session.commit()
    return Upload(problem, revision, compiled, True)


# -- Deleting ------------------------------------------------------------------------------------------


async def delete_problem(session: AsyncSession, problem: BindingCase, actor: User) -> None:
    """Delete ``problem``, its revisions and compilations, unless something names them.

    A run or a study cell that names one of its revisions keeps the problem (409 ``problem_has_runs``), and
    so does a sealed composition version, evaluation or derivation (409 ``problem_has_compositions``); runs are checked
    first. Blob rows and files stay (D14). A run launched or a version sealed while the delete runs is caught
    by the ``RESTRICT`` foreign keys, and the references are checked again to answer with the right code.
    """
    revision_ids = list((await session.scalars(
        select(BindingCaseRevision.id).where(BindingCaseRevision.binding_case_id == problem.id)
    )).all())
    refusal = await _named(session, revision_ids)
    if refusal is not None:
        raise refusal
    try:
        async with session.begin_nested():
            if revision_ids:
                for origin in (await session.scalars(
                    select(ProblemValueOrigin).where(ProblemValueOrigin.revision_id.in_(revision_ids))
                )).all():
                    await session.delete(origin)
                for compilation in (await session.scalars(
                    select(ProblemCompilation).where(ProblemCompilation.revision_id.in_(revision_ids))
                )).all():
                    await session.delete(compilation)
                await session.flush()
                for revision in (await session.scalars(
                    select(BindingCaseRevision).where(BindingCaseRevision.id.in_(revision_ids))
                )).all():
                    await session.delete(revision)
                await session.flush()
            await session.delete(problem)
            await session.flush()
    except IntegrityError as exc:
        raise (await _named(session, revision_ids) or _has_runs()) from exc
    audit(session, actor, "problem.deleted", "BindingCase", problem.id, problem.organization_id, slug=problem.slug)
    await session.flush()


async def _named(session: AsyncSession, revision_ids: list[uuid.UUID]) -> HTTPException | None:
    """Why the revisions are kept: a run or study cell first, then a composition; ``None`` when nothing names them.

    Compositions are read from their tables directly: this module may not import the compositions module.
    """
    if not revision_ids:
        return None
    for column in (Job.revision_id, StudyCell.binding_case_revision_id):
        if await session.scalar(select(column).where(column.in_(revision_ids)).limit(1)) is not None:
            return _has_runs()
    for column in (
        CompositionVersion.revision_id, CompositionEvaluation.revision_id, CompositionDerivation.revision_id,
    ):
        if await session.scalar(select(column).where(column.in_(revision_ids)).limit(1)) is not None:
            return api_error(
                409, "problem_has_compositions", "Delete the compositions that link this problem first.",
            )
    return None


def _has_runs() -> HTTPException:
    return api_error(
        409, "problem_has_runs", "Runs or studies name a revision of this problem, so it is kept as their evidence.",
    )
