"""Proposals (F6, plan §8): an organization's typed steps that change nothing until their author confirms them.

Adapted from SPHERE (MIT, SCORELabUS/SPHERE at ``73779a8a``): ``api/src/main/services/orbit/OrbitPlanService.ts``
(``propose``, ``build``) and ``api/src/main/repositories/mongoose/OrbitPlanRepository.ts`` (``supersedePending``,
``cancel``). A proposal follows ORBIT's plan model: it is built **in code** from a validated request, stored with each step's base revisions, shown, and applied only after its
author confirms (``proposal_executor``). Whatever makes the request (a person's form today, F7's tools tomorrow) never
writes; it only proposes.

**Building** (:func:`create`): every step names a registered kind (``domain.proposals.REGISTRY``) and parameters its
kind validates. A parameter the kind declares referenceable may hold ``@s<n>.<output>``, an output an earlier step
declares; the step then depends on step ``n`` and stores the parts known now, listing the rest under ``deferred``.
Each kind computes its base: ``seal_derived`` derives the document (storing nothing) and keeps its exact canonical
bytes as the step's ``preview`` and their digest as ``base.contentDigest``, beside the head version; ``adopt`` keeps
the environment's ETag and the version in effect. A destructive step goes alone, behind a typed phrase. Refusals are
``422 proposal_invalid`` with ``errors: [{step, code, message}]``.

**Storing**: one short transaction after the build. The composition is share-locked first (the order every delete
path takes: a composition, then its proposals), the author's pending proposal in the same scope becomes
``superseded`` by the new one, and the one-pending unique index makes two pending ones impossible: a create that loses
the race supersedes the winner on its one retry, or answers 409. Nothing an environment's feed serves changes.

**Reading**: members read every proposal of their organization; a seal step's preview is served with its diff against
the version in effect in the proposal's ``adopt`` environment, or the head version, computed on read by the function
behind ``POST /v1/compositions/diff``. **Cancelling** is the author's: ``pending`` -> ``cancelled``.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....collaboration import ROLE_STRENGTH
from ....composition import ids
from ....core import revision as etags
from ....db.models import (
    BindingCase,
    BindingCaseRevision,
    Composition,
    CompositionEnvironment,
    CompositionUpstreamEvent,
    CompositionVersion,
    Organization,
    OrganizationRole,
    Proposal,
    ProposalStep,
    User,
)
from ....models.errors import api_error
from ...execution.application import run_solutions
from ...shared.application import audit
from ..domain import proposals as domain
from ..domain.proposals import Reference
from . import adoption, derive, language
from .environments import environment_by_ref, forbidden
from .versions import version_by_ref

#: The audit target type of a proposal.
TARGET = "Proposal"
#: The most "Review before confirming" lines a proposal keeps.
WARNING_LIMIT = 8


# -- Errors ----------------------------------------------------------------------------------------------------------


class ProposalInvalid(Exception):
    """A request that cannot become a proposal: ``errors`` ``[{step, code, message, detail?}]`` (step ``None`` for the
    whole proposal)."""

    def __init__(self, errors: list[dict[str, Any]]):
        super().__init__("; ".join(f"{item.get('step')}: {item['code']}" for item in errors))
        self.errors = errors

    @classmethod
    def one(cls, step: int | None, code: str, message: str, detail: dict[str, Any] | None = None) -> "ProposalInvalid":
        error: dict[str, Any] = {"step": step, "code": code, "message": message}
        if detail:
            error["detail"] = detail
        return cls([error])

    def http(self) -> HTTPException:
        return api_error(
            422, "proposal_invalid",
            "The proposal cannot be made; `errors` says why, step by step.", errors=self.errors,
        )


def unreadable() -> HTTPException:
    """The one 404 of a proposal a caller may not read, a missing one and another organization's alike."""
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Proposal not found.")


def not_yours() -> HTTPException:
    return api_error(status.HTTP_403_FORBIDDEN, "proposal_not_yours", "Only the member who made this proposal may "
                     "confirm or cancel it.")


def not_pending(row: Proposal) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "proposal_not_pending",
                     f"This proposal is {row.status} and cannot be confirmed or cancelled.", current=row.status)


# -- The context a kind works in -------------------------------------------------------------------------------------


@dataclass
class Context:
    """What a step kind works with: the session, the organization, the proposal's composition, and the caller (who
    builds it, or who confirms it) with their role there. ``derived`` keeps, per ordinal, what the pre-flight derived,
    so a confirmed seal step is derived once."""

    session: AsyncSession
    organization: Organization
    composition: Composition | None
    caller: User
    role: OrganizationRole
    proposal: Proposal | None = None
    api_key: Any = None
    derived: dict[int, Any] = field(default_factory=dict)
    #: While building: the labels earlier seal steps claim, and the version an earlier step is known to give (the
    #: sealed version that already holds its document), by ordinal.
    labels: dict[int, str] = field(default_factory=dict)
    known_versions: dict[int, uuid.UUID] = field(default_factory=dict)


@dataclass(frozen=True)
class Built:
    """What a kind's builder stores for one step."""

    params: dict[str, Any]
    base: dict[str, Any]
    description: str
    preview: str | None = None
    warnings: tuple[str, ...] = ()
    phrase: str | None = None


def _need_composition(context: Context, ordinal: int) -> Composition:
    if context.composition is None:
        raise ProposalInvalid.one(ordinal, "unknown_kind", "This step needs a composition.")
    return context.composition


async def head_version(session: AsyncSession, composition: Composition) -> CompositionVersion | None:
    """The composition's latest version (highest ordinal)."""
    return await session.scalar(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition.id)
        .order_by(CompositionVersion.ordinal.desc()).limit(1)
    )


_RELEASE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


async def next_label(session: AsyncSession, composition: Composition, claimed: set[str] | None = None) -> str:
    """The next minor of the composition's highest release (``1.1.0`` -> ``1.2.0``), ``1.0.0`` for none; a label no
    version holds and no earlier step of the proposal claims (``claimed``)."""
    labels = set((await session.scalars(
        select(CompositionVersion.label).where(CompositionVersion.composition_id == composition.id)
    )).all()) | set(claimed or ())
    releases = [tuple(int(part) for part in found.groups()) for found in map(_RELEASE.match, labels) if found]
    major, minor, _ = max(releases) if releases else (1, -1, 0)
    candidate = f"{major}.{minor + 1}.0"
    while candidate in labels:
        minor += 1
        candidate = f"{major}.{minor + 1}.0"
    return candidate


def _message(error: HTTPException) -> tuple[str, dict[str, Any]]:
    detail = error.detail if isinstance(error.detail, dict) else {"error": str(error.detail)}
    extra = {key: value for key, value in detail.items() if key not in ("code", "error")}
    return str(detail.get("error") or detail.get("code") or "refused"), {"status": error.status_code,
                                                                          "code": detail.get("code"), **extra}


def transient(error: HTTPException) -> bool:
    """A refusal that says nothing about the request: a busy slot or spent budget (429), or a dependency that does not
    answer (5xx). It is passed on as it is (the caller may retry), never read as a refusal of a step or a stale base."""
    return error.status_code == status.HTTP_429_TOO_MANY_REQUESTS or error.status_code >= 500


def _stale(reason: str, base: Any = None, current: Any = None) -> dict[str, Any]:
    return {"reason": reason, "base": base, "current": current}


def output_of(outputs: dict[int, dict[str, Any]], reference: Reference) -> Any:
    """The value an earlier step's result gives for ``reference`` (``None`` when it gives none)."""
    return (outputs.get(reference.step) or {}).get(reference.output)


def changed(message: str, **extra: Any) -> HTTPException:
    """A deferred part that no longer holds at apply time: the step fails, nothing of it is applied."""
    return api_error(status.HTTP_409_CONFLICT, "derivation_changed", message, **extra)


# -- seal_derived ----------------------------------------------------------------------------------------------------


class RunSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run: uuid.UUID
    point: int = Field(default=0, ge=0, le=100000)


class RevisionSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: ``<problem>@<revision>``, or ``@s<n>.revision`` (an earlier step's revision).
    revision: str = Field(min_length=3, max_length=200)
    binding: dict[str, str] = Field(max_length=1024)


class SealDerivedParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Union[RunSource, RevisionSource]
    label: Optional[str] = Field(default=None, min_length=5, max_length=ids.MAX_SEMVER_CHARS,
                                 pattern=ids.SEMVER.pattern)
    offering: Optional[dict[str, Any]] = None
    kind: Optional[Literal["application", "workflow", "pipeline", "system"]] = None


async def _revision_name(session: AsyncSession, revision_id: uuid.UUID) -> str:
    revision = await session.get(BindingCaseRevision, revision_id)
    problem = None if revision is None else await session.get(BindingCase, revision.binding_case_id)
    return f"{problem.slug}@{revision.revision}" if revision is not None and problem is not None else str(revision_id)


class SealDerivedKind:
    """Derive a version from a run's solution or a binding of a revision, and seal it (the derive route's sequence,
    ``derive.derive_and_seal``). Base: the head version and the digest of the document the person saw (stored as the
    preview); a referenced revision defers the digest and the revision to apply time."""

    name = "seal_derived"
    params_model = SealDerivedParams
    referenceable = frozenset({"source.revision"})
    outputs = frozenset({"version"})
    destructive = False
    key_permission = "compositions:write"
    role = OrganizationRole.MEMBER

    async def build(self, context: Context, params: dict[str, Any], referenced: dict[str, Reference],
                    ordinal: int) -> Built:
        composition = _need_composition(context, ordinal)
        session = context.session
        parsed = SealDerivedParams.model_validate(params)
        claimed = set(context.labels.values())
        if parsed.label is not None and parsed.label in claimed:
            raise ProposalInvalid.one(ordinal, "derivation_invalid",
                                      f"An earlier step of this proposal already seals {parsed.label}.")
        label = parsed.label or await next_label(session, composition, claimed)
        context.labels[ordinal] = label
        head = await head_version(session, composition)
        stored = {**parsed.model_dump(mode="json", exclude_none=True), "label": label}
        source = parsed.source
        reference = referenced.get("source.revision")
        if reference is not None:
            assert isinstance(source, RevisionSource)
            return Built(
                params=stored,
                base={"headVersionId": None if head is None else str(head.id), "binding": dict(source.binding),
                      "dependsOn": [reference.step], "deferred": ["revisionId", "contentDigest"]},
                description=f"Seal {label} from the revision step {reference.step} makes",
            )
        taken = await session.scalar(select(CompositionVersion).where(
            CompositionVersion.composition_id == composition.id, CompositionVersion.label == label))
        try:
            derived = await derive.derive_version(
                session, context.organization, composition, caller=context.caller, label=label, kind=parsed.kind,
                offering=parsed.offering,
                run=source.run if isinstance(source, RunSource) else None,
                point=source.point if isinstance(source, RunSource) else 0,
                revision=source.revision if isinstance(source, RevisionSource) else None,
                binding=source.binding if isinstance(source, RevisionSource) else None,
            )
        except HTTPException as error:
            if transient(error):
                raise
            message, detail = _message(error)
            raise ProposalInvalid.one(ordinal, "derivation_invalid", message, detail) from None
        digest = derived.assessment.content_digest
        if taken is not None and taken.content_digest != digest:
            raise ProposalInvalid.one(
                ordinal, "derivation_invalid",
                f"Version {label} of this composition holds another content; give this one another label.",
            )
        named = await _revision_name(session, derived.derivation.revision_id)
        base: dict[str, Any] = {
            "headVersionId": None if head is None else str(head.id), "contentDigest": digest,
            "revisionId": str(derived.derivation.revision_id),
        }
        if isinstance(source, RunSource):
            base["runId"] = str(source.run)
            description = f"Seal {label} from solution {source.point} of run {str(source.run)[:8]} ({named})"
        else:
            description = f"Seal {label} from {named}"
        warnings = tuple(item.message for item in derived.diagnostics if item.severity == "warning")
        if taken is not None:
            warnings = (f"Version {label} already holds this document: confirming seals nothing new.", *warnings)
            context.known_versions[ordinal] = taken.id
        return Built(params=stored, base=base, description=description, preview=derived.content, warnings=warnings)

    def _source(self, step: Any, outputs: dict[int, dict[str, Any]] | None = None) -> dict[str, Any]:
        """The derivation's arguments from the stored parameters; a referenced revision read from ``outputs``."""
        parsed = SealDerivedParams.model_validate(step.params)
        source = parsed.source
        arguments: dict[str, Any] = {"label": parsed.label, "kind": parsed.kind, "offering": parsed.offering}
        if isinstance(source, RunSource):
            arguments.update(run=source.run, point=source.point)
        else:
            revision = source.revision
            reference = domain.parse_reference(revision)
            if reference is not None:
                value = output_of(outputs or {}, reference)
                revision = value if isinstance(value, str) else None
            arguments.update(revision=revision, binding=dict(source.binding))
        return arguments

    async def check_base(self, context: Context, step: Any) -> list[dict[str, Any]]:
        composition = context.composition
        if composition is None:
            return [_stale("composition_archived")]
        if composition.archived:
            return [_stale("composition_archived")]
        found: list[dict[str, Any]] = []
        head = await head_version(context.session, composition)
        current = None if head is None else str(head.id)
        if current != step.base.get("headVersionId"):
            found.append(_stale("head_version_changed", step.base.get("headVersionId"), current))
        arguments = self._source(step)
        if arguments.get("run") is not None:
            run = await run_solutions(context.session, context.organization.id, arguments["run"], context.caller)
            if run is None or not run.completed:
                found.append(_stale("run_unreadable", str(arguments["run"]), None if run is None else run.state.value))
        if "contentDigest" in (step.base.get("deferred") or []) or found:
            return found
        try:
            derived = await derive.derive_version(
                context.session, context.organization, composition, caller=context.caller, **arguments)
        except HTTPException as error:
            if transient(error):
                # A busy slot or an unreachable toolchain: the proposal stays pending, the caller retries.
                raise
            message, detail = _message(error)
            return [_stale("derivation_changed", step.base.get("contentDigest"), detail.get("code") or message)]
        digest = derived.assessment.content_digest
        if digest != step.base.get("contentDigest"):
            return [_stale("derivation_changed", step.base.get("contentDigest"), digest)]
        context.derived[step.ordinal] = derived
        return []

    async def check_permission(self, context: Context, step: Any) -> None:
        if ROLE_STRENGTH[context.role] < ROLE_STRENGTH[self.role]:
            raise forbidden(self.role)
        source = (step.params or {}).get("source") or {}
        if context.api_key is not None and source.get("run"):
            # A key sees only the runs of the engines it may use. A run this key cannot see is refused here, with the
            # proposal left pending, rather than read by the pre-flight as a run that is gone (stale).
            try:
                run_id = uuid.UUID(str(source["run"]))
            except ValueError:
                return
            if await run_solutions(context.session, context.organization.id, run_id, context.caller) is None:
                raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Run not found.")

    async def check_deferred(self, context: Context, step: Any, outputs: dict[int, dict[str, Any]]) -> None:
        reference = domain.parse_reference((step.params.get("source") or {}).get("revision"))
        if reference is None:
            return
        if not isinstance(output_of(outputs, reference), str):
            raise changed(f"Step {reference.step} gave no revision to derive from.")

    async def apply(self, context: Context, step: Any, outputs: dict[int, dict[str, Any]]) -> dict[str, Any]:
        assert context.composition is not None
        arguments = self._source(step, outputs)
        deferred = "contentDigest" in (step.base.get("deferred") or [])
        try:
            stored = await derive.derive_and_seal(
                context.session, context.organization, context.composition, caller=context.caller,
                expect_digest=None if deferred else step.base.get("contentDigest"),
                derived=None if deferred else context.derived.get(step.ordinal), **arguments,
            )
        except HTTPException as error:
            if deferred and error.status_code in (404, 422):
                message, detail = _message(error)
                raise changed(f"The revision step {domain.parse_reference(step.params['source']['revision']).step}"
                              f" made cannot be derived: {message}", cause=detail) from None
            raise
        version = stored.sealed.version
        return {"version": {"id": str(version.id), "label": version.label}, "created": stored.sealed.created}


# -- adopt -----------------------------------------------------------------------------------------------------------


class AdoptParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: The environment, by id (a slug is accepted and stored as the id).
    environment: str = Field(min_length=1, max_length=64)
    #: The version, by id, label or ordinal (stored as the id), or ``@s<n>.version``.
    version: str = Field(min_length=1, max_length=64)
    note: str = Field(default="", max_length=500)


class AdoptKind:
    """Adopt a version in an environment through ``adoption.adopt()``, the one adopt path, with the environment's ETag
    as ``If-Match``. Base: that ETag and the version in effect."""

    name = "adopt"
    params_model = AdoptParams
    referenceable = frozenset({"version"})
    outputs: frozenset[str] = frozenset()
    destructive = False
    key_permission = "compositions:adopt"

    async def build(self, context: Context, params: dict[str, Any], referenced: dict[str, Reference],
                    ordinal: int) -> Built:
        composition = _need_composition(context, ordinal)
        session = context.session
        parsed = AdoptParams.model_validate(params)
        environment = await environment_by_ref(session, composition, parsed.environment)
        if environment is None:
            raise ProposalInvalid.one(ordinal, "environment_not_found", "This composition has no such environment.")
        if ROLE_STRENGTH[context.role] < ROLE_STRENGTH[OrganizationRole(environment.adopt_role)]:
            raise ProposalInvalid.one(
                ordinal, "not_permitted",
                f"Adopting in {environment.name} requires {environment.adopt_role} access to the organization.",
            )
        base: dict[str, Any] = {
            "environmentEtag": etags.etag_for(environment),
            "inEffect": None if environment.adopted_version_id is None else str(environment.adopted_version_id),
        }
        reference = referenced.get("version")
        if reference is not None and context.known_versions.get(reference.step) == environment.adopted_version_id \
                and environment.adopted_version_id is not None:
            raise ProposalInvalid.one(ordinal, "already_in_effect",
                                      f"The version step {reference.step} seals is already in effect in "
                                      f"{environment.name}.")
        if reference is not None:
            return Built(
                params={"environment": str(environment.id), "version": str(reference), "note": parsed.note},
                base={**base, "dependsOn": [reference.step], "deferred": ["version"]},
                description=f"Adopt the version step {reference.step} seals in {environment.name}",
            )
        version = await version_by_ref(session, composition, parsed.version)
        if version is None:
            raise ProposalInvalid.one(ordinal, "version_not_found", "This composition has no such version.")
        if version.id == environment.adopted_version_id:
            raise ProposalInvalid.one(ordinal, "already_in_effect",
                                      f"Version {version.label} is already in effect in {environment.name}.")
        return Built(
            params={"environment": str(environment.id), "version": str(version.id), "note": parsed.note},
            base=base, description=f"Adopt {version.label} in {environment.name}",
        )

    async def _environment(self, context: Context, step: Any) -> CompositionEnvironment | None:
        try:
            environment_id = uuid.UUID(str(step.params.get("environment")))
        except ValueError:
            return None
        found = await context.session.scalar(
            select(CompositionEnvironment).where(CompositionEnvironment.id == environment_id)
            .execution_options(populate_existing=True)
        )
        if found is None or context.composition is None or found.composition_id != context.composition.id:
            return None
        return found

    async def check_base(self, context: Context, step: Any) -> list[dict[str, Any]]:
        composition = context.composition
        if composition is None or composition.archived:
            return [_stale("composition_archived")]
        environment = await self._environment(context, step)
        if environment is None:
            return [_stale("environment_missing", step.params.get("environment"))]
        found: list[dict[str, Any]] = []
        current = etags.etag_for(environment)
        if current != step.base.get("environmentEtag"):
            found.append(_stale("environment_changed", step.base.get("environmentEtag"), current))
        version = step.params.get("version")
        if domain.parse_reference(version) is None:
            exists = await context.session.scalar(select(CompositionVersion.id).where(
                CompositionVersion.composition_id == composition.id, CompositionVersion.id == uuid.UUID(str(version))))
            if exists is None:
                found.append(_stale("version_missing", version))
        return found

    async def check_permission(self, context: Context, step: Any) -> None:
        environment = await self._environment(context, step)
        if environment is not None and ROLE_STRENGTH[context.role] < ROLE_STRENGTH[
                OrganizationRole(environment.adopt_role)]:
            raise forbidden(environment.adopt_role)

    def _version(self, step: Any, outputs: dict[int, dict[str, Any]]) -> str | None:
        version = step.params.get("version")
        reference = domain.parse_reference(version)
        if reference is None:
            return str(version)
        value = output_of(outputs, reference)
        return str(value.get("id")) if isinstance(value, dict) and value.get("id") else None

    async def check_deferred(self, context: Context, step: Any, outputs: dict[int, dict[str, Any]]) -> None:
        reference = domain.parse_reference(step.params.get("version"))
        if reference is None:
            return
        version = self._version(step, outputs)
        assert context.composition is not None
        exists = None if version is None else await context.session.scalar(select(CompositionVersion.id).where(
            CompositionVersion.composition_id == context.composition.id, CompositionVersion.id == uuid.UUID(version)))
        if exists is None:
            raise changed(f"Step {reference.step} gave no version of this composition to adopt.")

    async def apply(self, context: Context, step: Any, outputs: dict[int, dict[str, Any]]) -> dict[str, Any]:
        assert context.composition is not None and context.proposal is not None
        environment = await self._environment(context, step)
        if environment is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Environment not found.")
        adopted = await adoption.adopt(
            context.session, organization=context.organization, composition=context.composition,
            environment=environment, role=context.role, version_ref=self._version(step, outputs) or "",
            actor=context.caller, if_match=step.base.get("environmentEtag"), note=step.params.get("note") or "",
            source="proposal", proposal_id=context.proposal.id,
        )
        version = await context.session.get(CompositionVersion, adopted.adoption.version_id)
        return {
            "ordinal": adopted.adoption.ordinal, "environment": adopted.environment.slug,
            "feedEtag": f'"{adopted.adoption.content_digest}"', "versionLabel": None if version is None else version.label,
        }


SEAL_DERIVED = domain.register(SealDerivedKind())
ADOPT = domain.register(AdoptKind())


# -- Requests --------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StepRequest:
    """One step as a builder asks for it: a kind and its parameters (validated by the kind)."""

    kind: str
    params: dict[str, Any]


def web_steps(request: Any) -> list[StepRequest]:
    """The steps of a web request: ``adopt`` is one step; ``derive_and_adopt`` is ``seal_derived`` (s1) and an
    ``adopt`` of ``@s1.version`` that depends on it."""
    if request.kind == "adopt":
        return [StepRequest("adopt", {"environment": request.environment, "version": request.version,
                                      "note": request.note})]
    source = request.source.model_dump(mode="json", exclude_none=True)
    seal: dict[str, Any] = {"source": source}
    for name in ("label", "offering"):
        if getattr(request, name, None) is not None:
            seal[name] = getattr(request, name)
    return [
        StepRequest("seal_derived", seal),
        StepRequest("adopt", {"environment": request.environment, "version": "@s1.version", "note": request.note}),
    ]


@dataclass
class _Planned:
    ordinal: int
    kind: Any
    params: dict[str, Any]
    referenced: dict[str, Reference]
    depends_on: list[int]


def _validate(steps: list[StepRequest]) -> list[_Planned]:
    """Kinds, parameters, references and the destructive rule; every refusal at once."""
    errors: list[dict[str, Any]] = []
    if not steps:
        raise ProposalInvalid.one(None, "too_many_steps", "A proposal has at least one step.")
    if len(steps) > domain.STEP_LIMIT:
        raise ProposalInvalid.one(None, "too_many_steps", f"A proposal has at most {domain.STEP_LIMIT} steps.")
    planned: list[_Planned] = []
    for ordinal, request in enumerate(steps, start=1):
        kind = domain.REGISTRY.get(request.kind)
        if kind is None:
            errors.append({"step": ordinal, "code": "unknown_kind", "message": f"No step kind {request.kind!r}."})
            continue
        referenced: dict[str, Reference] = {}
        for path, value in domain.references_in(request.params):
            reference = domain.parse_reference(value)
            if path not in kind.referenceable:
                # Free text that merely starts with "@s" (a note) is text; a well-formed reference is refused.
                problem = None if reference is None else f"`{path}` does not take an earlier step's output."
                if problem is not None:
                    errors.append({"step": ordinal, "code": "dependency_invalid", "message": problem})
                continue
            if reference is None:
                problem = f"{value!r} is not a reference: `@s<n>.<output>`."
            elif reference.step >= ordinal:
                problem = f"{reference} names a step that does not come before this one."
            else:
                earlier = domain.REGISTRY.get(steps[reference.step - 1].kind)
                problem = (None if earlier is not None and reference.output in earlier.outputs
                           else f"Step {reference.step} has no output {reference.output!r}.")
            if problem is not None:
                errors.append({"step": ordinal, "code": "dependency_invalid", "message": problem})
            else:
                assert reference is not None
                referenced[path] = reference
        try:
            kind.params_model.model_validate(request.params)
        except ValidationError as error:
            errors.append({"step": ordinal, "code": "params_invalid",
                           "message": "; ".join(f"{'.'.join(map(str, item['loc']))}: {item['msg']}"
                                                for item in error.errors(include_url=False))})
            continue
        planned.append(_Planned(ordinal, kind, dict(request.params), referenced,
                                sorted({item.step for item in referenced.values()})))
    if any(item.kind.destructive for item in planned) and len(steps) > 1:
        errors.append({"step": next(item.ordinal for item in planned if item.kind.destructive),
                       "code": "destructive_not_alone",
                       "message": "A step that deletes or replaces something goes alone in its proposal."})
    if errors:
        raise ProposalInvalid(errors)
    return planned


def summary_of(descriptions: list[str]) -> str:
    text = descriptions[0] if len(descriptions) == 1 else "; then ".join(descriptions)
    return text if len(text) <= 500 else text[:497] + "..."


async def create(
    session: AsyncSession,
    organization: Organization,
    caller: User,
    steps: list[StepRequest],
    *,
    role: OrganizationRole,
    composition: Composition | None = None,
    origin: domain.Origin = "web",
    scope_key: str | None = None,
    upstream_event: uuid.UUID | None = None,
) -> Proposal:
    """Build, validate and store a proposal of ``caller``'s, superseding their pending one in the same scope;
    committed. Refusals are :class:`ProposalInvalid` (422 ``proposal_invalid``)."""
    if scope_key is None:
        if composition is None:
            raise ValueError("a proposal without a composition names its scope")
        scope_key = f"composition:{composition.id}"
    if composition is not None and composition.archived:
        raise api_error(status.HTTP_409_CONFLICT, "composition_archived",
                        "An archived composition changes nothing; restore it first.")
    planned = _validate(steps)
    if upstream_event is not None:
        found = None if composition is None else await session.scalar(select(CompositionUpstreamEvent.id).where(
            CompositionUpstreamEvent.id == upstream_event, CompositionUpstreamEvent.composition_id == composition.id))
        if found is None:
            raise ProposalInvalid.one(None, "event_not_found", "This composition has no such upstream event.")
    context = Context(session, organization, composition, caller, role)
    built: list[tuple[_Planned, Built]] = []
    for item in planned:
        built.append((item, await item.kind.build(context, item.params, item.referenced, item.ordinal)))
    warnings: list[str] = []
    for _, made in built:
        warnings.extend(line for line in made.warnings if line not in warnings)
    phrase = next((made.phrase for _, made in built if made.phrase), None)
    return await _store(
        session, organization, composition, caller, built, origin=origin, scope_key=scope_key,
        summary=summary_of([made.description for _, made in built]), warnings=warnings[:WARNING_LIMIT],
        phrase=phrase, upstream_event=upstream_event,
    )


def _lost_pending_race(error: IntegrityError) -> bool:
    text = str(error.orig)
    return "uq_proposals_one_pending" in text or "proposals.proposed_by_id, proposals.scope_key" in text


async def _store(
    session: AsyncSession, organization: Organization, composition: Composition | None, caller: User,
    built: list[tuple[_Planned, Built]], *, origin: str, scope_key: str, summary: str, warnings: list[str],
    phrase: str | None, upstream_event: uuid.UUID | None,
) -> Proposal:
    for attempt in (1, 2):
        # The build (a derivation, its reads) ends here; nothing it holds is kept across the write.
        await session.commit()
        if composition is not None:
            # As every delete path takes them: the composition, then its proposals.
            locked = await session.scalar(
                select(Composition.id).where(Composition.id == composition.id)
                .with_for_update(read=True, key_share=True)
            )
            if locked is None:
                raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")
        new_id = uuid.uuid4()
        superseded = list((await session.execute(
            update(Proposal).where(
                Proposal.proposed_by_id == caller.id, Proposal.scope_key == scope_key, Proposal.status == "pending",
            ).values(status="superseded", superseded_by_id=new_id)
            .returning(Proposal.id, Proposal.organization_id).execution_options(synchronize_session=False)
        )).all())
        row = Proposal(
            id=new_id, organization_id=organization.id, composition_id=None if composition is None else composition.id,
            origin=origin, scope_key=scope_key, proposed_by_id=caller.id, summary=summary, warnings=warnings,
            confirmation_phrase=phrase, upstream_event_id=upstream_event, status="pending",
        )
        session.add(row)
        for item, made in built:
            session.add(ProposalStep(
                proposal_id=new_id, ordinal=item.ordinal, kind=item.kind.name, description=made.description[:300],
                params=made.params, base=made.base, preview=made.preview, depends_on=item.depends_on,
                destructive=item.kind.destructive, status="pending",
            ))
        try:
            await session.flush()
        except IntegrityError as error:
            await session.rollback()
            # A rollback expires every row the session holds: read them again before the retry (or the caller's reply).
            for held in (organization, composition, caller):
                if held is not None:
                    await session.refresh(held)
            if _lost_pending_race(error) and attempt == 1:
                continue
            if _lost_pending_race(error):
                raise api_error(status.HTTP_409_CONFLICT, "proposal_conflict",
                                "Another proposal of yours was made at the same time; try again.") from error
            raise
        for old_id, old_organization in superseded:
            audit(session, caller, "composition.proposal_superseded", TARGET, old_id, old_organization,
                  by=str(new_id))
        audit(session, caller, "composition.proposal_created", TARGET, new_id, organization.id,
              steps=[item.kind.name for item, _ in built], origin=origin,
              composition=None if composition is None else composition.slug)
        await session.commit()
        await session.refresh(row)
        return row
    raise AssertionError("unreachable")


# -- Reading ---------------------------------------------------------------------------------------------------------


async def by_id(session: AsyncSession, organization: Organization, proposal_id: str | uuid.UUID) -> Proposal | None:
    """The organization's proposal ``proposal_id``, or ``None`` (a malformed id, another organization's)."""
    try:
        parsed = proposal_id if isinstance(proposal_id, uuid.UUID) else uuid.UUID(str(proposal_id))
    except ValueError:
        return None
    return await session.scalar(select(Proposal).where(Proposal.id == parsed,
                                                       Proposal.organization_id == organization.id))


async def steps_of(session: AsyncSession, proposal: Proposal) -> list[ProposalStep]:
    return list((await session.scalars(
        select(ProposalStep).where(ProposalStep.proposal_id == proposal.id).order_by(ProposalStep.ordinal)
    )).all())


async def list_for(
    session: AsyncSession, organization: Organization, *, composition: Composition | None = None,
    status_: str | None = None, author: User | None = None, limit: int = 20,
    organization_ids: list[uuid.UUID] | None = None,
) -> list[Proposal]:
    """Proposals, newest first: an organization's (or one composition's), or ``author``'s across
    ``organization_ids``."""
    query = select(Proposal)
    if organization_ids is not None:
        query = query.where(Proposal.organization_id.in_(organization_ids))
    else:
        query = query.where(Proposal.organization_id == organization.id)
    if composition is not None:
        query = query.where(Proposal.composition_id == composition.id)
    if status_ is not None:
        query = query.where(Proposal.status == status_)
    if author is not None:
        query = query.where(Proposal.proposed_by_id == author.id)
    return list((await session.scalars(
        query.order_by(Proposal.created_at.desc(), Proposal.id.desc()).limit(limit)
    )).all())


def proposal_etag(row: Proposal) -> str:
    return etags.opaque_etag("proposals", row.id, row.status)


def deferred_of(step: ProposalStep) -> list[str]:
    return [str(name) for name in (step.base or {}).get("deferred") or []]


@dataclass(frozen=True)
class Preview:
    """A seal step's stored document and its diff against the version in effect (in the proposal's ``adopt``
    environment, else the head version)."""

    document: str
    against: CompositionVersion | None
    environment: CompositionEnvironment | None
    diff: dict[str, Any] | None


async def preview_of(session: AsyncSession, proposal: Proposal, step: ProposalStep,
                     steps: list[ProposalStep]) -> Preview | None:
    """The preview of ``step`` (``None`` when it stores none), diffed on read; nothing is stored."""
    if step.preview is None or proposal.composition_id is None:
        return None
    composition = await session.get(Composition, proposal.composition_id)
    if composition is None:
        return None
    environment = None
    adopt = next((other for other in steps if other.kind == "adopt" and step.ordinal in (other.depends_on or [])), None)
    adopt = adopt or next((other for other in steps if other.kind == "adopt"), None)
    if adopt is not None:
        try:
            environment = await session.get(CompositionEnvironment, uuid.UUID(str(adopt.params.get("environment"))))
        except ValueError:
            environment = None
    against = None
    if environment is not None and environment.adopted_version_id is not None:
        against = await session.get(CompositionVersion, environment.adopted_version_id)
    if against is None:
        environment_used = None
        against = await head_version(session, composition)
    else:
        environment_used = environment
    diff = None
    if against is not None:
        try:
            diff = await language.diff(against.content.encode("utf-8"), step.preview.encode("utf-8"))
        except language.LanguageRefusal:
            diff = None
    return Preview(step.preview, against, environment_used, diff)


def key_reaches(api_key: Any, organization: Organization, composition: Composition | None) -> bool:
    """Whether a personal API key's boundary covers a proposal of ``organization`` on ``composition``. A proposal's own
    routes name only the organization and the proposal, so the route-level check cannot see its composition; a key
    bounded by slugs reaches no proposal without one. ``None`` (a browser session) reaches every proposal."""
    from ....security.apikeys import boundary_of

    boundary = boundary_of(api_key) if api_key is not None else None
    if boundary is None:
        return True
    if not boundary:
        return False
    if "organizations" in boundary and not {str(organization.id), organization.slug} & boundary["organizations"]:
        return False
    if "slugs" in boundary:
        return composition is not None and bool({composition.slug, str(composition.id)} & boundary["slugs"])
    return True


# -- Cancelling ------------------------------------------------------------------------------------------------------


async def cancel(session: AsyncSession, proposal: Proposal, caller: User) -> Proposal:
    """``pending`` -> ``cancelled``, by its author only (403 ``proposal_not_yours``; 409 ``proposal_not_pending``);
    committed and audited."""
    if proposal.proposed_by_id != caller.id:
        raise not_yours()
    changed = await session.execute(
        update(Proposal).where(Proposal.id == proposal.id, Proposal.proposed_by_id == caller.id,
                               Proposal.status == "pending")
        .values(status="cancelled").execution_options(synchronize_session=False)
    )
    if changed.rowcount != 1:
        await session.refresh(proposal)
        raise not_pending(proposal)
    audit(session, caller, "composition.proposal_cancelled", TARGET, proposal.id, proposal.organization_id)
    await session.commit()
    await session.refresh(proposal)
    return proposal


async def pending_count(session: AsyncSession, composition: Composition) -> int:
    return int(await session.scalar(select(func.count()).select_from(Proposal).where(
        Proposal.composition_id == composition.id, Proposal.status == "pending")) or 0)


__all__ = [
    "ADOPT",
    "changed",
    "output_of",
    "SEAL_DERIVED",
    "AdoptKind",
    "Built",
    "Context",
    "Preview",
    "ProposalInvalid",
    "SealDerivedKind",
    "StepRequest",
    "by_id",
    "cancel",
    "create",
    "deferred_of",
    "head_version",
    "key_reaches",
    "list_for",
    "next_label",
    "not_pending",
    "not_yours",
    "preview_of",
    "proposal_etag",
    "steps_of",
    "unreadable",
    "web_steps",
]
