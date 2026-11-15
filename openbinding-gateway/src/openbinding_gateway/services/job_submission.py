"""Job submission: validate a run request, reserve its idempotency key and persist the Job.

``createRun`` (``modules.execution.adapters.routes``) and the study cell launch
(``study_jobs.launch_study_cell``) are the two callers. The route authenticates
the caller and reads the request (content type, size limit, JSON) into a
``RunRequest``; a study cell builds one from the cell. ``JobSubmission.submit``
does the rest and answers with a ``JobSubmissionResult`` that the caller turns
into a response or a cell outcome. Nothing here knows about requests or
responses; dispatching the job to a worker stays with the caller too, after the
job is committed.

The idempotency guarantees (G1-G4, docs/IDEMPOTENCY.md) are kept by this flow:
the account row is locked before the key is looked up again and before the
concurrency limit is counted, the job is inserted inside a savepoint, and a lost
INSERT race re-reads the winner and replays it.

A job runs a problem revision. The IR it runs is the revision's compilation by the
installed toolchain (``modules.problems.compile_or_get``): the job references it and
never copies it (D5).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

from bim_core import CanonicalizationError, ContractError
from bim_core.canonical import digest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..db.models import (
    BindingCase,
    BindingCaseRevision,
    EngineRegistrationRevision,
    Job,
    JobState,
    Organization,
    ProblemCompilation,
    User,
)
from ..domain import idempotency
from ..modules.execution.application import STUDY_CELL_KEY_PREFIX as STUDY_CELL_KEY_PREFIX
from ..modules.execution.application import RunRequest
from ..modules.plans.application import entitlement_map as ids
from ..integrations import bim
from ..jobs import limits as job_limits
from ..models.problem import VALIDATION_ERROR, problem_body, split_detail
from ..security.apikeys import allows_engine, authenticated_api_key, boundary_of
from ..security.roles import require_work_role
from .engines import (
    MANIFEST_DIR,
    engine_ref,
    installed_builtin_registration,
    is_installed_builtin_registration,
    mode_execution_contract,
    registration_engine_reference,
    registration_for_engine,
    registration_reference,
    select_engine,
)
from ..domain.binding_space import BindingSpace
from ..modules.problems.application import compile_or_get, package_file_digests
from .entitlements import EntitlementsUnavailable, entitlement_service

_PENDING_LAUNCHES = "pending-job-launches"
_ACCOUNT_REQUIRED = "Submitting a job requires an account."


def pending_launches(session: AsyncSession) -> list[uuid.UUID]:
    """Ids of jobs created without commit or dispatch on this session.

    The owner of the transaction commits, then dispatches them; if it cannot,
    it forgets them with ``discard_pending_launches``.
    """

    return session.info.setdefault(_PENDING_LAUNCHES, [])


def discard_pending_launches(session: AsyncSession, only: set[uuid.UUID] | None = None) -> None:
    """Forget every pending launch (or only these): their jobs were rolled back."""

    pending = pending_launches(session)
    pending[:] = [job_id for job_id in pending if only is not None and job_id not in only]


@dataclass(frozen=True)
class JobSubmissionResult:
    """What a submission came to: a new job, the replay of an earlier one, or a problem.

    ``body`` is the JSON document to answer with; for a problem it is already the
    problem+json document. ``status`` is the HTTP status and ``headers`` the
    extra headers (``Retry-After`` of a refused concurrency limit).
    """

    kind: Literal["created", "replay", "problem"]
    status: int
    body: dict[str, Any]
    headers: dict[str, str] = field(default_factory=dict)


def created(body: dict[str, Any]) -> JobSubmissionResult:
    return JobSubmissionResult("created", 202, body)


def problem(
    status_code: int,
    code: str,
    detail: str,
    diagnostics: list[dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JobSubmissionResult:
    body = problem_body(status_code, code, detail, diagnostics, extra)
    return JobSubmissionResult("problem", status_code, body, dict(headers) if headers else {})


def problem_from_http(exc: HTTPException) -> JobSubmissionResult:
    """The same document the central HTTPException handler would produce (main.py)."""
    default_code = VALIDATION_ERROR if exc.status_code == 422 else "request_invalid"
    code, message, diagnostics, extra = split_detail(exc.detail, default_code)
    return problem(exc.status_code, code, message, diagnostics, extra=extra, headers=exc.headers)


class _Finished(Exception):
    """A stage settled the submission early: the result is the answer."""

    def __init__(self, result: JobSubmissionResult) -> None:
        super().__init__(result.kind)
        self.result = result


# -- Idempotency ------------------------------------------------------------


async def _find_idempotent_job(session: AsyncSession, owner_id: Any, key: str) -> Job | None:
    return (
        await session.execute(select(Job).where(Job.owner_id == owner_id, Job.idempotency_key == key))
    ).scalars().first()


def _replay_body(existing: Job) -> dict[str, Any]:
    provenance = existing.provenance or {}
    return {
        "id": str(existing.id),
        "status": existing.state.value,
        "profile": provenance.get("profile", {}).get("id"),
        "irDigest": provenance.get("irDigest"),
        "idempotent": True,
    }


def _idempotent_outcome(existing: Job, fingerprint: str) -> JobSubmissionResult:
    if existing.idempotency_fingerprint != fingerprint:
        return problem(409, "idempotency_conflict", "Idempotency-Key was already used for a different request")
    return JobSubmissionResult("replay", 202, _replay_body(existing))


async def _raced_idempotent_outcome(
    session: AsyncSession, owner_id: Any, key: str | None, fingerprint: str | None
) -> JobSubmissionResult | None:
    if not key or fingerprint is None:
        return None
    existing = await _find_idempotent_job(session, owner_id, key)
    if existing is None:
        return None
    return _idempotent_outcome(existing, fingerprint)


# -- Stages' products -------------------------------------------------------


async def _key_boundary_allows(session: AsyncSession, caller: User, problem_row: BindingCase) -> bool:
    """Whether the authenticating API key's boundary covers a run of this problem.

    ``createRun`` names the revision in its body, so the route-level boundary check sees the
    organization of the address but not the problem; the run belongs to the problem's organization,
    and a run is in no project, so a key bounded to projects is refused.
    """
    key = authenticated_api_key(caller)
    boundary = boundary_of(key) if key is not None else None
    if boundary is None:
        return True
    if not boundary or "projects" in boundary:
        return False
    if "organizations" in boundary:
        organization = await session.get(Organization, problem_row.organization_id)
        if organization is None or not {str(organization.id), organization.slug} & boundary["organizations"]:
            return False
    return "slugs" not in boundary or problem_row.slug in boundary["slugs"]


@dataclass(frozen=True)
class _Source:
    revision: BindingCaseRevision
    problem: BindingCase
    compilation: ProblemCompilation
    request: RunRequest

    @property
    def ir(self) -> dict[str, Any]:
        return self.compilation.ir

    @property
    def spec(self) -> dict[str, Any]:
        return self.compilation.ir["spec"]


@dataclass(frozen=True)
class _Engine:
    name: str
    namespace: str | None
    selection: Any
    manifest: dict[str, Any]
    mode: dict[str, Any]
    options: dict[str, Any]
    requested_options: Any
    digest: str
    optimization: dict[str, Any]
    reference: dict[str, Any]


@dataclass(frozen=True)
class _PlanTerms:
    caps: Any
    options: dict[str, Any]
    warnings: list[dict[str, Any]]
    timeout: float


@dataclass(frozen=True)
class _Registration:
    document: Any
    reference: Any
    endpoint: str
    protocol_digest: str


async def _resolve_execution_optimization(
    ir: Mapping[str, Any],
    manifest: Mapping[str, Any],
    mode_id: str,
    requested: Any,
) -> dict[str, Any]:
    """Validate and canonicalize the execution-time optimization selection (the toolchain's rules)."""
    try:
        resolved = await bim.abim().resolve_optimization(ir, manifest, requested, mode=mode_id)
    except ContractError as exc:
        raise bim.http_exception_for(exc) from exc
    return resolved["optimization"]


class JobSubmission:
    """One attempt to create a job for ``caller`` on ``session``.

    ``commit`` says whether to commit the job here. Without it the job stays in
    the caller's transaction and its reservation is recorded in
    ``pending_launches``. ``study_cell_id`` is written in the job's own INSERT,
    so the cell and the job cannot be seen apart; losing the race for a cell
    returns the job that won it.
    """

    def __init__(
        self,
        session: AsyncSession | None,
        caller: User | None,
        *,
        commit: bool = True,
        study_cell_id: uuid.UUID | None = None,
    ) -> None:
        self.session = session
        self.caller = caller
        self.commit = commit
        self.study_cell_id = study_cell_id

    async def submit(self, request: RunRequest) -> JobSubmissionResult:
        try:
            return await self._submit(request)
        except _Finished as finished:
            return finished.result

    async def _submit(self, request: RunRequest) -> JobSubmissionResult:
        if self.caller is None or self.session is None:
            return problem(401, "unauthorized", _ACCOUNT_REQUIRED)
        source = await self._resolve_source(request)
        fingerprint = await self._precheck(request, source)
        engine = await self._select_engine(source)
        terms = await self._plan_terms(request, source, engine)
        if engine.selection.diagnostics:
            return problem(
                422,
                "engine_mode_incompatible",
                "selected engine mode cannot execute every construct in this BindingProblem",
                engine.selection.diagnostics,
            )
        limits = dict(engine.mode.get("limits", {}))
        mode_contract = mode_execution_contract(engine.mode)
        registration = await self._registration(source, engine)
        dialects = source.spec["dialects"]
        adapters = [item["adapter"] for item in dialects if isinstance(item, dict) and isinstance(item.get("adapter"), dict)]
        provenance = self._provenance(
            source, engine, terms, registration, limits=limits, mode_contract=mode_contract,
            dialects=dialects, adapters=adapters,
        )
        return await self._persist(
            request, source, engine, terms, registration, provenance,
            mode_contract=mode_contract, fingerprint=fingerprint,
        )

    # -- Stages -------------------------------------------------------------

    async def _resolve_source(self, request: RunRequest) -> _Source:
        """The revision the job runs, its problem and the compilation of the installed toolchain.

        The run belongs to the organization of the request, which must be the problem's: a
        revision of another organization the caller can see is a 409. A VIEWER, who only
        reads, is refused before the key is looked up or anything is written. A miss compiles
        once per revision and toolchain; later runs reuse the row.
        """
        session = self.session
        try:
            revision_id = uuid.UUID(str(request.revision_id))
        except ValueError:
            raise _Finished(problem(404, "not_found", "Problem revision not found")) from None
        revision = await session.get(BindingCaseRevision, revision_id)
        problem_row = await session.get(BindingCase, revision.binding_case_id) if revision is not None else None
        if revision is None or problem_row is None:
            raise _Finished(problem(404, "not_found", "Problem revision not found"))
        from ..collaboration import effective_role

        if await effective_role(session, problem_row.organization_id, self.caller) is None:
            # A non-member learns nothing about the revision.
            raise _Finished(problem(404, "not_found", "Problem revision not found"))
        if problem_row.organization_id != request.organization_id:
            raise _Finished(problem(
                409,
                "revision_not_in_organization",
                "The problem revision belongs to another organization; launch the run from that organization",
            ))
        if not await _key_boundary_allows(session, self.caller, problem_row):
            raise _Finished(problem(
                403, "api_key_boundary", "This API key is restricted from the requested method or resource."
            ))
        try:
            await require_work_role(session, self.caller, [problem_row.organization_id])
            compilation = await compile_or_get(session, revision, release_transaction=self.commit)
        except HTTPException as exc:
            raise _Finished(problem_from_http(exc)) from exc
        if compilation.ir.get("apiVersion") != "bim/v1" or compilation.ir.get("kind") != "BindingProblem":
            raise _Finished(problem(422, "execution_capability_unavailable", "This output has no installed execution evaluator"))
        return _Source(revision, problem_row, compilation, request)

    async def _precheck(self, request: RunRequest, source: _Source) -> str:
        """The request's fingerprint; an earlier job with the same key settles the request here (replay or 409)."""
        try:
            fingerprint = idempotency.request_fingerprint(
                source_digest=source.revision.package_digest,
                body=request.body(),
            )
        except CanonicalizationError as exc:
            raise _Finished(problem(422, "invalid_request", str(exc))) from exc
        if request.idempotency_key:
            existing = await _find_idempotent_job(self.session, self.caller.id, request.idempotency_key)
            if existing is not None:
                raise _Finished(_idempotent_outcome(existing, fingerprint))
        return fingerprint

    async def _select_engine(self, source: _Source) -> _Engine:
        request = source.request
        selector = request.engine
        if isinstance(selector, dict):
            name = selector.get("name")
            namespace = selector.get("namespace")
            version = selector.get("version")
            requested_digest = selector.get("digest")
            if not all(isinstance(value, str) and value for value in (name, namespace, version, requested_digest)):
                raise _Finished(problem(
                    422,
                    "invalid_engine",
                    "engine references require namespace, name, version and digest",
                ))
        else:
            name = selector
            namespace = version = requested_digest = None
        requested_mode = request.mode
        if not isinstance(name, str) or not name:
            raise _Finished(problem(422, "invalid_engine", "engine must be a name or immutable reference"))
        if not isinstance(selector, dict) and not (MANIFEST_DIR / f"{name}.json").is_file():
            raise _Finished(problem(
                422,
                "immutable_engine_required",
                "non-built-in engines must be selected by namespace, name, version and digest",
            ))
        requested_options = request.options
        try:
            selection = await select_engine(
                name,
                requested_mode,
                requested_options,
                self.session,
                caller=self.caller,
                namespace=namespace,
                version=version,
                manifest_digest=requested_digest,
                ir=source.ir,
            )
            manifest, mode, options = selection.manifest, selection.mode, selection.options
            manifest_digest = digest(manifest)
            optimization = await _resolve_execution_optimization(
                source.ir, manifest, mode["id"], request.optimization,
            )
        except HTTPException as exc:
            raise _Finished(problem_from_http(exc)) from exc
        reference = engine_ref(manifest, namespace or "bim.builtin")
        if self.caller is not None and not allows_engine(self.caller, reference):
            raise _Finished(problem(404, "not_found", "Engine revision not found"))
        return _Engine(
            name, namespace, selection, manifest, mode, options, requested_options,
            manifest_digest, optimization, reference,
        )

    async def _plan_terms(self, request: RunRequest, source: _Source, engine: _Engine) -> _PlanTerms:
        """What the caller's plan allows: payload and complexity ceilings, clamped options, solve timeout."""
        settings = get_settings()
        caps = None
        options = engine.options
        warnings: list[dict[str, Any]] = []
        timeout = settings.engine_solve_timeout_s
        if self.caller is not None:
            # A study cell launch treats this 503 as retryable (study_jobs.RETRYABLE_LAUNCH_CODES).
            try:
                caps = await entitlement_service.caps_for(self.caller.id)
            except EntitlementsUnavailable as exc:
                raise _Finished(problem(exc.status, exc.code, str(exc))) from exc
            # Before the account row is locked or the job inserted: a refusal here holds no slot and
            # leaves no row.
            refusal = entitlement_service.binding_space_refusal(BindingSpace.from_analysis(source.compilation.analysis))
            if refusal is not None:
                raise _Finished(problem(refusal.status, refusal.code, refusal.detail, extra=refusal.extra or None))
            clamped = entitlement_service.clamp_options(options, caps)
            options = clamped.options
            warnings = [warning.model_dump(mode="json") for warning in clamped.warnings]
            timeout = entitlement_service.solve_timeout(caps, settings.engine_solve_timeout_s)
        return _PlanTerms(caps, options, warnings, timeout)

    async def _registration(self, source: _Source, engine: _Engine) -> _Registration:
        """The EngineRegistration that pins the selected Engine revision and where it runs."""
        requested = source.request.registration
        if requested is not None and (
            not isinstance(requested, dict)
            or set(requested) != {"namespace", "name", "version", "digest"}
            or not all(isinstance(value, str) and value for value in requested.values())
        ):
            raise _Finished(problem(
                422,
                "invalid_registration",
                "registration references require exactly namespace, name, version and digest",
            ))
        registration = await registration_for_engine(
            requested.get("namespace") if requested else None,
            requested.get("name") if requested else None,
            requested.get("version") if requested else None,
            requested.get("digest") if requested else None,
            self.caller,
            self.session,
        )
        builtin = installed_builtin_registration(
            engine.manifest,
            get_settings().engine_urls.get(engine.name),
            requested,
        )
        if registration is None and builtin is not None:
            registration = builtin
        if requested is not None and registration is None:
            raise _Finished(problem(404, "not_found", "Engine registration not found or not active"))
        if registration is None:
            raise _Finished(problem(
                422,
                "engine_registration_required",
                "the selected Engine revision has no installed EngineRegistration",
            ))
        mismatch = problem(409, "engine_reference_mismatch", "registration does not pin the exact selected Engine revision")
        if isinstance(registration, EngineRegistrationRevision):
            if (
                registration.engine_digest != engine.digest
                or registration_engine_reference(registration) != engine.reference
            ):
                raise _Finished(mismatch)
            endpoint = registration.endpoint
            protocol_digest = registration.protocol_digest
        elif isinstance(registration, dict):
            if registration_engine_reference(registration) != engine.reference:
                raise _Finished(mismatch)
            endpoint = registration["document"]["spec"]["endpoint"]
            protocol_digest = registration["document"]["spec"]["protocol"]["digest"]
        else:
            raise TypeError(f"unsupported engine registration: {type(registration).__name__}")
        return _Registration(registration, registration_reference(registration), endpoint, protocol_digest)

    def _provenance(
        self,
        source: _Source,
        engine: _Engine,
        terms: _PlanTerms,
        registration: _Registration,
        *,
        limits: dict[str, Any],
        mode_contract: Mapping[str, Any],
        dialects: Any,
        adapters: list[Any],
    ) -> dict[str, Any]:
        compilation = source.compilation
        profile = source.spec["profile"]
        evaluator_hash = bim.toolchain_digest()
        provenance = {
            "engine": engine.reference,
            "engineDigest": engine.digest,
            "registration": registration.reference,
            "protocol": "bim-engine/v1",
            "protocolDigest": registration.protocol_digest,
            "mode": engine.mode["id"],
            "optimization": engine.optimization,
            "algorithm": engine.mode.get("algorithm"),
            "profile": profile,
            "profileDigest": profile["digest"],
            "ir": {"apiVersion": compilation.ir["apiVersion"], "kind": compilation.ir["kind"]},
            "irDigest": compilation.ir_digest,
            "instanceDigest": source.revision.instance_digest,
            "packageDigest": source.revision.package_digest,
            "fileDigests": package_file_digests(source.revision.document, compilation.ir),
            "resourceDigests": dict(source.revision.resource_digests or {}),
            "revisionId": str(source.revision.id),
            "compilationId": str(compilation.id),
            "compilationDigest": compilation.compilation_digest,
            "dialects": dialects,
            "adapters": adapters,
            "compiler": "bim-compiler/v1",
            "compilerDigest": compilation.compiler_digest,
            "evaluator": "bim-reference-evaluator/v1",
            "evaluatorDigest": evaluator_hash,
            "options": terms.options,
            "limits": {**limits, "effectiveTimeoutSeconds": terms.timeout},
            "warnings": terms.warnings,
            "terminationGuarantees": mode_contract["terminationGuarantees"],
        }
        provenance["requestedOptions"] = engine.requested_options
        return provenance

    async def _persist(
        self,
        request: RunRequest,
        source: _Source,
        engine: _Engine,
        terms: _PlanTerms,
        registration: _Registration,
        provenance: dict[str, Any],
        *,
        mode_contract: Mapping[str, Any],
        fingerprint: str | None,
    ) -> JobSubmissionResult:
        """Take the account's slot and store the job; the replay of a lost race wins over a refusal."""
        session, caller, compilation = self.session, self.caller, source.compilation
        key = request.idempotency_key
        federated = not (
            isinstance(registration.document, dict) and is_installed_builtin_registration(registration.document)
        )
        # Lock the account row first: a request that waited behind the one that
        # created this job now sees it, and two creations cannot both take the
        # last slot.
        await job_limits.lock_owner(session, caller.id)
        if key:
            raced = await _raced_idempotent_outcome(session, caller.id, key, fingerprint)
            if raced is not None:
                return raced
        refusal = entitlement_service.feature_refusal(terms.caps, ids.FEDERATED_ENGINES if federated else ids.RUNS)
        if refusal is None:
            refusal = await job_limits.enforce_concurrency_limit(session, caller.id, caps=terms.caps)
        if refusal is not None:
            return problem(
                refusal.status,
                refusal.code,
                refusal.detail,
                extra=refusal.extra or None,
                headers=refusal.headers or None,
            )
        job_id = str(uuid.uuid4())
        tasks = compilation.ir["spec"].get("application", {}).get("tasks", {})
        space = BindingSpace.from_analysis(compilation.analysis)
        db_job = Job(
            id=uuid.UUID(job_id),
            owner_id=caller.id,
            engine_id=engine.name,
            engine_job_id=job_id,
            service_url=registration.endpoint,
            state=JobState.QUEUED,
            original_request={
                "timeout": terms.timeout,
                "mode": mode_contract,
                "optimization": engine.optimization,
                "registration": registration.reference,
            },
            options=terms.options,
            warnings=terms.warnings,
            instance_complexity={
                "instanceDigest": source.revision.instance_digest,
                "resourceCount": len(source.revision.files or []),
                "tasks": len(tasks) if isinstance(tasks, (dict, list)) else 0,
                "candidates": int(compilation.analysis.get("candidates") or 0),
                "bindingSpace": space.cardinality or "0",
            },
            revision_id=source.revision.id,
            compilation_id=compilation.id,
            organization_id=request.organization_id,
            provenance=provenance,
            idempotency_key=key,
            idempotency_fingerprint=fingerprint,
            requested_budget_s=terms.timeout,
            study_cell_id=self.study_cell_id,
        )
        try:
            async with session.begin_nested():
                session.add(db_job)
                await session.flush()
        except IntegrityError:
            if self.study_cell_id is not None:
                # Another launch of this cell won the unique index: that job is the cell's job.
                winner = (
                    await session.execute(select(Job).where(Job.study_cell_id == self.study_cell_id))
                ).scalars().first()
                if winner is not None:
                    return JobSubmissionResult("replay", 202, _replay_body(winner))
            raced = await _raced_idempotent_outcome(session, caller.id, key, fingerprint)
            if raced is not None:
                return raced
            return problem(409, "job_conflict", "job identity conflicted with another request")
        if self.commit:
            await session.commit()
        else:
            pending_launches(session).append(db_job.id)
        return created({
            "id": job_id,
            "status": "queued",
            "profile": source.spec["profile"]["id"],
            "irDigest": compilation.ir_digest,
        })
