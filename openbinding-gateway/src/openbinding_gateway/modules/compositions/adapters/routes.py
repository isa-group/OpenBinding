"""The compositions of an organization and their versions: ``/v1/organizations/{org}/compositions``.

VIEWER reads and checks a document against its problem, MEMBER creates, edits and seals versions, ADMIN
deletes and changes who reads a composition. A composition the caller cannot read answers as a missing one:
404 for a non-member and for a composition of another organization, never 403. A member whose role is too
weak for a write gets 403 ``organization_forbidden``. Edits take an optional ``If-Match`` (the ``ETag`` of a
read or an earlier edit).

A ``public`` composition is read by anybody, with no credential too, through the five read routes (the
composition, its versions, a version, its content and the diff): a reader who is not a member gets the
views redacted to what the published documents say (``_public_version``), and is the only caller charged
for these reads. Every other route stays for members, public composition or not.

A version is sealed from a Composition2Yaml document sent as YAML (at most 256 KiB): it is read, judged
and, when it links a problem, evaluated by the toolchain; its canonical bytes and the evaluation are then
stored, immutable. Sealing and checking count against the caller's ``evaluate`` budget. Two versions are
compared from their stored bytes; a version is forked into another organization as a new composition, whose
first version is sealed through the same pipeline (also the ``evaluate`` budget).

A sealed version is evaluated again from its stored bytes: by the installed toolchain, whose evaluation is
stored (one per toolchain release), with some tasks bound otherwise (nothing stored), and around its binding
(the toolchain's one-task alternatives). The three count against the ``evaluate`` budget.

A version is also derived from a binding of a problem: a run's solution, or a binding given with a revision.
The derived document is written from the toolchain's evaluation, and stored with an edge naming what it was
derived from; the same binding derived again answers the version that holds its bytes (the ``evaluate``
budget too).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Union

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, get_reader, session_dependency
from ....access.work_limits import charge_anonymous_read, limit_work
from ....composition.text import document as text_document
from ....core import revision as etags
from ....db.models import (
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionKind,
    CompositionVersion,
    Organization,
    OrganizationRole,
    User,
    ValuesStatus,
)
from ....models.errors import (
    CONFLICT_RESPONSE,
    FORBIDDEN_RESPONSE as _FORBIDDEN,
    NOT_FOUND_RESPONSE,
    UNAVAILABLE_RESPONSE,
    ErrorResponse,
    api_error,
)
from ....security.apikeys import authenticated_api_key, boundary_of
from ..application import compositions, derive, evaluate, language, seal, versions
from ..application.fork import NameTaken, fork_composition
from ..application.language import diagnostic_view
from ..domain.records import values_json
from .language_routes import MAX_DOCUMENT_BYTES, YAML_BODY, YAML_MEDIA_TYPES, document_body
from .schemas import (
    CheckResult,
    CompositionCreate,
    CompositionDerive,
    CompositionEvaluate,
    CompositionKindName,
    CompositionList,
    CompositionNeighborhoodResponse,
    CompositionOrganization,
    CompositionFork,
    CompositionUpdate,
    CompositionVersionDiff,
    CompositionVersionList,
    CompositionVersionSummary,
    CompositionVersionView,
    CompositionView,
    DerivationView,
    DeriveDraft,
    DeriveResult,
    EvaluateResult,
    EvaluationCompilation,
    EvaluationSummary,
    EvaluationSummaryCompilation,
    EvaluationView,
    EvidenceRun,
    ForkedFrom,
    ForkNameTaken,
    ForkResult,
    SealResult,
    VersionCompilation,
    VersionDerivation,
    VersionDerivationRevision,
    VersionDerivationRun,
    VersionLink,
    VersionName,
    VersionProblem,
    VersionRevision,
)

router = APIRouter(prefix="/v1/organizations/{org}/compositions", tags=["Compositions"])

_UNREADABLE: dict[int | str, dict[str, Any]] = {
    404: {**NOT_FOUND_RESPONSE, "description": "No such organization or composition, or the caller cannot read it."},
}
#: The read routes answer by credential (a member's view or the public one), so caches key on it.
_VARY = "Authorization, X-API-Key"


def _read_headers(headers, reader: compositions.Reader) -> None:
    """``Vary`` on every read; and a public reader's copy is revalidated each time, as SPHERE does, so a
    composition made private again stops being served from a cache."""
    headers["Vary"] = _VARY
    if reader.public:
        headers["Cache-Control"] = "private, no-cache"


def _summary(summary: versions.Summary) -> CompositionVersionSummary | None:
    version = summary.latest
    if version is None:
        return None
    return CompositionVersionSummary(
        id=version.id, ordinal=version.ordinal, label=version.label, values_status=version.values_status.value,
        verified=summary.verified, created_at=version.created_at,
    )


def _view(
    composition: Composition, organization: Organization, summary: versions.Summary | None = None,
) -> CompositionView:
    return CompositionView(
        id=composition.id, slug=composition.slug, name=composition.name, description=composition.description,
        kind=composition.kind.value, archived=composition.archived, visibility=composition.visibility,
        organization=CompositionOrganization(id=organization.id, slug=organization.slug, name=organization.name),
        latest_version=_summary(summary) if summary else None,
        version_count=summary.count if summary else 0,
        created_by_id=composition.created_by_id, created_at=composition.created_at, updated_at=composition.updated_at,
    )


async def _viewed(session: AsyncSession, composition: Composition, organization: Organization) -> CompositionView:
    summary = (await versions.summaries(session, [composition.id]))[composition.id]
    return _view(composition, organization, summary)


@router.get("", response_model=CompositionList, operation_id="listCompositions", responses=_UNREADABLE)
async def list_compositions(
    org: str,
    kind: CompositionKindName | None = Query(default=None),
    q: str | None = Query(default=None, max_length=160, description="Text in the name or the slug."),
    archived: bool | None = Query(default=None, description="Only archived (`true`) or only active (`false`) ones."),
    sort: Literal["name", "updated"] = Query(
        default="name", description="By `name` (the default), or the most recently `updated` first.",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionList:
    """The organization's compositions, by name or the most recently updated first."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    page = await compositions.list_compositions(
        session, organization.id, kind=CompositionKind(kind) if kind else None, q=q, archived=archived,
        sort=sort, limit=limit, offset=offset,
    )
    found = await versions.summaries(session, [row.id for row in page.compositions])
    return CompositionList(
        compositions=[_view(row, organization, found[row.id]) for row in page.compositions],
        total=page.total, limit=limit, offset=offset,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=CompositionView,
    operation_id="createComposition",
    responses={
        201: {"headers": {"ETag": etags.ETAG_HEADER}},
        **_UNREADABLE,
        409: {**CONFLICT_RESPONSE, "description": "The slug is in use in this organization (`slug_conflict`)."},
    },
)
async def create_composition(
    org: str,
    payload: CompositionCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """Create an empty composition: no version yet."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    created = await compositions.create_composition(
        session, organization, user, slug=payload.slug, name=payload.name, description=payload.description,
        kind=CompositionKind(payload.kind),
    )
    etags.set_etag(response, created)
    return _view(created, organization, versions.Summary(None, 0))


@router.get(
    "/{composition}",
    response_model=CompositionView,
    operation_id="getComposition",
    dependencies=[Depends(charge_anonymous_read)],
    responses={**etags.ETAG_RESPONSE, **_UNREADABLE},
)
async def get_composition(
    org: str,
    composition: str,
    response: Response,
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """One composition, by slug or id; a public one for anybody."""
    organization, found, reader = await compositions.readable_composition(session, org, composition, user)
    etags.set_etag(response, found)
    _read_headers(response.headers, reader)
    view = await _viewed(session, found, organization)
    return view.model_copy(update={"created_by_id": None}) if reader.public else view


@router.patch(
    "/{composition}",
    response_model=CompositionView,
    operation_id="updateComposition",
    responses={
        **etags.EDIT_RESPONSES,
        403: {
            **_FORBIDDEN,
            "description": "The caller's role is too weak: MEMBER edits, ADMIN changes `visibility` (`organization_forbidden`).",
        },
        **_UNREADABLE,
    },
)
async def update_composition(
    org: str,
    composition: str,
    payload: CompositionUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """Rename, describe, archive or restore a composition, or change who reads it (ADMIN)."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    if payload.visibility is not None and payload.visibility != found.visibility:
        await compositions.require_visibility_role(session, organization, user)
    await etags.guard(session, found, if_match)
    updated = await compositions.update_composition(
        session, found, user, name=payload.name, description=payload.description, archived=payload.archived,
        visibility=payload.visibility,
    )
    etags.set_etag(response, updated)
    return await _viewed(session, updated, organization)


@router.delete(
    "/{composition}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteComposition",
    responses=_UNREADABLE,
)
async def delete_composition(
    org: str,
    composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete a composition with its versions and their evaluations."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.ADMIN)
    found = await compositions.required_composition(session, organization, composition)
    await compositions.delete_composition(session, found, user)


# -- Versions --------------------------------------------------------------------------------------------

_ERROR = {"model": ErrorResponse}
_BUSY = {429: {**_ERROR, "description": "Every Composition2Yaml slot of this process is taken (`composition_busy`)."}}
_DOCUMENT_REFUSALS: dict[int | str, dict[str, Any]] = {
    413: {**_ERROR, "description": f"The document is longer than {MAX_DOCUMENT_BYTES} bytes (`limitBytes`)."},
    415: {**_ERROR, "description": "The document is not sent as YAML."},
}
_TOOLCHAIN_DOWN = {503: {**UNAVAILABLE_RESPONSE, "description": "The toolchain does not answer (`bim_unavailable`)."}}
_VERSION_ETAG = {"ETag": {"description": "The version's content digest, quoted.", "schema": {"type": "string"}}}


def _values(values: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    return {name: {"value": value["value"], "unit": value["unit"]} for name, value in (values or {}).items()}


def _evaluation_view(
    evaluation: CompositionEvaluation, current: CompositionEvaluation | None, detail: versions.Detail | None = None,
) -> EvaluationView:
    compiled = None
    if evaluation.compilation_id is not None:
        row = detail.compilations.get(evaluation.compilation_id) if detail is not None else None
        compiled = EvaluationCompilation(
            id=evaluation.compilation_id,
            compilation_digest=evaluation.compilation_digest or "",
            compiler_digest=evaluation.compiler_digest or "",
            semantic_digest=evaluation.semantic_digest or (row.semantic_digest if row is not None else ""),
            toolchain=dict(evaluation.toolchain or {}),
        )
    result = evaluation.result or {}
    return EvaluationView(
        id=evaluation.id,
        basis=evaluation.basis.value,
        outcome=evaluation.outcome.value,
        values=_values(evaluation.values),
        violations=list(result.get("violations") or []),
        diagnostics=list(evaluation.diagnostics or []),
        compilation=compiled,
        binding=_binding(evaluation.binding),
        current=current is not None and current.id == evaluation.id,
        created_at=evaluation.created_at,
    )


def _binding(binding: dict[str, Any] | None) -> dict[str, str] | None:
    """``{task: {resource, id}}`` as the toolchain was given it, keyed as a problem's facts key a candidate."""
    if binding is None:
        return None
    return {task: f"{reference['resource']}/{reference['id']}" for task, reference in binding.items()}


def _evaluation_summary(evaluation: CompositionEvaluation | None, detail: versions.Detail) -> EvaluationSummary | None:
    if evaluation is None:
        return None
    compiled = None
    if evaluation.compilation_id is not None:
        row = detail.compilations.get(evaluation.compilation_id)
        compiled = EvaluationSummaryCompilation(
            compilation_digest=evaluation.compilation_digest or "",
            semantic_digest=evaluation.semantic_digest or (row.semantic_digest if row is not None else ""),
            toolchain=dict(evaluation.toolchain or {}),
        )
    return EvaluationSummary(
        id=evaluation.id, basis=evaluation.basis.value, outcome=evaluation.outcome.value, compilation=compiled,
        created_at=evaluation.created_at,
    )


def _derivation(found: versions.Derivation | None) -> VersionDerivation | None:
    if found is None:
        return None
    return VersionDerivation(
        source=found.source,
        run=VersionDerivationRun(id=found.run_id) if found.run_id is not None else None,
        point=found.point,
        revision=VersionDerivationRevision(id=found.revision_id, revision=found.revision),
    )


def _version_view(
    detail: versions.Detail,
    *,
    analytics: bool = True,
    evaluations: bool = True,
    document: dict[str, Any] | None = None,
) -> CompositionVersionView:
    """A version's view; ``evaluations`` false leaves the evaluations out (a light list row), and
    ``document`` is its content as JSON when asked for."""
    version, current, link = detail.version, detail.current, detail.link
    linked = None
    if link is not None:
        linked = VersionLink(
            problem=VersionProblem(id=link.problem.id, slug=link.problem.slug, name=link.problem.name),
            revision=VersionRevision(id=link.revision.id, revision=link.revision.revision),
            linked_compilation=VersionCompilation(
                id=link.compilation.id, compilation_digest=link.compilation.compilation_digest,
                semantic_digest=link.compilation.semantic_digest,
            ),
        )
    return CompositionVersionView(
        id=version.id,
        ordinal=version.ordinal,
        label=version.label,
        syntax_version=version.syntax_version,
        kind=version.kind.value,
        values_status=version.values_status.value,
        verified=(
            version.values_status == ValuesStatus.VERIFIED and current is not None
            and current.outcome.value == "verified"
        ),
        content_digest=version.content_digest,
        size_bytes=version.size_bytes,
        values=_values(current.values if current is not None else None),
        problem=linked,
        offering=version.offering,
        evidence_run=EvidenceRun(id=version.evidence_job_id) if version.evidence_job_id else None,
        based_on=version.based_on,
        forked_from=version.forked_from,
        analytics=version.analytics if analytics else None,
        derivation=_derivation(detail.derivation),
        evaluations=[_evaluation_view(item, current, detail) for item in detail.evaluations] if evaluations else [],
        current_evaluation_id=current.id if current is not None else None,
        current_evaluation=_evaluation_summary(current, detail),
        document=document,
        created_by_id=version.created_by_id,
        created_at=version.created_at,
    )


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value is not None else None
    except ValueError:
        return None


def _sources(view: CompositionVersionView) -> set[uuid.UUID]:
    """The compositions a version's lineage names (``forked_from`` and ``based_on``)."""
    found = {_uuid((view.based_on or {}).get("composition_id"))}
    if view.forked_from is not None:
        found.add(view.forked_from.composition_id)
    return {item for item in found if item is not None}


def _public_evaluation(view: EvaluationView) -> EvaluationView:
    compiled = view.compilation.model_copy(update={"id": None}) if view.compilation is not None else None
    return view.model_copy(update={"violations": [], "diagnostics": [], "compilation": compiled, "binding": None})


def _public_version(view: CompositionVersionView, readable: set[uuid.UUID]) -> CompositionVersionView:
    """A version as a reader who is not a member sees it: what its canonical bytes say, and nothing else.

    The bytes are served (the content, the diff), so what they carry stays: values, digests, the toolchain,
    the problem's ref (slug and revision number), the run and point of ``evidence``. What they do not carry
    goes: member ids, the problem, revision and compilation ids and the problem's name, every evaluation but
    the current one and its diagnostics and violations, which speak of the private problem, the binding it
    was given (catalog resource names a document writes only when an id is ambiguous), and lineage that
    names a source ``readable`` does not hold (one that is neither this composition nor public now). The
    derivation keeps its source, run and point (the bytes' ``evidence``) and loses its revision id.
    """
    link = view.problem
    if link is not None:
        link = VersionLink(
            problem=link.problem.model_copy(update={"id": None, "name": None}),
            revision=link.revision.model_copy(update={"id": None}),
            linked_compilation=link.linked_compilation.model_copy(update={"id": None}),
        )
    based_on = view.based_on
    if based_on is not None and _uuid(based_on.get("composition_id")) not in readable:
        based_on = None
    forked_from = view.forked_from
    if forked_from is not None and forked_from.composition_id not in readable:
        forked_from = ForkedFrom(dropped_problem=forked_from.dropped_problem)
    derivation = view.derivation
    if derivation is not None:
        derivation = derivation.model_copy(update={"revision": derivation.revision.model_copy(update={"id": None})})
    return view.model_copy(update={
        "problem": link,
        "based_on": based_on,
        "forked_from": forked_from,
        "derivation": derivation,
        "evaluations": [_public_evaluation(item) for item in view.evaluations if item.current],
        "created_by_id": None,
    })


async def _for_reader(
    session: AsyncSession, reader: compositions.Reader, composition: Composition, views: list[CompositionVersionView],
) -> list[CompositionVersionView]:
    """``views`` as ``reader`` sees them; for a public reader, the sources public now are read in one query."""
    if not reader.public:
        return views
    named = set().union(*(_sources(view) for view in views)) - {composition.id}
    readable = await compositions.public_among(session, named) | {composition.id}
    return [_public_version(view, readable) for view in views]


def _content_tag(version: CompositionVersion) -> str:
    return f'"{version.content_digest}"'


def _invalid(diagnostics) -> Exception:
    return api_error(
        422, "composition_invalid", "The document has errors; `diagnostics` says where.",
        diagnostics=[diagnostic_view(item) for item in diagnostics],
    )


@router.get(
    "/{composition}/versions",
    response_model=CompositionVersionList,
    operation_id="listCompositionVersions",
    dependencies=[Depends(charge_anonymous_read)],
    responses={
        **_UNREADABLE,
        422: {"description": "`created_after` is later than `created_before` (`invalid_request`)."},
    },
)
async def list_composition_versions(
    org: str,
    composition: str,
    response: Response,
    include: str | None = Query(
        default=None, pattern=r"^(analytics|evaluations)(,(analytics|evaluations))*$",
        description=(
            "A comma list: `analytics`, each version with the summary of its document; `evaluations`, each with "
            "its evaluations (without it a row names its current evaluation only)."
        ),
    ),
    order: Literal["newest", "oldest"] = Query(
        default="newest", description="`newest` first (the default) or `oldest` first, as evolution charts read them.",
    ),
    created_after: datetime | None = Query(
        default=None, description="Only versions sealed at or after this instant (ISO 8601; UTC without an offset).",
    ),
    created_before: datetime | None = Query(
        default=None, description="Only versions sealed before this instant (ISO 8601; UTC without an offset).",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionVersionList:
    """The composition's versions, each with its values, value status and current evaluation."""
    _, found, reader = await compositions.readable_composition(session, org, composition, user)
    _read_headers(response.headers, reader)
    included = set(include.split(",")) if include else set()
    if created_after is not None and created_before is not None and created_after > created_before:
        raise api_error(422, "invalid_request", "`created_after` is later than `created_before`.")
    rows, total = await versions.list_versions(
        session, found, order=order, created_after=created_after, created_before=created_before,
        limit=limit, offset=offset,
    )
    whole = "evaluations" in included
    shown = await versions.details(session, rows, light=not whole)
    views = [_version_view(item, analytics="analytics" in included, evaluations=whole) for item in shown]
    return CompositionVersionList(
        versions=await _for_reader(session, reader, found, views), total=total, limit=limit, offset=offset,
    )


@router.post(
    "/{composition}/versions",
    status_code=status.HTTP_201_CREATED,
    response_model=SealResult,
    operation_id="createCompositionVersion",
    summary="Seal a version of a composition",
    description=(
        "Read the document, judge it and, when it links a problem, have the toolchain check its binding and "
        "compute its values; then store its canonical text as a new, immutable version with that evaluation. "
        "The same canonical text sealed again answers 200 with the version that holds it."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {
            "description": "The canonical text was already sealed: the version that holds it.",
            "headers": _VERSION_ETAG, "model": SealResult,
        },
        201: {"headers": {"Location": {"description": "The new version.", "schema": {"type": "string"}}, **_VERSION_ETAG}},
        **_UNREADABLE,
        409: {**CONFLICT_RESPONSE, "description": "Another content holds this `version:` (`version_label_taken`)."},
        **_DOCUMENT_REFUSALS,
        422: {"description": "The document has errors (`composition_invalid`); `diagnostics` lists each one, located."},
        **_TOOLCHAIN_DOWN,
    },
    openapi_extra=YAML_BODY,
)
async def create_composition_version(
    org: str,
    composition: str,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SealResult:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    raw = await document_body(request, YAML_MEDIA_TYPES, MAX_DOCUMENT_BYTES, "A document")
    checked = await seal.check(session, organization, found, raw, user)
    if not checked.valid or checked.assessment is None:
        raise _invalid(checked.diagnostics)
    sealed = await seal.persist(session, found, checked.assessment, actor=user)
    (detail,) = await versions.details(session, [sealed.version])
    response.status_code = status.HTTP_201_CREATED if sealed.created else status.HTTP_200_OK
    response.headers["ETag"] = _content_tag(sealed.version)
    if sealed.created:
        response.headers["Location"] = (
            f"/v1/organizations/{organization.slug}/compositions/{found.slug}/versions/{sealed.version.id}"
        )
    return SealResult(
        version=_version_view(detail),
        evaluation=_evaluation_view(sealed.evaluation, detail.current, detail),
        diagnostics=[diagnostic_view(item) for item in checked.diagnostics],
    )


@router.post(
    "/{composition}/versions/check",
    response_model=CheckResult,
    operation_id="checkCompositionVersion",
    summary="Check a document as a seal would, storing nothing",
    description=(
        "Every diagnostic a seal of this document would give, against its problem and by the toolchain, "
        "and the canonical text a seal would store: 200 whether or not the document is valid."
    ),
    dependencies=[Depends(limit_work)],
    responses={**_UNREADABLE, **_DOCUMENT_REFUSALS, **_TOOLCHAIN_DOWN},
    openapi_extra=YAML_BODY,
)
async def check_composition_version(
    org: str,
    composition: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CheckResult:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    raw = await document_body(request, YAML_MEDIA_TYPES, MAX_DOCUMENT_BYTES, "A document")
    checked = await seal.check(session, organization, found, raw, user)
    assessment = checked.assessment
    valid = checked.valid and assessment is not None and assessment.effective is not None
    values_status = None
    if assessment is not None:
        values_status = "declared" if assessment.document.problem is None else "verified"
    return CheckResult(
        valid=valid,
        values_status=values_status,
        values=values_json(assessment.effective.values) if valid else None,
        content=assessment.content if valid else None,
        diagnostics=[diagnostic_view(item) for item in checked.diagnostics],
    )


@router.get(
    "/{composition}/versions/{version}",
    response_model=CompositionVersionView,
    operation_id="getCompositionVersion",
    dependencies=[Depends(charge_anonymous_read)],
    responses={200: {"headers": _VERSION_ETAG}, **_UNREADABLE, **_BUSY},
)
async def get_composition_version(
    org: str,
    composition: str,
    version: str,
    response: Response,
    include: str | None = Query(
        default=None, pattern=r"^document(,document)*$",
        description="A comma list: `document`, the version's content as the canonical JSON model, read as it was sealed.",
    ),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionVersionView:
    """One version, by id, label or ordinal."""
    _, found, reader = await compositions.readable_composition(session, org, composition, user)
    row = await versions.required_version(session, found, version)
    (detail,) = await versions.details(session, [row])
    document = await language.document_stored(row.content) if include else None
    response.headers["ETag"] = _content_tag(row)
    _read_headers(response.headers, reader)
    (view,) = await _for_reader(session, reader, found, [_version_view(detail, document=document)])
    return view


@router.get(
    "/{composition}/versions/{version}/content",
    response_class=Response,
    operation_id="getCompositionVersionContent",
    summary="Download a version's Composition2Yaml text",
    description="The canonical text the version stores. It never changes: `ETag` is its digest.",
    responses={
        200: {
            "description": "The canonical text.",
            "headers": _VERSION_ETAG,
            "content": {"application/yaml": {"schema": {"type": "string"}}},
        },
        304: {"description": "The caller's copy (`If-None-Match`) is the content."},
        **_UNREADABLE,
    },
    dependencies=[Depends(charge_anonymous_read)],
)
async def get_composition_version_content(
    org: str,
    composition: str,
    version: str,
    request: Request,
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    # Who may read it is decided before the caller's copy is compared: a composition made private again is
    # a 404, never a 304.
    _, found, reader = await compositions.readable_composition(session, org, composition, user)
    row = await versions.required_version(session, found, version)
    tag = _content_tag(row)
    headers = {"ETag": tag, "Cache-Control": "private, immutable"}
    _read_headers(headers, reader)
    if tag in {item.strip() for item in request.headers.get("if-none-match", "").split(",")}:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=row.content.encode("utf-8"), media_type="application/yaml; charset=utf-8", headers=headers)


# -- Diff and fork ---------------------------------------------------------------------------------------


def _name(version: CompositionVersion) -> dict[str, Any]:
    return {"id": version.id, "label": version.label}


@router.get(
    "/{composition}/diff",
    response_model=CompositionVersionDiff,
    operation_id="diffCompositionVersions",
    summary="Compare two versions of a composition",
    description=(
        "What changed from version `from` to version `to`, read from their stored bytes, in SPHERE's "
        "PricingDiff shape with a `comparison` (see `diffCompositions`). `to` is the latest version by "
        "default, and `from` the one before `to`. Versions of two compositions are compared with "
        "`diffCompositions` on their contents."
    ),
    responses={
        **_UNREADABLE,
        422: {
            "description": "A default the composition cannot give: no version yet, or none before `to` (`diff_version_missing`).",
        },
        **_BUSY,
    },
    dependencies=[Depends(charge_anonymous_read)],
)
async def diff_composition_versions(
    org: str,
    composition: str,
    response: Response,
    from_version: str | None = Query(default=None, alias="from", description="The earlier version: id, label or ordinal."),
    to_version: str | None = Query(default=None, alias="to", description="The later version: id, label or ordinal."),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict[str, Any]:
    _, found, reader = await compositions.readable_composition(session, org, composition, user)
    _read_headers(response.headers, reader)
    before, after = await versions.diff_pair(session, found, from_version, to_version)
    compared = await language.diff_stored(before.content, after.content)
    return {"from": _name(before), "to": _name(after), **compared}


def _key_reaches(user: User, organization: Organization, slug: str) -> bool:
    """Whether the authenticating API key's boundary covers a composition ``slug`` of ``organization``.

    The fork's target is named in its body, so the route-level boundary check sees only the source.
    """
    key = authenticated_api_key(user)
    boundary = boundary_of(key) if key is not None else None
    if boundary is None:
        return True
    if not boundary:
        return False
    if "organizations" in boundary and not {str(organization.id), organization.slug} & boundary["organizations"]:
        return False
    return "slugs" not in boundary or slug in boundary["slugs"]


@router.post(
    "/{composition}/fork",
    status_code=status.HTTP_201_CREATED,
    response_model=ForkResult,
    operation_id="forkComposition",
    summary="Fork a version of a composition into another organization",
    description=(
        "Create a new composition in `targetOrganization` whose first version is the source version's "
        "document with `composition:` set to the new slug, sealed again through the same pipeline. The "
        "caller must read the source and be a MEMBER of the target. Without `slug` the fork takes the "
        "source's, and when the target holds it already nothing is written: 200 `nameTaken` names the "
        "composition that holds it. A version that links a problem is forked only with `dropProblem`, which "
        "removes its `problem` and `evidence` and declares its values."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {"model": ForkNameTaken, "description": "Nothing was forked: the source's slug is taken in the target."},
        201: {"headers": {
            "ETag": etags.ETAG_HEADER,
            "Location": {"description": "The new composition.", "schema": {"type": "string"}},
        }},
        403: {
            **_ERROR,
            "description": (
                "The caller's role in the target is too weak (`organization_forbidden`), its plan lacks the "
                "`repository` feature (`feature_not_entitled`), or its API key does not reach the target "
                "(`api_key_boundary`)."
            ),
        },
        **_UNREADABLE,
        409: {
            **CONFLICT_RESPONSE,
            "description": (
                "The target is the source's own organization (`composition_fork_same_organization`), the version "
                "links a problem and `dropProblem` is not set (`composition_fork_problem_unreadable`), or the "
                "given `slug` is in use in the target (`slug_conflict`)."
            ),
        },
        422: {"description": "The forked document has errors (`composition_invalid`); `diagnostics` lists each one."},
        **_BUSY,
    },
)
async def fork_composition_version(
    org: str,
    composition: str,
    payload: CompositionFork,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Any:
    # A member of the source's organization, or anybody for a public source; the fork itself is private.
    source_organization, source, _ = await compositions.readable_composition(session, org, composition, user)
    version = await versions.required_version(session, source, payload.version)
    target = await compositions.organization_for(session, payload.target_organization, user, OrganizationRole.MEMBER)
    if not _key_reaches(user, target, payload.slug or source.slug):
        raise api_error(
            status.HTTP_403_FORBIDDEN, "api_key_boundary",
            "This API key is restricted from the requested method or resource.",
        )
    outcome = await fork_composition(
        session, source_organization, source, version, target,
        actor=user, slug=payload.slug, name=payload.name, description=payload.description,
        drop_problem=payload.drop_problem,
    )
    if isinstance(outcome, NameTaken):
        existing = outcome.existing
        return JSONResponse(status_code=status.HTTP_200_OK, content=ForkNameTaken(
            nameTaken=True, existingComposition={"id": existing.id, "slug": existing.slug, "name": existing.name},
        ).model_dump(mode="json", by_alias=True))
    created = outcome.composition
    (detail,) = await versions.details(session, [outcome.sealed.version])
    forked = _version_view(detail)
    etags.set_etag(response, created)
    response.headers["Location"] = f"/v1/organizations/{target.slug}/compositions/{created.slug}"
    return ForkResult(
        composition=_view(created, target, versions.Summary(outcome.sealed.version, 1, forked.verified)),
        version=forked,
        droppedProblem=outcome.dropped_problem,
    )


# -- Re-evaluation, other bindings and the neighbourhood ------------------------------------------------

_NOT_LINKED = "the version links no problem (`composition_not_linked`)"
_EMPTY = {409: {**CONFLICT_RESPONSE, "description": "The composition has no version to default to (`composition_empty`)."}}


@router.post(
    "/{composition}/versions/{version}/evaluations",
    status_code=status.HTTP_201_CREATED,
    response_model=EvaluationView,
    operation_id="reevaluateCompositionVersion",
    summary="Evaluate a version with the installed toolchain",
    description=(
        "Store the installed toolchain's evaluation of the version, read from its stored bytes and the "
        "problem it links: one per toolchain release, whatever its outcome (`verified`, `binding_invalid`, "
        "`semantics_changed`). 200 with the evaluation when it already exists; a version linked to no "
        "problem answers its declared evaluation. The version itself never changes."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {"model": EvaluationView, "description": "The installed toolchain had evaluated the version already."},
        **_UNREADABLE,
        422: {
            "description": (
                "The installed toolchain could not evaluate the version, for example its package no longer "
                "compiles (`evaluation_invalid`); `diagnostics` says why."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def reevaluate_composition_version(
    org: str,
    composition: str,
    version: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> EvaluationView:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    row = await versions.required_version(session, found, version)
    outcome = await evaluate.reevaluate(session, organization, found, row, actor=user)
    (detail,) = await versions.details(session, [row])
    response.status_code = status.HTTP_201_CREATED if outcome.created else status.HTTP_200_OK
    return _evaluation_view(outcome.evaluation, detail.current, detail)


@router.post(
    "/{composition}/evaluate",
    response_model=EvaluateResult,
    operation_id="evaluateComposition",
    summary="Evaluate another binding of a version",
    description=(
        "Have the installed toolchain evaluate the binding of a version (the latest by default) with the "
        "tasks `binding` names bound to those candidates, the others as the version binds them. Nothing is "
        "stored. A binding the toolchain evaluated answers 200, `valid` false when it reports a hard "
        "violation; one it could not evaluate is 422 `evaluation_invalid`."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **_UNREADABLE,
        **_EMPTY,
        422: {
            "description": (
                f"The binding could not be evaluated (`evaluation_invalid`; a finding about a rebound task points "
                f"at `/binding/<task>`), or {_NOT_LINKED}."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def evaluate_composition(
    org: str,
    composition: str,
    payload: CompositionEvaluate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> EvaluateResult:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    evaluated = await evaluate.evaluate_binding(
        session, organization, found, version_ref=payload.version, binding=payload.binding, caller=user,
    )
    return EvaluateResult(
        version=VersionName(**_name(evaluated.version)),
        valid=evaluated.valid,
        values=_values(dict(evaluated.values)),
        violations=evaluated.violations,
        diagnostics=[diagnostic_view(item) for item in evaluated.diagnostics],
    )


@router.get(
    "/{composition}/neighborhood",
    response_model=CompositionNeighborhoodResponse,
    operation_id="getCompositionNeighborhood",
    summary="Evaluate the one-task alternatives of a version's binding",
    description=(
        "The toolchain's canonical one-task counterfactuals of a version's binding (the latest version by "
        "default), on the installed toolchain's compilation of the problem it links: at most `limit` "
        "alternatives, within a cooperative two-second budget. Each move also names its candidate as a "
        "document does. Nothing is stored."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **_UNREADABLE,
        **_EMPTY,
        422: {
            "description": (
                f"The toolchain cannot analyse the binding or the task (`analysis_invalid`), {_NOT_LINKED}, or the "
                "installed toolchain reads the problem differently (`c2y_compilation_semantics_changed`)."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def get_composition_neighborhood(
    org: str,
    composition: str,
    version: str | None = Query(default=None, max_length=64, description="The version: id, label or ordinal; the latest by default."),
    task: str | None = Query(default=None, max_length=256, description="Only the alternatives of this task."),
    limit: int = Query(default=32, ge=1, le=128, description="At most this many alternatives are evaluated."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict[str, Any]:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    row, result = await evaluate.neighbourhood(
        session, organization, found, version_ref=version, task=task, limit=limit,
    )
    return {**result, "version": _name(row)}


# -- Derivation ------------------------------------------------------------------------------------------


def _derivation_view(row: CompositionDerivation) -> DerivationView:
    return DerivationView(
        id=row.id, source=row.source.value, revision_id=row.revision_id, compilation_id=row.compilation_id,
        job_id=row.job_id, point=row.point, binding=row.binding, binding_digest=row.binding_digest,
        provenance=row.provenance, created_by_id=row.created_by_id, created_at=row.created_at,
    )


@router.post(
    "/{composition}/derive",
    status_code=status.HTTP_201_CREATED,
    response_model=DeriveResult,
    operation_id="deriveComposition",
    summary="Derive a version from a binding of a problem",
    description=(
        "Write the Composition2Yaml document of a binding the problem already has (a run's solution at "
        "`point`, or `binding` given with `revision`), evaluated by the toolchain on the installed "
        "compilation, and seal it as a new version with an edge naming what it was derived from. The "
        "document links the compilation the run solved (the installed one for a binding), states the "
        "toolchain's values and writes no offering unless one is given. The same binding derived again gives "
        "the same bytes: 200 with the version that holds them. With `seal: false` nothing is stored and the "
        "document is answered instead."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {
            "model": Union[DeriveResult, DeriveDraft],
            "description": (
                "The bytes were already sealed: the version that holds them (its derivation edge added when it "
                "had none). Or, with `seal: false`, the document a seal would store (`DeriveDraft`)."
            ),
        },
        201: {"headers": {"Location": {"description": "The new version.", "schema": {"type": "string"}}, **_VERSION_ETAG}},
        404: {
            **NOT_FOUND_RESPONSE,
            "description": "No such organization, composition, run or problem revision, or the caller cannot read it.",
        },
        409: {**CONFLICT_RESPONSE, "description": "Another content holds this `version` (`version_label_taken`)."},
        422: {
            "description": (
                "The binding cannot be derived (`derivation_invalid`): `diagnostics` lists the `c2y_*` findings, "
                "those about the request at `/point`, `/binding/<task>` or `/offering/...`, the others in the "
                "derived document."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def derive_composition(
    org: str,
    composition: str,
    payload: CompositionDerive,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Any:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    derived = await derive.derive_version(
        session, organization, found,
        caller=user, label=payload.version, kind=payload.kind, offering=payload.offering,
        run=payload.run, point=payload.point or 0, revision=payload.revision, binding=payload.binding,
    )
    diagnostics = [diagnostic_view(item) for item in derived.diagnostics]
    if not payload.seal:
        draft = DeriveDraft(
            content=derived.content,
            document=text_document(derived.document),
            values=values_json(derived.document.values),
            diagnostics=diagnostics,
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content=draft.model_dump(mode="json"))
    sealed = await seal.persist(session, found, derived.assessment, actor=user, derivation=derived.derivation)
    assert sealed.derivation is not None
    (detail,) = await versions.details(session, [sealed.version])
    response.status_code = status.HTTP_201_CREATED if sealed.created else status.HTTP_200_OK
    response.headers["ETag"] = _content_tag(sealed.version)
    if sealed.created:
        response.headers["Location"] = (
            f"/v1/organizations/{organization.slug}/compositions/{found.slug}/versions/{sealed.version.id}"
        )
    return DeriveResult(
        version=_version_view(detail),
        evaluation=_evaluation_view(sealed.evaluation, detail.current, detail),
        derivation=_derivation_view(sealed.derivation),
        diagnostics=diagnostics,
    )
