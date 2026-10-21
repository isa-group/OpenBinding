"""CAS login/link/unlink without ever placing a gateway token in a URL."""

from __future__ import annotations

import logging
import secrets
import uuid
from typing import Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access.dependencies import get_current_user, get_optional_user, session_dependency
from ..cas import CasPrincipal, get_cas_store, parse_service_validate
from ..core.public_errors import pricing_unavailable_error
from ..core.settings import Settings, get_settings
from ..db.models import AuditEvent, AuthIdentity, User
from ..models.accounts import CasSession, PlanChange
from ..models.errors import api_error
from ..security.passwords import hash_password
from .auth import _issue_session
from ..access.contracts import live_pricing_version

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/auth/cas", tags=["Authentication"])
identity_router = APIRouter(prefix="/v1/users/me/identities", tags=["Users"])

#: The closed list of values `GET /v1/auth/cas/callback` may put in `?error=`.
#: Stable: the frontend switches on them. Anything else collapses to `cas_error`.
CAS_ERROR_CODES = (
    "cas_unavailable",              # CAS login disabled, or the university's validation could not be reached
    "cas_state_invalid",            # the login state is missing, used, expired or unknown
    "cas_ticket_invalid",           # the ticket is missing or the university refused it
    "account_inactive",             # the account being signed in or linked is deactivated or gone
    "identity_in_use",              # that UVUS identity is already linked to another account
    "account_collision",            # a local account with the same username or email already exists
    "pricing_unavailable",          # the pricing service could not be reached
    "institutional_pricing_invalid",  # the live pricing has no RESEARCH plan
    "cas_error",                    # anything else
)


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


async def _upgrade_to_research(user: User, session: AsyncSession) -> PlanChange | None:
    """Move a default-plan account to RESEARCH; the change made, or ``None`` if there was none.

    Deliberate product rule (decided by the owner): linking a verified CAS
    identity is what entitles an account to RESEARCH, so the upgrade is
    automatic and costs nothing. An account on any other plan is left alone.
    The caller reports the returned change to the person (``plan_changed``).
    """
    settings = get_settings()
    default_plan = settings.space_default_plan
    if not default_plan:
        # Without a configured default plan there is no "default-plan account"
        # to upgrade; plans are SPACE's to assign.
        return None
    try:
        gate = space_client.get_gate()
        current = await gate.subscription(user.id)
        if current.plan != default_plan:
            return None
        # SPACE rejects the novation if the pricing version has no RESEARCH plan.
        await gate.change_plan(user.id, "RESEARCH", live_pricing_version(settings))
    except space_client.PricingUnavailable as exc:
        raise pricing_unavailable_error(exc, where="CAS research upgrade") from exc
    user.plan_cache = "RESEARCH"
    return PlanChange(from_plan=current.plan, to="RESEARCH", extra_cost=False)


def _frontend_redirect(settings: Settings, params: dict[str, str]) -> RedirectResponse:
    """Send the browser back to the frontend's CAS screen.

    The destination is always ``settings.frontend_url``; nothing from the
    request (query, headers, stored state) ever contributes to it, so the
    callback cannot be used as an open redirect.
    """
    location = f"{settings.frontend_url.rstrip('/')}/auth/cas/callback?{urlencode(params)}"
    return RedirectResponse(location, status_code=status.HTTP_303_SEE_OTHER)


def _redirect_error_code(error: BaseException) -> str:
    """Collapse any failure of the callback into the closed ``CAS_ERROR_CODES`` list."""
    if isinstance(error, HTTPException) and isinstance(error.detail, dict):
        code = error.detail.get("code")
        if code in CAS_ERROR_CODES:
            return code
    return "cas_error"


@router.get(
    "/callback",
    operation_id="completeUsCasValidation",
    status_code=status.HTTP_303_SEE_OTHER,
    response_class=RedirectResponse,
    summary="Complete the CAS round trip and return to the frontend",
    responses={
        303: {
            "description": (
                "Always a redirect to `{FRONTEND_URL}/auth/cas/callback`. On success the query carries "
                "`code` (one-time, exchange it at `POST /v1/auth/cas/exchange`) and, when linking CAS "
                "raised the account's plan, `plan_changed=<new plan>` (e.g. `RESEARCH`; the full "
                "`{from, to, extra_cost}` is in the exchange response). On failure the query carries "
                "`error=<code>` instead, where code is one of: " + ", ".join(f"`{code}`" for code in CAS_ERROR_CODES)
                + ". The destination comes from configuration only, never from the request."
            ),
            "headers": {"Location": {"description": "Frontend CAS callback URL.", "schema": {"type": "string"}}},
        }
    },
)
async def cas_callback(
    state: str | None = Query(default=None, description="The one-time state issued by `/start`."),
    ticket: str | None = Query(default=None, description="The CAS service ticket."),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    try:
        return await _complete_callback(state, ticket, session, settings)
    except Exception as error:  # every failure becomes a redirect with a stable code
        if not isinstance(error, HTTPException):
            # Unexpected (for example a failed flush): the session is unusable and,
            # now that no exception reaches the session wrapper, would commit what
            # was written before it. Every expected refusal (HTTPException) is
            # raised before the first write, so those need no rollback.
            await session.rollback()
            logger.exception("CAS callback failed unexpectedly")
        return _frontend_redirect(settings, {"error": _redirect_error_code(error)})


async def _complete_callback(
    state: str | None,
    ticket: str | None,
    session: AsyncSession,
    settings: Settings,
) -> RedirectResponse:
    _enabled(settings)
    if not state:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_state_invalid", "CAS state is missing.")
    stored = await get_cas_store(settings).pop("cas-state", state)
    if stored is None:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_state_invalid", "CAS state was used, expired or is invalid.")
    if not ticket:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_ticket_invalid", "The CAS ticket is missing.")
    principal = await _validated_principal(settings, state, ticket)
    identity = (await session.execute(select(AuthIdentity).where(
        AuthIdentity.provider == "us-cas", AuthIdentity.subject == principal.subject
    ))).scalars().first()
    mode = stored.get("mode")
    plan_changed: PlanChange | None = None
    if mode == "link":
        user = await session.get(User, uuid.UUID(stored["userId"]))
        if user is None or not user.is_active:
            raise api_error(status.HTTP_401_UNAUTHORIZED, "account_inactive", "The linking account no longer exists.")
        if identity is not None and identity.user_id != user.id:
            raise api_error(status.HTTP_409_CONFLICT, "identity_in_use", "That UVUS identity belongs to another account.")
        plan_changed = await _upgrade_to_research(user, session)
        if identity is None:
            identity = AuthIdentity(
                user_id=user.id, provider="us-cas", subject=principal.subject,
                attributes=principal.attributes,
            )
            session.add(identity)
            await session.flush()
            session.add(AuditEvent(
                actor_id=user.id,
                action="account.cas.linked",
                target_type="User",
                target_id=user.id,
                detail={
                    "provider": "us-cas",
                    "identity_id": str(identity.id),
                    "plan_changed": plan_changed.model_dump(by_alias=True) if plan_changed else None,
                },
            ))
        elif plan_changed is not None:
            session.add(AuditEvent(
                actor_id=user.id,
                action="account.cas.plan_changed",
                target_type="User",
                target_id=user.id,
                detail={"provider": "us-cas", "plan_changed": plan_changed.model_dump(by_alias=True)},
            ))
    elif identity is not None:
        user = await session.get(User, identity.user_id)
        if user is None or not user.is_active:
            raise api_error(status.HTTP_401_UNAUTHORIZED, "account_inactive", "That CAS account is inactive.")
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
                live_pricing_version(settings),
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
        "cas-exchange", code,
        {
            "userId": str(user.id),
            "planChanged": plan_changed.model_dump(by_alias=True) if plan_changed else None,
        },
        settings.cas_exchange_ttl_s,
    )
    params = {"code": code}
    if plan_changed is not None:
        params["plan_changed"] = plan_changed.to
    return _frontend_redirect(settings, params)


@router.post(
    "/exchange",
    response_model=CasSession,
    response_model_by_alias=True,
    operation_id="exchangeUsCasCode",
    summary="Exchange the one-time CAS code for a session",
)
async def exchange_cas_code(
    payload: CasExchange,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> CasSession:
    """The session tokens, plus ``plan_changed`` when this sign-in raised the plan.

    ``plan_changed`` is ``{from, to, extra_cost}`` (``extra_cost`` is always
    false: RESEARCH is part of the institutional agreement) and is null when the
    plan did not change.
    """
    _enabled(settings)
    value = await get_cas_store(settings).pop("cas-exchange", payload.code)
    if value is None:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "cas_code_invalid", "CAS code was used, expired or is invalid.")
    user = await session.get(User, uuid.UUID(value["userId"]))
    if user is None or not user.is_active:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "unauthorized", "That account is inactive.")
    tokens = await _issue_session(session, user, settings)
    planned = value.get("planChanged")
    return CasSession(
        **tokens.model_dump(),
        plan_changed=PlanChange.model_validate(planned) if planned else None,
    )


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
            raise pricing_unavailable_error(exc, where="CAS identity removal") from exc
    else:
        current = None
    if current is not None and current.plan == "RESEARCH":
        if confirmation != "DOWNGRADE RESEARCH":
            raise api_error(
                status.HTTP_409_CONFLICT,
                "research_downgrade_confirmation_required",
                "Type DOWNGRADE RESEARCH to remove US CAS and lose institutional access.",
            )
        settings = get_settings()
        default_plan = settings.space_default_plan
        if not default_plan:
            raise api_error(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "pricing_unavailable",
                "SPACE_DEFAULT_PLAN is not configured, so there is no plan to return this account to.",
            )
        try:
            await space_client.get_gate().change_plan(
                user.id, default_plan, live_pricing_version(settings)
            )
        except space_client.PricingUnavailable as exc:
            raise pricing_unavailable_error(exc, where="CAS research downgrade") from exc
        user.plan_cache = default_plan
    await session.delete(identity)
