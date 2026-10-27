"""M9.6 keeps what was sealed or published: the data drop changes no answer about it.

A SQLite file is built with ``alembic upgrade b6c7d8e9f0a1`` and filled through the gateway (HTTP) and the
internal services that replaced the removed write routes (``_m96_seed.py``): two case revisions that pin
sealed library versions, a frozen published report, a draft report that carries a publication, a sealed but
unpublished report version, a project resource with two revisions, and one never-sealed draft report that
the migration removes. The answers are recorded, the database is exported and upgraded with the manifest
(as ``test_drop_retired_data_migration.py`` does), and the same answers are read again.
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


def report_document(title: str) -> dict:
    """A report document whose provenance is enough to seal it (no linked run)."""
    return {"title": title, "provenance": {
        "study": {"reference": f"urn:openbinding:study:{title}", "digest": "sha256-" + "b" * 64},
        "datasets": [{"reference": "urn:openbinding:dataset:checkout-v1", "digest": "sha256-" + "d" * 64}],
        "software": [{"name": "openbinding-gateway", "version": "1.0.0", "digest": "sha256-" + "c" * 64}],
        "bimVersion": "v1", "engineRevisions": ["sha256-" + "a" * 64], "parameters": {"seed": 7},
    }}


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
    from openbinding_gateway.db.models import User
    from openbinding_gateway.models.artifacts import ArtifactUse
    from openbinding_gateway.reports import new_report_draft

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

    # f1: frozen and published.
    f1 = await seed.report(session, project, alice, slug="f1", title="F1", document=report_document("f1"),
                           freeze=True)
    await seed.report_publication(session, f1, alice, slug="f1", citation={"doi": "10.0000/f1"})
    # d3: published at version 1, then returned to draft.
    d3 = await seed.report(session, project, alice, slug="d3", title="D3", document=report_document("d3"),
                           freeze=True)
    await seed.report_publication(session, d3, alice, slug="d3")
    d3_digest = d3.version.content_digest
    await new_report_draft(session, d3, await session.get(User, uuid.UUID(alice)))
    # d2: frozen at version 1, never published, then returned to draft.
    d2 = await seed.report(session, project, alice, slug="d2", title="D2", document=report_document("d2"),
                           freeze=True)
    d2_digest = d2.version.content_digest
    await new_report_draft(session, d2, await session.get(User, uuid.UUID(alice)))
    # d1: never sealed and never published, so the migration removes it.
    d1 = await seed.report(session, project, alice, slug="d1", title="D1", document=report_document("d1"))
    # r1: a project resource with two revisions.
    await seed.project_resource(session, project, alice, slug="r1", name="R1", kind="qos-offerings",
                                documents=[{"offers": [{"id": "edge-a", "latency": 20}]},
                                           {"offers": [{"id": "edge-a", "latency": 25}]}])
    await session.commit()
    assert d3.draft.sealed_version_id is None and d2.draft.sealed_version_id is None
    return {
        "headers": headers, "revisions": revisions,
        "f1": f1.version.content_digest, "d3": d3_digest, "d2": d2_digest,
        "report:d1": str(d1.id), "artifact:d1": str(d1.artifact_id),
        "report:d3": str(d3.id), "draft:d3": str(d3.draft_id),
    }


async def read_everything(client, ids: dict) -> dict:
    """Every answer the requirements compare, as ``{name: body}``; each one must be 200."""
    anonymous, member = {}, ids["headers"]
    calls = {
        **{f"case:{slug}": (f"/v1/resolve/case-revision/{revision['digest']}", anonymous)
           for slug, revision in ids["revisions"].items()},
        "report:f1": (f"/v1/resolve/report/{ids['f1']}", anonymous),
        "report:d3": (f"/v1/resolve/report/{ids['d3']}", anonymous),
        "report:d2": (f"/v1/resolve/report/{ids['d2']}", member),
        "publications": (f"{BASE}/publications", anonymous),
        "explore": ("/v1/explore/publications", anonymous),
        "resources": (f"{BASE}/resources", member),
        "revisions": (f"{BASE}/resources/r1/revisions", member),
        "library": (f"/v1/organizations/{ORG}/library", member),
        "reports": (f"{BASE}/reports", member),
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


def rows_exist(database: Path, ids: dict) -> dict[str, bool]:
    import sqlite3
    from contextlib import closing

    hexed = {name: uuid.UUID(ids[name]).hex for name in ("report:d1", "report:d3", "draft:d3")}
    with closing(sqlite3.connect(database)) as connection:
        def present(sql: str, value: str) -> bool:
            return connection.execute(sql, (value,)).fetchone() is not None

        return {
            "report:d1": present("SELECT 1 FROM reports WHERE id = ?", hexed["report:d1"]),
            "report:d3": present("SELECT 1 FROM reports WHERE id = ?", hexed["report:d3"]),
            "draft:d3": present("SELECT 1 FROM artifact_drafts WHERE id = ?", hexed["draft:d3"]),
            "publication:d3": present("SELECT 1 FROM publications WHERE report_id = ?", hexed["report:d3"]),
        }


# [utest->req~data-retirement-sealed-ir-unchanged~1]
# [utest->req~data-retirement-publications-answer~1]
# [utest->req~data-retirement-kept-set~1]
# [utest->req~collaboration-artifacts-resources-read-only~1]
async def test_sealed_and_published_data_answer_the_same_after_the_upgrade(tmp_path, monkeypatch, registration):
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
        assert rows_exist(database, ids) == dict.fromkeys(("report:d1", "report:d3", "draft:d3", "publication:d3"), True)

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
            assert before[f"case:{slug}"]["verified"] is True and after[f"case:{slug}"]["verified"] is True
        # Publications and sealed report versions: the same bodies.
        for name in ("case:c1", "case:c2", "report:f1", "report:d3", "report:d2", "publications", "explore",
                     "resources", "revisions"):
            assert after[name] == before[name], name
        assert {item["slug"] for item in before["publications"]} == {"f1", "d3"}
        assert {item["slug"] for item in before["explore"]} == {"f1", "d3"}
        assert len(before["revisions"]) == 2
        # Only the never-sealed draft report d1 and its artifact are gone.
        assert after["reports"] == [item for item in before["reports"] if item["id"] != ids["report:d1"]]
        assert len(after["reports"]) == len(before["reports"]) - 1
        assert after["library"] == [item for item in before["library"] if item["id"] != ids["artifact:d1"]]
        assert len(after["library"]) == len(before["library"]) - 1
        assert rows_exist(database, ids) == {
            "report:d1": False, "report:d3": True, "draft:d3": True, "publication:d3": True}
    finally:
        public_read.reset_rate_limits()
        get_settings.cache_clear()
