"""Unit tests of ``core/deprecation.py``: the table, the recorded Sunset date, the OpenAPI headers and the docs page.

The end-to-end behaviour with no date recorded is in ``test_retired_operations_deprecation.py``.
"""

from __future__ import annotations

import datetime
import re

import pytest
from _repo import REPO_ROOT

from openbinding_gateway.core import deprecation
from openbinding_gateway.main import app, create_app

SUNSET_DAY = datetime.date(2027, 4, 15)
SUNSET_HEADER = "Thu, 15 Apr 2027 23:59:59 GMT"
#: 90 days after the Deprecation date 2026-10-22.
SUNSET_FLOOR = datetime.date(2027, 1, 20)

#: Class-B operations kept screens still call; never rows.
KEPT_CALLED = {
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
}

DOCS = REPO_ROOT / "docs" / "API_DEPRECATIONS.md"


def application_operations() -> set[tuple[str, str]]:
    document = app.openapi()
    return {
        (method.upper(), path)
        for path, item in document["paths"].items()
        for method in item
        if method in {"get", "put", "post", "delete", "patch"}
    }


# [utest->req~gateway-api-retired-operation-set~1]
def test_the_table_has_36_unique_rows_that_are_routes_of_the_application():
    rows = deprecation.RETIRED_OPERATIONS

    assert len(rows) == 36 and len(set(rows)) == 36
    assert set(rows) <= application_operations()
    assert not set(rows) & KEPT_CALLED


def test_the_deprecation_value_is_the_pinned_date():
    assert deprecation.DEPRECATION_VALUE == "@1792627200"
    moment = datetime.datetime.fromtimestamp(1792627200, tz=datetime.timezone.utc)
    assert moment == datetime.datetime(2026, 10, 22, tzinfo=datetime.timezone.utc)


# [utest->req~gateway-api-retired-operation-no-sunset~1]
def test_no_sunset_value_while_no_date_is_recorded():
    if deprecation.RETIRED_OPERATIONS_SUNSET is None:
        assert deprecation.sunset_value() is None
        assert [name for name, _ in deprecation.response_headers()] == [b"deprecation"]


# [utest->req~gateway-api-retired-operation-sunset~1]
def test_sunset_value_is_the_imf_fixdate_at_the_end_of_the_day(monkeypatch):
    monkeypatch.setattr(deprecation, "RETIRED_OPERATIONS_SUNSET", SUNSET_DAY)

    assert deprecation.sunset_value() == SUNSET_HEADER


# [utest->req~gateway-api-retired-operation-sunset~1]
async def test_sunset_is_sent_on_a_table_row_and_not_elsewhere(monkeypatch, api_client):
    monkeypatch.setattr(deprecation, "RETIRED_OPERATIONS_SUNSET", SUNSET_DAY)

    retired = await api_client.get("/v1/analysis/sources")
    kept = await api_client.get("/v1/organizations/isa-demo/projects/p1/resources")

    assert retired.status_code == 401
    assert retired.headers["sunset"] == SUNSET_HEADER
    assert retired.headers["deprecation"] == "@1792627200"
    assert "sunset" not in kept.headers and "deprecation" not in kept.headers


# [utest->req~gateway-api-retired-operation-openapi-headers~1]
def test_the_openapi_document_declares_sunset_once_a_date_is_recorded(monkeypatch):
    monkeypatch.setattr(deprecation, "RETIRED_OPERATIONS_SUNSET", SUNSET_DAY)
    document = create_app().openapi()

    for method, template in deprecation.RETIRED_OPERATIONS:
        for status, response in document["paths"][template][method.lower()]["responses"].items():
            headers = response["headers"]
            assert headers["Deprecation"] == {"$ref": "#/components/headers/Deprecation"}, (method, template, status)
            assert headers["Sunset"] == {"$ref": "#/components/headers/Sunset"}, (method, template, status)
    assert "Sunset" in document["components"]["headers"]
    kept = document["paths"]["/v1/organizations/{org}/library"]["get"]["responses"]
    assert all("Sunset" not in response.get("headers", {}) for response in kept.values())


# [utest->req~gateway-api-retired-operation-sunset-floor~1]
def test_a_recorded_sunset_date_is_a_date_not_earlier_than_the_floor():
    recorded = deprecation.RETIRED_OPERATIONS_SUNSET

    if recorded is None:
        return
    assert type(recorded) is datetime.date
    assert recorded >= SUNSET_FLOOR, f"a recorded Sunset date must be {SUNSET_FLOOR} or later, got {recorded}"


# [utest->req~gateway-api-retired-operation-docs~1]
def test_the_docs_page_lists_every_row_and_no_kept_operation():
    text = DOCS.read_text(encoding="utf-8")
    entries = set(re.findall(r"^- `([A-Z]+) (\S+)`$", text, flags=re.MULTILINE))

    assert set(deprecation.RETIRED_OPERATIONS) <= entries
    assert not entries & KEPT_CALLED
    assert "2026-10-22" in text
    if deprecation.RETIRED_OPERATIONS_SUNSET is None:
        assert "not set yet" in text and "plus 90 days" in text
    else:
        assert deprecation.RETIRED_OPERATIONS_SUNSET.isoformat() in text


@pytest.mark.parametrize("name", ["Deprecation", "Sunset"])
def test_both_header_names_are_exposed_by_settings(name):
    from openbinding_gateway.core.settings import CORS_EXPOSED_HEADERS

    assert name in CORS_EXPOSED_HEADERS
