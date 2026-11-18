"""A version's upstream pricings from stored snapshots alone, and hand-written ``from`` snapshotted at seal."""

from __future__ import annotations

import pytest
import yaml
from sqlalchemy import update

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.db.models import Composition
from openbinding_gateway.modules.compositions.application import upstream as upstream_module
from openbinding_gateway.composition.document import Provenance
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import set_pricing_source
from compositions._sphere import BINDING, YAML, compositions, generated_problem

pytestmark = pytest.mark.asyncio

RESEND_FROM = {"sphere": "sphere/resend", "version": "69639298641bc8e6c0f764d1", "plan": "Pro"}


async def _derived(api_client, headers, base, **extra):
    derived = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0", **extra},
    )
    assert derived.status_code == 201, derived.text
    return derived.json()


async def test_a_derived_version_lists_its_upstream_plans_and_value_sources(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    await _derived(api_client, headers, base, offering={"sphere": "sphere/tomatometer"})
    calls = len(sphere.requests)
    view = await api_client.get(f"{base}/upstream", headers=headers)
    assert view.status_code == 200, view.text
    assert len(sphere.requests) == calls  # stored data only
    body = view.json()
    assert body["version"] == "1.0.0"
    (email,) = [e for e in body["entries"] if e["task"] == "dailySummary"]
    assert email["status"] == "snapshotted" and email["from"]["plan"] == "FOUNDATION"
    assert email["snapshot"]["versionName"] == "2026-10" and email["snapshot"]["owner"] == "danruilop1"
    assert "6ade364540e55445692b0eda" in email["snapshot"]["permanentUrl"]
    assert email["plan"] == {"name": "FOUNDATION", "price": {"kind": "fixed", "amount": 35.0},
                             "unit": "account/month", "private": False}
    assert all(e["status"] == "not_snapshotted" for e in body["entries"] if e["task"] != "dailySummary")
    assert set(body["values"]["availability"]["sources"]) == {"guarantee", "manual"}
    assert body["values"]["latency"] == {"sources": ["manual"], "manualOnly": True}
    assert body["values"]["subscription"]["manualOnly"] is False
    assert body["offering"]["status"] == "read" and body["offering"]["versionName"] == "1.0.0"
    assert body["offering"]["source"] == {"sphere": "sphere/tomatometer"}


async def _hand_written(api_client, headers, base, label: str, entries: dict) -> bytes:
    draft = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@1", "binding": {**BINDING, "dailySummary": "email.selfhosted.postfix"},
              "version": label, "seal": False},
    )
    document = yaml.safe_load(draft.json()["content"])
    for task, source in entries.items():
        document["binding"][task]["from"] = source
    return yaml.safe_dump(document, sort_keys=False).encode()


async def test_a_hand_written_from_is_snapshotted_at_seal_or_later(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    sphere.unavailable(host="sphere.score.us.es")
    body = await _hand_written(api_client, headers, base, "1.0.0", {"dailySummary": RESEND_FROM})
    sealed = await api_client.post(f"{base}/versions", content=body, headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text  # SPHERE down: the seal succeeds all the same
    view = (await api_client.get(f"{base}/upstream", headers=headers)).json()
    assert [e["status"] for e in view["entries"] if e["task"] == "dailySummary"] == ["not_snapshotted"]

    # SPHERE is back (a fresh port: the failed paths are no longer remembered): F6's poller resolves the entry.
    sphere.scripts.clear()
    set_pricing_source(SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}),
                                        transport=sphere.transport()))
    found = await upstream_module.resolve_provenance(
        db_session, await _organization_id(db_session, org), [Provenance(**RESEND_FROM)],
    )
    assert set(found) == {RESEND_FROM["version"]}
    view = (await api_client.get(f"{base}/upstream", headers=headers)).json()
    (email,) = [e for e in view["entries"] if e["task"] == "dailySummary"]
    assert email["status"] == "snapshotted" and email["snapshot"]["versionId"] == RESEND_FROM["version"]
    assert email["snapshot"]["pricingId"] == "6ab0a323697330667ccce8e9"  # the family that lists the version

    calls = len(sphere.requests)
    assert await upstream_module.resolve_provenance(
        db_session, await _organization_id(db_session, org), [Provenance(**RESEND_FROM)],
    ) == found
    assert len(sphere.requests) == calls  # idempotent: a stored snapshot makes no call


async def test_seal_resolves_at_most_eight_entries_over_the_network(api_client, registration, db_session, gate, sphere, monkeypatch):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    attempts = []

    async def counting(session, where, owner, slug, credential=None, *, version_id=None, **kwargs):
        attempts.append(version_id)
        from openbinding_gateway.modules.plans.application import PricingNotFound

        raise PricingNotFound("not in this test")

    monkeypatch.setattr(upstream_module, "resolve_family", counting)
    entries = [Provenance(sphere=f"acme/p{i}", version=f"{i:024x}", plan="Pro") for i in range(9)]
    await upstream_module.resolve_provenance(db_session, await _organization_id(db_session, org), entries)
    assert len(attempts) == 8
    not_hex = [Provenance(sphere="acme/p", version="v7", plan="Pro")]
    attempts.clear()
    await upstream_module.resolve_provenance(db_session, await _organization_id(db_session, org), not_hex)
    assert attempts == []


async def test_a_visitor_sees_public_snapshots_only(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.serve("/offering.yml", b"syntaxVersion: '3.1'\nsaasName: A\nversion: '1'\ncreatedAt: '2026-11-18'\n"
                                  b"currency: USD\nplans:\n  B:\n    price: 1\n    unit: user/month\n",
                 {"content-type": "application/yaml"})
    await _derived(api_client, headers, base, offering={"url": "https://pricings.example/offering.yml"})
    await db_session.execute(update(Composition).where(Composition.slug == "summary").values(visibility="public"))
    await db_session.commit()
    visitor = (await api_client.get(f"{base}/upstream")).json()
    member = (await api_client.get(f"{base}/upstream", headers=headers)).json()
    assert member["offering"]["snapshot"] is not None  # the organization's own copy of the URL
    assert visitor["offering"]["snapshot"] is None and visitor["offering"]["status"] == "read"
    (email,) = [e for e in visitor["entries"] if e["task"] == "dailySummary"]
    assert email["status"] == "snapshotted"  # a public SPHERE version
    other_headers, _ = await generated_problem(api_client, registration, db_session, gate)
    foreign = await api_client.get(f"{base}/upstream", headers=other_headers)
    assert foreign.json()["offering"]["snapshot"] is None


async def _organization_id(db_session, org):
    from sqlalchemy import select

    from openbinding_gateway.db.models import Organization

    return await db_session.scalar(select(Organization.id).where(Organization.slug == org))
