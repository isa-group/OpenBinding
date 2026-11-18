"""Immutable pricing snapshots (``plans.application.snapshots``) over the recorded SPHERE, on SQLite."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.exc import DatabaseError

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import Organization, PricingSnapshot, User
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import (
    DEFAULT_ENDPOINT,
    Credential,
    PricingNotFound,
    PricingSourceUnavailable,
    SphereEndpoint,
    account_stored_bytes,
    normalised,
    read_snapshot,
    snapshot_bytes,
    snapshot_url,
    snapshot_version,
)
from openbinding_gateway.modules.plans.application import snapshots as snapshots_module
from openbinding_gateway.space_client import PlanCaps
from sphere_recorded import SFX, RecordedSphere, sfx_bytes

from ._pricings import SET_B, TOMATOMETER, latest

MAILGUN = SET_B["mailgun"]
MAILGUN_VERSION = "6ade36454b2b5b01c587db3d"
PRIVATE_VERSION = "6b0000000000000000000002"
KEY_A = "sk-" + "a" * 64


async def _user(db) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.org", password_hash="x", plan_cache="free")
    db.add(user)
    await db.flush()
    return user


async def _org(db, user: User) -> Organization:
    organization = Organization(slug=f"o-{uuid.uuid4().hex[:8]}", name="O", created_by_id=user.id)
    db.add(organization)
    await db.commit()
    return organization


def _yaml_requests(sphere: RecordedSphere) -> list:
    return [r for r in sphere.requests if r.url.path.endswith("/yaml")]


async def test_a_version_read_twice_is_one_row_and_one_request(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    first = await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, MAILGUN, MAILGUN_VERSION, actor_id=user.id)
    second = await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, MAILGUN, MAILGUN_VERSION, actor_id=user.id)
    assert first.change == "new" and second.change == "reused" and first.snapshot.id == second.snapshot.id
    assert len(_yaml_requests(sphere)) == 1
    row = first.snapshot
    assert (row.sphere_organization_id, row.owner, row.slug) == ("6ade2ce94b2b5b01c587d7c6", "danruilop1", "mailgun")
    assert row.scope_key == "public" and row.organization_id is None and row.source_kind == "sphere"
    assert row.source_key == f"sphere:{MAILGUN}@{MAILGUN_VERSION}" and row.version_label == "2026-10"
    assert row.content_hash_verified and row.valid and row.syntax_version == "3.1" and row.currency == "USD"
    assert row.sha256 == hashlib.sha256(sfx_bytes(f"{MAILGUN}/{MAILGUN_VERSION}.yml")).hexdigest()
    assert snapshot_bytes(row) == sfx_bytes(f"{MAILGUN}/{MAILGUN_VERSION}.yml")
    assert (await normalised(row)).normalised.plans


async def test_two_organizations_share_a_public_snapshot(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    a, b = await _org(db_session, user), await _org(db_session, user)
    first = await snapshot_version(db_session, a.id, DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER))
    second = await snapshot_version(db_session, b.id, DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER))
    assert second.change == "reused" and second.snapshot.id == first.snapshot.id
    assert (await read_snapshot(db_session, b.id, first.snapshot.id, member=False, signed_in=False)).id == first.snapshot.id
    assert first.snapshot.owner == "sphere" and first.snapshot.slug == "tomatometer"


async def test_a_private_version_read_with_a_key_belongs_to_that_organization(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    a, b = await _org(db_session, user), await _org(db_session, user)
    sphere.private(MAILGUN, PRIVATE_VERSION, (SFX / "derived" / "mailgun-scale.yml").read_bytes(), credential=KEY_A)
    taken = await snapshot_version(db_session, a.id, DEFAULT_ENDPOINT, MAILGUN, PRIVATE_VERSION, Credential(str(a.id), KEY_A))
    row = taken.snapshot
    assert row.scope_key == str(a.id) and row.organization_id == a.id
    assert (await read_snapshot(db_session, a.id, row.id, member=True, signed_in=True)).id == row.id
    with pytest.raises(PricingNotFound):
        await read_snapshot(db_session, b.id, row.id, member=True, signed_in=True)
    with pytest.raises(PricingNotFound):
        await snapshot_version(db_session, b.id, DEFAULT_ENDPOINT, MAILGUN, PRIVATE_VERSION)


async def test_a_private_registry_version_is_for_signed_in_users_only(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    a, b = await _org(db_session, user), await _org(db_session, user)
    sphere.add_host("registry.internal", "10.0.0.7")
    registries = Settings(sphere_registries={"lab": {"url": "https://registry.internal", "api_key": "operator-key"}})
    source = SphereHttpSource(
        get_settings().model_copy(update={"sphere_enabled": True, "sphere_registries": registries.sphere_registries}),
        transport=sphere.transport(),
    )
    sphere.private(MAILGUN, PRIVATE_VERSION, (SFX / "derived" / "mailgun-scale.yml").read_bytes(), credential="operator-key")
    taken = await snapshot_version(db_session, a.id, SphereEndpoint("lab"), MAILGUN, PRIVATE_VERSION, source=source)
    row = taken.snapshot
    assert row.scope_key == "registry:lab" and row.organization_id is None and row.registry == "lab"
    assert row.source_key == f"registry:lab:{MAILGUN}@{PRIVATE_VERSION}" and row.source_kind == "registry"
    assert (await read_snapshot(db_session, b.id, row.id, member=True, signed_in=True)).id == row.id
    with pytest.raises(PricingNotFound):
        await read_snapshot(db_session, b.id, row.id, member=False, signed_in=False)


def _serve_url(sphere: RecordedSphere, body: bytes, etag: str = '"v1"') -> str:
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.serve("/offering.yml", body, {"content-type": "application/yaml", "etag": etag})
    return "https://Pricings.Example:443/offering.yml#top"


async def test_a_url_snapshot_belongs_to_the_reader_and_counts_in_its_storage(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    body = sfx_bytes(f"{TOMATOMETER}/{latest(TOMATOMETER)}.yml")
    url = _serve_url(sphere, body)
    taken = await snapshot_url(db_session, org.id, url, actor_id=user.id)
    row = taken.snapshot
    assert row.scope_key == str(org.id) and row.source_kind == "url" and row.url == "https://pricings.example/offering.yml"
    assert row.fetched_by_id == user.id and row.content_hash_verified
    assert await account_stored_bytes(db_session, user.id) == len(body)
    # Within OFFERING_URL_MIN_INTERVAL_S: no request.
    sent = len(sphere.requests)
    again = await snapshot_url(db_session, org.id, url, actor_id=user.id)
    assert again.change == "reused" and again.snapshot.id == row.id and len(sphere.requests) == sent


async def test_url_bytes_identical_reuse_their_row_and_new_bytes_add_one(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    url = _serve_url(sphere, b"saasName: A\nsyntaxVersion: '3.1'\ncurrency: EUR\nplans:\n  P:\n    price: 1\n", '"v1"')
    first = await snapshot_url(db_session, org.id, url, actor_id=user.id)
    later = datetime.now(timezone.utc) + timedelta(seconds=301)
    same = await snapshot_url(db_session, org.id, url, actor_id=user.id, now=later)
    assert same.snapshot.id == first.snapshot.id and same.change == "same"
    assert sphere.requests[-1].headers["if-none-match"] == '"v1"'
    sphere.serve("/offering.yml", b"saasName: B\nsyntaxVersion: '3.1'\ncurrency: EUR\nplans:\n  P:\n    price: 1\n",
                 {"content-type": "application/yaml", "etag": '"v2"'})
    renamed = await snapshot_url(db_session, org.id, url, actor_id=user.id, now=later + timedelta(seconds=301))
    assert renamed.change == "rename" and renamed.snapshot.renamed_from_id == first.snapshot.id
    rows = list(await db_session.scalars(select(PricingSnapshot).where(PricingSnapshot.source_kind == "url")))
    assert len(rows) == 2


async def test_a_url_snapshot_past_the_storage_quota_is_refused(db_session, sphere: RecordedSphere, monkeypatch) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    gate = space_client.get_gate()
    real = gate.caps

    async def caps(user_id):
        base = await real(user_id)
        return PlanCaps(plan=base.plan, features=base.features, limits={**base.limits, "maxRepositoryStorage": 0.000001})

    monkeypatch.setattr(gate, "caps", caps)
    url = _serve_url(sphere, b"saasName: A\nsyntaxVersion: '3.1'\ncurrency: EUR\nplans:\n  P:\n    price: 1\n")
    with pytest.raises(HTTPException) as refused:
        await snapshot_url(db_session, org.id, url, actor_id=user.id)
    assert refused.value.status_code == 402
    assert refused.value.detail["quota"]["limit_id"] == "maxRepositoryStorage"
    assert await db_session.scalar(select(PricingSnapshot.id).limit(1)) is None


def _serve_version(sphere: RecordedSphere, body: bytes) -> None:
    sphere.serve(
        f"/api/v1/public/pricings/{MAILGUN}/versions/{MAILGUN_VERSION}/yaml", body,
        {"content-type": "application/yaml", "etag": '"' + hashlib.sha256(body).hexdigest() + '"'},
    )


async def test_a_rename_and_a_content_change_of_one_version(db_session, sphere: RecordedSphere, caplog) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    first = await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, MAILGUN, MAILGUN_VERSION)
    _serve_version(sphere, (SFX / "derived" / "mailgun-renamed.yml").read_bytes())
    renamed = await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, MAILGUN, MAILGUN_VERSION, refresh=True)
    assert renamed.change == "rename" and renamed.snapshot.renamed_from_id == first.snapshot.id
    _serve_version(sphere, (SFX / "derived" / "mailgun-scale.yml").read_bytes())
    with caplog.at_level(logging.WARNING):
        changed = await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, MAILGUN, MAILGUN_VERSION, refresh=True)
    assert changed.change == "content" and changed.snapshot.renamed_from_id is None
    assert not changed.snapshot.content_hash_verified
    assert "pricing_version_content_changed" in caplog.text


async def test_snapshots_are_immutable_and_shared_rows_are_retained(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    public = (await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER))).snapshot
    own = (await snapshot_url(db_session, org.id, _serve_url(sphere, b"saasName: A\n"), actor_id=user.id)).snapshot
    public_id, own_id = public.id, own.id
    for statement in (
        update(PricingSnapshot).where(PricingSnapshot.id == public_id).values(title="x"),
        update(PricingSnapshot).where(PricingSnapshot.id == own_id).values(title="x"),
        delete(PricingSnapshot).where(PricingSnapshot.id == public_id),
    ):
        with pytest.raises(DatabaseError):
            async with db_session.begin():
                await db_session.execute(statement)
        await db_session.rollback()
    async with db_session.begin():
        await db_session.execute(delete(PricingSnapshot).where(PricingSnapshot.id == own_id))
    assert await db_session.get(PricingSnapshot, public_id) is not None


async def test_the_stored_digest_is_checked_on_read(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    row = (await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER))).snapshot
    path = snapshots_module.path_for(f"sha256-{row.sha256}")
    path.write_bytes(path.read_bytes() + b"# altered\n")
    with pytest.raises(PricingSourceUnavailable) as caught:
        snapshot_bytes(row)
    assert caught.value.reason == "integrity"


async def test_the_normalised_memo_is_bounded(db_session, sphere: RecordedSphere, monkeypatch) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    monkeypatch.setattr(snapshots_module, "_MEMO", snapshots_module._Memo())
    monkeypatch.setattr(snapshots_module, "MEMO_ENTRIES", 1)
    a = (await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER))).snapshot
    b = (await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, MAILGUN, MAILGUN_VERSION)).snapshot
    first = await normalised(a)
    assert await normalised(a) is first
    await normalised(b)
    assert list(snapshots_module._MEMO.items) == [b.sha256]
    monkeypatch.setattr(snapshots_module, "MEMO_ENTRIES", 64)
    monkeypatch.setattr(snapshots_module, "MEMO_BYTES", 10)
    snapshots_module._MEMO.put("x", first, 11)
    assert "x" not in snapshots_module._MEMO.items


async def test_a_non_sphere_id_is_not_found_without_a_request(db_session, sphere: RecordedSphere) -> None:
    user = await _user(db_session)
    org = await _org(db_session, user)
    with pytest.raises(PricingNotFound):
        await snapshot_version(db_session, org.id, DEFAULT_ENDPOINT, "../users/me", MAILGUN_VERSION)
    assert sphere.requests == []
    assert json.loads((SFX / "users-me.json").read_text())["username"] == "fixture-user"
