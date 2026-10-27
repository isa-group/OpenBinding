"""M2.4: the operations behind the retired screens answer with ``Deprecation`` (and ``Sunset`` once R1 records it).

Every expected value below is a literal copied from ``openspec/changes/m24-sunset/specs/gateway-api/spec.md`` and
``design.md`` §2, never imported from ``core/deprecation.py``: these tests pin the contract, and they ran red before
that module existed. The R1 release PR changes one line here, ``EXPECTED_SUNSET`` (design.md §5).
"""

from __future__ import annotations

import copy
import re
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from _pricing import largest_plan
from _repo import REPO_ROOT

from openbinding_gateway import space_client
from openbinding_gateway.main import app

#: ``@1792627200`` is 2026-10-22T00:00:00Z, the owner's retirement decision (ADR-0020), in the RFC 9745 form.
DEPRECATION = "@1792627200"
#: No Sunset date is recorded before R1 (CRP ``crp-ob-m24-sunset-date``, option D). The R1 release PR sets the
#: header value here, for example ``"Thu, 15 Apr 2027 23:59:59 GMT"``.
EXPECTED_SUNSET: str | None = None

# [utest->req~gateway-api-retired-operation-set~1]
#: The 36 class-A operations (design.md §2.1): ``(method, route path template)``.
RETIRED: tuple[tuple[str, str], ...] = (
    ("GET", "/v1/analysis/sources"),
    ("POST", "/v1/analysis/query"),
    ("POST", "/v1/analysis/candidate"),
    ("POST", "/v1/analysis/export"),
    ("POST", "/v1/analysis/reports"),
    ("POST", "/v1/analysis/pareto"),
    ("GET", "/v1/analysis/pareto/{task_id}"),
    ("POST", "/v1/analysis/pareto/{task_id}/cancel"),
    ("GET", "/v1/organizations/{org}/projects/{project}/reports/{report}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/reports"),
    ("POST", "/v1/organizations/{org}/projects/{project}/reports/{report}/freeze"),
    ("POST", "/v1/organizations/{org}/projects/{project}/reports/{report}/drafts"),
    ("PATCH", "/v1/organizations/{org}/projects/{project}/reports/{report}"),
    ("DELETE", "/v1/organizations/{org}/projects/{project}/reports/{report}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/publications"),
    ("POST", "/v1/organizations/{org}/library"),
    ("GET", "/v1/artifacts/{artifact_id}"),
    ("PATCH", "/v1/artifacts/{artifact_id}"),
    ("GET", "/v1/artifacts/{artifact_id}/versions/{version_id}"),
    ("GET", "/v1/artifacts/{artifact_id}/drafts"),
    ("POST", "/v1/artifacts/{artifact_id}/drafts"),
    ("PUT", "/v1/artifacts/{artifact_id}/drafts/{draft_id}"),
    ("POST", "/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal"),
    ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/publish"),
    ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw"),
    ("PUT", "/v1/organizations/{org}/projects/{project}/library/{artifact_id}"),
    ("GET", "/v1/organizations/{org}/projects/{project}/library"),
    ("DELETE", "/v1/organizations/{org}/projects/{project}/library/{artifact_id}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/resources"),
    ("GET", "/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions"),
    ("GET", "/v1/organizations/{org}/projects/{project}/resources/{resource}"),
    ("PATCH", "/v1/organizations/{org}/projects/{project}/resources/{resource}"),
    ("DELETE", "/v1/organizations/{org}/projects/{project}/resources/{resource}"),
    ("POST", "/v1/admin/organizations/{organization_id}/sponsor"),
    ("GET", "/v1/sponsor-proposals/{proposal_id}"),
)

#: The 12 class-B operations kept screens still call (design.md §2.2). They are never rows.
KEPT_CALLED: tuple[tuple[str, str], ...] = (
    ("GET", "/v1/organizations/{org}/projects/{project}/reports"),
    ("GET", "/v1/organizations/{org}/library"),
    ("GET", "/v1/artifacts/{artifact_id}/versions"),
    ("GET", "/v1/artifacts/{artifact_id}/versions/{version_id}/content"),
    ("POST", "/v1/artifacts/resolve"),
    ("GET", "/v1/organizations/{org}/projects/{project}/resources"),
    ("GET", "/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions"),
    ("GET", "/v1/users/me/sponsor-proposals"),
    ("GET", "/v1/organizations/{org}/sponsor-proposals"),
    ("POST", "/v1/sponsor-proposals/{proposal_id}/accept"),
    ("POST", "/v1/sponsor-proposals/{proposal_id}/decline"),
    ("POST", "/v1/sponsor-proposals/{proposal_id}/cancel"),
)

#: Operations deprecated before this change (design.md §7). ``m43-plans-pricing-route`` may add to it.
PREVIOUSLY_DEPRECATED = {"getPricingDocument"}

#: Frontend client bindings of class-A operations, by defining module under ``frontend/src`` (design.md §2.3).
#: A bare name matches any member (``analysisApi.query``) or a direct call (``adminTransferSponsor``).
CLIENT_BINDINGS: dict[str, tuple[str, ...]] = {
    "analysis/archive.ts": ("analysisApi",),
    "api/platform.ts": (
        "platformApi.report", "platformApi.createReport", "platformApi.freezeReport",
        "platformApi.createReportDraft", "platformApi.updateReport", "platformApi.deleteReport",
        "platformApi.publishReport",
        "platformApi.createResource", "platformApi.createResourceRevision", "platformApi.resource",
        "platformApi.updateResource", "platformApi.deleteResource",
    ),
    "api/libraryItems.ts": (
        "libraryItemsApi.create", "libraryItemsApi.item", "libraryItemsApi.rename", "libraryItemsApi.drafts",
        "libraryItemsApi.createDraft", "libraryItemsApi.saveDraft", "libraryItemsApi.seal",
        "libraryItemsApi.publish", "libraryItemsApi.withdraw", "libraryItemsApi.associate",
        "libraryItemsApi.projectItems", "libraryItemsApi.dissociate",
    ),
    "api/library.ts": ("libraryApi.drafts",),
    "api/client.ts": ("adminTransferSponsor",),
}

FRONTEND_DEV = "http://localhost:5173"
#: The names ``CORS_EXPOSED_HEADERS`` held before this change; they stay exposed.
CURRENT_EXPOSED = ("Retry-After", "ETag", "Location", "Content-Disposition", "Digest", "Idempotency-Key")
#: Sample values for path parameters that are slugs (spec: ``isa-demo``, ``p1`` and other slugs).
SLUGS = {"org": "isa-demo", "project": "p1", "report": "report-1", "resource": "r1", "revision": "1"}
#: Parameters every scenario fills with a random UUID (the route parses them as UUIDs, or accepts any string).
UUID_PARAMETERS = {"task_id", "artifact_id", "version_id", "draft_id", "proposal_id", "organization_id"}


def concrete(template: str) -> str:
    """The template with sample values: slugs for slugs, a fresh random UUID for each identifier."""

    def value(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in UUID_PARAMETERS:
            return str(uuid.uuid4())
        return SLUGS[name]

    return re.sub(r"\{([a-z_]+)\}", value, template)


def label(row: tuple[str, str]) -> str:
    return f"{row[0]} {row[1]}"


def assert_deprecation_headers(response) -> None:
    """``Deprecation`` is the pinned value, and ``Sunset`` follows ``EXPECTED_SUNSET`` (absent while ``None``)."""
    where = f"{response.request.method} {response.request.url.path} -> {response.status_code}"
    assert response.headers.get("deprecation") == DEPRECATION, (
        f"{where}: expected Deprecation: {DEPRECATION}, got {response.headers.get('deprecation')!r}"
    )
    if EXPECTED_SUNSET is None:
        assert "sunset" not in response.headers, (
            f"{where}: no Sunset date is recorded, yet the response carries Sunset: {response.headers['sunset']!r}"
        )
    else:
        assert response.headers.get("sunset") == EXPECTED_SUNSET, (
            f"{where}: expected Sunset: {EXPECTED_SUNSET}, got {response.headers.get('sunset')!r}"
        )


def assert_no_deprecation_headers(response) -> None:
    where = f"{response.request.method} {response.request.url.path} -> {response.status_code}"
    assert "deprecation" not in response.headers, f"{where}: unexpected Deprecation: {response.headers['deprecation']!r}"
    assert "sunset" not in response.headers, f"{where}: unexpected Sunset: {response.headers['sunset']!r}"


async def call(client, method: str, path: str, headers: dict[str, str] | None = None):
    """One request with an empty JSON body where the method takes one; the route decides the status."""
    if method in {"POST", "PUT", "PATCH"}:
        return await client.request(method, path, json={}, headers=headers)
    return await client.request(method, path, headers=headers)


# -- 1.1: every row carries Deprecation, whatever the status -------------------------------------------------


@pytest.mark.parametrize("row", RETIRED, ids=label)
async def test_every_retired_operation_carries_the_deprecation_header(api_client, row):
    """[utest->req~gateway-api-retired-operation-set~1] [utest->req~gateway-api-retired-operation-deprecation~1]
    [utest->req~gateway-api-retired-operation-no-sunset~1]"""
    method, template = row

    response = await call(api_client, method, concrete(template))

    assert_deprecation_headers(response)


def test_the_literal_tables_are_the_ones_the_spec_lists():
    """Guards the literals themselves: 36 unique rows, 12 unique class-B rows, and no overlap."""
    assert len(RETIRED) == 36 and len(set(RETIRED)) == 36
    assert len(KEPT_CALLED) == 12 and len(set(KEPT_CALLED)) == 12
    assert not set(RETIRED) & set(KEPT_CALLED)


# -- 1.2: one authenticated call per area, statuses unchanged -----------------------------------------------


async def member_of_isa_demo(client, registration) -> dict[str, str]:
    """An account on the largest plan that owns organization ``isa-demo`` and its project ``p1``."""
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    space_client.get_gate().plans[uuid.UUID(created.json()["id"])] = largest_plan()
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    organization = await client.post("/v1/organizations", headers=headers, json={"slug": "isa-demo", "name": "ISA demo"})
    assert organization.status_code == 201, organization.text
    project = await client.post(
        "/v1/organizations/isa-demo/projects", headers=headers,
        json={"slug": "p1", "name": "P1", "visibility": "private"},
    )
    assert project.status_code == 201, project.text
    return headers


@pytest_asyncio.fixture
async def member(api_client, registration):
    return await member_of_isa_demo(api_client, registration)


async def test_a_refused_call_still_carries_the_header(api_client):
    """[utest->req~gateway-api-retired-operation-deprecation~1]"""
    response = await api_client.get("/v1/analysis/sources")

    assert response.status_code == 401, response.text
    assert_deprecation_headers(response)


async def test_decision_space_read_keeps_its_status(api_client, member):
    """[utest->req~gateway-api-retired-operation-deprecation~1] [utest->req~gateway-api-retired-operation-unchanged~1]"""
    response = await api_client.get("/v1/analysis/sources", headers=member)

    assert response.status_code == 200, response.text
    assert_deprecation_headers(response)


async def test_library_create_keeps_its_status(api_client, member):
    """[utest->req~gateway-api-retired-operation-deprecation~1] [utest->req~gateway-api-retired-operation-unchanged~1]"""
    response = await api_client.post(
        "/v1/organizations/isa-demo/library", headers=member,
        json={"name": "shared-data", "display_name": "Shared data", "kind": "Dataset"},
    )

    assert response.status_code == 201, response.text
    assert_deprecation_headers(response)


async def test_report_create_keeps_its_status(api_client, member):
    """[utest->req~gateway-api-retired-operation-deprecation~1] [utest->req~gateway-api-retired-operation-unchanged~1]"""
    response = await api_client.post(
        "/v1/organizations/isa-demo/projects/p1/reports", headers=member,
        json={"slug": "findings", "title": "Findings", "document": {}},
    )

    assert response.status_code == 201, response.text
    assert_deprecation_headers(response)


async def test_resource_create_keeps_its_status(api_client, member):
    """[utest->req~gateway-api-retired-operation-deprecation~1] [utest->req~gateway-api-retired-operation-unchanged~1]"""
    response = await api_client.post(
        "/v1/organizations/isa-demo/projects/p1/resources", headers=member,
        json={"slug": "offers", "name": "Offers", "kind": "qos-offerings"},
    )

    assert response.status_code == 201, response.text
    assert_deprecation_headers(response)


async def test_a_not_found_inside_a_matched_route_carries_the_header(api_client, member):
    """[utest->req~gateway-api-retired-operation-deprecation~1] [utest->req~gateway-api-retired-operation-unchanged~1]"""
    response = await api_client.get(f"/v1/sponsor-proposals/{uuid.uuid4()}", headers=member)

    assert response.status_code == 404, response.text
    assert_deprecation_headers(response)


async def test_a_request_validation_error_carries_the_header(api_client):
    """[utest->req~gateway-api-retired-operation-deprecation~1]"""
    response = await api_client.get("/v1/artifacts/not-a-uuid")

    assert response.status_code == 422, response.text
    assert_deprecation_headers(response)


async def test_the_streaming_export_carries_the_header_and_the_same_body(api_client, db_session, registration):
    """The fixture of ``test_archive_analysis.py::test_api_canonical_sources_revision_export_and_auth``.

    [utest->req~gateway-api-retired-operation-deprecation~1] [utest->req~gateway-api-retired-operation-unchanged~1]
    """
    from bim_core.compiler import compile_instance, compiler_bundle_digest
    from bim_core.package import load_package
    from sqlalchemy import select

    from openbinding_gateway.db.models import Job, JobState, User

    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    token = (await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]},
    )).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    owner = (await db_session.execute(select(User).where(User.username == details["username"]))).scalar_one()
    problem = compile_instance(load_package(REPO_ROOT / "examples/demo/17_analysis_tradeoffs"))
    binding = {t: refs[0] for t, refs in problem.document["spec"]["eligibility"].items()}
    result = {"solutions": [{"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)}]}
    jobs = [Job(owner_id=owner.id, engine_id="diagnostic", engine_job_id=f"deprecation-fixture-{i}",
                service_url="https://example.invalid", state=JobState.COMPLETED,
                original_request={"bindingProblem": problem.document}, result=copy.deepcopy(result),
                provenance={"irDigest": problem.digest, "evaluatorDigest": compiler_bundle_digest()})
            for i in range(2)]
    db_session.add_all(jobs)
    await db_session.commit()
    query = {"sources": [str(job.id) for job in jobs]}
    answer = await api_client.post("/v1/analysis/query", json=query, headers=headers)
    assert answer.status_code == 200, answer.text
    selected = answer.json()["winners"][0]["id"]

    response = await api_client.post("/v1/analysis/export", json={**query, "format": "csv"}, headers=headers)

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == 'attachment; filename="binding-archive.csv"'
    lines = response.text.splitlines()
    assert lines[0].startswith("id,rank,score_group,eligible,feasible,score,reasons")
    assert len(lines) == 2 and lines[1].startswith(selected + ",")
    assert_deprecation_headers(response)


# -- 1.3 and 1.4: guards, nothing outside the table carries either header -----------------------------------


@pytest.mark.parametrize("row", KEPT_CALLED, ids=label)
async def test_operations_kept_screens_call_carry_neither_header(api_client, row):
    """Negative control: passes on the base by design.

    [utest->req~gateway-api-retired-operation-set~1] [utest->req~gateway-api-retired-operation-no-match~1]
    """
    method, template = row

    response = await call(api_client, method, concrete(template))

    assert_no_deprecation_headers(response)


@pytest.mark.parametrize("method, path", [
    ("GET", "/health"),
    ("GET", "/v1/organizations"),
    ("GET", "/v1/organizations/isa-demo/projects/p1/publications"),
    ("DELETE", "/v1/organizations/isa-demo/projects/p1/publications/pub1"),
])
async def test_other_kept_operations_carry_neither_header(api_client, method, path):
    """Negative control: passes on the base by design.

    [utest->req~gateway-api-retired-operation-set~1] [utest->req~gateway-api-retired-operation-no-match~1]
    [utest->req~gateway-api-retired-operation-no-sunset~1]
    """
    response = await api_client.request(method, path)

    assert_no_deprecation_headers(response)


@pytest.mark.parametrize("method, template", [
    ("PUT", "/v1/analysis/sources"),
    ("DELETE", "/v1/artifacts/{artifact_id}"),
])
async def test_a_wrong_method_on_a_retired_path_carries_neither_header(api_client, method, template):
    """Negative control: passes on the base by design. [utest->req~gateway-api-retired-operation-no-match~1]"""
    response = await api_client.request(method, concrete(template))

    assert response.status_code == 405, response.text
    assert_no_deprecation_headers(response)


async def test_an_unknown_path_carries_neither_header(api_client):
    """Negative control: passes on the base by design. [utest->req~gateway-api-retired-operation-no-match~1]"""
    response = await api_client.get("/v1/analysis/does-not-exist")

    assert response.status_code == 404, response.text
    assert_no_deprecation_headers(response)


async def test_a_cors_preflight_carries_neither_header(api_client):
    """Negative control: passes on the base by design. [utest->req~gateway-api-retired-operation-no-match~1]"""
    response = await api_client.options(
        "/v1/analysis/sources",
        headers={"Origin": FRONTEND_DEV, "Access-Control-Request-Method": "GET"},
    )

    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == FRONTEND_DEV
    assert_no_deprecation_headers(response)


# -- 1.5: the OpenAPI document declares what is sent -------------------------------------------------------


@pytest.fixture(scope="module")
def document() -> dict:
    return app.openapi()


def operation(document: dict, row: tuple[str, str]) -> dict:
    method, template = row
    path_item = document["paths"].get(template)
    assert path_item is not None, f"{template} is not a path of the OpenAPI document"
    found = path_item.get(method.lower())
    assert found is not None, f"{method} {template} is not an operation of the OpenAPI document"
    return found


def test_exactly_the_retired_and_previously_deprecated_operations_are_deprecated(document):
    """[utest->req~gateway-api-retired-operation-openapi~1]"""
    deprecated = {
        entry["operationId"]
        for path_item in document["paths"].values()
        for entry in path_item.values()
        if isinstance(entry, dict) and entry.get("deprecated") is True
    }
    expected = {operation(document, row)["operationId"] for row in RETIRED} | PREVIOUSLY_DEPRECATED

    assert sorted(expected - deprecated) == [], "retired or previously deprecated operations not marked deprecated"
    assert sorted(deprecated - expected) == [], "operations marked deprecated outside the table"


@pytest.mark.parametrize("row", RETIRED, ids=label)
def test_every_response_of_a_retired_operation_declares_the_headers(document, row):
    """[utest->req~gateway-api-retired-operation-openapi-headers~1] [utest->req~gateway-api-retired-operation-no-sunset~1]"""
    responses = operation(document, row)["responses"]

    assert responses
    for status, response in responses.items():
        headers = response.get("headers", {})
        assert headers.get("Deprecation") == {"$ref": "#/components/headers/Deprecation"}, (
            f"{label(row)} response {status} does not declare Deprecation"
        )
        if EXPECTED_SUNSET is None:
            assert "Sunset" not in headers, f"{label(row)} response {status} declares Sunset, but no date is recorded"
        else:
            assert headers.get("Sunset") == {"$ref": "#/components/headers/Sunset"}, (
                f"{label(row)} response {status} does not declare Sunset"
            )


def test_the_header_components_follow_the_recorded_date(document):
    """[utest->req~gateway-api-retired-operation-openapi-headers~1] [utest->req~gateway-api-retired-operation-no-sunset~1]"""
    components = document.get("components", {}).get("headers", {})

    assert "Deprecation" in components
    if EXPECTED_SUNSET is None:
        assert "Sunset" not in components
    else:
        assert "Sunset" in components


@pytest.mark.parametrize("row", KEPT_CALLED, ids=label)
def test_operations_kept_screens_call_declare_neither_header(document, row):
    """Passes on the base: the class-B operations stay unmarked. [utest->req~gateway-api-retired-operation-openapi-headers~1]"""
    found = operation(document, row)

    assert found.get("deprecated") is not True
    for status, response in found["responses"].items():
        headers = response.get("headers", {})
        assert "Deprecation" not in headers and "Sunset" not in headers, f"{label(row)} response {status}"


# -- 1.6: browsers may read both headers -------------------------------------------------------------------


async def test_both_header_names_are_exposed_to_an_allowed_origin(api_client):
    """[utest->req~gateway-api-deprecation-headers-exposed~1]"""
    response = await api_client.get("/v1/analysis/sources", headers={"Origin": FRONTEND_DEV})

    assert response.headers["access-control-allow-origin"] == FRONTEND_DEV
    exposed = {name.strip().lower() for name in response.headers["access-control-expose-headers"].split(",")}
    assert {"deprecation", "sunset"} <= exposed, f"exposed: {sorted(exposed)}"
    assert {name.lower() for name in CURRENT_EXPOSED} <= exposed, f"exposed: {sorted(exposed)}"


# -- 1.7: guard, no kept screen calls a client binding of a retired operation -------------------------------


def binding_pattern(binding: str) -> re.Pattern[str]:
    """``platformApi.report`` matches ``platformApi.report(`` and never ``platformApi.reports``."""
    return re.compile(r"(?<![\w$])" + re.escape(binding) + r"(?![\w$])")


PATTERNS = [(binding, binding_pattern(binding)) for bindings in CLIENT_BINDINGS.values() for binding in bindings]


def scanned_files(source: Path) -> list[Path]:
    """Every ``.ts``/``.tsx`` file except the defining modules, ``*.test.ts(x)`` and ``test/**``."""
    files = []
    for path in sorted(source.rglob("*")):
        if path.suffix not in {".ts", ".tsx"} or not path.is_file():
            continue
        relative = path.relative_to(source).as_posix()
        if relative in CLIENT_BINDINGS or relative.startswith("test/") or re.search(r"\.test\.tsx?$", relative):
            continue
        files.append(path)
    return files


def kept_callers(source: Path) -> list[str]:
    """``file: binding`` for every reference; fails (never skips) when ``source`` is missing."""
    if not source.is_dir():
        pytest.fail(f"the frontend sources are missing at {source}: the no-kept-caller scan cannot run")
    findings = []
    for path in scanned_files(source):
        text = path.read_text(encoding="utf-8")
        for binding, pattern in PATTERNS:
            if pattern.search(text):
                findings.append(f"{path.relative_to(source).as_posix()}: {binding}")
    return findings


def test_no_kept_screen_references_a_retired_operation_binding():
    """Negative control: passes on the base by design. [utest->req~gateway-api-retired-operation-no-kept-caller~1]"""
    source = REPO_ROOT / "frontend" / "src"

    findings = kept_callers(source)

    assert scanned_files(source), f"no source file scanned under {source}"
    assert findings == [], "kept screens reference client bindings of retired operations:\n" + "\n".join(findings)


def test_the_scan_names_the_file_and_the_binding_and_skips_class_b_members(tmp_path):
    """[utest->req~gateway-api-retired-operation-no-kept-caller~1]"""
    pages = tmp_path / "pages" / "Reports"
    pages.mkdir(parents=True)
    (pages / "Report.tsx").write_text("await platformApi.report(org, project, slug)\n", encoding="utf-8")
    (pages / "List.tsx").write_text(
        "platformApi.reports(org, project); libraryApi.versions(id); libraryItemsApi.list(org)\n", encoding="utf-8"
    )
    (tmp_path / "api").mkdir()
    (tmp_path / "api" / "platform.ts").write_text("export const platformApi = { report: () => 1 }; platformApi.report()\n", encoding="utf-8")
    (pages / "Report.test.tsx").write_text("platformApi.report(org, project, slug)\n", encoding="utf-8")
    (tmp_path / "test").mkdir()
    (tmp_path / "test" / "helpers.ts").write_text("analysisApi.query()\n", encoding="utf-8")

    assert kept_callers(tmp_path) == ["pages/Reports/Report.tsx: platformApi.report"]


def test_the_scan_fails_when_the_frontend_sources_are_missing(tmp_path):
    """[utest->req~gateway-api-retired-operation-no-kept-caller~1]"""
    with pytest.raises(pytest.fail.Exception, match="frontend sources are missing"):
        kept_callers(tmp_path / "frontend" / "src")
