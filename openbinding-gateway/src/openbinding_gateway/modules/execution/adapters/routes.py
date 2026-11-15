"""The runs API: ``/v1/organizations/{org}/runs``.

A run belongs to the organization of the problem revision it runs (D10). Every member reads the
organization's runs; below MEMBER, and for an API key that cannot run engines, the inputs are
redacted (``security.redaction``). MEMBER and above create, cancel, retry and re-evaluate. A
non-member learns nothing: every route answers 404. Errors use the platform JSON envelope (D9).

The submission (validation, idempotency, limits, persistence) is ``services.job_submission``; the
dispatch, worker, leases and evidence are unchanged.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from bim_core import PackageError
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import exists, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....collaboration import effective_role, organization_by_ref
from ....core.jsonio import strict_json_loads
from ....core.public_errors import (
    BIM_EVALUATION_UNAVAILABLE,
    CANCELLATION_REQUESTED,
    EVIDENCE_EXPIRED,
    JOB_ALREADY_RETRIED,
    JOB_IN_STUDY,
    JOB_NOT_REEVALUABLE,
    PublicProblem,
    log_internal_failure,
)
from ....db import base as db_base
from ....db.models import AuditEvent, Job, JobEngineEvidence, JobState, Organization, ProblemCompilation, User
from ....domain.binding_space import BindingSpace, parse_cardinality
from ....integrations import bim
from ....job_dispatch import dispatch_persisted_job
from ....jobs import clock as job_clock
from ....jobs import evidence as job_evidence
from ....jobs import lifecycle
from ....jobs import limits as job_limits
from ....models.analysis import NeighborhoodResponse
from ....models.errors import (
    CONFLICT_RESPONSE,
    FORBIDDEN_RESPONSE,
    NOT_FOUND_RESPONSE,
    UNAVAILABLE_RESPONSE,
    ErrorResponse,
    api_error,
)
from ....models.platform import JobView, RunList, RunView, job_view, run_view
from ....models.problem import JSON_MEDIA_TYPE, PROBLEM_TYPE_BASE, problem_response
from ....modules.plans.application import entitlement_map as ids
from ....repositories import jobs as job_repository
from ....security.apikeys import allows_engine, authenticated_api_key
from ....security.redaction import must_redact_jobs
from ....security.roles import require_work_role
from ....services.engines import persisted_mode_contract, run_in_org
from ....services.entitlements import EntitlementService, get_entitlements
from ....services.execution import evaluate_engine_result
from ....services.job_submission import JobSubmission, JobSubmissionResult
from ..domain.run_request import REQUEST_FIELDS, STUDY_CELL_KEY_PREFIX, RunRequest, RunRequestRefused

router = APIRouter(prefix="/v1/organizations/{org}/runs", tags=["Runs"])

_TERMINAL = {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}


# -- Access ---------------------------------------------------------------------------------------------


async def _organization(session: AsyncSession, org: str, user: User) -> Organization:
    """The organization of the address, for a member of it; 404 for everyone else."""
    organization = await organization_by_ref(session, org)
    if organization is None or await effective_role(session, organization.id, user) is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    return organization


async def _run(
    session: AsyncSession, organization: Organization, run: uuid.UUID, user: User, *, lock: bool = False
) -> Job:
    found = await run_in_org(session, organization.id, run, user, lock=lock)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Run not found.")
    return found


async def _view(session: AsyncSession, job: Job, viewer: User) -> JobView:
    refs = await job_repository.refs_for(session, [job])
    redact = await must_redact_jobs(session, job.organization_id, viewer)
    return job_view(job, viewer, redact=redact, refs=refs.get(job.id))


def _audit(session: AsyncSession, user: User, action: str, target: Job, **detail: str) -> None:
    """One audit event of the run's organization."""
    session.add(AuditEvent(
        organization_id=target.organization_id, actor_id=user.id, action=action,
        target_type=target.__class__.__name__, target_id=target.id, detail=detail,
    ))


def _refuse(problem: PublicProblem) -> HTTPException:
    return api_error(problem.status, problem.code, problem.detail)


# -- Create ---------------------------------------------------------------------------------------------


def _max_body() -> int:
    """Largest request body read here: the toolchain's expanded-package limit."""
    return bim.package_limits()["max_expanded_bytes"]


async def _read_run_request(request: Request, organization: Organization, key: str | None) -> RunRequest:
    """The body as a ``RunRequest``, or the refusal that stops it at the transport."""
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type and content_type != "application/json":
        raise api_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "A run request is a JSON object naming a problem revision; upload packages as problems first.",
        )
    body = await request.body()
    if len(body) > _max_body():
        raise api_error(413, "payload_too_large", f"request body exceeds {_max_body()} bytes")
    try:
        payload = strict_json_loads(body)
    except PackageError as exc:
        raise api_error(422, "invalid_request", str(exc)) from exc
    revision = payload.get("revision") if isinstance(payload, dict) else None
    if not isinstance(revision, str) or not revision:
        raise api_error(422, "revision_required", "A run names the problem revision it runs (revision).")
    if set(payload) - REQUEST_FIELDS:
        raise api_error(422, "invalid_request_fields", "The run request contains fields outside the run contract.")
    try:
        return RunRequest.from_document(organization.id, payload, idempotency_key=key, body_size=len(body))
    except RunRequestRefused as exc:
        raise api_error(422, exc.code, exc.message) from exc


def _refusal(result: JobSubmissionResult) -> JSONResponse:
    """A refused submission in the platform envelope: ``detail`` holds the code, the message and the extras."""
    body = dict(result.body)
    code = str(body.pop("code"))
    message = str(body.pop("detail", ""))
    for key in ("type", "title", "status"):
        body.pop(key, None)
    diagnostics = body.pop("diagnostics", None)
    extra = {**body.pop("extra", {}), **body}
    if result.status == 422:
        return problem_response(
            422, code, message, diagnostics, headers=result.headers or None, extra=extra or None,
            media_type=JSON_MEDIA_TYPE,
        )
    detail: dict[str, Any] = {"code": code, "error": message, **extra}
    if diagnostics:
        detail["diagnostics"] = diagnostics
    return JSONResponse(
        {"type": f"{PROBLEM_TYPE_BASE}{code}", "title": code, "status": result.status, "code": code,
         "detail": detail},
        status_code=result.status,
        headers=result.headers or None,
    )


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="createRun",
    responses={
        402: {"model": ErrorResponse, "description": "The plan has no room for another run."},
        403: {"model": ErrorResponse, "description": "Below MEMBER, or the feature or engine is not in the plan."},
        404: {"model": ErrorResponse, "description": "The organization, revision, engine or deployment is not visible."},
        409: {"model": ErrorResponse, "description": (
            "The revision belongs to another organization (`revision_not_in_organization`), or an immutable "
            "selection or the idempotency key conflicts."
        )},
        413: {"model": ErrorResponse, "description": "The request exceeds the transport size limit."},
        415: {"model": ErrorResponse, "description": "The request is not JSON."},
        422: {"description": (
            "The revision, selection, mode or options are invalid, or the binding space exceeds the limit; the "
            "preset is not one of the organization's (`preset_not_found`) or comes with settings of its own "
            "(`preset_with_settings`)."
        )},
        429: {"model": ErrorResponse, "description": "The account already has the maximum number of queued and running runs."},
        503: UNAVAILABLE_RESPONSE,
    },
)
async def create_run(
    org: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
):
    """Run a revision of one of the organization's problems on an engine (MEMBER).

    The settings (engine, registration, mode, options, optimization) are given inline or taken from a run
    preset of the organization (``preset``, its slug or id), never both. The run copies the preset's
    settings and records it as ``{id, slug}`` in ``original_request`` and ``provenance``.

    ``Idempotency-Key`` makes sending twice by accident start one run: the same key and the same
    request answer the first run again (202, ``idempotent``), the same key with another request 409.
    """
    organization = await _organization(session, org, user)
    key = request.headers.get("Idempotency-Key")
    if key is not None and not (1 <= len(key) <= 255):
        raise api_error(422, "invalid_idempotency_key", "Idempotency-Key must contain between 1 and 255 characters.")
    if key is not None and key.startswith(STUDY_CELL_KEY_PREFIX):
        raise api_error(
            422,
            "reserved_idempotency_key",
            f"Idempotency-Key cannot start with {STUDY_CELL_KEY_PREFIX!r}; the gateway reserves that prefix.",
        )
    # The transport refuses what is not a run request before any role is looked at; the role is
    # checked before the revision is read or anything is compiled or written.
    run_request = await _read_run_request(request, organization, key)
    await require_work_role(session, user, [organization.id])
    result = await JobSubmission(session, user).submit(run_request)
    if result.kind == "created":
        await dispatch_persisted_job(result.body["id"], None if db_base.is_configured() else session)
        return result.body
    if result.kind == "replay":
        return JSONResponse(result.body, status_code=result.status, headers=result.headers or None)
    return _refusal(result)


# -- Read -----------------------------------------------------------------------------------------------


@router.get("", response_model=RunList, operation_id="listRuns", responses={404: NOT_FOUND_RESPONSE})
async def list_runs(
    org: str,
    state: JobState | None = None,
    problem: str | None = Query(default=None, max_length=64, description="A problem slug or id."),
    revision: uuid.UUID | None = None,
    engine: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RunList:
    """The organization's runs, newest first: summaries only, results load with ``getRun``."""
    organization = await _organization(session, org, user)
    filters = {"state": state, "problem": problem, "revision": revision, "engine": engine}
    # A key sees the runs of the engines it may use; the rest read as absent.
    visible = None if authenticated_api_key(user) is None else (
        lambda provenance: allows_engine(user, provenance.get("engine", {}) if isinstance(provenance, dict) else {})
    )
    rows, total = await job_repository.list_in_org(
        session, organization.id, **filters, limit=limit, offset=offset, visible=visible,
    )
    redact = await must_redact_jobs(session, organization.id, user)
    refs = await job_repository.refs_for(session, rows)
    return RunList(
        runs=[job_view(row, user, include_results=False, redact=redact, refs=refs.get(row.id)) for row in rows],
        total=total,
    )


@router.get("/{run}", response_model=RunView, operation_id="getRun", responses={404: NOT_FOUND_RESPONSE})
async def get_run(
    org: str,
    run: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RunView:
    """One run: its state, settings, result and provenance, and what the engine reported about itself."""
    organization = await _organization(session, org, user)
    job = await _run(session, organization, run, user)
    refs = await job_repository.refs_for(session, [job])
    redact = await must_redact_jobs(session, organization.id, user)
    return run_view(job, user, redact=redact, refs=refs.get(job.id))


# -- Cancel, retry, re-evaluate --------------------------------------------------------------------------


@router.post(
    "/{run}/cancel",
    response_model=JobView,
    operation_id="cancelRun",
    responses={403: FORBIDDEN_RESPONSE, 404: NOT_FOUND_RESPONSE, 409: CONFLICT_RESPONSE},
)
async def cancel_run(
    org: str,
    run: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobView:
    organization = await _organization(session, org, user)
    await require_work_role(session, user, [organization.id])
    # A study's job is cancelled under the lock of its run, taken before the job's.
    await lifecycle.lock_study_run(session, run, organization.id)
    job = await _run(session, organization, run, user, lock=True)
    if job.state in _TERMINAL:
        raise api_error(status.HTTP_409_CONFLICT, "terminal_job", "The run is already terminal.")
    previous = job.state
    cancelled = await lifecycle.request_cancellation(session, job)
    _audit(
        session, user, "job.cancelled", job,
        jobId=str(job.id), ownerId=str(job.owner_id), previousState=previous.value,
        result="cancelled" if cancelled else "cancellation_requested",
    )
    await session.flush()
    return await _view(session, job, user)


@router.post(
    "/{run}/retry",
    response_model=JobView,
    status_code=202,
    operation_id="retryRun",
    responses={403: FORBIDDEN_RESPONSE, 404: NOT_FOUND_RESPONSE, 409: CONFLICT_RESPONSE},
)
async def retry_run(
    org: str,
    run: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    plans: EntitlementService = Depends(get_entitlements),
) -> JobView:
    """Run a failed or cancelled run again, as a new run launched by the caller.

    The new run is the caller's (its concurrency slot and plan), on the same compilation, engine and
    deployment. A private engine resolves for the caller, so retrying a teammate's run on that
    teammate's private engine is refused at dispatch (``registration_changed``, D10).
    """
    organization = await _organization(session, org, user)
    await require_work_role(session, user, [organization.id])
    original = await _run(session, organization, run, user, lock=True)
    if original.state not in {JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "job_not_retryable", "Only failed or cancelled runs may be retried.")
    existing = await job_repository.find_retry_of(session, original.id)
    if existing is not None:
        return await _view(session, existing, user)
    compilation = await session.get(ProblemCompilation, original.compilation_id)
    if compilation is None or not bim.ir_is_installed(compilation.ir):
        # The retry runs the same compilation; one made by another toolchain cannot run here.
        raise api_error(422, "contract_not_installed", bim.STALE_IR_MESSAGE)
    provenance = dict(original.provenance or {})
    registration = provenance.get("registration")
    federated = (
        isinstance(registration, dict)
        and bool(registration)
        and registration.get("namespace") != "bim.builtin"
    )
    caps = await plans.caps_or_503(user.id)
    refusal = plans.feature_refusal(caps, ids.FEDERATED_ENGINES if federated else ids.RUNS)
    recorded = (original.instance_complexity or {}).get("bindingSpace")
    if refusal is None and recorded is not None:
        # The size recorded when the original was accepted, held against today's limit.
        refusal = plans.binding_space_refusal(BindingSpace(parse_cardinality(recorded), None))
    if refusal is None:
        refusal = await job_limits.enforce_concurrency_limit(session, user.id, caps=caps)
    if refusal is not None:
        raise api_error(
            refusal.status,
            refusal.code,
            refusal.detail,
            headers=refusal.headers or None,
            **refusal.extra,
        )
    replacement = Job(
        owner_id=user.id, engine_id=original.engine_id, engine_job_id=str(uuid.uuid4()),
        service_url=original.service_url, state=JobState.QUEUED,
        original_request=original.original_request, options=original.options, warnings=original.warnings,
        instance_complexity=original.instance_complexity,
        revision_id=original.revision_id, compilation_id=original.compilation_id, provenance=provenance,
        idempotency_fingerprint=original.idempotency_fingerprint,
        requested_budget_s=original.requested_budget_s, retry_of_id=original.id,
        organization_id=original.organization_id,
    )
    session.add(replacement)
    await session.flush()
    replacement.engine_job_id = str(replacement.id)
    _audit(
        session, user, "job.retried", replacement,
        jobId=str(original.id), ownerId=str(original.owner_id), replacementJobId=str(replacement.id),
        result="retried",
    )
    await session.commit()
    # The job exists from here on. If dispatch fails, the redelivery sweep queues it again.
    await dispatch_persisted_job(str(replacement.id), None if db_base.is_configured() else session)
    return await _view(session, replacement, user)


async def _reevaluable(session: AsyncSession, job: Job, evidence_id: uuid.UUID | None = None) -> JobEngineEvidence:
    """The kept answer to evaluate again, or the reason this run cannot be.

    Every refusal is the same for every member whatever else is true of the run, in this order.
    ``evidence_id`` pins the row read before BIM was called: if the run moved on in the meantime
    it is not the one this evaluation was made for.
    """
    if job.study_cell_id is not None:
        raise _refuse(JOB_IN_STUDY)
    if await job_repository.find_retry_of(session, job.id) is not None:
        raise _refuse(JOB_ALREADY_RETRIED)
    if job.cancellation_requested:
        raise _refuse(CANCELLATION_REQUESTED)
    result = job.result if isinstance(job.result, dict) else {}
    if job.state is not JobState.FAILED or result.get("code") != "bim_evaluation_failed":
        raise _refuse(JOB_NOT_REEVALUABLE)
    reference = result.get("evidence")
    row = await job_evidence.current(session, job.id, job.attempt)
    if (
        not isinstance(reference, dict)
        or row is None
        or str(row.id) != reference.get("id")
        or (evidence_id is not None and row.id != evidence_id)
        or not await job_evidence.is_current(session, row)
    ):
        raise _refuse(EVIDENCE_EXPIRED)
    return row


@router.post(
    "/{run}/reevaluate",
    response_model=JobView,
    operation_id="reevaluateRun",
    responses={
        403: FORBIDDEN_RESPONSE,
        404: NOT_FOUND_RESPONSE,
        409: CONFLICT_RESPONSE,
        410: {"model": ErrorResponse, "description": "The kept answer of the engine has expired."},
        503: UNAVAILABLE_RESPONSE,
    },
)
async def reevaluate_run(
    org: str,
    run: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobView:
    """Evaluate again the engine answer kept for a run that failed with ``bim_evaluation_failed``.

    The engine does not run again. BIM is called with no transaction open; the run then goes
    FAILED -> COMPLETED in one conditional UPDATE, so of two simultaneous calls (or a call and a
    cancellation or a retry) one wins and the others answer 409. If BIM fails again the run and
    its evidence are untouched.
    """
    organization = await _organization(session, org, user)
    await require_work_role(session, user, [organization.id])
    job = await _run(session, organization, run, user)
    row = await _reevaluable(session, job)
    request = job.original_request if isinstance(job.original_request, dict) else {}
    provenance = dict(job.provenance or {})
    compilation = await session.get(ProblemCompilation, job.compilation_id)
    document = compilation.ir if compilation is not None else None
    mode = persisted_mode_contract(request.get("mode"))
    if not isinstance(document, dict) or mode is None:
        raise _refuse(JOB_NOT_REEVALUABLE)
    optimization = request.get("optimization", provenance.get("optimization", {}))
    raw_result, evidence_id = row.raw_result, row.id
    await session.commit()  # no transaction is open while BIM works
    try:
        final_provenance, reevaluated = await evaluate_engine_result(
            document, raw_result, optimization, mode["terminationGuarantees"], provenance
        )
    except Exception as exc:
        log_internal_failure("job re-evaluation", exc, job=run, code=BIM_EVALUATION_UNAVAILABLE.code)
        raise _refuse(BIM_EVALUATION_UNAVAILABLE) from None

    job = await _run(session, organization, run, user, lock=True)
    await session.refresh(job)
    await _reevaluable(session, job, evidence_id)
    won = await session.execute(
        update(Job)
        .where(
            Job.id == run,
            Job.state == JobState.FAILED,
            Job.cancellation_requested.is_(False),
            Job.study_cell_id.is_(None),
            Job.result["code"].as_string() == "bim_evaluation_failed",
            exists()
            .where(
                JobEngineEvidence.id == evidence_id,
                JobEngineEvidence.job_id == Job.id,
                JobEngineEvidence.attempt == Job.attempt,
            )
            .correlate(Job),
        )
        .values(
            state=JobState.COMPLETED,
            result=reevaluated,
            termination=reevaluated["termination"],
            provenance=final_provenance,
            lease_token=None,
            lease_until=None,
            finished_at=job_clock.now(session),
        )
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    if won.first() is None:
        await session.rollback()
        raise _refuse(JOB_NOT_REEVALUABLE)
    await session.refresh(job)
    await job_evidence.delete_for_job(session, run)
    _audit(
        session, user, "job.reevaluated", job,
        jobId=str(job.id), ownerId=str(job.owner_id), evidenceId=str(evidence_id), result="completed",
    )
    await session.commit()
    return await _view(session, job, user)


# -- Events and analysis --------------------------------------------------------------------------------


@router.get(
    "/{run}/events",
    operation_id="streamRunEvents",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}, 404: NOT_FOUND_RESPONSE},
)
async def stream_run_events(
    org: str,
    run: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StreamingResponse:
    organization = await _organization(session, org, user)
    organization_id = organization.id
    first = await _run(session, organization, run, user)

    def snapshot(job: Job) -> dict:
        return {
            "id": str(job.id),
            "status": job.state.value,
            "cancellationRequested": job.cancellation_requested,
            "finishedAt": job.finished_at.isoformat() if job.finished_at else None,
        }

    initial = snapshot(first)

    async def events():
        last = None
        current = initial
        for attempt in range(900):
            if attempt:
                if await request.is_disconnected() or not db_base.is_configured():
                    return
                # A streaming response may outlive its dependency session. Each poll therefore owns a
                # short read-only session and releases its connection before waiting for the next event.
                async with db_base.session_factory()() as poll_session:
                    job = await job_repository.get_in_org(poll_session, organization_id, run)
                    if job is None:
                        return
                    current = snapshot(job)
            encoded = json.dumps(current, separators=(",", ":"))
            if encoded != last:
                yield f"event: job\ndata: {encoded}\n\n"
                last = encoded
            if current["status"] in {state.value for state in _TERMINAL}:
                return
            await asyncio.sleep(1)

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


# A per-process bound protects the evaluator pool. No Engine or solver job is dispatched.
_ANALYSIS_SLOTS = asyncio.Semaphore(2)


@router.get(
    "/{run}/neighborhood",
    response_model=NeighborhoodResponse,
    operation_id="getRunNeighborhood",
    summary="Evaluate bounded one-task binding alternatives",
    description="Counterfactual evaluation against the run's compiled problem, for any member. "
                "At most 128 eligible substitutions, with a cooperative two-second budget between evaluations. "
                "Does not invoke an Engine, change the run, or claim global optimality.",
    responses={404: NOT_FOUND_RESPONSE, 409: CONFLICT_RESPONSE, 429: {"model": ErrorResponse, "description": "The evaluator is busy."}},
)
async def get_run_neighborhood(
    org: str,
    run: uuid.UUID,
    solution_index: int = Query(0, ge=0),
    task: str | None = Query(None, max_length=256),
    limit: int = Query(64, ge=1, le=128),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
):
    organization = await _organization(session, org, user)
    job = await _run(session, organization, run, user)
    solutions = (job.result or {}).get("solutions", [])
    if not isinstance(solutions, list) or solution_index >= len(solutions):
        raise api_error(422, "invalid_solution", "Selected returned solution does not exist")
    decision = solutions[solution_index].get("decision", {})
    if decision.get("kind") != "binding" or not isinstance(decision.get("binding"), dict):
        raise api_error(422, "unsupported_decision", "Analysis requires a canonical binding decision")
    compilation = await session.get(ProblemCompilation, job.compilation_id)
    document = compilation.ir if compilation is not None else None
    ir_digest = (job.provenance or {}).get("irDigest")
    if compilation is not None and ir_digest and ir_digest != compilation.ir_digest:
        raise api_error(409, "analysis_unavailable", "Run and compilation IR identities disagree")
    if not isinstance(document, dict) or document.get("kind") != "BindingProblem":
        raise api_error(409, "analysis_unavailable", "The pinned BindingProblem is unavailable")
    if not bim.ir_is_installed(document):
        raise api_error(422, "contract_not_installed", bim.STALE_IR_MESSAGE)
    if _ANALYSIS_SLOTS.locked():
        raise api_error(429, "analysis_busy", "The analysis evaluator is busy; retry shortly")
    # Compare under the run's execution optimization, as the gateway re-evaluation did.
    execution = (job.original_request or {}).get("optimization") or (job.provenance or {}).get("optimization")
    if not isinstance(execution, dict):
        execution = None
    async with _ANALYSIS_SLOTS:
        try:
            result = await bim.abim().neighborhood(
                document, decision["binding"], task=task, limit=limit, execution=execution
            )
        except (ValueError, ArithmeticError) as exc:
            raise api_error(422, "analysis_invalid", str(exc)[:300]) from exc
    return {"jobId": str(run), "solutionIndex": solution_index, **result}
