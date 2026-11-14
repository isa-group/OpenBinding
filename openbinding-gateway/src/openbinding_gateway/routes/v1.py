"""The public BIM v1 API exposed by the OpenBinding platform.

This router intentionally deals in snapshots and canonical IR. It never passes
a source ZIP to an engine: engines receive only the compiled BindingProblem.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Mapping

from ..models.analysis import NeighborhoodResponse
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_optional_user, optional_session, require_v1_admin, solve_caller
from ..access.work_limits import limit_work_of_counted_caller
from ..core import revision
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    BindingIRSnapshot,
    InstanceSnapshot,
    User,
)
from ..job_dispatch import dispatch_persisted_job
from ..models.problem import PROBLEM_MEDIA_TYPE, VALIDATION_ERROR, problem_response, split_detail
from ..security.apikeys import allows_engine
from bim_core import PackageError
from bim_core.canonical import digest_bytes
from ..core.jsonio import strict_json_loads
from ..integrations import bim
from ..v1.remote import fetch_remote_document, solve_remote, validate_endpoint

from ..v1.remote import RemoteEngineError as RemoteEngineError  # re-exported for the tests
from ..services import discovery, engine_registry, instances
from ..services.entitlements import EntitlementsUnavailable, entitlement_service
from ..services.engine_registry import RegistrationKey
from ..services.engines import owned_job
from ..services.engines import protocol_digest as protocol_digest  # re-exported for the tests
from ..services.engines import manifest as _manifest
from ..services.engines import manifest_async
from ..services.job_submission import (
    STUDY_CELL_KEY_PREFIX,
    JobSubmission,
    JobSubmissionInput,
    JobSubmissionResult,
)

# Re-exported for ``study_jobs`` and the tests that read the pending launches through this module.
from ..services.job_submission import discard_pending_launches as discard_pending_launches
from ..services.job_submission import pending_launches as pending_launches
from ..services.snapshots import (
    compile_resolved,
    package_file_digests,
    persist_snapshot,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["BIM v1"])

_BIM_ZIP_TYPES = instances.BIM_ZIP_TYPES


def _max_expanded() -> int:
    """Largest JSON document or registered resource the gateway reads: the toolchain's expanded-package limit."""
    return bim.package_limits()["max_expanded_bytes"]


def _max_compressed() -> int:
    """Largest ``.bim.zip`` upload: the toolchain's compressed-package limit."""
    return bim.package_limits()["max_compressed_bytes"]


def _problem(
    status_code: int,
    code: str,
    detail: str,
    diagnostics: list[dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return problem_response(status_code, code, detail, diagnostics, headers=headers, extra=extra)


# The conformance helpers live in ``services.engine_registry``; the tests reach them through this module.
_assert_operation_auth = engine_registry.assert_operation_auth
_assert_protocol_schema = engine_registry.assert_protocol_schema
_conformance_optimization = engine_registry.conformance_optimization
_conformance_shape = engine_registry.conformance_shape
_operation_schema = engine_registry.operation_schema


async def _verify_registration(
    document: dict[str, Any],
    credential: str | None,
    engine: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """``engine_registry.verify_registration`` over this module's transport and settings.

    The names are looked up here on every call, so replacing ``fetch_remote_document``, ``solve_remote`` or
    ``get_settings`` on this module (as the tests do) keeps working.
    """
    return await engine_registry.verify_registration(
        document,
        credential,
        engine,
        settings=get_settings(),
        fetch=fetch_remote_document,
        solve=solve_remote,
    )


def _package_request(request: Request) -> instances.PackageRequest:
    """The upload as ``services.instances`` takes it.

    The limits are looked up in this module when the service asks for them (hence the lambdas), so replacing
    ``_max_compressed`` here, as the tests do, takes effect.
    """
    return instances.PackageRequest(request.headers, request.body, lambda: _max_compressed(), lambda: _max_expanded())


async def _read_package(request: Request) -> bytes:
    return await instances.read_package(_package_request(request))


def _multipart_zip(body: bytes, content_type: str) -> bytes:
    return instances.multipart_zip(body, content_type, lambda: _max_compressed())


def _service_problem(exc: instances.InstanceProblem | discovery.DiscoveryProblem) -> JSONResponse:
    return _problem(exc.status, exc.code, exc.detail, extra=getattr(exc, "extra", None) or None)


def _error_from_http(exc: HTTPException) -> JSONResponse:
    """The same document the central HTTPException handler would produce (main.py)."""
    default_code = VALIDATION_ERROR if exc.status_code == 422 else "request_invalid"
    code, message, diagnostics, extra = split_detail(exc.detail, default_code)
    return _problem(exc.status_code, code, message, diagnostics, extra=extra, headers=exc.headers)


async def _read_json_body(request: Request, invalid_code: str) -> Any | JSONResponse:
    """The JSON body of a registry request, within the expanded-document limit, or the problem to answer."""
    try:
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        return strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, invalid_code, str(exc))


def _registry_problem(exc: engine_registry.RegistryProblem) -> JSONResponse:
    return _problem(exc.status, exc.code, exc.detail, exc.diagnostics, extra=exc.extra, headers=exc.headers)


@router.get("/profiles")
async def list_profiles() -> dict[str, Any]:
    return discovery.profiles_document()


def _builtin_dialects() -> list[dict[str, Any]]:
    return discovery.builtin_dialects()


@router.get("/dialects")
async def list_dialects() -> dict[str, Any]:
    # Only the installed contracts are listed: the gateway takes no Dialect submissions.
    return discovery.dialects_document(_builtin_dialects())


@router.get("/examples")
async def list_examples() -> dict[str, Any]:
    return {"examples": discovery.example_paths()}


@router.get("/examples/{example_path:path}")
async def get_example_package(example_path: str):
    try:
        example = await discovery.example_package(example_path)
    except discovery.DiscoveryProblem as exc:
        return _service_problem(exc)
    return Response(
        example.archive,
        media_type="application/vnd.bim+zip",
        headers={
            "Content-Disposition": f'attachment; filename="{example.name}.bim.zip"',
            "Digest": f"sha-256={digest_bytes(example.archive).removeprefix('sha256-')}",
        },
    )


@router.get("/engines")
async def list_v1_engines(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User | None = Depends(get_optional_user),
) -> dict[str, Any]:
    # The public engine catalogue: a visitor gets the built-in and published Engines.
    return await discovery.engines_document(session, caller)


@router.get("/engines/revisions")
async def list_engine_revisions(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    return await discovery.engine_revisions_document(session, caller)


@router.get("/engines/{name}")
async def get_v1_engine(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    if not allows_engine(
        caller,
        {
            "namespace": namespace,
            "name": name,
            "version": version,
            "digest": manifest_digest,
        },
    ):
        return _problem(404, "not_found", "Engine revision not found")
    try:
        return await manifest_async(
            name,
            session,
            caller=caller,
            namespace=namespace,
            version=version,
            manifest_digest=manifest_digest,
        )
    except HTTPException as exc:
        return _problem(exc.status_code, "not_found", str(exc.detail))


@router.get("/engines/{namespace}/{name}/revisions/{version}")
async def get_engine_revision_detail(
    namespace: str,
    name: str,
    version: str,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    try:
        # ``_manifest`` is resolved here on every call: the tests replace it on this module.
        return await discovery.engine_revision_document(namespace, name, version, session, manifest=_manifest)
    except discovery.DiscoveryProblem as exc:
        return _service_problem(exc)


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot_detail(
    snapshot_id: uuid.UUID,
    caller: User = Depends(solve_caller),
    session: AsyncSession = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    try:
        return await instances.snapshot_detail(str(snapshot_id), caller, session)
    except instances.InstanceProblem as exc:
        return _service_problem(exc)


@router.get(
    "/snapshots/{snapshot_id}/archive",
    operation_id="downloadSnapshotArchive",
    response_class=Response,
    responses={200: {"content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def download_snapshot_archive(
    snapshot_id: uuid.UUID,
    caller: User = Depends(solve_caller),
    session: AsyncSession = Depends(optional_session, scope="function"),
) -> Response:
    try:
        archive = await instances.snapshot_archive(str(snapshot_id), caller, session)
    except instances.InstanceProblem as exc:
        return _service_problem(exc)
    return Response(
        content=archive.content,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="snapshot-{archive.snapshot_id}.bim.zip"',
            "ETag": f'"{archive.package_digest}"',
            "Cache-Control": "no-store",
        },
    )


@router.post(
    "/engines",
    status_code=status.HTTP_201_CREATED,
    operation_id="createEngine",
)
async def create_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    document = await _read_json_body(request, "invalid_engine")
    if isinstance(document, JSONResponse):
        return document
    try:
        return await engine_registry.create_engine_revision(document, caller, session)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.post("/engine-registrations", status_code=status.HTTP_201_CREATED)
async def register_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    document = await _read_json_body(request, "invalid_registration")
    if isinstance(document, JSONResponse):
        return document
    try:
        return await engine_registry.register_engine(
            document, caller, session, settings=get_settings(), validate=validate_endpoint
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.get("/engine-registrations")
async def list_engine_registrations(
    review: bool = Query(
        False,
        description="Administrators may request only registrations explicitly submitted for review.",
    ),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await engine_registry.list_registrations(caller, session, review=review)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.get("/engine-registrations/{name}")
async def get_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = RegistrationKey(namespace, name, version, manifest_digest)
    try:
        return await engine_registry.read_registration(key, caller, session)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


async def _change_registration(
    namespace: str,
    name: str,
    version: str,
    manifest_digest: str,
    caller: User,
    session: AsyncSession | None,
    *,
    action: str,
):
    max_active = None
    if action == "activate":
        # The plan's numeric ``federatedEngines``: an absent value is zero (fail closed), unlimited is ``None``.
        try:
            max_active = (await entitlement_service.caps_for(caller.id)).limit("federatedEngines")
        except EntitlementsUnavailable as exc:
            return _problem(exc.status, exc.code, str(exc))
    try:
        return await engine_registry.change_registration(
            RegistrationKey(namespace, name, version, manifest_digest),
            caller,
            session,
            action=action,
            settings=get_settings(),
            verify=_verify_registration,
            max_active=max_active,
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.post("/engine-registrations/{name}/approve")
async def approve_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="approve")


@router.post("/engine-registrations/{name}/reject")
async def reject_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="reject")


@router.post("/engine-registrations/{name}/activate")
async def activate_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="activate")


@router.post("/engine-registrations/{name}/deactivate")
async def deactivate_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="deactivate")


@router.post("/engine-registrations/{name}/publication-request")
async def request_engine_registration_publication(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Make a private registration visible to administrators for moderation."""
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="request_publication")


@router.delete("/engine-registrations/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        await engine_registry.delete_registration(
            RegistrationKey(namespace, name, version, manifest_digest), caller, session
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/engine-registrations/{name}/report")
async def get_engine_registration_report(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = RegistrationKey(namespace, name, version, manifest_digest)
    try:
        return await engine_registry.registration_report(key, caller, session)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


_PROBLEM_BODY = {PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}}
_CREDENTIAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "The registration summary. `ETag` is the revision of the stored credential.",
        "headers": {"ETag": revision.ETAG_HEADER},
    },
    400: {
        "description": "`If-Match` is not a list of entity-tags or `*` (code `invalid_if_match`).",
        "content": _PROBLEM_BODY,
    },
    412: {
        "description": (
            "`If-Match` does not match the stored credential (code `precondition_failed`), or no credential is "
            "stored yet: nothing was applied. The `ETag` header carries the current revision when one exists."
        ),
        "headers": {"ETag": revision.ETAG_HEADER},
        "content": _PROBLEM_BODY,
    },
}


@router.put("/engine-registrations/{name}/credential", responses=_CREDENTIAL_RESPONSES)
async def set_engine_registration_credential(
    name: str,
    request: Request,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    if_match: str | None = revision.IF_MATCH_HEADER,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Replace a deployment credential without ever placing it in a manifest."""
    payload = await _read_json_body(request, "invalid_credential")
    if isinstance(payload, JSONResponse):
        return payload
    secret = payload.get("secret") if isinstance(payload, dict) else None
    if not isinstance(secret, str) or not secret:
        return _problem(422, "invalid_credential", "credential payload requires a non-empty secret")
    try:
        summary, etag = await engine_registry.set_credential_revision(
            RegistrationKey(namespace, name, version, manifest_digest),
            secret,
            caller,
            session,
            settings=get_settings(),
            if_match=if_match,
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)
    return JSONResponse(summary, headers={"ETag": etag})


@router.post("/instances/validate", dependencies=[Depends(limit_work_of_counted_caller)])
async def validate_legacy_instance(
    request: Request,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await instances.validate_legacy(_package_request(request), session, compiler=compile_resolved)
    except HTTPException as exc:
        return _error_from_http(exc)


@router.post(
    "/validate",
    operation_id="validateInstance",
    summary="Validate a BIM package and find compatible engines",
)
async def validate_instance(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await instances.validate_package(_package_request(request), caller, session, compiler=compile_resolved)
    except instances.InstanceProblem as exc:
        return _service_problem(exc)
    except HTTPException as exc:
        return _error_from_http(exc)


@router.post("/instances", status_code=status.HTTP_201_CREATED)
async def create_snapshot(
    request: Request,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await instances.create_snapshot(
            _package_request(request), caller, session, compiler=compile_resolved, persist=persist_snapshot
        )
    except instances.InstanceProblem as exc:
        return _service_problem(exc)
    except HTTPException as exc:
        return _error_from_http(exc)


@router.get("/instances/{snapshot_id}")
async def get_snapshot(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await instances.instance_view(snapshot_id, caller, session)
    except instances.InstanceProblem as exc:
        return _service_problem(exc)


@router.get("/instances/{snapshot_id}/source")
async def get_snapshot_source(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        archive = await instances.instance_source(snapshot_id, caller, session)
    except instances.InstanceProblem as exc:
        return _service_problem(exc)
    return Response(
        archive,
        media_type="application/vnd.bim+zip",
        headers={"Content-Disposition": f'attachment; filename="{snapshot_id}.bim.zip"', "Digest": f"sha-256={digest_bytes(archive).removeprefix('sha256-')}"},
    )


@router.get("/instances/{snapshot_id}/ir")
async def get_snapshot_ir(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await instances.instance_ir(snapshot_id, caller, session)
    except instances.InstanceProblem as exc:
        return _service_problem(exc)


@router.post("/jobs", status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    request: Request,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = request.headers.get("Idempotency-Key")
    if key is not None and key.startswith(STUDY_CELL_KEY_PREFIX):
        return _problem(
            422,
            "reserved_idempotency_key",
            f"Idempotency-Key cannot start with {STUDY_CELL_KEY_PREFIX!r}; the gateway reserves that prefix",
        )
    return await _create_job_core(request, caller, session)


async def _create_job_core(
    request: Request,
    caller: User | None,
    session: AsyncSession | None,
    *,
    commit: bool = True,
    dispatch: bool = True,
    study_cell_id: uuid.UUID | None = None,
):
    """Read, submit and dispatch a job; ``create_job`` is its HTTP face.

    The submission itself (validation, idempotency, limits, persistence) is
    ``services.job_submission``. ``commit`` and ``dispatch`` say whether to
    commit and queue the job here. Without them the job stays in the caller's
    transaction and its reservation is recorded in ``pending_launches``.
    ``study_cell_id`` is written in the job's own INSERT, so the cell and the
    job cannot be seen apart; losing the race for a cell returns the job that
    won it.
    """

    if dispatch and not commit:
        raise ValueError("a job cannot be dispatched before it is committed")
    idempotency_key = request.headers.get("Idempotency-Key")
    if idempotency_key is not None and not (1 <= len(idempotency_key) <= 255):
        return _problem(
            422,
            "invalid_idempotency_key",
            "Idempotency-Key must contain between 1 and 255 characters",
        )
    submission = await _read_job_request(request, idempotency_key)
    if isinstance(submission, JSONResponse):
        return submission
    result = await JobSubmission(
        session,
        caller,
        commit=commit,
        study_cell_id=study_cell_id,
        snapshot_persister=persist_snapshot,
    ).submit(submission)
    if dispatch and result.kind == "created":
        await dispatch_persisted_job(result.body["id"], None if db_base.is_configured() else session)
    return _job_response(result)


async def _read_job_request(request: Request, idempotency_key: str | None) -> JobSubmissionInput | JSONResponse:
    """The job request as the service takes it, or the problem that stops it at the transport."""
    try:
        content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
        if content_type.startswith("multipart/form-data"):
            body = await request.body()
            if len(body) > _max_compressed() + 1024 * 1024:
                return _problem(413, "payload_too_large", "multipart BIM package is too large")
            archive = _multipart_zip(body, request.headers.get("content-type", ""))
            return JobSubmissionInput({}, len(body), idempotency_key, archive=archive)
        if content_type in _BIM_ZIP_TYPES:
            archive = await _read_package(request)
            body_size = int(request.headers.get("content-length", "0") or 0)
            return JobSubmissionInput({}, body_size, idempotency_key, archive=archive)
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        payload = strict_json_loads(body)
        snapshot_id = payload.get("snapshot") if isinstance(payload, dict) else None
        if not snapshot_id:
            return _problem(
                422,
                "snapshot_or_package_required",
                "BIM v1 jobs accept an existing snapshot or a ZIP package upload",
            )
        allowed_fields = {"snapshot", "engine", "registration", "mode", "options", "optimization", "configuration"}
        if set(payload) - allowed_fields:
            return _problem(
                422,
                "invalid_request_fields",
                "job request contains fields outside the BIM v1 job contract",
            )
        return JobSubmissionInput(payload, len(body), idempotency_key, snapshot_id=snapshot_id)
    except PackageError as exc:
        return _problem(422, "invalid_request", str(exc))
    except HTTPException as exc:
        return _error_from_http(exc)


def _job_response(result: JobSubmissionResult) -> dict[str, Any] | JSONResponse:
    """A new job answers with its document (202 by the route); a replay or a problem is a response of its own."""
    if result.kind == "created":
        return result.body
    if result.kind == "replay":
        return JSONResponse(result.body, status_code=result.status, headers=result.headers or None)
    return JSONResponse(
        result.body, status_code=result.status, media_type=PROBLEM_MEDIA_TYPE, headers=result.headers or None
    )


@router.get("/jobs/{job_id}")
async def get_v1_job(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    result = {"id": job_id, "status": job.state.value, "provenance": dict(job.provenance or {})}
    if job.result is not None:
        result["result"] = job.result
        if isinstance(job.result, dict) and "error" in job.result:
            result["error"] = job.result["error"]
    return result


# A per-process bound protects the evaluator pool. No Engine or solver job is dispatched.
_ANALYSIS_SLOTS = asyncio.Semaphore(2)


@router.get(
    "/jobs/{job_id}/analysis/neighborhood",
    response_model=NeighborhoodResponse,
    summary="Evaluate bounded one-task binding alternatives",
    description="Owner-scoped counterfactual evaluation against the pinned job IR. "
                "At most 128 eligible substitutions, with a cooperative two-second budget between evaluations. "
                "Does not invoke an Engine, mutate the job, or claim global optimality.",
)
async def get_v1_job_neighborhood(
    job_id: str,
    solution_index: int = Query(0, ge=0),
    task: str | None = Query(None, max_length=256),
    limit: int = Query(64, ge=1, le=128),
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    solutions = (job.result or {}).get("solutions", [])
    if not isinstance(solutions, list) or solution_index >= len(solutions):
        return _problem(422, "invalid_solution", "Selected returned solution does not exist")
    decision = solutions[solution_index].get("decision", {})
    if decision.get("kind") != "binding" or not isinstance(decision.get("binding"), dict):
        return _problem(422, "unsupported_decision", "Analysis requires a canonical binding decision")
    document = (job.original_request or {}).get("bindingProblem")
    ir_digest = (job.provenance or {}).get("irDigest")
    if not isinstance(document, dict) and job.instance_snapshot_id is not None:
        ir = (await session.execute(select(BindingIRSnapshot).where(
            BindingIRSnapshot.snapshot_id == job.instance_snapshot_id
        ))).scalars().first()
        if ir is not None:
            if ir_digest and ir_digest != ir.ir_digest:
                return _problem(409, "analysis_unavailable", "Job and snapshot IR identities disagree")
            document = ir.document
    if not isinstance(document, dict) or document.get("kind") != "BindingProblem":
        return _problem(409, "analysis_unavailable", "The pinned BindingProblem is unavailable")
    if not bim.ir_is_installed(document):
        return _problem(422, "contract_not_installed", bim.STALE_IR_MESSAGE)
    if _ANALYSIS_SLOTS.locked():
        return _problem(429, "analysis_busy", "The analysis evaluator is busy; retry shortly")
    # Compare under the job's execution optimization, as the gateway re-evaluation did.
    execution = (job.original_request or {}).get("optimization") or (job.provenance or {}).get("optimization")
    if not isinstance(execution, dict):
        execution = None
    async with _ANALYSIS_SLOTS:
        try:
            result = await bim.abim().neighborhood(
                document, decision["binding"], task=task, limit=limit, execution=execution
            )
        except (ValueError, ArithmeticError) as exc:
            return _problem(422, "analysis_invalid", str(exc)[:300])
    return {"jobId": job_id, "solutionIndex": solution_index, **result}


@router.get("/jobs/{job_id}/ir")
async def get_v1_job_ir(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    document = (job.original_request or {}).get("bindingProblem")
    if not isinstance(document, dict) and job.instance_snapshot_id is not None:
        ir = (await session.execute(select(BindingIRSnapshot).where(
            BindingIRSnapshot.snapshot_id == job.instance_snapshot_id
        ))).scalars().first()
        if ir is not None:
            if (job.provenance or {}).get("irDigest") not in (None, ir.ir_digest):
                return _problem(409, "analysis_unavailable", "Job and snapshot IR identities disagree")
            document = ir.document
    if not isinstance(document, dict):
        return _problem(404, "not_found", "BindingProblem not found")
    return document


@router.get("/jobs/{job_id}/instance")
async def get_v1_job_instance(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    if job.instance_snapshot_id is None:
        return _problem(404, "not_found", "Instance snapshot not found")
    snapshot = (
        await session.execute(
            select(InstanceSnapshot).where(
                InstanceSnapshot.id == job.instance_snapshot_id,
                InstanceSnapshot.owner_id == caller.id,
            )
        )
    ).scalars().first()
    if snapshot is None:
        return _problem(404, "not_found", "Instance snapshot not found")
    ir = (await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))).scalars().first()
    return {
        "id": str(snapshot.id),
        "instanceDigest": snapshot.instance_digest,
        "packageDigest": snapshot.package_digest,
        "fileDigests": package_file_digests(snapshot.root_document, ir.document if ir else {}),
        "resourceDigests": snapshot.resource_digests,
        "instance": snapshot.root_document,
    }


@router.get("/jobs/{job_id}/report")
async def get_v1_job_report(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    result = job.result or {}
    provenance = job.provenance or {}
    return {
        "id": job_id,
        "gatewayEvaluation": {
            "termination": result.get("termination"),
            "solutions": result.get("solutions", []),
        },
        "remote": result.get("provenance", {}).get("engineReported", {}),
        "provenance": provenance,
    }
