"""B2 #7: ``web_url`` points at screens that exist today, or is null.

The frontend's route table (``frontend/src/routes/d*.tsx``) is the source of
truth, so the contract test below reads it: every link the resolver produces
must match one of its ``live(id, path, ...)`` definitions.
"""

from __future__ import annotations

import re
import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    DialectRevision,
    EngineRevision,
    Project,
    RegisteredResourceRevision,
    User,
)
from openbinding_gateway.db.platform_models import Report, ReportState
from openbinding_gateway.routes import resolve as resolve_routes
from openbinding_gateway.v1.package import load_package
from _pricing import fake_pricing_gate, largest_plan
from _repo import REPO_ROOT

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from seed_analysis import analysis_link, report_link  # noqa: E402

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
ROUTES = sorted((REPO_ROOT / "frontend" / "src" / "routes").glob("d[0-9].tsx"))


def frontend_patterns() -> list[re.Pattern]:
    paths = []
    for route_file in ROUTES:
        paths += re.findall(r"live\('[^']+', '([^']+)'", route_file.read_text(encoding="utf-8"))
    return [re.compile("^" + re.sub(r":[A-Za-z]+", "[^/]+", path) + "$") for path in paths]


def assert_is_a_frontend_screen(url: str) -> None:
    if not ROUTES:
        pytest.skip("the frontend route table is not part of this checkout")
    path = url.split("?", 1)[0]
    assert any(pattern.match(path) for pattern in frontend_patterns()), f"{url} matches no frontend route"


# -- the helpers -------------------------------------------------------------


def test_each_helper_builds_the_current_frontend_route():
    snapshot = uuid.uuid4()
    artifact = uuid.uuid4()
    expected = {
        resolve_routes.case_revision_url("lab", "routing", "baseline", 3):
            "/app/lab/routing/cases/baseline/revisions/3",
        resolve_routes.library_version_url("lab", artifact, "2"):
            f"/app/lab/library/{artifact}/versions/2",
        resolve_routes.report_url("lab", "routing", "decision-1"): "/app/lab/routing/reports/decision-1",
        resolve_routes.collection_url("lab", "routing", "set-a"): "/app/lab/routing/collections/set-a",
        resolve_routes.project_files_url("lab", "routing"): "/app/lab/routing/files",
        resolve_routes.engine_url("acme", "solver", "1.2.0"): "/engines/acme/solver/1.2.0",
        resolve_routes.snapshot_url("lab", "routing", snapshot): f"/app/lab/routing/snapshots/{snapshot}",
    }
    for produced, wanted in expected.items():
        assert produced == wanted
        assert_is_a_frontend_screen(produced)


def test_segments_are_escaped_so_a_slug_cannot_change_the_route():
    url = resolve_routes.report_url("lab", "routing", "a/b?c#d")

    assert url == "/app/lab/routing/reports/a%2Fb%3Fc%23d"
    assert url.count("/") == 5


def test_no_legacy_route_is_left_in_the_resolver():
    source = Path(resolve_routes.__file__).read_text(encoding="utf-8")

    for legacy in ('"/dialects"', '/records"', "/app/snapshots/", "library?artifact=", '"/app/engines"', "/resources/{reg"):
        assert legacy not in source


def test_seed_analysis_links_are_current_screens():
    jobs = [str(uuid.uuid4()), str(uuid.uuid4())]

    sources = analysis_link(jobs)
    saved = analysis_link(jobs, ("lab", "routing", "analysis-tradeoffs-abc"))

    assert sources == f"/app/analysis/workspace?job={jobs[0]}&job={jobs[1]}"
    assert saved == "/app/analysis/workspace?report=lab%2Frouting%2Fanalysis-tradeoffs-abc"
    assert report_link("lab", "routing", "analysis-tradeoffs-abc") == "/app/lab/routing/reports/analysis-tradeoffs-abc"
    for url in (sources, saved, report_link("lab", "routing", "x")):
        assert_is_a_frontend_screen(url)
    assert "/app/analysis?" not in sources and "/app/analysis?" not in saved


# -- every kind, through the endpoint -----------------------------------------


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


@pytest.fixture(autouse=True)
def isolated_artifact_root(monkeypatch, tmp_path):
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()


async def account(client, registration, gate=None) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    if gate is not None:
        gate.plans[uuid.UUID(created.json()["id"])] = largest_plan()
    return created.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}


async def project(client, headers) -> tuple[str, str]:
    org = f"org-{uuid.uuid4().hex[:8]}"
    assert (await client.post("/v1/organizations", headers=headers, json={"slug": org, "name": "Org"})).status_code == 201
    slug = f"proj-{uuid.uuid4().hex[:8]}"
    created = await client.post(
        f"/v1/organizations/{org}/projects",
        headers=headers,
        json={"slug": slug, "name": "Project", "visibility": "public"},
    )
    assert created.status_code == 201, created.text
    return org, slug


async def seal(client, headers, org: str, kind: str, content: dict, name: str | None = None) -> dict:
    created = await client.post(
        f"/v1/organizations/{org}/library",
        headers=headers,
        json={"name": name or f"item-{uuid.uuid4().hex[:6]}", "display_name": "Item", "kind": kind},
    )
    assert created.status_code == 201, created.text
    base = f"/v1/artifacts/{created.json()['id']}"
    draft = await client.post(f"{base}/drafts", headers=headers, json={"content": content})
    assert draft.status_code == 201, draft.text
    sealed = await client.post(f"{base}/drafts/{draft.json()['id']}/seal", headers=headers, json={"revision": 1})
    assert sealed.status_code == 201, sealed.text
    return {"artifact": created.json(), "version": sealed.json()}


async def resolved_locations(client, kind: str, digest: str, headers=None) -> list[dict]:
    response = await client.get(f"/v1/resolve/{kind}/{digest}", headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()["locations"]


async def test_case_revision_points_at_the_revision_screen(api_client, registration, platform_gate):
    alice, headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, headers)
    await api_client.post(
        f"/v1/organizations/{org}/projects/{proj}/cases", headers=headers, json={"slug": "baseline", "name": "Baseline"}
    )
    revision = await api_client.post(
        f"/v1/organizations/{org}/projects/{proj}/cases/baseline/revisions",
        headers=headers,
        json={"document": {"apiVersion": "bim/v1", "kind": "Instance", "metadata": {"name": "c"},
                           "spec": {"profile": "qos-binding/v1", "resources": {"application": {"app": "a.json"}}}}},
    )
    assert revision.status_code == 201, revision.text

    locations = await resolved_locations(api_client, "case-revision", revision.json()["digest"])

    number = locations[0]["version_or_revision"]
    assert isinstance(number, int) and number >= 1
    assert locations[0]["web_url"] == f"/app/{org}/{proj}/cases/baseline/revisions/{number}"
    assert_is_a_frontend_screen(locations[0]["web_url"])


async def test_resource_and_collection_versions_point_at_the_library_version_screen(
    api_client, registration, platform_gate
):
    alice, headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, headers)
    dataset = await seal(api_client, headers, org, "Dataset", {"value": 1})
    collection = await seal(
        api_client, headers, org, "Collection", {"apiVersion": "openbinding/collection/v1", "members": []}
    )
    for sealed in (dataset, collection):
        used = await api_client.put(
            f"/v1/organizations/{org}/projects/{proj}/library/{sealed['artifact']['id']}", headers=headers
        )
        assert used.status_code == 200, used.text

    resource = await resolved_locations(api_client, "resource-revision", dataset["version"]["contentDigest"], headers)
    grouped = await resolved_locations(api_client, "collection-revision", collection["version"]["contentDigest"], headers)

    for locations, sealed in ((resource, dataset), (grouped, collection)):
        assert len(locations) == 1
        expected = f"/app/{org}/library/{sealed['artifact']['id']}/versions/{sealed['version']['ref']['version']}"
        assert locations[0]["web_url"] == expected
        assert_is_a_frontend_screen(expected)


async def test_a_report_points_at_the_report_screen(api_client, registration, platform_gate, db_session):
    alice, headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, headers)
    sealed = await seal(api_client, headers, org, "Dataset", {"decision": "binding-a"})
    project_row = (await db_session.execute(select(Project).where(Project.slug == proj))).scalars().one()
    db_session.add(Report(
        project_id=project_row.id, slug="decision-1", title="Decision", state=ReportState.FROZEN,
        artifact_id=uuid.UUID(sealed["artifact"]["id"]), version_id=uuid.UUID(sealed["version"]["id"]),
        created_by_id=uuid.UUID(alice["id"]),
    ))
    await db_session.flush()

    locations = await resolved_locations(api_client, "report", sealed["version"]["contentDigest"], headers)

    assert locations[0]["web_url"] == f"/app/{org}/{proj}/reports/decision-1"
    assert_is_a_frontend_screen(locations[0]["web_url"])


async def test_a_file_points_at_the_project_files_screen(api_client, registration, platform_gate):
    alice, headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, headers)
    uploaded = await api_client.post(
        f"/v1/organizations/{org}/projects/{proj}/blobs?public=true",
        headers={**headers, "Content-Type": "text/plain"},
        content=b"reproducible bytes\n",
    )
    assert uploaded.status_code == 201, uploaded.text

    locations = await resolved_locations(api_client, "artifact", uploaded.json()["digest"])

    assert locations[0]["web_url"] == f"/app/{org}/{proj}/files"
    assert_is_a_frontend_screen(locations[0]["web_url"])


async def test_an_engine_points_at_its_public_detail_screen(api_client, registration, platform_gate, db_session):
    alice, _ = await account(api_client, registration)
    digest = "sha256-" + "e" * 64
    db_session.add(EngineRevision(
        owner_id=uuid.UUID(alice["id"]), namespace="acme", name="solver", version="1.2.0",
        digest=digest, document={"metadata": {"name": "solver"}}, state="published",
    ))
    await db_session.flush()

    locations = await resolved_locations(api_client, "engine", digest)

    assert locations[0]["web_url"] == "/engines/acme/solver/1.2.0"
    assert_is_a_frontend_screen(locations[0]["web_url"])


async def test_kinds_without_a_screen_have_no_web_url(api_client, registration, platform_gate, db_session):
    alice, _ = await account(api_client, registration)
    owner = uuid.UUID(alice["id"])
    dialect_digest = "sha256-" + "d" * 64
    resource_digest = "sha256-" + "f" * 64
    db_session.add(DialectRevision(
        owner_id=owner, namespace="acme", name="dialect", version="1", digest=dialect_digest,
        adapter_digest="sha256-" + "a" * 64, document={"kind": "Dialect"}, state="published",
    ))
    db_session.add(RegisteredResourceRevision(
        owner_id=owner, namespace="acme", name="res", version="1", digest=resource_digest, role="application",
        api_version="bim/v1", kind="Application", dialect_id="acme/dialect@1", media_type="application/json",
        document={"a": 1}, content=b'{"a": 1}', state="published",
    ))
    await db_session.flush()

    dialect = await resolved_locations(api_client, "dialect", dialect_digest)
    resource = await resolved_locations(api_client, "registered-resource", resource_digest)

    assert dialect[0]["web_url"] is None
    assert resource[0]["web_url"] is None
    # The element is still resolved and located; only the broken link is gone.
    assert dialect[0]["slug"] == "acme/dialect"
    assert resource[0]["slug"] == "acme/res"


async def test_snapshots_link_to_their_project_screen_only_when_a_project_holds_them(
    api_client, registration, platform_gate, db_session
):
    alice, alice_headers = await account(api_client, registration, platform_gate)
    carol, carol_headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, alice_headers)
    archive = load_package(EXAMPLE).to_zip()
    zip_headers = {"Content-Type": "application/vnd.bim+zip"}
    mine = await api_client.post("/v1/instances", headers={**alice_headers, **zip_headers}, content=archive)
    hers = await api_client.post("/v1/instances", headers={**carol_headers, **zip_headers}, content=archive)
    assert mine.status_code == 201 and hers.status_code == 201, (mine.text, hers.text)
    assert mine.json()["id"] != hers.json()["id"]

    # Before a case revision is sealed from the snapshot there is no project to show it in.
    unlinked = await resolved_locations(api_client, "instance-snapshot", mine.json()["instanceDigest"], alice_headers)
    await api_client.post(
        f"/v1/organizations/{org}/projects/{proj}/cases", headers=alice_headers, json={"slug": "c", "name": "C"}
    )
    stored = await api_client.get(f"/v1/instances/{mine.json()['id']}", headers=alice_headers)
    assert stored.status_code == 200, stored.text
    revision = await api_client.post(
        f"/v1/organizations/{org}/projects/{proj}/cases/c/revisions",
        headers=alice_headers,
        json={"document": stored.json()["instance"], "source_snapshot_id": mine.json()["id"]},
    )
    assert revision.status_code == 201, revision.text
    assert revision.json()["source_snapshot_id"] == mine.json()["id"]
    snapshot = await resolved_locations(api_client, "instance-snapshot", mine.json()["instanceDigest"], alice_headers)
    ir = await resolved_locations(api_client, "binding-ir", mine.json()["irDigest"], alice_headers)
    strangers = await resolved_locations(api_client, "instance-snapshot", hers.json()["instanceDigest"], carol_headers)

    assert unlinked[0]["web_url"] is None
    expected = f"/app/{org}/{proj}/snapshots/{mine.json()['id']}"
    assert snapshot[0]["web_url"] == expected
    assert ir[0]["web_url"] == expected
    assert_is_a_frontend_screen(expected)
    # Carol's own snapshot is in no project she (or anyone) can open it in.
    assert strangers[0]["web_url"] is None
    assert str(carol["id"]) != str(alice["id"])


async def test_an_anonymous_caller_never_gets_a_snapshot_link(api_client, registration, platform_gate, db_session):
    from openbinding_gateway.db.models import InstanceSnapshot

    owner, owner_headers = await account(api_client, registration, platform_gate)
    snapshot = InstanceSnapshot(
        owner_id=uuid.UUID(str(owner["id"])), name="private-snapshot", instance_digest="sha256-" + "1" * 64,
        package_digest="sha256-" + "2" * 64, root_document={"kind": "Instance"}, source_archive=b"zip",
    )
    db_session.add(snapshot)
    await db_session.flush()
    path = f"/v1/resolve/instance-snapshot/{snapshot.instance_digest}"

    # A snapshot always has an owner and is private to it: nothing is resolved anonymously.
    assert (await api_client.get(path)).status_code == 404
    assert (await api_client.get(f"{path}/content")).status_code == 404

    # The owner resolves it; without a sealed case revision there is no project screen to link.
    locations = await resolved_locations(api_client, "instance-snapshot", snapshot.instance_digest, owner_headers)
    assert locations[0]["web_url"] is None
