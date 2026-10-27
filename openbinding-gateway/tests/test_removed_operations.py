"""M9.6: the removed operations are not routed (design.md §2.1, ``req~gateway-api-removed-operations-not-routed~1``).

Each removed operation answers like any path no route matches: ``404`` with the
body of ``GET /v1/m96-never-routed``, or ``405`` with an ``Allow`` header that
names only the kept method(s) when its path stays for another method. The
kept operations of the same areas (design.md §2.2) stay routed, documented and
answer as before. The OpenAPI document checked is the one the application
generates (``docs/openapi.json`` is regenerated and checked by its own snapshot test).

Both tables are data: a slice that removes more operations adds its rows to
``REMOVED`` (and the kept neighbours to ``KEPT``); the tests below need no change.
"""

from __future__ import annotations

import re
import uuid
from types import SimpleNamespace
from typing import NamedTuple

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import func, select

import _m96_seed as seed
from _b1_helpers import gate, make_account, make_key, make_org  # noqa: F401
from _repo import REPO_ROOT
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import ProjectArtifact
from openbinding_gateway.main import app

UNROUTED = "/v1/m96-never-routed"
PROJECT = "/v1/organizations/{org}/projects/{project}"

#: Values of the path parameters (the scenario of the requirement); any other parameter gets a random UUID.
PARAMETERS = {"org": "isa-demo", "project": "p1", "report": "r1", "resource": "r1"}


class Removed(NamedTuple):
    row: str
    method: str
    template: str
    after: int


class Kept(NamedTuple):
    row: str
    method: str
    template: str


#: The removed-operations table of design.md §2.1, as far as the slices that landed have removed it.
REMOVED = [
    Removed("1", "GET", "/v1/analysis/sources", 404),
    Removed("2", "POST", "/v1/analysis/query", 404),
    Removed("3", "POST", "/v1/analysis/candidate", 404),
    Removed("4", "POST", "/v1/analysis/export", 404),
    Removed("5", "POST", "/v1/analysis/reports", 404),
    Removed("6", "POST", "/v1/analysis/pareto", 404),
    Removed("7", "GET", "/v1/analysis/pareto/{task_id}", 404),
    Removed("8", "POST", "/v1/analysis/pareto/{task_id}/cancel", 404),
    Removed("9", "GET", f"{PROJECT}/reports/{{report}}", 404),
    Removed("10", "POST", f"{PROJECT}/reports", 405),
    Removed("11", "POST", f"{PROJECT}/reports/{{report}}/freeze", 404),
    Removed("12", "POST", f"{PROJECT}/reports/{{report}}/drafts", 404),
    Removed("13", "PATCH", f"{PROJECT}/reports/{{report}}", 404),
    Removed("14", "DELETE", f"{PROJECT}/reports/{{report}}", 404),
    Removed("15", "POST", f"{PROJECT}/publications", 405),
    Removed("16", "POST", "/v1/organizations/{org}/library", 405),
    Removed("17", "GET", "/v1/artifacts/{artifact_id}", 404),
    Removed("18", "PATCH", "/v1/artifacts/{artifact_id}", 404),
    Removed("19", "GET", "/v1/artifacts/{artifact_id}/versions/{version_id}", 404),
    Removed("20", "GET", "/v1/artifacts/{artifact_id}/drafts", 404),
    Removed("21", "POST", "/v1/artifacts/{artifact_id}/drafts", 404),
    Removed("22", "PUT", "/v1/artifacts/{artifact_id}/drafts/{draft_id}", 404),
    Removed("23", "POST", "/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal", 404),
    Removed("24", "POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/publish", 404),
    Removed("25", "POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw", 404),
    Removed("26", "PUT", f"{PROJECT}/library/{{artifact_id}}", 404),
    Removed("27", "GET", f"{PROJECT}/library", 404),
    Removed("28", "DELETE", f"{PROJECT}/library/{{artifact_id}}", 404),
    Removed("29", "POST", f"{PROJECT}/resources", 405),
    Removed("30", "GET", f"{PROJECT}/resources/{{resource}}/revisions/{{revision}}", 404),
    Removed("31", "POST", f"{PROJECT}/resources/{{resource}}/revisions", 405),
    Removed("32", "GET", f"{PROJECT}/resources/{{resource}}", 404),
    Removed("33", "PATCH", f"{PROJECT}/resources/{{resource}}", 404),
    Removed("34", "DELETE", f"{PROJECT}/resources/{{resource}}", 404),
    Removed("35", "POST", "/v1/admin/organizations/{organization_id}/sponsor", 404),
    Removed("36", "GET", "/v1/sponsor-proposals/{proposal_id}", 404),
    Removed("37", "GET", "/v1/users/me/sponsor-proposals", 404),
    Removed("38", "GET", "/v1/organizations/{org}/sponsor-proposals", 404),
    Removed("39", "POST", "/v1/sponsor-proposals/{proposal_id}/accept", 404),
    Removed("40", "POST", "/v1/sponsor-proposals/{proposal_id}/decline", 404),
    Removed("41", "POST", "/v1/sponsor-proposals/{proposal_id}/cancel", 404),
]

#: The kept operations of design.md §2.2 next to the removed ones above.
KEPT = [
    Kept("B1", "GET", f"{PROJECT}/reports"),
    Kept("B2", "GET", "/v1/organizations/{org}/library"),
    Kept("B3", "GET", "/v1/artifacts/{artifact_id}/versions"),
    Kept("B4", "GET", "/v1/artifacts/{artifact_id}/versions/{version_id}/content"),
    Kept("B5", "POST", "/v1/artifacts/resolve"),
    Kept("B6", "GET", f"{PROJECT}/resources"),
    Kept("B7", "GET", f"{PROJECT}/resources/{{resource}}/revisions"),
    Kept("K1", "GET", "/v1/jobs/{job_id}/analysis/neighborhood"),
    Kept("K2", "GET", f"{PROJECT}/publications"),
    Kept("K3", "DELETE", f"{PROJECT}/publications/{{publication}}"),
    Kept("K4", "GET", "/v1/explore/publications"),
    Kept("K5", "GET", "/v1/resolve/{kind}/{digest_value}"),
    Kept("K5", "GET", "/v1/resolve/{kind}/{digest_value}/content"),
    Kept("sponsor", "PATCH", "/v1/organizations/{org}"),
]

#: The rows of the slice that retired the library, the report editor and the project resources (tasks.md S7).
S7_ROWS = {str(row) for row in range(9, 35)}


def kept_methods(template: str) -> set[str]:
    """The methods the kept-operations table keeps on this path template."""
    return {entry.method for entry in KEPT if entry.template == template}


def concrete(template: str) -> str:
    return re.sub(r"\{(\w+)\}", lambda match: PARAMETERS.get(match[1], str(uuid.uuid4())), template)


def api_routes() -> list[APIRoute]:
    """Every API route, looking inside included routers as the other route-table tests do."""
    found = []
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute):
                found.append(route)
    return found


def methods_serving(path: str) -> set[str]:
    """The methods of every route whose path pattern matches ``path``."""
    return {method for route in api_routes() if route.path_regex.match(path) for method in route.methods}


def by_row(entries) -> dict:
    return {"argvalues": entries, "ids": [f"{entry.row}-{entry.method}-{entry.template}" for entry in entries]}


async def row_counts(db_session) -> dict[str, int]:
    return {
        table.name: (await db_session.execute(select(func.count()).select_from(table))).scalar_one()
        for table in Base.metadata.sorted_tables
    }


def assert_answers_like_its_row(entry: Removed, response, unrouted) -> None:
    assert response.status_code == entry.after, (entry, response.text)
    if entry.after == 404:
        assert response.json() == unrouted.json(), (entry, response.text)
    else:
        allowed = {method.strip() for method in response.headers["allow"].split(",")}
        assert "GET" in allowed and entry.method not in allowed, (entry, allowed)
        # The Allow header names only the method(s) the kept-operations table keeps on the path.
        assert allowed == kept_methods(entry.template), (entry, allowed)


@pytest.mark.parametrize("entry", **by_row(REMOVED))
async def test_a_removed_operation_answers_with_the_status_of_its_row(api_client, entry):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    unrouted = await api_client.get(UNROUTED)
    assert unrouted.status_code == 404

    response = await api_client.request(entry.method, concrete(entry.template), json={})

    assert_answers_like_its_row(entry, response, unrouted)


@pytest.mark.parametrize("entry", **by_row(REMOVED))
def test_no_route_serves_a_removed_operation(entry):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    serving = methods_serving(concrete(entry.template))

    assert entry.method not in serving, (entry, serving)
    if entry.after == 404:
        assert serving == set(), (entry, serving)
    else:
        assert "GET" in serving, (entry, serving)
        assert serving == kept_methods(entry.template), (entry, serving)


@pytest.mark.parametrize("entry", **by_row(KEPT))
def test_a_kept_operation_of_a_retired_area_is_still_routed(entry):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    # [utest->req~gateway-api-kept-retired-area-operations~1]
    templates = {route.path_format for route in api_routes() if entry.method in route.methods}

    assert entry.template in templates
    assert entry.method in methods_serving(concrete(entry.template))


def openapi_operations() -> dict[str, dict]:
    """The paths of the OpenAPI document the application generates (not the committed docs/openapi.json)."""
    return app.openapi()["paths"]


@pytest.mark.parametrize("entry", **by_row(REMOVED))
def test_the_generated_document_has_no_removed_operation(entry):
    # [utest->req~gateway-api-removed-operations-not-documented~1]
    paths = openapi_operations()

    assert entry.method.lower() not in paths.get(entry.template, {}), entry
    if entry.after == 404:
        # The path has no remaining route, so it is absent from the document altogether.
        assert entry.template not in paths, entry
    else:
        assert set(paths[entry.template]) == {method.lower() for method in kept_methods(entry.template)}


@pytest.mark.parametrize("entry", **by_row(KEPT))
def test_the_generated_document_keeps_the_kept_operations(entry):
    # [utest->req~gateway-api-kept-retired-area-operations~1]
    # [utest->req~gateway-api-removed-operations-not-documented~1]
    assert entry.method.lower() in openapi_operations().get(entry.template, {}), entry


def route_pairs(*prefixes: str) -> set[tuple[str, str]]:
    return {(method, route.path_format) for route in api_routes() if route.path_format.startswith(prefixes)
            for method in route.methods - {"HEAD", "OPTIONS"}}


def test_project_resources_are_read_only_in_the_route_table():
    # [utest->req~collaboration-artifacts-resources-read-only~1]
    assert route_pairs(f"{PROJECT}/resources") == {
        ("GET", f"{PROJECT}/resources"),
        ("GET", f"{PROJECT}/resources/{{resource}}/revisions"),
    }


def test_the_library_is_read_only_in_the_route_table():
    # [utest->req~collaboration-artifacts-library-read-only~1]
    assert route_pairs("/v1/artifacts", "/v1/organizations/{org}/library", f"{PROJECT}/library") == {
        ("GET", "/v1/organizations/{org}/library"),
        ("GET", "/v1/artifacts/{artifact_id}/versions"),
        ("GET", "/v1/artifacts/{artifact_id}/versions/{version_id}/content"),
        ("POST", "/v1/artifacts/resolve"),
    }


async def test_a_session_gets_the_same_answer_and_writes_nothing(
    api_client, registration, db_session, gate  # noqa: F811
):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    _, headers = await make_account(api_client, registration, db_session, gate)
    unrouted = await api_client.get(UNROUTED)
    entries = [entry for entry in REMOVED if entry.row in {"1", "37"}]
    before = await row_counts(db_session)

    for entry in entries:
        response = await api_client.request(entry.method, concrete(entry.template), headers=headers)
        assert_answers_like_its_row(entry, response, unrouted)

    assert await row_counts(db_session) == before


async def test_an_api_key_gets_the_unrouted_answer_and_not_a_permission_refusal(
    api_client, registration, db_session, gate  # noqa: F811
):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    _, session = await make_account(api_client, registration, db_session, gate)
    key = await make_key(api_client, session, ["jobs:read", "engines:execute"])
    unrouted = await api_client.get(UNROUTED)

    response = await api_client.post("/v1/analysis/pareto", headers=key, json={"sources": [str(uuid.uuid4())]})

    assert response.status_code == 404, response.text
    assert response.json() == unrouted.json()


# --- the library, the report editor and the project resources (rows 9 to 34) --------------------------------


#: Permissions that would let a key use every removed operation of rows 9 to 34 if it were still routed.
WRITER = ["projects:read", "projects:write", "reports:read", "reports:write", "artifacts:read", "artifacts:write"]

REPORT_DOCUMENT = {"provenance": {
    "study": {"reference": "urn:test:m96-study", "digest": "sha256-" + "a" * 64},
    "datasets": [{"reference": "urn:test:m96-dataset", "digest": "sha256-" + "b" * 64}],
    "software": [{"name": "test", "version": "1", "digest": "sha256-" + "c" * 64}],
    "bimVersion": "bim/v1", "engineRevisions": ["sha256-" + "d" * 64], "parameters": {},
}}


@pytest.fixture
async def area(api_client, registration, db_session, gate, monkeypatch, tmp_path):  # noqa: F811
    """An OWNER of ``isa-demo`` with the public project ``p1``, holding what the removed routes used to create.

    The rows are seeded through the internal services (``artifacts.seal_draft``, ``reports.create_report_context``,
    ``reports.seal_report``), as before this change: resource ``r1`` with two revisions, a frozen report ``r1``
    with a live publication, and a sealed Dataset of the organization library.
    """
    from openbinding_gateway.core.settings import get_settings

    monkeypatch.setattr(get_settings(), "artifact_root", str(tmp_path / "artifacts"))
    owner, headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, headers, slug="isa-demo")
    created = await api_client.post("/v1/organizations/isa-demo/projects", headers=headers,
                                    json={"slug": "p1", "name": "P1", "visibility": "public"})
    assert created.status_code == 201, created.text
    project = await seed.project_by_slugs(db_session, "isa-demo", "p1")
    resource, revisions = await seed.project_resource(
        db_session, project, owner["id"], slug="r1", name="Providers", kind="qos-offerings",
        documents=[{"providers": ["alpha"]}, {"providers": ["alpha", "beta"]}],
    )
    report = await seed.report(db_session, project, owner["id"], slug="r1", title="Findings",
                               document=REPORT_DOCUMENT, freeze=True)
    await seed.report_publication(db_session, report, owner["id"], slug="pub-1")
    dataset = await seed.library_artifact(db_session, organization["id"], owner["id"], name="d1", kind="Dataset")
    version = await seed.seal(db_session, dataset, owner["id"], {"rows": [1, 2]})
    return SimpleNamespace(owner=owner, headers=headers, project=project, resource=resource, revisions=revisions,
                           report=report, dataset=dataset, version=version)


async def test_an_owner_gets_the_same_answers_and_nothing_is_written(api_client, db_session, area):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    # [utest->req~collaboration-artifacts-resources-read-only~1]
    # [utest->req~collaboration-artifacts-library-read-only~1]
    unrouted = await api_client.get(UNROUTED)
    before = await row_counts(db_session)
    bodies = {"16": {"name": "d1", "kind": "Dataset"}}

    for entry in (entry for entry in REMOVED if entry.row in S7_ROWS | {"1", "37"}):
        response = await api_client.request(entry.method, concrete(entry.template), headers=area.headers,
                                            json=bodies.get(entry.row, {}))
        assert_answers_like_its_row(entry, response, unrouted)

    assert await row_counts(db_session) == before


async def test_an_api_key_that_could_write_gets_the_answers_of_unrouted_paths(
    api_client, db_session, area
):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    key = await make_key(api_client, area.headers, WRITER)
    unrouted = await api_client.get(UNROUTED)
    before = await row_counts(db_session)

    for entry in (entry for entry in REMOVED if entry.row in S7_ROWS):
        response = await api_client.request(entry.method, concrete(entry.template), headers=key, json={})
        assert_answers_like_its_row(entry, response, unrouted)
        assert response.status_code != 403, (entry, response.text)

    assert await row_counts(db_session) == before


async def test_the_kept_operations_answer_a_member_as_before(api_client, area):
    # [utest->req~gateway-api-kept-retired-area-operations~1]
    # [utest->req~collaboration-artifacts-resources-read-only~1]
    # [utest->req~collaboration-artifacts-library-read-only~1]
    from bim_core.canonical import canonical_json

    from openbinding_gateway.artifacts import reference

    headers, base = area.headers, "/v1/organizations/isa-demo/projects/p1"
    artifact = f"/v1/artifacts/{area.dataset.id}"

    reports = await api_client.get(f"{base}/reports", headers=headers)  # B1
    library = await api_client.get("/v1/organizations/isa-demo/library", headers=headers)  # B2
    versions = await api_client.get(f"{artifact}/versions", headers=headers)  # B3
    content = await api_client.get(f"{artifact}/versions/{area.version.id}/content", headers=headers)  # B4
    resolved = await api_client.post("/v1/artifacts/resolve", headers=headers,
                                     json=reference(area.dataset, area.version))  # B5
    resources = await api_client.get(f"{base}/resources", headers=headers)  # B6
    revisions = await api_client.get(f"{base}/resources/r1/revisions", headers=headers)  # B7
    publications = await api_client.get(f"{base}/publications", headers=headers)  # K2
    explore = await api_client.get("/v1/explore/publications")  # K4
    permanent = await api_client.get(f"/v1/resolve/report/{area.report.digest}", headers=headers)  # K5
    permanent_content = await api_client.get(f"/v1/resolve/report/{area.report.digest}/content", headers=headers)
    renamed = await api_client.patch("/v1/organizations/isa-demo", headers=headers, json={"name": "ISA demo"})

    for response in (reports, library, versions, content, resolved, resources, revisions, publications, explore,
                     permanent, permanent_content, renamed):
        assert response.status_code == 200, (str(response.url), response.text)
    assert [(row["slug"], row["state"]) for row in reports.json()] == [("r1", "frozen")]
    assert "d1" in {row["name"] for row in library.json()}
    assert [row["ref"]["versionDigest"] for row in versions.json()] == [area.version.version_digest]
    assert content.content == canonical_json({"rows": [1, 2]})
    assert resolved.json()["id"] == str(area.version.id)
    assert "r1" in {row["slug"] for row in resources.json()}
    assert [row["revision"] for row in revisions.json()] == [1, 2]
    assert [row["digest"] for row in revisions.json()] == [version.content_digest for version in area.revisions]
    assert [(row["slug"], row["withdrawn"]) for row in publications.json()] == [("pub-1", False)]
    assert "pub-1" in {row["slug"] for row in explore.json()}
    assert permanent_content.json() == REPORT_DOCUMENT
    assert renamed.json()["name"] == "ISA demo"

    withdrawn = await api_client.delete(f"{base}/publications/pub-1", headers=headers)  # K3
    assert withdrawn.status_code == 204, withdrawn.text
    listed = await api_client.get(f"{base}/publications", headers=headers)
    assert [(row["slug"], row["withdrawn"]) for row in listed.json()] == [("pub-1", True)]


async def test_a_version_sealed_by_package_import_is_listed(api_client, db_session, area):
    # [utest->req~collaboration-artifacts-library-read-only~1]
    # Package import still seals versions through the internal artifact service; the kept version list shows them.
    from bim_core.canonical import digest

    headers = area.headers
    db_session.add(ProjectArtifact(project_id=area.project.id, artifact_id=area.dataset.id))
    await db_session.flush()
    exported = await api_client.get("/v1/organizations/isa-demo/projects/p1/package?format=json", headers=headers)
    assert exported.status_code == 200, exported.text
    package = exported.json()
    # The package holds a sealed Dataset version that does not exist yet, so the import must seal it.
    entry = next(item for item in package["library"] if item["ref"]["name"] == "d1")
    original = dict(entry["ref"])
    entry["manifest"]["identity"]["name"] = entry["ref"]["name"] = "d1-imported"
    entry["ref"]["versionDigest"] = digest(entry["manifest"])
    package["projectArtifacts"] = [entry["ref"] if ref == original else ref for ref in package["projectArtifacts"]]
    package["packageDigest"] = digest({key: value for key, value in package.items() if key != "packageDigest"})
    assert (await api_client.post("/v1/artifacts/resolve", headers=headers, json=entry["ref"])).status_code == 404
    created = await api_client.post("/v1/organizations/isa-demo/projects", headers=headers,
                                    json={"slug": "p2", "name": "P2", "visibility": "private"})
    assert created.status_code == 201, created.text
    imported = await api_client.post("/v1/organizations/isa-demo/projects/p2/package", headers=headers,
                                     json=package)
    assert imported.status_code == 200, imported.text

    resolved = await api_client.post("/v1/artifacts/resolve", headers=headers, json=entry["ref"])
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["artifact_id"] != str(area.dataset.id)
    versions = await api_client.get(f"/v1/artifacts/{resolved.json()['artifact_id']}/versions", headers=headers)

    assert versions.status_code == 200, versions.text
    assert entry["ref"]["versionDigest"] in {row["ref"]["versionDigest"] for row in versions.json()}


# --- the record of removed operations ------------------------------------------------------------------------


def test_the_removed_operations_page_lists_every_removed_row_and_no_kept_one():
    # [utest->req~gateway-api-removed-operations-page~1]
    text = (REPO_ROOT / "docs" / "API_DEPRECATIONS.md").read_text(encoding="utf-8")
    removed_section = text.split("## Removed operations", 1)[1].split("\n## ", 1)[0]
    rows = set(re.findall(r"^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|", removed_section, flags=re.MULTILINE))

    assert len(REMOVED) == 41
    assert rows == {(entry.method, entry.template) for entry in REMOVED}
    assert not rows & {(entry.method, entry.template) for entry in KEPT}
    assert "M9.6" in text
    assert "Sunset:" not in text and "not set yet" not in text
