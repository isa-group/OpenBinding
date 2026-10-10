"""Shared setup for the B1 authorization and integrity tests.

Not a test module (no ``test_`` prefix); the B1 test files import from it.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _pricing import fake_pricing_gate, largest_plan
from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    Artifact,
    ArtifactVersion,
    BindingCase,
    BindingCaseRevision,
    Blob,
    ProjectArtifact,
    User,
    UserRole,
)


@pytest.fixture
def gate():
    """A pricing gate whose plans the test controls."""
    previous = space_client.get_gate()
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(previous)


async def make_account(client, registration, db_session, gate, *, admin: bool = False):
    """Register and sign in; returns ``(account json, bearer headers)``."""
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    account = created.json()
    gate.plans[uuid.UUID(account["id"])] = largest_plan()
    if admin:
        user = (
            await db_session.execute(select(User).where(User.username == details["username"]))
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return account, {"Authorization": f"Bearer {login.json()['access_token']}"}


async def make_key(client, headers, permissions: list[str]) -> dict[str, str]:
    """Mint an API key with exactly these permissions; returns its headers."""
    response = await client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "b1 test key",
            "permissions": permissions,
            "engine_access": {"all": True, "engines": []},
            "boundary": {},
        },
    )
    assert response.status_code == 201, response.text
    return {"X-API-Key": response.json()["secret"]}


async def make_org(client, headers, slug: str | None = None, **extra) -> dict:
    slug = slug or f"b1-{uuid.uuid4().hex[:8]}"
    response = await client.post(
        "/v1/organizations", headers=headers, json={"slug": slug, "name": slug, **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def put_member(client, headers, org: str, user_id: str, role: str):
    return await client.put(
        f"/v1/organizations/{org}/members/{user_id}",
        headers=headers,
        json={"user_id": user_id, "role": role},
    )


SECRET = "secret-name"


def random_digest() -> str:
    return "sha256-" + uuid.uuid4().hex + uuid.uuid4().hex


async def add_blob(db, ctx, digest: str, *, project_id=None, public: bool = False) -> Blob:
    """A blob row without bytes; ``ctx`` carries ``org_id`` and ``user_id``."""
    row = Blob(
        organization_id=ctx.org_id, project_id=project_id, digest=digest, public=public,
        media_type="application/octet-stream", size_bytes=1,
        storage_uri=f"/nonexistent/{uuid.uuid4().hex}", created_by_id=ctx.user_id,
    )
    db.add(row)
    await db.flush()
    return row


async def add_version(db, ctx, *, kind: str, content_digest: str, blob: Blob | None = None,
                      project_id=None) -> tuple[Artifact, ArtifactVersion]:
    """A sealed library version (optionally part of a project) with the given content digest."""
    artifact = Artifact(
        organization_id=ctx.org_id, namespace=str(ctx.org_id), name=f"{SECRET}-{uuid.uuid4().hex[:8]}",
        display_name=f"{SECRET} display", kind=kind, created_by_id=ctx.user_id,
    )
    db.add(artifact)
    await db.flush()
    backing = blob or await add_blob(db, ctx, random_digest())
    version = ArtifactVersion(
        artifact_id=artifact.id, ordinal=1, version="1", blob_id=backing.id,
        content_digest=content_digest, version_digest=random_digest(), manifest={},
        created_by_id=ctx.user_id,
    )
    db.add(version)
    if project_id is not None:
        db.add(ProjectArtifact(project_id=project_id, artifact_id=artifact.id))
    await db.flush()
    return artifact, version


async def add_case_revision(db, ctx, *, digest: str, snapshot_id=None) -> BindingCaseRevision:
    case = BindingCase(
        project_id=ctx.project_id, slug=f"{SECRET}-case-{uuid.uuid4().hex[:6]}",
        name=f"{SECRET} case", created_by_id=ctx.user_id,
    )
    db.add(case)
    await db.flush()
    revision = BindingCaseRevision(
        binding_case_id=case.id, revision=1, digest=digest, document={},
        source_snapshot_id=snapshot_id, created_by_id=ctx.user_id,
    )
    db.add(revision)
    await db.flush()
    return revision


async def roles(client, headers, org: str) -> dict[str, str]:
    response = await client.get(f"/v1/organizations/{org}/members", headers=headers)
    assert response.status_code == 200, response.text
    return {row["user_id"]: row["role"] for row in response.json()}
