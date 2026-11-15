"""The stateless BIM language services: ``POST /v1/bim/validate`` and ``GET /v1/bim/templates*`` (D25, D26)."""

from __future__ import annotations

import io
import zipfile

import pytest
from bim_core.compiler import ir_digest
from sqlalchemy import func, select

from _b1_helpers import gate, make_account, make_key  # noqa: F401,F811
from _problem_helpers import ZIP, make_org, package_bytes
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.base import Base
from openbinding_gateway.modules.problems.adapters import bim_routes
from openbinding_gateway.modules.problems.application import validate as validate_module

pytestmark = pytest.mark.asyncio

VALIDATE = "/v1/bim/validate"


def broken_package() -> bytes:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as handle:
        handle.writestr("instance.json", b'{"apiVersion": "bim/v1", "kind": "Instance", "metadata": {"name": "x"}, "spec": {}}')
    return archive.getvalue()


async def row_counts(db) -> dict[str, int]:
    return {
        table.name: int(await db.scalar(select(func.count()).select_from(table)) or 0)
        for table in Base.metadata.sorted_tables
    }


async def test_a_visitor_validates_a_package_and_learns_its_identities(api_client, db_session):
    before = await row_counts(db_session)

    response = await api_client.post(VALIDATE, content=package_bytes(), headers=ZIP)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["valid"] is True
    for key in ("instanceDigest", "packageDigest", "irDigest"):
        assert body[key].startswith("sha256-")
    assert "instance.json" in body["fileDigests"]
    assert body["resourceDigests"]
    assert set(body["analysis"]) == {"tasks", "candidates", "constraints", "placement", "bindingSpace"}
    assert isinstance(body["compatibleModes"], list)
    assert "ir" not in body and "sourceMap" not in body
    assert await row_counts(db_session) == before


async def test_the_modes_are_the_ones_the_caller_can_see(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    seen = []
    real = validate_module.compatible_modes

    async def recording(ir, caller, session):
        seen.append(caller)
        return await real(ir, caller, session)

    monkeypatch.setattr(validate_module, "compatible_modes", recording)
    account, headers = await make_account(api_client, registration, db_session, gate)

    anonymous = await api_client.post(VALIDATE, content=package_bytes(), headers=ZIP)
    signed_in = await api_client.post(VALIDATE, content=package_bytes(), headers={**headers, **ZIP})

    assert anonymous.status_code == signed_in.status_code == 200
    assert seen[0] is None
    assert str(seen[1].id) == account["id"]
    assert signed_in.json()["compatibleModes"]


async def test_include_ir_returns_the_ir_of_the_digest_and_its_source_map(api_client):
    response = await api_client.post(VALIDATE, params={"include": "ir"}, content=package_bytes(), headers=ZIP)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ir"]["kind"] == "BindingProblem"
    assert ir_digest(body["ir"]) == body["irDigest"]
    assert isinstance(body["sourceMap"], dict)


async def test_a_refused_package_answers_located_diagnostics(api_client):
    response = await api_client.post(VALIDATE, content=broken_package(), headers=ZIP)

    assert response.status_code == 422, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "invalid_instance"
    assert response.json()["diagnostics"]


async def test_the_snapshot_form_is_gone(api_client):
    response = await api_client.post(VALIDATE, json={"snapshot": "00000000-0000-0000-0000-000000000000"})

    assert response.status_code == 415, response.text


async def test_a_package_above_the_limit_is_a_413(api_client, monkeypatch):
    monkeypatch.setattr(bim_routes, "max_compressed", lambda caller: 10)

    response = await api_client.post(VALIDATE, content=b"x" * 11, headers=ZIP)

    assert response.status_code == 413, response.text


async def test_a_binding_space_above_the_deployment_limit_is_refused(api_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_binding_space_log10", 0.0)

    response = await api_client.post(VALIDATE, content=package_bytes(), headers=ZIP)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "binding_space_over_technical_limit"


async def test_validation_is_counted_as_compile_work_for_every_caller(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    settings = get_settings()
    monkeypatch.setattr(settings, "work_rate_limit_compile_requests", 1)
    monkeypatch.setattr(settings, "work_rate_limit_signed_in_multiplier", 2)
    monkeypatch.setattr(settings, "work_rate_limit_window_s", 3600)
    _, headers = await make_account(api_client, registration, db_session, gate)

    anonymous = [(await api_client.post(VALIDATE, content=b"", headers=ZIP)).status_code for _ in range(2)]
    signed_in = [(await api_client.post(VALIDATE, content=b"", headers={**headers, **ZIP})).status_code for _ in range(3)]

    assert anonymous == [422, 429]
    assert signed_in == [422, 422, 429]


async def test_the_templates_are_listed_and_served_as_packages_an_upload_accepts(
    api_client, registration, db_session, gate  # noqa: F811
):
    listed = await api_client.get("/v1/bim/templates")
    assert listed.status_code == 200
    assert "demo/01_simple_seq" in listed.json()["templates"]

    template = await api_client.get("/v1/bim/templates/demo/01_simple_seq")
    assert template.status_code == 200
    assert template.headers["content-type"] == "application/vnd.bim+zip"
    assert template.headers["digest"].startswith("sha-256=")

    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    created = await api_client.post(
        f"/v1/organizations/{org}/problems", content=template.content, headers={**headers, **ZIP},
    )
    assert created.status_code == 201, created.text


@pytest.mark.parametrize("path", ["../openbinding-gateway", "demo/../../docs", "no/such/template"])
async def test_a_path_outside_the_templates_is_a_404(api_client, path):
    response = await api_client.get(f"/v1/bim/templates/{path}")

    assert response.status_code == 404, response.text


async def test_an_api_key_needs_problems_read_to_validate_and_nothing_for_templates(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    without = await make_key(api_client, headers, ["account:read"])
    reader = await make_key(api_client, headers, ["problems:read"])

    refused = await api_client.post(VALIDATE, content=package_bytes(), headers={**without, **ZIP})
    allowed = await api_client.post(VALIDATE, content=package_bytes(), headers={**reader, **ZIP})
    templates = await api_client.get("/v1/bim/templates", headers=without)

    assert refused.status_code == 403, refused.text
    assert allowed.status_code == 200, allowed.text
    assert templates.status_code == 200, templates.text
