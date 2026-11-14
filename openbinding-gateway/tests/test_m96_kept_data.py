"""M9.6 keeps what was sealed: the data drop changes no answer about it.

A SQLite file is built with ``alembic upgrade b6c7d8e9f0a1`` and filled through the gateway (HTTP) and the
internal services that replaced the removed write routes (``_m96_seed.py``): two case revisions that pin
sealed library versions and a project resource with two revisions. The answers are recorded, the database
is exported and upgraded with the manifest (as ``test_drop_retired_data_migration.py`` does), and the same
answers are read again.
"""

from __future__ import annotations

import copy
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import _m96_seed as seed
from _pricing import largest_plan
from openbinding_gateway import space_client
from openbinding_gateway.access import public_read
from openbinding_gateway.core.settings import get_settings
from test_drop_retired_data_migration import upgrade, version
from test_export_retired_data import HEAD, MIGRATION, build_template, export_run, sqlite_url

ORG, PROJECT = "isa-demo", "p1"
BASE = f"/v1/organizations/{ORG}/projects/{PROJECT}"


@asynccontextmanager
async def gateway(database: Path):
    """The gateway over HTTP and one session, both on the SQLite file; nothing is left open afterwards."""
    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.main import app

    engine = create_async_engine(sqlite_url(database), poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            async def override():
                yield session

            app.dependency_overrides[session_dependency] = override
            app.dependency_overrides[optional_session] = override
            try:
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
                    yield client, session
            finally:
                app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def sign_up(client, registration) -> tuple[str, dict[str, str]]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    assert login.status_code == 200, login.text
    space_client.get_gate().plans[uuid.UUID(created.json()["id"])] = largest_plan()
    return created.json()["id"], {"Authorization": f"Bearer {login.json()['access_token']}"}


async def populate(client, session, registration) -> dict:
    """Everything the requirements name, created at b6c7d8e9f0a1; returns the ids and digests to read back."""
    from test_artifacts_platform import multi_resource_package

    from openbinding_gateway.artifacts import reference
    from openbinding_gateway.models.artifacts import ArtifactUse

    alice, headers = await sign_up(client, registration)
    created = await client.post("/v1/organizations", headers=headers, json={"slug": ORG, "name": "ISA"})
    assert created.status_code == 201, created.text
    created = await client.post(f"/v1/organizations/{ORG}/projects", headers=headers,
                                json={"slug": PROJECT, "name": "P1", "visibility": "public"})
    assert created.status_code == 201, created.text
    project = await seed.project_by_slugs(session, ORG, PROJECT)

    # Two case revisions that pin sealed library versions; the second pins a second version of one catalog.
    package = multi_resource_package()
    root = package.instance()
    uses, artifacts, documents = [], {}, {}
    for role, resources in root["spec"]["resources"].items():
        for alias, path in resources.items():
            document = json.loads(package.files[path])
            artifact = await seed.library_artifact(session, project.organization_id, alice, name=alias,
                                                   kind=document["kind"])
            sealed = await seed.seal(session, artifact, alice, document)
            uses.append(ArtifactUse(role=role, alias=alias, artifact=reference(artifact, sealed)))
            artifacts[alias], documents[alias] = artifact, document
    changed = copy.deepcopy(documents["cat-a"])
    changed["spec"]["candidates"]["c1"]["features"]["latency"] += 1
    second = await seed.seal(session, artifacts["cat-a"], alice, changed)
    other_uses = [ArtifactUse(role=use.role, alias=use.alias, artifact=reference(artifacts["cat-a"], second))
                  if use.alias == "cat-a" else use for use in uses]
    revisions = {}
    for slug, chosen in (("c1", uses), ("c2", other_uses)):
        case = await client.post(f"{BASE}/cases", headers=headers, json={"slug": slug, "name": slug.upper()})
        assert case.status_code == 201, case.text
        revision = await client.post(f"{BASE}/cases/{slug}/revisions", headers=headers, json={
            "document": root, "resources": [use.model_dump(mode="json") for use in chosen]})
        assert revision.status_code == 201, revision.text
        revisions[slug] = revision.json()
    assert revisions["c1"]["digest"] != revisions["c2"]["digest"]

    # r1: a project resource with two revisions.
    await seed.project_resource(session, project, alice, slug="r1", name="R1", kind="qos-offerings",
                                documents=[{"offers": [{"id": "edge-a", "latency": 20}]},
                                           {"offers": [{"id": "edge-a", "latency": 25}]}])
    await session.commit()
    return {"headers": headers, "revisions": revisions}


async def read_everything(client, ids: dict) -> dict:
    """Every answer the requirements compare, as ``{name: body}``; each one must be 200."""
    member = ids["headers"]
    calls = {
        **{f"case:{slug}": (f"{BASE}/cases/{slug}/revisions", member) for slug in ids["revisions"]},
        "resources": (f"{BASE}/resources", member),
        "revisions": (f"{BASE}/resources/r1/revisions", member),
        "library": (f"/v1/organizations/{ORG}/library", member),
    }
    bodies = {}
    for name, (path, headers) in calls.items():
        response = await client.get(path, headers=headers)
        assert response.status_code == 200, (name, response.status_code, response.text)
        bodies[name] = response.json()
    return bodies


async def recompile(session, revision_id: str) -> tuple[str, str]:
    """Compile a case revision again from the versions it pins; return the new and the stored IR digest.

    The composition goes through ``materialize_case``, the path that compiled it when it was created; the
    compilation is captured from ``compile_resolved`` and the session is rolled back afterwards.
    """
    from openbinding_gateway.artifacts import materialize_case, reference
    from openbinding_gateway.db.models import (
        Artifact,
        ArtifactVersion,
        BindingCase,
        BindingCaseRevision,
        BindingIRSnapshot,
        CaseArtifact,
        Organization,
        Project,
        User,
    )
    from openbinding_gateway.models.artifacts import ArtifactUse
    from openbinding_gateway.services import snapshots

    revision = await session.get(BindingCaseRevision, uuid.UUID(revision_id))
    case = await session.get(BindingCase, revision.binding_case_id)
    project = await session.get(Project, case.project_id)
    organization = await session.get(Organization, project.organization_id)
    user = await session.get(User, revision.created_by_id)
    pinned = {row.alias: row for row in (await session.scalars(
        select(CaseArtifact).where(CaseArtifact.revision_id == revision.id))).all()}
    uses = []
    for resources in revision.document["spec"]["resources"].values():
        for alias in resources:
            row = pinned.pop(alias)
            version_row = await session.get(ArtifactVersion, row.version_id)
            artifact = await session.get(Artifact, version_row.artifact_id)
            uses.append(ArtifactUse(role=row.role, alias=alias, artifact=reference(artifact, version_row),
                                    bindings=row.bindings))
    assert not pinned and uses
    stored = await session.scalar(
        select(BindingIRSnapshot.ir_digest).where(BindingIRSnapshot.snapshot_id == revision.source_snapshot_id))
    compiled = []
    original = snapshots.compile_resolved

    async def capture(*arguments, **keywords):
        compiled.append(await original(*arguments, **keywords))
        return compiled[-1]

    snapshots.compile_resolved = capture
    try:
        await materialize_case(session, user, organization, copy.deepcopy(revision.document), uses)
    finally:
        snapshots.compile_resolved = original
        await session.rollback()
    assert len(compiled) == 1
    return compiled[0].ir_digest, stored


async def test_sealed_data_answers_the_same_after_the_upgrade(tmp_path, monkeypatch, registration):
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()
    # Anonymous reads of a public project are counted per client address for the whole process.
    public_read.reset_rate_limits()
    try:
        database = build_template(tmp_path / "db")
        async with gateway(database) as (client, session):
            ids = await populate(client, session, registration)
            before = await read_everything(client, ids)
            ir_before = {slug: await recompile(session, revision["id"]) for slug, revision in ids["revisions"].items()}

        exported = export_run(sqlite_url(database), tmp_path / "export" / "m96")
        assert exported.returncode == 0, exported.stderr
        assert version(database) == [HEAD]
        upgraded = upgrade(database, tmp_path / "export" / "m96" / "manifest.json")
        assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
        assert version(database) == [MIGRATION]

        async with gateway(database) as (client, session):
            after = await read_everything(client, ids)
            ir_after = {slug: await recompile(session, revision["id"]) for slug, revision in ids["revisions"].items()}

        # Sealed problem versions: the same IR digest as the stored snapshot, before and after the upgrade.
        for slug in ids["revisions"]:
            assert ir_before[slug][0] == ir_before[slug][1], slug
            assert ir_after[slug] == ir_before[slug], slug
        assert ir_before["c1"][0] != ir_before["c2"][0]
        for slug in ids["revisions"]:
            assert ids["revisions"][slug]["digest"] in {row["digest"] for row in before[f"case:{slug}"]}
        # Sealed versions and resources: the same bodies.
        for name in ("case:c1", "case:c2", "resources", "revisions", "library"):
            assert after[name] == before[name], name
        assert len(before["revisions"]) == 2
    finally:
        public_read.reset_rate_limits()
        get_settings.cache_clear()
