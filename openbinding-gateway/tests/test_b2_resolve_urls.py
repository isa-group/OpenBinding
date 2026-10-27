"""B2 #7: ``web_url`` points at screens that exist today, or is null.

The frontend's route table (``frontend/src/routes/d*.tsx``) is the source of
truth, so the contract test below reads it: every link the resolver produces
must match one of its ``live(id, path, ...)`` definitions.

A retired screen (``RETIRED_ROUTES`` in ``frontend/src/routes/retiredRoutes.tsx``)
is NOT accepted by default, so retiring a screen the resolver points at fails
here. The addresses that still open a page only through a redirect are listed
one by one in ``KNOWN_REDIRECTING_WEB_URLS`` and each must be retired. A slice that
retires an address the resolver emits must list it there in the same PR.
"""

from __future__ import annotations

import re
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
)
from openbinding_gateway.db.platform_models import Report, ReportState
from openbinding_gateway.routes import resolve as resolve_routes
from bim_core.package import load_package
from _pricing import fake_pricing_gate, largest_plan
from _repo import REPO_ROOT
import _m96_seed as seed

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
ROUTES = sorted((REPO_ROOT / "frontend" / "src" / "routes").glob("d[0-9].tsx"))
RETIRED_ROUTES_FILE = REPO_ROOT / "frontend" / "src" / "routes" / "retiredRoutes.tsx"


def path_patterns(paths: list[str]) -> list[re.Pattern]:
    return [re.compile("^" + re.sub(r":[A-Za-z]+", "[^/]+", path) + "$") for path in paths]


def retired_paths(source: str) -> list[str]:
    """The ``path`` of every ``{ id: '...', path: '...' ...}`` entry of the RETIRED_ROUTES table."""
    return re.findall(r"\bid: '[^']+', path: '([^']+)'", source)


# Addresses that the resolver or the seed tooling emit although the screen is retired: they open a page only
# through the redirect of RETIRED_ROUTES. Nothing else is accepted by pattern alone; an entry is dropped when the
# emitter is retargeted. Every entry must be in RETIRED_ROUTES (see ``stale_entries``). A slice that retires an
# address the resolver emits must list it here in the same PR.
KNOWN_REDIRECTING_WEB_URLS = {
    "/app/:org/:project/reports/:slug": "retired by M2.4 slice 2; retarget the resolver in M9.6 or earlier",
    "/app/:org/library/:artifact/versions/:version": "retired by M2.4 slice 3; retarget the resolver in M9.6 or earlier",
}


def live_paths() -> list[str]:
    paths = []
    for route_file in ROUTES:
        paths += re.findall(r"live\('[^']+', '([^']+)'", route_file.read_text(encoding="utf-8"))
    return paths


def real_retired_paths() -> list[str]:
    if not RETIRED_ROUTES_FILE.exists():
        return []
    return retired_paths(RETIRED_ROUTES_FILE.read_text(encoding="utf-8"))


def stale_entries(redirecting: dict[str, str], retired: list[str]) -> list[str]:
    """Entries that are not in the retired table; there are no exceptions."""
    retired_shapes = {_shape(path) for path in retired}
    return [address for address in redirecting if _shape(address) not in retired_shapes]


def _shape(path: str) -> str:
    """The path with its parameter names erased, so ``:report`` and ``:slug`` compare equal."""
    return re.sub(r":[A-Za-z]+", ":", path)


def _matches(url: str, paths) -> bool:
    path = url.split("?", 1)[0]
    return any(pattern.match(path) for pattern in path_patterns(list(paths)))


def assert_is_a_frontend_screen(url: str, live: list[str] | None = None) -> None:
    """The address is a live route; a retired (redirecting) address does not count."""
    if not ROUTES:
        pytest.skip("the frontend route table is not part of this checkout")
    assert _matches(url, live_paths() if live is None else live), f"{url} matches no live frontend route"


def assert_opens_a_frontend_page(
    url: str, live: list[str] | None = None, redirecting: dict[str, str] | None = None
) -> None:
    """The address is live, or is explicitly listed as a known redirecting address."""
    if not ROUTES:
        pytest.skip("the frontend route table is not part of this checkout")
    live = live_paths() if live is None else live
    redirecting = KNOWN_REDIRECTING_WEB_URLS if redirecting is None else redirecting
    assert _matches(url, [*live, *redirecting]), f"{url} is neither a live route nor a listed redirecting address"


# -- the helpers -------------------------------------------------------------


def test_each_helper_builds_the_current_frontend_route():
    snapshot = uuid.uuid4()
    artifact = uuid.uuid4()
    expected_report = resolve_routes.report_url("lab", "routing", "decision-1")
    expected_library_version = resolve_routes.library_version_url("lab", artifact, "2")
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
        if produced in (expected_report, expected_library_version):
            assert_opens_a_frontend_page(produced)
        else:
            assert_is_a_frontend_screen(produced)


def test_a_retired_address_is_accepted_only_when_listed_and_an_unknown_one_never():
    table = """
    export type RetiredRoute = { id: string; path: string; slice: 1 | 2 };
    export const RETIRED_ROUTES = [
      { id: 'old-screen', path: '/app/:org/:project/synthetic-retired/:slug', slice: 2, target: () => '/' },
    ];
    """
    assert retired_paths(table) == ["/app/:org/:project/synthetic-retired/:slug"]

    retired = retired_paths(table)
    listed = {retired[0]: "synthetic"}

    # A retired address is not a live screen; only an explicit entry lets it through.
    with pytest.raises(AssertionError):
        assert_is_a_frontend_screen("/app/lab/routing/synthetic-retired/x", [])
    with pytest.raises(AssertionError):
        assert_opens_a_frontend_page("/app/lab/routing/synthetic-retired/x", [], {})
    assert_opens_a_frontend_page("/app/lab/routing/synthetic-retired/x?a=1", [], listed)
    for unknown in ("/app/lab/routing/synthetic-unknown/x", "/app/lab/routing/synthetic-retired/x/extra"):
        with pytest.raises(AssertionError):
            assert_opens_a_frontend_page(unknown, [], listed)


def test_retiring_the_report_screen_fails_unless_the_address_is_listed():
    report = "/app/:org/:project/reports/:slug"
    if not ROUTES:
        pytest.skip("the frontend route table is not part of this checkout")
    live_without_reports = [path for path in live_paths() if _shape(path) != _shape(report)]
    url = resolve_routes.report_url("lab", "routing", "decision-1")

    # Today the report address is retired and listed, so it opens a page through the redirect.
    assert_opens_a_frontend_page(url)
    with pytest.raises(AssertionError):
        assert_is_a_frontend_screen(url, live_without_reports)
    with pytest.raises(AssertionError):
        assert_opens_a_frontend_page(url, live_without_reports, {})
    listed = {report: "synthetic retirement of the report screen"}
    assert_opens_a_frontend_page(url, live_without_reports, listed)
    # The entry is valid only once the address is in the retired table.
    assert stale_entries(listed, []) == [report]
    assert stale_entries(listed, [report]) == []


def test_retiring_the_library_version_screen_fails_unless_the_address_is_listed():
    version = "/app/:org/library/:artifact/versions/:version"
    if not ROUTES:
        pytest.skip("the frontend route table is not part of this checkout")
    live_without_versions = [path for path in live_paths() if _shape(path) != _shape(version)]
    url = resolve_routes.library_version_url("lab", uuid.uuid4(), "2")

    assert_opens_a_frontend_page(url)
    with pytest.raises(AssertionError):
        assert_is_a_frontend_screen(url, live_without_versions)
    with pytest.raises(AssertionError):
        assert_opens_a_frontend_page(url, live_without_versions, {})
    listed = {version: "synthetic retirement of the library version screen"}
    assert_opens_a_frontend_page(url, live_without_versions, listed)
    assert stale_entries(listed, []) == [version]
    assert stale_entries(listed, [version]) == []


def test_every_listed_redirecting_address_is_retired():
    if not ROUTES:
        pytest.skip("the frontend route table is not part of this checkout")

    assert stale_entries(KNOWN_REDIRECTING_WEB_URLS, real_retired_paths()) == []
    # A stale entry is caught: every entry must be retired, whether or not it is still live.
    assert stale_entries({"/app/gone": "x"}, ["/app/other"]) == ["/app/gone"]
    assert stale_entries({"/app/gone": "x"}, []) == ["/app/gone"]
    assert stale_entries({"/app/gone": "x"}, ["/app/gone"]) == []


def test_every_entry_of_the_real_retired_table_is_parsed():
    if not RETIRED_ROUTES_FILE.exists():
        pytest.skip("the frontend route table is not part of this checkout")
    source = RETIRED_ROUTES_FILE.read_text(encoding="utf-8")

    assert retired_paths(source)
    assert len(retired_paths(source)) == len(re.findall(r"\bid: '", source))


def test_segments_are_escaped_so_a_slug_cannot_change_the_route():
    url = resolve_routes.report_url("lab", "routing", "a/b?c#d")

    assert url == "/app/lab/routing/reports/a%2Fb%3Fc%23d"
    assert url.count("/") == 5


def test_no_legacy_route_is_left_in_the_resolver():
    source = Path(resolve_routes.__file__).read_text(encoding="utf-8")

    for legacy in ('"/dialects"', '/records"', "/app/snapshots/", "library?artifact=", '"/app/engines"', "/resources/{reg"):
        assert legacy not in source


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


async def seal(client, headers, org: str, kind: str, content: dict, name: str | None = None, *, db,
               dependencies=()) -> dict:
    """A sealed library version, as the views of the removed create and seal routes described it.

    The library write routes are removed since M9.6: the version is sealed by ``artifacts.seal_draft``.
    """
    from openbinding_gateway.artifacts import artifact_view, version_view
    from openbinding_gateway.db.models import Organization
    from openbinding_gateway.models.artifacts import ArtifactVersionView, ArtifactView

    user_id = (await client.get("/v1/users/me", headers=headers)).json()["id"]
    organization = (await db.execute(select(Organization).where(Organization.slug == org))).scalars().one()
    artifact = await seed.library_artifact(db, organization.id, user_id, name=name or f"item-{uuid.uuid4().hex[:6]}",
                                           display_name="Item", kind=kind)
    version = await seed.seal(db, artifact, user_id, content, dependencies=dependencies)
    return {"artifact": ArtifactView.model_validate(artifact_view(artifact)).model_dump(mode="json"),
            "version": ArtifactVersionView.model_validate(version_view(artifact, version)).model_dump(mode="json")}


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


async def test_resource_and_collection_versions_open_the_organization_overview_through_the_redirect(
    api_client, registration, platform_gate, db_session
):
    from openbinding_gateway.db.models import ProjectArtifact

    alice, headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, headers)
    dataset = await seal(api_client, headers, org, "Dataset", {"value": 1}, db=db_session)
    collection = await seal(
        api_client, headers, org, "Collection", {"apiVersion": "openbinding/collection/v1", "members": []},
        db=db_session,
    )
    # The project library association route is removed since M9.6: the project uses them through its rows.
    project_row = (await db_session.execute(select(Project).where(Project.slug == proj))).scalars().one()
    for sealed in (dataset, collection):
        db_session.add(ProjectArtifact(project_id=project_row.id, artifact_id=uuid.UUID(sealed["artifact"]["id"])))
    await db_session.flush()

    resource = await resolved_locations(api_client, "resource-revision", dataset["version"]["contentDigest"], headers)
    grouped = await resolved_locations(api_client, "collection-revision", collection["version"]["contentDigest"], headers)

    for locations, sealed in ((resource, dataset), (grouped, collection)):
        assert len(locations) == 1
        expected = f"/app/{org}/library/{sealed['artifact']['id']}/versions/{sealed['version']['ref']['version']}"
        assert locations[0]["web_url"] == expected
        assert_opens_a_frontend_page(expected)


async def test_a_report_points_at_the_report_screen(api_client, registration, platform_gate, db_session):
    alice, headers = await account(api_client, registration, platform_gate)
    org, proj = await project(api_client, headers)
    sealed = await seal(api_client, headers, org, "Dataset", {"decision": "binding-a"}, db=db_session)
    project_row = (await db_session.execute(select(Project).where(Project.slug == proj))).scalars().one()
    db_session.add(Report(
        project_id=project_row.id, slug="decision-1", title="Decision", state=ReportState.FROZEN,
        artifact_id=uuid.UUID(sealed["artifact"]["id"]), version_id=uuid.UUID(sealed["version"]["id"]),
        created_by_id=uuid.UUID(alice["id"]),
    ))
    await db_session.flush()

    locations = await resolved_locations(api_client, "report", sealed["version"]["contentDigest"], headers)

    assert locations[0]["web_url"] == f"/app/{org}/{proj}/reports/decision-1"
    assert_opens_a_frontend_page(locations[0]["web_url"])


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
