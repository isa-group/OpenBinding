"""CAS login/link/unlink without ever placing a gateway token in a URL."""

from __future__ import annotations

import secrets
import uuid
from typing import Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access.dependencies import get_current_user, get_optional_user, session_dependency
from ..cas import CasPrincipal, get_cas_store, parse_service_validate
from ..core.settings import Settings, get_settings
from ..db.models import AuthIdentity, User
from ..models.accounts import TokenPair
from ..models.errors import api_error
from ..security.passwords import hash_password
from .auth import _issue_session
from ..pricing_catalog import PricingCatalogError, live_catalog

router = APIRouter(prefix="/v1/auth/cas", tags=["Authentication"])
identity_router = APIRouter(prefix="/v1/users/me/identities", tags=["Users"])


class CasExchange(BaseModel):
    code: str = Field(..., min_length=32)


class CasLinkIntent(BaseModel):
    url: str


def _enabled(settings: Settings) -> None:
    if not settings.cas_enabled:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "cas_unavailable", "CAS login is not enabled.")


def _service(settings: Settings, state: str) -> str:
    return f"{settings.public_base_url.rstrip('/')}/api/v1/auth/cas/callback?{urlencode({'state': state})}"


@router.get(
    "/start",
    operation_id="startUsCasLogin",
    status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    response_class=RedirectResponse,
)
async def start_cas(
    mode: Literal["login", "link"] = Query(default="login"),
    intent: str | None = Query(default=None),
    current: User | None = Depends(get_optional_user),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    _enabled(settings)
    linking_user_id = str(current.id) if current else None
    if mode == "link" and current is None:
        stored_intent = (
            await get_cas_store(settings).pop("cas-link-intent", intent)
            if intent
            else None
        )
        linking_user_id = stored_intent.get("userId") if stored_intent else None
        if linking_user_id is None:
            raise api_error(
                status.HTTP_401_UNAUTHORIZED,
                "cas_link_intent_invalid",
                "The CAS link intent was used, expired or is invalid.",
            )
    state = secrets.token_urlsafe(32)
    store = get_cas_store(settings)
    await store.put(
        "cas-state", state,
        {"mode": mode, "userId": linking_user_id},
        settings.cas_state_ttl_s,
    )
    location = f"{settings.effective_cas_base_url}/login?{urlencode({'service': _service(settings, state)})}"
    return RedirectResponse(location, status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.post("/link-intent", response_model=CasLinkIntent, operation_id="createUsCasLinkIntent")
async def create_link_intent(
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> CasLinkIntent:
    """Mint a one-use navigation URL without putting a JWT in the browser URL."""
    _enabled(settings)
    intent = secrets.token_urlsafe(32)
    await get_cas_store(settings).put(
        "cas-link-intent",
        intent,
        {"userId": str(user.id)},
        settings.cas_state_ttl_s,
    )
    return CasLinkIntent(
        url=f"/api/v1/auth/cas/start?{urlencode({'mode': 'link', 'intent': intent})}"
    )


async def _validated_principal(settings: Settings, state: str, ticket: str) -> CasPrincipal:
    url = f"{settings.effective_cas_base_url}/serviceValidate"
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.get(url, params={"service": _service(settings, state), "ticket": ticket})
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "cas_unavailable", "CAS validation is unavailable.") from exc
    try:
        return parse_service_validate(response.content)
    except ValueError as exc:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_ticket_invalid", str(exc)) from exc


def _attribute(principal: CasPrincipal, *names: str) -> str | None:
    for name in names:
        value = principal.attributes.get(name.casefold())
        if value:
            return value
    return None


async def _upgrade_to_research(user: User, session: AsyncSession) -> None:
    try:
        catalog = await live_catalog(session, get_settings())
    except PricingCatalogError as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    if "RESEARCH" not in catalog.plans:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "institutional_pricing_invalid",
            "The active iPricing must declare the CAS-only RESEARCH plan.",
        )
    try:
        gate = space_client.get_gate()
        current = await gate.subscription(user.id)
        if current.plan != catalog.default_plan:
            return
        await gate.change_plan(
            user.id, "RESEARCH", catalog.version
        )
    except space_client.PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    user.plan_cache = "RESEARCH"


@router.get(
    "/callback",
    operation_id="completeUsCasValidation",
    status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    response_class=RedirectResponse,
)
async def cas_callback(
    state: str,
    ticket: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    _enabled(settings)
    stored = await get_cas_store(settings).pop("cas-state", state)
    if stored is None:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_state_invalid", "CAS state was used, expired or is invalid.")
    principal = await _validated_principal(settings, state, ticket)
    identity = (await session.execute(select(AuthIdentity).where(
        AuthIdentity.provider == "us-cas", AuthIdentity.subject == principal.subject
    ))).scalars().first()
    mode = stored.get("mode")
    if mode == "link":
        user = await session.get(User, uuid.UUID(stored["userId"]))
        if user is None or not user.is_active:
            raise api_error(status.HTTP_401_UNAUTHORIZED, "unauthorized", "The linking account no longer exists.")
        if identity is not None and identity.user_id != user.id:
            raise api_error(status.HTTP_409_CONFLICT, "identity_in_use", "That UVUS identity belongs to another account.")
        await _upgrade_to_research(user, session)
        if identity is None:
            session.add(AuthIdentity(
                user_id=user.id, provider="us-cas", subject=principal.subject,
                attributes=principal.attributes,
            ))
    elif identity is not None:
        user = await session.get(User, identity.user_id)
        if user is None or not user.is_active:
            raise api_error(status.HTTP_401_UNAUTHORIZED, "unauthorized", "That CAS account is inactive.")
    else:
        username = principal.subject.casefold()
        email = (_attribute(principal, "mail", "email", "correo") or f"{username}@identity.openbinding.invalid").casefold()
        collision = await session.scalar(select(func.count(User.id)).where(
            (User.username == username) | (User.email == email)
        ))
        if collision:
            # Deliberately never auto-link by email: the existing account must
            # authenticate and start a link flow itself.
            raise api_error(status.HTTP_409_CONFLICT, "account_collision", "Sign in to the existing account and link CAS explicitly.")
        try:
            catalog = await live_catalog(session, settings)
        except PricingCatalogError as exc:
            raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
        if "RESEARCH" not in catalog.plans:
            raise api_error(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "institutional_pricing_invalid",
                "The active iPricing must declare the CAS-only RESEARCH plan.",
            )
        user = User(
            username=username, email=email,
            password_hash=hash_password(secrets.token_urlsafe(48)), password_enabled=False,
            plan_cache="RESEARCH", contract_pending=True,
        )
        session.add(user)
        await session.flush()
        try:
            await space_client.get_gate().create_contract(
                user.id,
                "RESEARCH",
                user.email,
                catalog.version,
            )
            user.contract_pending = False
        except space_client.PricingUnavailable:
            user.contract_pending = True
        session.add(AuthIdentity(
            user_id=user.id, provider="us-cas", subject=principal.subject,
            attributes=principal.attributes,
        ))
    await session.flush()
    code = secrets.token_urlsafe(32)
    await get_cas_store(settings).put(
        "cas-exchange", code, {"userId": str(user.id)}, settings.cas_exchange_ttl_s
    )
    location = f"{settings.frontend_url.rstrip('/')}/auth/cas/callback?{urlencode({'code': code})}"
    return RedirectResponse(location, status_code=status.HTTP_303_SEE_OTHER)


@router.post("/exchange", response_model=TokenPair, operation_id="exchangeUsCasCode")
async def exchange_cas_code(
    payload: CasExchange,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> TokenPair:
    _enabled(settings)
    value = await get_cas_store(settings).pop("cas-exchange", payload.code)
    if value is None:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_code_invalid", "CAS code was used, expired or is invalid.")
    user = await session.get(User, uuid.UUID(value["userId"]))
    if user is None or not user.is_active:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "unauthorized", "That account is inactive.")
    return await _issue_session(session, user, settings)


@identity_router.get("", operation_id="listOwnIdentities")
async def list_identities(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[dict]:
    rows = (await session.execute(select(AuthIdentity).where(AuthIdentity.user_id == user.id))).scalars().all()
    return [{"id": str(row.id), "provider": row.provider, "subject": row.subject, "verifiedAt": row.verified_at} for row in rows]


@identity_router.delete("/{identity_id}", status_code=204, operation_id="unlinkOwnIdentity")
async def unlink_identity(
    identity_id: uuid.UUID,
    confirmation: str | None = Query(
        default=None,
        description="Type DOWNGRADE RESEARCH when unlinking US CAS from RESEARCH.",
    ),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    identity = await session.get(AuthIdentity, identity_id)
    if identity is None or identity.user_id != user.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Identity not found.")
    others = int(await session.scalar(select(func.count(AuthIdentity.id)).where(
        AuthIdentity.user_id == user.id, AuthIdentity.id != identity.id
    )) or 0)
    if not user.password_enabled and others == 0:
        raise api_error(status.HTTP_409_CONFLICT, "last_login_method", "Set a password before removing the last external identity.")
    if identity.provider == "us-cas":
        try:
            current = await space_client.get_gate().subscription(user.id)
        except space_client.PricingUnavailable as exc:
            raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    else:
        current = None
    if current is not None and current.plan == "RESEARCH":
        if confirmation != "DOWNGRADE RESEARCH":
            raise api_error(
                status.HTTP_409_CONFLICT,
                "research_downgrade_confirmation_required",
                "Type DOWNGRADE RESEARCH to remove US CAS and lose institutional access.",
            )
        try:
            catalog = await live_catalog(session, get_settings())
            await space_client.get_gate().change_plan(
                user.id, catalog.default_plan, catalog.version
            )
        except (space_client.PricingUnavailable, PricingCatalogError) as exc:
            raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
        user.plan_cache = catalog.default_plan
    await session.delete(identity)
