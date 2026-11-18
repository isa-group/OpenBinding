"""An organization's connection to SPHERE: a write-only, encrypted API key (``org_connections``).

``put_sphere_key`` checks the key's form (``sk-`` and 64 hexadecimal characters), asks SPHERE who it is
(``/users/me``) outside any transaction, and stores the key encrypted with the deployment's Fernet keys
(``security/secrets.CredentialStore``) together with only the SPHERE user id, the username, the key's scopes
and its expiry; every other field of ``/users/me`` (the email included) is dropped before anything is logged
or stored. The key is decrypted only inside ``credential_for`` for one call and is never returned.

Which keys read private pricings is SPHERE's to enforce: a MANAGEMENT or ALL key of an organization ADMIN or
OWNER reads every private version of it; a VIEW key reads a private pricing only with an explicit grant.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import status
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....core import revision as etags
from ....core.settings import get_settings
from ....db.models import OrgConnection, User
from ....models.errors import api_error
from ....security.secrets import CredentialStore, SecretsUnavailable
from ...shared.application import audit
from ..domain.sources import DEFAULT_ENDPOINT, Credential
from .pricing_source import (
    CredentialRejected,
    PricingSourceBusy,
    PricingSourceUnavailable,
    get_pricing_source,
)

logger = logging.getLogger(__name__)

SPHERE_KEY = re.compile(r"^sk-[0-9a-f]{64}$")
SPHERE = "sphere"


@dataclass(frozen=True)
class ConnectionView:
    kind: str
    status: str
    username: str | None
    scopes: list[dict[str, str]] | None
    key_hint: str
    validated_at: datetime | None
    expires_at: str | None
    etag: str


def view(row: OrgConnection) -> ConnectionView:
    return ConnectionView(
        kind=row.kind,
        status=row.status,
        username=row.sphere_username,
        scopes=list(row.scopes) if row.scopes is not None else None,
        key_hint=row.key_hint,
        validated_at=row.validated_at,
        expires_at=row.expires_at,
        etag=etags.etag_for(row),
    )


def _store() -> CredentialStore:
    store = CredentialStore.from_settings(get_settings())
    if not store.available:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "secrets_unavailable",
            "This deployment cannot keep secrets (SECRETS_FERNET_KEYS is not set).",
        )
    return store


async def list_connections(session: AsyncSession, organization_id: uuid.UUID) -> list[OrgConnection]:
    return list(await session.scalars(
        select(OrgConnection).where(OrgConnection.organization_id == organization_id).order_by(OrgConnection.kind)
    ))


async def get_connection(session: AsyncSession, organization_id: uuid.UUID, kind: str = SPHERE) -> OrgConnection | None:
    return await session.scalar(
        select(OrgConnection).where(OrgConnection.organization_id == organization_id, OrgConnection.kind == kind)
    )


async def put_sphere_key(
    session: AsyncSession, organization_id: uuid.UUID, api_key: str, caller: User, if_match: str | None
) -> OrgConnection:
    """Validate ``api_key`` with SPHERE and keep it, encrypted, as the organization's connection."""
    if not isinstance(api_key, str) or not SPHERE_KEY.fullmatch(api_key):
        raise api_error(
            422, "sphere_key_malformed",
            "A SPHERE API key is 'sk-' followed by 64 hexadecimal characters.",
        )
    store = _store()
    existing = await get_connection(session, organization_id)
    if existing is not None:
        etags.precondition(existing, if_match)
    if session.in_transaction():
        await session.commit()
    try:
        user = await get_pricing_source().whoami(DEFAULT_ENDPOINT, Credential(str(organization_id), api_key))
    except CredentialRejected as exc:
        raise api_error(
            422, "sphere_key_rejected", "SPHERE does not accept this API key."
        ) from exc
    except PricingSourceBusy as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "sphere_busy", "SPHERE is busy; try again later.",
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except PricingSourceUnavailable as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "sphere_unavailable", "SPHERE cannot be reached right now."
        ) from exc
    try:
        secret = store.encrypt(api_key)
    except SecretsUnavailable as exc:  # pragma: no cover - checked by _store above
        raise api_error(503, "secrets_unavailable", "This deployment cannot keep secrets.") from exc
    scopes = [{"organizationId": org, "scope": scope} for org, scope in user.scopes] if user.scopes is not None else None
    now = datetime.now(timezone.utc)
    row = await get_connection(session, organization_id)
    if row is None:
        row = OrgConnection(organization_id=organization_id, kind=SPHERE, created_by_id=caller.id)
        session.add(row)
    else:
        await etags.guard(session, row, if_match)
    row.secret = secret
    row.key_hint = api_key[-4:]
    row.sphere_user_id = user.id[:64]
    row.sphere_username = user.username[:120]
    row.scopes = scopes
    row.expires_at = user.expires_at
    row.status = "active"
    row.last_error = None
    row.validated_at = now
    row.updated_at = now
    await session.flush()
    audit(session, caller, "organization.connection_set", "OrgConnection", row.id, organization_id, kind=SPHERE)
    await session.commit()
    logger.info("organization_connection_set organization=%s kind=sphere", organization_id)
    return row


async def delete_connection(session: AsyncSession, organization_id: uuid.UUID, caller: User, kind: str = SPHERE) -> bool:
    row = await get_connection(session, organization_id, kind)
    if row is None:
        return False
    audit(session, caller, "organization.connection_removed", "OrgConnection", row.id, organization_id, kind=kind)
    await session.execute(delete(OrgConnection).where(OrgConnection.id == row.id))
    await session.commit()
    return True


async def mark_invalid(session: AsyncSession, organization_id: uuid.UUID, reason: str = "rejected by SPHERE") -> None:
    """Mark the organization's SPHERE connection invalid (its own short transaction)."""
    await session.execute(
        update(OrgConnection)
        .where(OrgConnection.organization_id == organization_id, OrgConnection.kind == SPHERE)
        .values(status="invalid", last_error=reason[:240], updated_at=datetime.now(timezone.utc))
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    logger.info("organization_connection_invalid organization=%s", organization_id)


async def credential_for(session: AsyncSession, organization_id: uuid.UUID) -> Credential | None:
    """The organization's active SPHERE key, decrypted for one call, or ``None``.

    A 401 on it marks the connection invalid (``Credential.on_rejected``), and the read is retried anonymously.
    """
    row = await get_connection(session, organization_id)
    if row is None or row.status != "active":
        return None
    try:
        key = CredentialStore.from_settings(get_settings()).decrypt(row.secret)
    except SecretsUnavailable:
        logger.warning("organization_connection_undecryptable organization=%s", organization_id)
        return None

    async def rejected() -> None:
        await mark_invalid(session, organization_id)

    return Credential(str(organization_id), key, rejected)
