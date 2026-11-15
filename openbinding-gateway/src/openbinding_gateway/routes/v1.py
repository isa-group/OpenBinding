"""The public BIM v1 API exposed by the OpenBinding platform: engines and engine registrations.

Runs are ``modules.execution`` (``/v1/organizations/{org}/runs``) and problems ``modules.problems``.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_optional_user, optional_session, require_v1_admin, solve_caller
from ..core import revision
from ..core.settings import get_settings
from ..db.models import User
from ..models.problem import PROBLEM_MEDIA_TYPE, VALIDATION_ERROR, problem_response, split_detail
from ..security.apikeys import allows_engine
from bim_core import PackageError
from ..core.jsonio import strict_json_loads
from ..integrations import bim
from ..v1.remote import fetch_remote_document, solve_remote, validate_endpoint

from ..v1.remote import RemoteEngineError as RemoteEngineError  # re-exported for the tests
from ..services import engine_registry
from ..services import engines as engine_documents
from ..services.entitlements import EntitlementsUnavailable, entitlement_service
from ..modules.plans.application import entitlement_map as ids
from ..services.engine_registry import RegistrationKey
from ..services.engines import protocol_digest as protocol_digest  # re-exported for the tests
from ..services.engines import manifest as _manifest
from ..services.engines import manifest_async

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["BIM v1"])

def _max_expanded() -> int:
    """Largest JSON document the gateway reads here: the toolchain's expanded-package limit."""
    return bim.package_limits()["max_expanded_bytes"]


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


def _service_problem(exc: engine_documents.EngineDocumentProblem) -> JSONResponse:
    return _problem(exc.status, exc.code, exc.detail)


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


@router.get("/engines")
async def list_v1_engines(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User | None = Depends(get_optional_user),
) -> dict[str, Any]:
    # The public engine catalogue: a visitor gets the built-in and published Engines.
    return await engine_documents.engines_document(session, caller)


@router.get("/engines/revisions")
async def list_engine_revisions(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    return await engine_documents.engine_revisions_document(session, caller)


@router.get(
    "/engines/protocol",
    operation_id="getEngineProtocol",
    summary="The engine protocol of the installed Profiles",
)
async def get_engine_protocol() -> dict[str, Any]:
    """The ``qos-binding/v1`` Profile entry with its ``protocolDigest`` and capability vocabulary.

    Anonymous: a federated engine reads it to register. Declared before ``/engines/{name}``, which would
    otherwise take ``protocol`` for an engine name.
    """
    return engine_documents.profiles_document()


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
        return await engine_documents.engine_revision_document(namespace, name, version, session, manifest=_manifest)
    except engine_documents.EngineDocumentProblem as exc:
        return _service_problem(exc)


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
        # The plan's ``maxFederatedEngines``: an absent value is zero (fail closed), unlimited is ``None``.
        try:
            max_active = (await entitlement_service.caps_for(caller.id)).limit(ids.MAX_FEDERATED_ENGINES)
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
