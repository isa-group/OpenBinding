"""The offering is read through the ``PricingSource`` port when an evaluation row is created, and the version read
is recorded with it; nothing commercial ever invalidates a binding."""

from __future__ import annotations

import uuid

import pytest
import yaml
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from _problem_helpers import make_org
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import CompositionEvaluation, PricingSnapshot
from openbinding_gateway.modules.compositions.application import offering as offering_module
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import set_pricing_source
from compositions._sphere import BINDING, YAML, compositions, generated_problem
from problems._sphere_helpers import member

pytestmark = pytest.mark.asyncio

TOMATOMETER_VERSION = "6921867e7004563bd918e7e8"


@pytest.fixture(autouse=True)
def forget_failures():
    offering_module.clear_failures()
    yield
    offering_module.clear_failures()


def declared(offering: dict, label: str = "1.0.0") -> bytes:
    """A document linked to no problem, with ``offering``."""
    return yaml.safe_dump({
        "syntaxVersion": "1.0", "composition": "shop", "version": label, "kind": "workflow",
        "workflow": {"seq": ["t1", "t2"]}, "binding": {"t1": {"candidate": "c1a"}, "t2": {"local": True}},
        "values": {"latency": {"value": 30, "unit": "ms"}}, "offering": offering,
    }, sort_keys=False).encode()


async def _shop(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, organization, user = await member(api_client, registration, db_session, gate)
    created = await api_client.post(f"/v1/organizations/{org}/compositions", json={"slug": "shop", "name": "Shop"},
                                    headers=headers)
    assert created.status_code == 201, created.text
    return headers, org, f"/v1/organizations/{org}/compositions/shop"


async def _seal(api_client, headers, base, body: bytes):
    sealed = await api_client.post(f"{base}/versions", content=body, headers={**headers, **YAML})
    assert sealed.status_code in (200, 201), sealed.text
    return sealed.json()


def _codes(body) -> dict[str, str]:
    return {item["code"]: item["message"] for item in body["diagnostics"]}


async def test_a_sphere_offering_is_read_and_recorded(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    body = await _seal(api_client, headers, base, declared({"sphere": "sphere/tomatometer"}))
    offering = body["evaluation"]["offering"]
    assert offering["status"] == "read" and offering["versionName"] == "1.0.0"
    snapshot = await db_session.get(PricingSnapshot, uuid.UUID(offering["snapshot"]))
    assert snapshot.version_id == TOMATOMETER_VERSION
    row = await db_session.scalar(select(CompositionEvaluation).where(CompositionEvaluation.id == uuid.UUID(body["evaluation"]["id"])))
    assert row.offering_status == "read" and row.offering_snapshot_id == snapshot.id
    assert "c2y_offering_unreadable" not in _codes(body)

    # The same content sealed again has its evaluation: nothing is read.
    calls = len(sphere.requests)
    again = await _seal(api_client, headers, base, declared({"sphere": "sphere/tomatometer"}))
    assert again["version"]["id"] == body["version"]["id"] and len(sphere.requests) == calls
    # Reading the sealed version, checking it, never read.
    await api_client.get(f"{base}/versions/1", headers=headers)
    await api_client.post(f"{base}/versions/check", content=declared({"sphere": "sphere/tomatometer"}, "2.0.0"),
                          headers={**headers, **YAML})
    assert len(sphere.requests) == calls


@pytest.mark.parametrize(
    ("sphere_name", "reason"),
    [
        ("sphere/resend", "ambiguous"),
        ("nobody/resend", "not found or not visible"),
    ],
)
async def test_an_unreadable_sphere_offering_is_a_warning(api_client, registration, db_session, gate, sphere, sphere_name, reason):  # noqa: F811
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    body = await _seal(api_client, headers, base, declared({"sphere": sphere_name}))
    assert body["evaluation"]["offering"]["status"] == "unreadable"
    assert reason in _codes(body)["c2y_offering_unreadable"]
    assert body["version"]["values_status"] == "declared"


async def test_a_multi_word_slug_resolves_by_slug_not_display_name(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    body = await _seal(api_client, headers, base, declared({"sphere": "danruilop1/twilio-sendgrid-email-api"}))
    assert body["evaluation"]["offering"]["status"] == "read", body["diagnostics"]


async def test_a_registry_offering_reads_the_registry_and_an_unknown_alias_reads_nothing(
    api_client, registration, db_session, gate, sphere, monkeypatch,  # noqa: F811
):
    sphere.add_host("registry.internal", "10.0.0.7")
    registries = Settings(sphere_registries={"onprem": {"url": "https://registry.internal"}}).sphere_registries
    settings = get_settings()
    monkeypatch.setattr(settings, "sphere_registries", registries)
    set_pricing_source(SphereHttpSource(settings.model_copy(update={"sphere_enabled": True}), transport=sphere.transport()))
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    body = await _seal(api_client, headers, base, declared({"sphere": "sphere/tomatometer", "registry": "onprem"}))
    assert body["evaluation"]["offering"]["status"] == "read", body["diagnostics"]
    assert any(sphere.host_of(r) == "registry.internal" for r in sphere.requests)

    calls = len(sphere.requests)
    other = await _seal(api_client, headers, base, declared({"sphere": "sphere/tomatometer", "registry": "elsewhere"}, "2.0.0"))
    assert other["evaluation"]["offering"]["status"] == "registry_unknown"
    assert "c2y_offering_registry_unknown" in _codes(other) and "c2y_offering_unreadable" not in _codes(other)
    assert len(sphere.requests) == calls


TOMATO_YAML = (
    b"syntaxVersion: '3.1'\nsaasName: Shop\nversion: '1'\ncreatedAt: '2026-11-18'\ncurrency: USD\n"
    b"plans:\n  BASIC:\n    price: 10\n    unit: user/month\n"
)


async def test_a_url_offering_is_kept_once_per_content(api_client, registration, db_session, gate, sphere):  # noqa: F811
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.serve("/offering.yml", TOMATO_YAML, {"content-type": "application/yaml"})
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    first = await _seal(api_client, headers, base, declared({"url": "https://pricings.example/offering.yml"}))
    assert first["evaluation"]["offering"]["status"] == "read", first["diagnostics"]
    snapshot = await db_session.get(PricingSnapshot, uuid.UUID(first["evaluation"]["offering"]["snapshot"]))
    assert snapshot.source_kind == "url" and snapshot.scope_key != "public"
    calls = len(sphere.requests)
    second = await _seal(api_client, headers, base, declared({"url": "https://pricings.example/offering.yml"}, "2.0.0"))
    # Within OFFERING_URL_MIN_INTERVAL_S: the stored copy, with no request.
    assert second["evaluation"]["offering"]["snapshot"] == first["evaluation"]["offering"]["snapshot"]
    assert len(sphere.requests) == calls
    assert await db_session.scalar(select(func.count()).select_from(PricingSnapshot).where(PricingSnapshot.source_kind == "url")) == 1


@pytest.mark.parametrize(
    ("script", "url", "status", "words"),
    [
        ("redirect_http", "https://pricings.example/moved.yml", "unreadable", "redirects"),
        ("private", "https://internal.example/o.yml", "unreadable", "public address"),
        ("metadata", "https://metadata.example/o.yml", "unreadable", "public address"),
        ("large", "https://pricings.example/large.yml", "unreadable", "5 MiB"),
        ("slow", "https://pricings.example/slow.yml", "unreadable", "in time"),
        ("not_yaml", "https://pricings.example/text.yml", "invalid_pricing", ""),
        ("old", "https://pricings.example/old.yml", "invalid_pricing", "2.1"),
    ],
)
async def test_a_url_that_cannot_be_read_is_a_warning(
    api_client, registration, db_session, gate, sphere, monkeypatch, script, url, status, words,  # noqa: F811
):
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.add_host("internal.example", "10.0.0.5")
    sphere.add_host("metadata.example", "169.254.169.254")
    if script == "redirect_http":
        sphere.redirect("/moved.yml", "http://pricings.example/offering.yml")
    elif script == "large":
        sphere.oversize("/large.yml", 6 * 1024 * 1024)
    elif script == "slow":
        monkeypatch.setattr(offering_module, "READ_TIMEOUT_S", 0.2)
        sphere.slow("/slow.yml", 5)
    elif script == "not_yaml":
        sphere.serve("/text.yml", b"<html>not a pricing</html>", {"content-type": "text/html"})
    elif script == "old":
        sphere.serve("/old.yml", b"syntaxVersion: '2.1'\nsaasName: Old\nplans: {}\n", {"content-type": "application/yaml"})
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    body = await _seal(api_client, headers, base, declared({"url": url}))
    assert body["evaluation"]["offering"]["status"] == status
    code = "c2y_offering_unreadable" if status == "unreadable" else "c2y_offering_invalid_pricing"
    assert words in _codes(body)[code]
    assert body["version"]["values_status"] == "declared"  # sealed all the same


async def test_derive_fork_and_reevaluation_record_the_offering(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    request = {"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0",
               "offering": {"sphere": "sphere/tomatometer"}}
    calls = len(sphere.requests)
    draft = await api_client.post(f"{base}/derive", headers=headers, json={**request, "seal": False})
    assert draft.status_code == 200 and len(sphere.requests) == calls  # a draft reads nothing
    derived = await api_client.post(f"{base}/derive", headers=headers, json=request)
    assert derived.status_code == 201, derived.text
    assert derived.json()["evaluation"]["offering"]["status"] == "read"
    assert derived.json()["evaluation"]["offering"]["versionName"] == "1.0.0"
    # Evaluating another binding or reading the neighbourhood never reads the offering.
    calls = len(sphere.requests)
    await api_client.post(f"{base}/evaluate", headers=headers, json={"version": "1.0.0", "binding": BINDING})
    assert len(sphere.requests) == calls

    # Re-evaluating on the basis that already has a row returns it and reads nothing.
    calls = len(sphere.requests)
    again = await api_client.post(f"{base}/versions/1.0.0/evaluations", headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["offering"]["status"] == "read" and len(sphere.requests) == calls

    other = await make_org(api_client, headers)
    forked = await api_client.post(f"{base}/fork", headers=headers,
                                   json={"version": "1.0.0", "slug": "summary-copy", "targetOrganization": other, "dropProblem": True})
    assert forked.status_code == 201, forked.text
    assert [e["offering"]["status"] for e in forked.json()["version"]["evaluations"]] == ["read"], forked.json()


async def test_the_binding_is_judged_alike_with_and_without_an_offering(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, base = await _shop(api_client, registration, db_session, gate)
    sphere.add_host("nowhere.example", "10.0.0.9")
    with_offering = await _seal(api_client, headers, base, declared({"url": "https://nowhere.example/o.yml"}))
    without = await api_client.post(f"{base}/versions/check", content=declared({"sphere": "sphere/tomatometer"}, "9.0.0"),
                                    headers={**headers, **YAML})
    assert with_offering["version"]["values_status"] == without.json()["values_status"] == "declared"
    assert without.json()["valid"] is True
