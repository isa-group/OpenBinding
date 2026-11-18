"""Organization connections on PostgreSQL: one per organization and kind, never moved, only ciphertext stored,
and a replace under a stale ``If-Match`` refused.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import uuid

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from openbinding_gateway.core import revision as etags
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Organization, OrgConnection, User
from openbinding_gateway.modules.plans.application import connections
from sphere_recorded import RecordedSphere, sfx_bytes

pytestmark = pytest.mark.asyncio

KEY = "sk-" + "1" * 64


async def _org(session) -> tuple[User, Organization]:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
    session.add(organization)
    await session.commit()
    return user, organization


@pytest.fixture
def fernet(monkeypatch):
    monkeypatch.setattr(get_settings(), "secrets_fernet_keys", Fernet.generate_key().decode())


async def test_one_connection_per_organization_and_kind_never_moved(pg, sphere: RecordedSphere, fernet) -> None:
    sphere.serve("/api/v1/users/me", sfx_bytes("users-me.json"), {"content-type": "application/json"})
    async with pg.session() as session:
        user, organization = await _org(session)
        _, other = await _org(session)
        row = await connections.put_sphere_key(session, organization.id, KEY, user, None)
        stored = await session.scalar(text("SELECT secret FROM org_connections WHERE id = :id").bindparams(id=row.id))
        assert KEY not in stored
        session.add(OrgConnection(organization_id=organization.id, kind="sphere", secret="x", key_hint="x"))
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()
        with pytest.raises(DBAPIError):
            await session.execute(update(OrgConnection).where(OrgConnection.id == row.id).values(organization_id=other.id))
        await session.rollback()


async def test_a_replace_under_a_stale_if_match_is_refused(pg, sphere: RecordedSphere, fernet) -> None:
    sphere.serve("/api/v1/users/me", sfx_bytes("users-me.json"), {"content-type": "application/json"})
    async with pg.session() as session:
        user, organization = await _org(session)
        row = await connections.put_sphere_key(session, organization.id, KEY, user, None)
        stale = etags.etag_for(row)
        await connections.put_sphere_key(session, organization.id, "sk-" + "2" * 64, user, stale)
        with pytest.raises(HTTPException) as refused:
            await connections.put_sphere_key(session, organization.id, "sk-" + "3" * 64, user, stale)
        assert refused.value.status_code == 412
        current = await session.scalar(select(OrgConnection).where(OrgConnection.organization_id == organization.id))
        assert current.key_hint == "2222"
