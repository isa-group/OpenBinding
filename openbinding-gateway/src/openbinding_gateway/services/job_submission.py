"""Job submission: validate a job request, reserve its idempotency key and persist the Job.

``routes.v1.create_job`` is the HTTP face of this module. The route authenticates
the caller and reads the request (content type, size limits, multipart, JSON)
into a ``JobSubmissionInput``; ``JobSubmission.submit`` does the rest and answers
with a ``JobSubmissionResult`` that the route turns into a response. Nothing here
knows about requests or responses; dispatching the job to a worker stays with the
caller too, after the job is committed.

The idempotency guarantees (G1-G4, docs/IDEMPOTENCY.md) are kept by this flow:
the account row is locked before the key is looked up again and before the
concurrency limit is counted, the job is inserted inside a savepoint, and a lost
INSERT race re-reads the winner and replays it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Mapping

from bim_core import CanonicalizationError, ContractError, PackageError
from bim_core.canonical import digest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.jsonio import strict_json_loads
from ..core.settings import get_settings
from ..db.models import (
    BindingCase,
    BindingCaseRevision,
    EngineRegistrationRevision,
    Job,
    JobProvenance,
    JobState,
    Project,
    User,
)
from ..domain import idempotency
from ..integrations import bim
from ..jobs import limits as job_limits
from ..models.artifacts import ArtifactRef
from ..models.problem import VALIDATION_ERROR, problem_body, split_detail
from ..security.apikeys import allows_engine
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
from .entitlements import EntitlementsUnavailable, entitlement_service
from .snapshots import Compilation, compile_resolved, owned_snapshot, persist_snapshot, snapshot_ir

#: Idempotency keys the gateway writes for study cells; clients cannot claim them.
STUDY_CELL_KEY_PREFIX = "study-cell:"

_PENDING_LAUNCHES = "pending-job-launches"
_ACCOUNT_REQUIRED = "Submitting a job requires an account."

SnapshotPersister = Callable[[Compilation, User, AsyncSession], Awaitable[str | None]]


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
class JobSubmissionInput:
    """A job request already read from the transport.

    ``payload`` is the JSON object of the request (empty for a package upload).
    Exactly one of ``snapshot_id`` (an existing snapshot) and ``archive`` (an
    uploaded ``.bim.zip``) is set.
    """

    payload: dict[str, Any]
    body_size: int = 0
    idempotency_key: str | None = None
    snapshot_id: str | None = None
    archive: bytes | None = None


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


def _legacy_fingerprint(
    *,
    configuration: Any,
    requested_options: Any,
    compilation: Compilation,
    dialects: Any,
    adapters: list[Any],
    engine_digest: str,
    registration: Any,
    protocol_digest: str,
    mode: str,
    optimization: Any,
    algorithm: Any,
    options: Any,
    limits: dict[str, Any],
) -> str:
    """The fingerprint rows written before ``domain.idempotency`` carry: it hashes resolved values."""
    return digest({
        "configuration": configuration,
        "requestedOptions": requested_options,
        "packageDigest": compilation.package_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
        "irDigest": compilation.ir_digest,
        "dialects": dialects,
        "adapters": adapters,
        "engineDigest": engine_digest,
        "registration": registration,
        "protocolDigest": protocol_digest,
        "mode": mode,
        "optimization": optimization,
        "algorithm": algorithm,
        "options": options,
        "limits": limits,
    })


async def _sharing_organizations(session: AsyncSession, snapshot: Any, caller: User) -> list[uuid.UUID]:
    """The organizations whose cases share a snapshot the caller does not own; none for their own.

    ``owned_snapshot`` grants access through exactly these, so the role needed to run
    the snapshot is the role the caller holds in one of them.
    """
    if snapshot.owner_id == caller.id:
        return []
    return list((await session.scalars(
        select(Project.organization_id)
        .join(BindingCase, BindingCase.project_id == Project.id)
        .join(BindingCaseRevision, BindingCaseRevision.binding_case_id == BindingCase.id)
        .where(BindingCaseRevision.source_snapshot_id == snapshot.id)
        .distinct()
    )).all())


# -- Stages' products -------------------------------------------------------


@dataclass(frozen=True)
class _Source:
    compilation: Compilation
    payload: dict[str, Any]
    configuration_ref: Any
    configuration_version: Any


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
    returns the job that won it. ``snapshot_persister`` replaces
    ``persist_snapshot`` (the route passes its own binding of it).
    """

    def __init__(
        self,
        session: AsyncSession | None,
        caller: User | None,
        *,
        commit: bool = True,
        study_cell_id: uuid.UUID | None = None,
        snapshot_persister: SnapshotPersister | None = None,
    ) -> None:
        self.session = session
        self.caller = caller
        self.commit = commit
        self.study_cell_id = study_cell_id
        self._persist_snapshot = snapshot_persister or persist_snapshot

    async def submit(self, request: JobSubmissionInput) -> JobSubmissionResult:
        try:
            return await self._submit(request)
        except _Finished as finished:
            return finished.result

    async def _submit(self, request: JobSubmissionInput) -> JobSubmissionResult:
        source = await self._resolve_source(request)
        compilation = source.compilation
        fingerprint, legacy_existing = await self._precheck(request, source)
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
        dialects = compilation.spec["dialects"]
        adapters = [item["adapter"] for item in dialects if isinstance(item, dict) and isinstance(item.get("adapter"), dict)]
        if legacy_existing is not None:
            # Written by the legacy algorithm: comparable only after resolving.
            return _idempotent_outcome(
                legacy_existing,
                _legacy_fingerprint(
                    configuration=source.configuration_ref,
                    requested_options=engine.requested_options,
                    compilation=compilation,
                    dialects=dialects,
                    adapters=adapters,
                    engine_digest=engine.digest,
                    registration=registration.reference,
                    protocol_digest=registration.protocol_digest,
                    mode=engine.mode["id"],
                    optimization=engine.optimization,
                    algorithm=engine.mode.get("algorithm"),
                    options=terms.options,
                    limits=limits,
                ),
            )
        provenance = self._provenance(
            source, engine, terms, registration, limits=limits, mode_contract=mode_contract,
            dialects=dialects, adapters=adapters,
        )
        if self.caller is None or self.session is None:
            return problem(401, "unauthorized", _ACCOUNT_REQUIRED)
        return await self._persist(
            request, source, engine, terms, registration, provenance,
            mode_contract=mode_contract, fingerprint=fingerprint,
        )

    # -- Stages -------------------------------------------------------------

    async def _resolve_source(self, request: JobSubmissionInput) -> _Source:
        """The compiled package the job runs: a snapshot (and its configuration) or the uploaded archive."""
        payload = request.payload
        configuration_version = None
        configuration_ref = None
        pinned: Compilation | None = None
        try:
            if request.snapshot_id:
                if "configuration" in payload:
                    if self.session is None or self.caller is None:
                        raise _Finished(problem(401, "unauthorized", "Selecting a library execution configuration requires an account."))
                    if set(payload) & {"engine", "registration", "mode", "options", "optimization"}:
                        raise _Finished(problem(422, "ambiguous_configuration", "Select a configuration version or inline execution settings, not both."))
                    # Imported late: ``artifacts`` still reaches back into the routes.
                    from ..artifacts import reference, resolve_version, version_content
                    try:
                        selected = ArtifactRef.model_validate(payload["configuration"])
                    except ValidationError as exc:
                        raise _Finished(problem(422, "invalid_configuration", str(exc))) from exc
                    configuration_artifact, configuration_version = await resolve_version(self.session, selected, self.caller)
                    if configuration_artifact.kind != "ExecutionConfiguration":
                        raise _Finished(problem(422, "invalid_configuration", "Select an ExecutionConfiguration version."))
                    configuration_ref = reference(configuration_artifact, configuration_version)
                    settings_document = strict_json_loads((await version_content(self.session, configuration_version))[0])
                    payload = {**payload, **settings_document}
                snapshot = await owned_snapshot(request.snapshot_id, self.caller, self.session)
                if snapshot is None:
                    raise _Finished(problem(404, "not_found", "Snapshot not found"))
                # Before the IR is read, the key looked up or anything written: a VIEWER only reads.
                await require_work_role(self.session, self.caller, await _sharing_organizations(self.session, snapshot, self.caller))
                archive = snapshot.source_archive
                pinned = await snapshot_ir(snapshot, self.session)
            else:
                archive = request.archive
            compilation = pinned or await compile_resolved(archive, self.session, self.caller)
        except PackageError as exc:
            raise _Finished(problem(422, "invalid_request", str(exc))) from exc
        except HTTPException as exc:
            raise _Finished(problem_from_http(exc)) from exc
        return _Source(compilation, payload, configuration_ref, configuration_version)

    async def _precheck(self, request: JobSubmissionInput, source: _Source) -> tuple[str | None, Job | None]:
        """The request's fingerprint, and the earlier job with the same key if one exists.

        A job written by the current algorithm settles the request here (replay or
        409); one written by the legacy algorithm is returned to be compared after
        the request is resolved.
        """
        if self.session is None or self.caller is None:
            return None, None
        try:
            fingerprint = idempotency.request_fingerprint(
                source_digest=source.compilation.package_digest,
                body=request.payload,
                configuration=source.configuration_ref,
            )
        except CanonicalizationError as exc:
            raise _Finished(problem(422, "invalid_request", str(exc))) from exc
        if request.idempotency_key:
            existing = await _find_idempotent_job(self.session, self.caller.id, request.idempotency_key)
            if existing is not None:
                if idempotency.is_request_fingerprint(existing.idempotency_fingerprint):
                    raise _Finished(_idempotent_outcome(existing, fingerprint))
                return fingerprint, existing
        return fingerprint, None

    async def _select_engine(self, source: _Source) -> _Engine:
        payload = source.payload
        compilation = source.compilation
        selector = payload.get("engine", "random-search")
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
        requested_mode = payload.get("mode")
        if not isinstance(name, str) or not name:
            raise _Finished(problem(422, "invalid_engine", "engine must be a name or immutable reference"))
        if not isinstance(selector, dict) and not (MANIFEST_DIR / f"{name}.json").is_file():
            raise _Finished(problem(
                422,
                "immutable_engine_required",
                "non-built-in engines must be selected by namespace, name, version and digest",
            ))
        requested_options = payload.get("options", {})
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
                ir=compilation.ir,
            )
            manifest, mode, options = selection.manifest, selection.mode, selection.options
            manifest_digest = digest(manifest)
            optimization = await _resolve_execution_optimization(
                compilation.ir, manifest, mode["id"], payload.get("optimization"),
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

    async def _plan_terms(self, request: JobSubmissionInput, source: _Source, engine: _Engine) -> _PlanTerms:
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
            # A chunked upload has no Content-Length, so the route reports a size
            # of 0: the bytes actually read are what the plan ceiling applies to.
            size = request.body_size
            if not size and request.archive is not None:
                size = len(request.archive)
            if size and size > entitlement_service.payload_ceiling(caps, 512 * 1024 * 1024):
                raise _Finished(problem(413, "payload_too_large", "BIM package exceeds the caller plan limit"))
            # Before the account row is locked, the snapshot stored or the job inserted: a refusal
            # here holds no slot and leaves no row.
            refusal = entitlement_service.binding_space_refusal(source.compilation.binding_space, caps)
            if refusal is not None:
                raise _Finished(problem(refusal.status, refusal.code, refusal.detail, extra=refusal.extra or None))
            clamped = entitlement_service.clamp_options(options, caps)
            options = clamped.options
            warnings = [warning.model_dump(mode="json") for warning in clamped.warnings]
            timeout = entitlement_service.solve_timeout(caps, settings.engine_solve_timeout_s)
        return _PlanTerms(caps, options, warnings, timeout)

    async def _registration(self, source: _Source, engine: _Engine) -> _Registration:
        """The EngineRegistration that pins the selected Engine revision and where it runs."""
        requested = source.payload.get("registration")
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
        profile = compilation.spec["profile"]
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
            "instanceDigest": compilation.instance_digest,
            "packageDigest": compilation.package_digest,
            "fileDigests": compilation.file_digests,
            "resourceDigests": compilation.resource_digests,
            "dialects": dialects,
            "adapters": adapters,
            "compiler": "bim-compiler/v1",
            "compilerDigest": evaluator_hash,
            "evaluator": "bim-reference-evaluator/v1",
            "evaluatorDigest": evaluator_hash,
            "options": terms.options,
            "limits": {**limits, "effectiveTimeoutSeconds": terms.timeout},
            "warnings": terms.warnings,
            "terminationGuarantees": mode_contract["terminationGuarantees"],
        }
        provenance["requestedOptions"] = engine.requested_options
        if source.configuration_ref:
            provenance["configuration"] = source.configuration_ref
        return provenance

    async def _persist(
        self,
        request: JobSubmissionInput,
        source: _Source,
        engine: _Engine,
        terms: _PlanTerms,
        registration: _Registration,
        provenance: dict[str, Any],
        *,
        mode_contract: Mapping[str, Any],
        fingerprint: str | None,
    ) -> JobSubmissionResult:
        """Take the account's slot, store the snapshot and the job; the replay of a lost race wins over a refusal."""
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
        refusal = entitlement_service.feature_refusal(terms.caps, "federatedEngines" if federated else "solve")
        if refusal is None:
            refusal = await job_limits.enforce_concurrency_limit(session, caller.id)
        if refusal is not None:
            return problem(
                refusal.status,
                refusal.code,
                refusal.detail,
                extra=refusal.extra or None,
                headers=refusal.headers or None,
            )
        try:
            async with session.begin_nested():
                snapshot_db_id = await self._persist_snapshot(compilation, caller, session)
        except IntegrityError:
            raced = await _raced_idempotent_outcome(session, caller.id, key, fingerprint)
            if raced is not None:
                return raced
            return problem(409, "snapshot_conflict", "snapshot identity conflicted with another revision")
        try:
            parsed_snapshot_id = uuid.UUID(snapshot_db_id) if snapshot_db_id else None
        except ValueError:
            parsed_snapshot_id = None
        job_id = str(uuid.uuid4())
        tasks = compilation.spec.get("application", {}).get("tasks", {})
        version = source.configuration_version
        db_job = Job(
            id=uuid.UUID(job_id),
            owner_id=caller.id,
            engine_id=engine.name,
            engine_job_id=job_id,
            service_url=registration.endpoint,
            state=JobState.QUEUED,
            original_request={
                "bindingProblem": compilation.ir,
                "timeout": terms.timeout,
                "mode": mode_contract,
                "optimization": engine.optimization,
                "registration": registration.reference,
            },
            options=terms.options,
            warnings=terms.warnings,
            instance_complexity={
                "instanceDigest": compilation.instance_digest,
                "resourceCount": len(compilation.file_digests),
                "tasks": len(tasks) if isinstance(tasks, (dict, list)) else 0,
                "candidates": compilation.analysis["candidates"],
                "bindingSpace": compilation.binding_space_text,
            },
            instance_snapshot_id=parsed_snapshot_id,
            configuration_version_id=version.id if version else None,
            provenance=provenance,
            idempotency_key=key,
            idempotency_fingerprint=fingerprint,
            requested_budget_s=terms.timeout,
            study_cell_id=self.study_cell_id,
        )
        try:
            async with session.begin_nested():
                session.add(db_job)
                session.add(JobProvenance(job_id=db_job.id, document=provenance, digest=digest(provenance)))
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
            "profile": compilation.spec["profile"]["id"],
            "irDigest": compilation.ir_digest,
        })
