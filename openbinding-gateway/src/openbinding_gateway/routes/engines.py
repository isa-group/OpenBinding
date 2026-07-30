"""Registering somebody else's solver, through the API rather than a pull request.

The shape of this module follows from one decision: a registration is checked
rather than trusted, and what it is checked against is stated back to its owner.
So a submission does not simply succeed or fail - it produces a conformance
report, and an engine that fails keeps its registration, its report and its
edit history instead of vanishing with a 422.

The other decision worth naming is that the hard part is done for the
submitter. ``POST /v1/engines/draft`` reads a third party's OpenAPI document and
proposes the whole manifest: which operation solves, where the instance goes,
which field is the binding. Registering an engine is then correcting a draft
rather than authoring a document, which is the difference between a feature
people use and a feature people admire.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..access.dependencies import get_current_user, require_admin, session_dependency
from ..core.settings import get_settings
from ..db.models import EngineStatus, EngineVisibility, FederatedEngine, User, utcnow
from ..federation import ssrf
from ..federation.conformance import verify as run_verification
from ..federation.inference import draft_manifest
from ..federation.transport import FederatedTransport, TransportError
from ..models.errors import (
    CONFLICT_RESPONSE,
    NOT_FOUND_RESPONSE,
    QUOTA_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..models.manifest import EngineManifest, qualify
from ..registry.engine import EngineRegistry
from ..registry.federated import load_entries
from ..security.secrets import CredentialStore, SecretsUnavailable
from ..space_client import PricingUnavailable, get_gate

router = APIRouter(prefix="/v1/engines", tags=["Engines"])

#: How much OpenAPI document is worth reading. Generous for a spec, and finite
#: because the URL is a stranger's.
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024


# -- Wire shapes ------------------------------------------------------------


class DraftRequest(BaseModel):
    """Ask the gateway to read a spec and propose a manifest."""

    openapi_url: Optional[str] = Field(
        default=None, description="Where to fetch the engine's OpenAPI document."
    )
    openapi_document: Optional[Dict[str, Any]] = Field(
        default=None, description="The document itself, if it is not served publicly."
    )
    engine_id: str = Field(default="my-engine", description="Your name for the engine.")
    display_name: Optional[str] = None


class DraftResponse(BaseModel):
    """A manifest to correct, and what to correct in it."""

    manifest: Dict[str, Any]
    notes: List[str] = Field(
        default_factory=list, description="What each guess was based on."
    )
    unresolved: List[str] = Field(
        default_factory=list, description="What the document does not answer."
    )
    ready: bool = Field(
        description="Whether the draft already carries the one required mapping."
    )


class RegisterEngineRequest(BaseModel):
    manifest: Dict[str, Any] = Field(..., description="The engine manifest.")
    credential: Optional[str] = Field(
        default=None,
        description=(
            "The secret for the engine's own authentication. Stored encrypted and "
            "never returned; replaceable only."
        ),
    )
    publish: bool = Field(
        default=False,
        description="Ask for the engine to be listed publicly. An administrator decides.",
    )


class UpdateEngineRequest(BaseModel):
    manifest: Dict[str, Any]
    credential: Optional[str] = None


class CredentialRequest(BaseModel):
    credential: str


class EngineView(BaseModel):
    """A registered engine, as its owner or an administrator sees it.

    There is deliberately no credential field of any kind. It can be replaced
    but never read back, which is what lets this be shown in a review queue.
    """

    id: uuid.UUID
    engine_id: str
    display_name: str
    owner: str
    visibility: str
    status: str
    verified_at: Optional[Any] = None
    health_failures: int = 0
    manifest: Dict[str, Any]
    conformance_report: Optional[Dict[str, Any]] = None
    has_credential: bool = False
    created_at: Any
    updated_at: Any


def owner_name(row: FederatedEngine) -> str:
    """The owner's username, without provoking a lazy load.

    SQLAlchemy would happily fetch the relationship here, and under asyncio
    that is a MissingGreenlet rather than a query. Queries that need the name
    ask for it with ``selectinload``; anything else gets the id it already has.
    """
    from sqlalchemy import inspect as sa_inspect

    if "owner" in sa_inspect(row).unloaded:
        return ""
    return getattr(row.owner, "username", "")


def view_of(row: FederatedEngine, owner_username: str = "") -> EngineView:
    return EngineView(
        id=row.id,
        engine_id=row.engine_id,
        display_name=row.display_name,
        owner=owner_username or owner_name(row),
        visibility=row.visibility.value,
        status=row.status.value,
        verified_at=row.verified_at,
        health_failures=row.health_failures,
        manifest=row.manifest,
        conformance_report=row.conformance_report,
        has_credential=bool(row.credential_encrypted),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# -- Helpers ----------------------------------------------------------------


async def fetch_document(url: str) -> Dict[str, Any]:
    """Read somebody's OpenAPI document, through the same guard a solve uses.

    A registration URL is as much an SSRF primitive as a solve URL, and it
    arrives earlier - so this is checked before anything is stored, not after.
    """
    settings = get_settings()
    target = ssrf.resolve(url, require_https=settings.federation_require_https)

    pinned = httpx.URL(url).copy_with(host=target.address)
    async with httpx.AsyncClient(timeout=15.0) as client:
        request = client.build_request(
            "GET",
            pinned,
            headers={"Host": target.host, "Accept": "application/json"},
            extensions={"sni_hostname": target.host},
        )
        response = await client.send(request, stream=True, follow_redirects=False)
        try:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_DOCUMENT_BYTES:
                    raise ValueError(
                        f"The document is larger than {MAX_DOCUMENT_BYTES} bytes."
                    )
        finally:
            await response.aclose()

    if response.status_code >= 400:
        raise ValueError(f"Fetching the document returned {response.status_code}.")

    import json

    try:
        document = json.loads(bytes(body))
    except ValueError as error:
        try:
            import yaml

            document = yaml.safe_load(bytes(body))
        except Exception:
            raise ValueError("The document is neither JSON nor YAML.") from error

    if not isinstance(document, dict):
        raise ValueError("The document is not an object.")
    return document


async def document_for(manifest: EngineManifest) -> Dict[str, Any]:
    """The OpenAPI document a manifest points at, inline or fetched.

    Whatever is fetched is stored on the row: verifying against one document
    and then solving against whatever the URL serves later would make the
    conformance report a statement about the past.
    """
    assert manifest.transport is not None
    source = manifest.transport.openapi
    if source.document is not None:
        return source.document
    return await fetch_document(source.url or "")


def parse_manifest(payload: Dict[str, Any], owner: User) -> EngineManifest:
    try:
        manifest = EngineManifest.model_validate(payload)
    except ValidationError as error:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "invalid_manifest",
            "The manifest is not valid.",
            violations=[
                {
                    "path": ".".join(str(part) for part in item["loc"]),
                    "message": item["msg"],
                    "code": item["type"],
                }
                for item in error.errors()
            ],
        ) from error

    if manifest.transport is None:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "no_transport",
            "A registered engine has to say where it is: add a transport block.",
        )
    return manifest


async def refresh_registry(session: AsyncSession) -> None:
    """Reload the cache so the change takes effect without a restart."""
    entries, _ = await load_entries(session)
    EngineRegistry.refresh_federated(entries)


async def owned_engine(engine_id: str, user: User, session: AsyncSession) -> FederatedEngine:
    """The engine, if this caller may act on it, or a 404.

    A 404 rather than a 403 for somebody else's engine: whether ``alice~tabu``
    exists is Alice's business, and the same rule already governs jobs.
    """
    row = (
        await session.execute(
            select(FederatedEngine)
            .options(selectinload(FederatedEngine.owner))
            .where(FederatedEngine.engine_id == engine_id)
        )
    ).scalar_one_or_none()

    if row is None or not (row.owner_id == user.id or user.is_admin):
        raise api_error(
            status.HTTP_404_NOT_FOUND, "engine_not_found", f"No engine called '{engine_id}'."
        )
    return row


async def store_credential(row: FederatedEngine, credential: Optional[str]) -> None:
    if credential is None:
        return
    store = CredentialStore.from_settings(get_settings())
    try:
        row.credential_encrypted = store.encrypt(credential)
    except SecretsUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "secrets_unavailable", str(error)
        ) from error


async def verify_row(row: FederatedEngine, manifest: EngineManifest) -> None:
    """Run the checks and write the outcome onto the row."""
    settings = get_settings()
    credential = None
    if row.credential_encrypted:
        credential = CredentialStore.from_settings(settings).decrypt(row.credential_encrypted)

    transport = FederatedTransport(
        manifest,
        row.openapi_document or {},
        credential=credential,
        require_https=settings.federation_require_https,
    )

    report = await run_verification(manifest, row.openapi_document or {}, transport)
    row.conformance_report = report.as_dict()
    if report.passed:
        row.status = EngineStatus.ACTIVE
        row.verified_at = utcnow()
        row.health_failures = 0
    else:
        row.status = EngineStatus.FAILED


# -- Drafting ---------------------------------------------------------------


@router.post(
    "/draft",
    response_model=DraftResponse,
    operation_id="draftEngineManifest",
    summary="Propose a manifest from an OpenAPI document",
    responses={401: UNAUTHORIZED_RESPONSE, 422: {"description": "The document could not be read"}},
)
async def draft(request: DraftRequest, user: User = Depends(get_current_user)) -> DraftResponse:
    """Read an engine's own spec and propose the manifest for it.

    This is the difference between registering an engine and authoring a
    document. The gateway works out which operation solves, where the instance
    belongs in the request, and which field of a solution is the binding - and
    says what each guess was based on, so the answer can be checked rather than
    trusted.

    What the document does not answer is listed rather than invented. An
    engine's own words for its job states, for instance, are not in its schema.
    """
    if (request.openapi_url is None) == (request.openapi_document is None):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "one_source",
            "Give either openapi_url or openapi_document.",
        )

    document = request.openapi_document
    if document is None:
        try:
            document = await fetch_document(request.openapi_url or "")
        except (ssrf.UnsafeUrl, ValueError) as error:
            raise api_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "document_unreadable", str(error)
            ) from error

    manifest, proposal = draft_manifest(
        document,
        engine_id=request.engine_id,
        display_name=request.display_name,
        openapi_url=request.openapi_url,
    )
    return DraftResponse(
        manifest=manifest,
        notes=proposal.notes,
        unresolved=proposal.unresolved,
        ready=proposal.is_complete,
    )


# -- Registration -----------------------------------------------------------


@router.post(
    "",
    response_model=EngineView,
    status_code=status.HTTP_201_CREATED,
    operation_id="registerEngine",
    summary="Register your own solver",
    responses={
        401: UNAUTHORIZED_RESPONSE,
        402: QUOTA_RESPONSE,
        409: CONFLICT_RESPONSE,
        503: UNAVAILABLE_RESPONSE,
    },
)
async def register_engine(
    request: RegisterEngineRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Submit a manifest, and find out straight away whether it works.

    The engine is registered either way. One that fails verification is stored
    with its conformance report and cannot be solved on until it passes - which
    is more useful than a rejection, because the report says what to change.
    """
    manifest = parse_manifest(request.manifest, user)
    engine_id = qualify(user.username, manifest.engine_id)

    existing = (
        await session.execute(
            select(FederatedEngine).where(FederatedEngine.engine_id == engine_id)
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "engine_exists",
            f"You already have an engine called '{manifest.engine_id}'.",
        )

    gate = get_gate()
    try:
        verdict = await gate.evaluate(
            user.id, "federatedEngines", {"federatedEnginesLimit": 1}
        )
        if not verdict.allowed:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "quota_exceeded",
                verdict.reason or "Your plan does not allow another engine.",
                quota=verdict.limit.__dict__ if verdict.limit else None,
            )
    except PricingUnavailable as error:
        if get_settings().space_fail_mode == "closed":
            raise api_error(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "pricing_unavailable",
                "Entitlements cannot be checked right now.",
            ) from error

    row = FederatedEngine(
        engine_id=engine_id,
        owner_id=user.id,
        display_name=manifest.display_name,
        manifest=manifest.model_dump(mode="json", exclude_none=True),
        status=EngineStatus.VERIFYING,
        visibility=(
            EngineVisibility.PENDING_REVIEW if request.publish else EngineVisibility.PRIVATE
        ),
    )
    await store_credential(row, request.credential)

    try:
        row.openapi_document = await document_for(manifest)
    except (ssrf.UnsafeUrl, ValueError, TransportError, httpx.HTTPError) as error:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "document_unreadable",
            f"The engine's OpenAPI document could not be read: {error}",
        ) from error

    session.add(row)
    await session.flush()

    await verify_row(row, manifest)
    await session.flush()
    await refresh_registry(session)

    return view_of(row, user.username)


@router.get(
    "/registered",
    response_model=List[EngineView],
    operation_id="listOwnEngines",
    summary="Engines you have registered",
    responses={401: UNAUTHORIZED_RESPONSE},
)
async def list_own_engines(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> List[EngineView]:
    """Your own registrations, whatever state they are in.

    Under ``/registered`` rather than at the collection root because
    ``GET /v1/engines`` is the public catalogue and answers for everybody; this
    one is about administering what you own, including the drafts and the
    failures that the catalogue does not show.
    """
    rows = (
        (
            await session.execute(
                select(FederatedEngine)
                .options(selectinload(FederatedEngine.owner))
                .where(FederatedEngine.owner_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    return [view_of(row, user.username) for row in rows]


@router.get(
    "/registered/{engine_id}",
    response_model=EngineView,
    operation_id="getRegisteredEngine",
    summary="One registration, with its conformance report",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def get_registered_engine(
    engine_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    return view_of(await owned_engine(engine_id, user, session))


@router.put(
    "/registered/{engine_id}",
    response_model=EngineView,
    operation_id="updateRegisteredEngine",
    summary="Change a registration, and re-verify it",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def update_registered_engine(
    engine_id: str,
    request: UpdateEngineRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Replace the manifest and check it again.

    Always re-verified: a manifest that changed is a set of claims that has
    not been checked, and letting an edit inherit the previous report would
    make ``verified_at`` a lie.
    """
    row = await owned_engine(engine_id, user, session)
    manifest = parse_manifest(request.manifest, user)

    row.manifest = manifest.model_dump(mode="json", exclude_none=True)
    row.display_name = manifest.display_name
    row.status = EngineStatus.VERIFYING
    row.verified_at = None
    await store_credential(row, request.credential)

    try:
        row.openapi_document = await document_for(manifest)
    except (ssrf.UnsafeUrl, ValueError, TransportError, httpx.HTTPError) as error:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "document_unreadable",
            f"The engine's OpenAPI document could not be read: {error}",
        ) from error

    await verify_row(row, manifest)
    await session.flush()
    await refresh_registry(session)
    return view_of(row)


@router.post(
    "/registered/{engine_id}/verify",
    response_model=EngineView,
    operation_id="verifyRegisteredEngine",
    summary="Run the conformance checks again",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def verify_registered_engine(
    engine_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Ask again, unchanged.

    For the ordinary case where a registration failed because the engine was
    not running yet.
    """
    row = await owned_engine(engine_id, user, session)
    manifest = EngineManifest.model_validate(row.manifest)
    row.status = EngineStatus.VERIFYING
    await verify_row(row, manifest)
    await session.flush()
    await refresh_registry(session)
    return view_of(row)


@router.post(
    "/registered/{engine_id}/credential",
    response_model=EngineView,
    operation_id="replaceEngineCredential",
    summary="Replace the stored credential",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def replace_credential(
    engine_id: str,
    request: CredentialRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Set a new secret. There is no endpoint that returns the old one."""
    row = await owned_engine(engine_id, user, session)
    await store_credential(row, request.credential)
    await session.flush()
    await refresh_registry(session)
    return view_of(row)


@router.post(
    "/registered/{engine_id}/publish",
    response_model=EngineView,
    operation_id="publishRegisteredEngine",
    summary="Ask for the engine to be listed publicly",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE, 409: CONFLICT_RESPONSE},
)
async def publish_registered_engine(
    engine_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Enter the review queue. Asking is not being published.

    Only a verified engine may ask: publishing one that does not pass its own
    conformance checks would put a broken engine in everybody's catalogue.
    """
    row = await owned_engine(engine_id, user, session)
    if row.status is not EngineStatus.ACTIVE:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "not_verified",
            "Only an engine that passes its conformance checks can be published.",
        )
    row.visibility = EngineVisibility.PENDING_REVIEW
    await session.flush()
    await refresh_registry(session)
    return view_of(row)


@router.delete(
    "/registered/{engine_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteRegisteredEngine",
    summary="Remove a registration",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def delete_registered_engine(
    engine_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> None:
    row = await owned_engine(engine_id, user, session)
    await session.delete(row)
    await session.flush()

    try:
        await get_gate().adjust_usage(user.id, {"federatedEnginesLimit": -1})
    except PricingUnavailable:
        # The allowance will be resynchronised; refusing the deletion because
        # the pricing service is down would leave the user unable to tidy up.
        pass

    await refresh_registry(session)


# -- Review -----------------------------------------------------------------

admin_router = APIRouter(prefix="/v1/admin/engines", tags=["Administration"])


@admin_router.get(
    "",
    response_model=List[EngineView],
    operation_id="listEnginesForReview",
    summary="Registered engines, for review",
    responses={401: UNAUTHORIZED_RESPONSE},
)
async def list_engines_for_review(
    pending: bool = False,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency),
) -> List[EngineView]:
    """Every registration, or only those asking to be published."""
    query = select(FederatedEngine).options(selectinload(FederatedEngine.owner))
    if pending:
        query = query.where(FederatedEngine.visibility == EngineVisibility.PENDING_REVIEW)
    rows = (await session.execute(query)).scalars().all()
    return [view_of(row) for row in rows]


@admin_router.post(
    "/{engine_id}/approve",
    response_model=EngineView,
    operation_id="approveEngine",
    summary="List an engine publicly",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE, 409: CONFLICT_RESPONSE},
)
async def approve_engine(
    engine_id: str,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    row = await owned_engine(engine_id, admin, session)
    if row.status is not EngineStatus.ACTIVE:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "not_verified",
            "This engine does not pass its own conformance checks.",
        )
    row.visibility = EngineVisibility.PUBLIC
    await session.flush()
    await refresh_registry(session)
    return view_of(row)


@admin_router.post(
    "/{engine_id}/reject",
    response_model=EngineView,
    operation_id="rejectEngine",
    summary="Refuse a publication request",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def reject_engine(
    engine_id: str,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Send it back to private. The engine keeps working for its owner."""
    row = await owned_engine(engine_id, admin, session)
    row.visibility = EngineVisibility.PRIVATE
    await session.flush()
    await refresh_registry(session)
    return view_of(row)


@admin_router.post(
    "/{engine_id}/disable",
    response_model=EngineView,
    operation_id="disableEngine",
    summary="Stop an engine being solved on",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def disable_engine(
    engine_id: str,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency),
) -> EngineView:
    """Turn it off without deleting it, so the owner can see what happened."""
    row = await owned_engine(engine_id, admin, session)
    row.status = EngineStatus.DISABLED
    row.visibility = EngineVisibility.PRIVATE
    await session.flush()
    await refresh_registry(session)
    return view_of(row)
