"""The scenario catalog (``fixtures/sphere/scenarios.json``) and ``RecordedSphere.publish`` (F6)."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime

import pytest

from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import DEFAULT_ENDPOINT, Manifest, NotModified, functional_hash
from openbinding_gateway.core.settings import get_settings
from sphere_recorded import SFX, RecordedSphere

CATALOG = json.loads((SFX / "scenarios.json").read_text())


def _when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


@pytest.mark.parametrize("entry", CATALOG, ids=[e["scenario"] for e in CATALOG])
def test_each_scenario_hashes_and_ids(entry) -> None:
    data = (SFX / entry["file"]).read_bytes()
    assert entry["contentHash"] == functional_hash(data)
    assert entry["sha256"] == hashlib.sha256(data).hexdigest()
    recorded = json.loads((SFX / entry["pricingId"] / "manifest.json").read_text())
    if entry["versionId"].startswith("6fff"):
        assert len(entry["versionId"]) == 24
        assert all(_when(entry["createdAt"]) > _when(v["createdAt"]) for v in recorded["versions"])
        assert entry["versionId"] not in {v["versionId"] for v in recorded["versions"]}


def test_labels_are_unique_per_family() -> None:
    for pricing_id in {e["pricingId"] for e in CATALOG}:
        recorded = json.loads((SFX / pricing_id / "manifest.json").read_text())
        labels = [v["version"] for v in recorded["versions"]] + [
            e["label"] for e in CATALOG if e["pricingId"] == pricing_id and e["versionId"].startswith("6fff")
        ]
        assert len(labels) == len(set(labels)), pricing_id


def test_the_renamed_family_keeps_every_version_and_hash() -> None:
    entry = next(e for e in CATALOG if e["scenario"] == "brevo-renamed-family")
    recorded = json.loads((SFX / entry["pricingId"] / "manifest.json").read_text())
    original = next(v for v in recorded["versions"] if v["versionId"] == entry["versionId"])
    assert entry["contentHash"] == original["contentHash"]
    assert entry["sha256"] != hashlib.sha256((SFX / entry["pricingId"] / f"{entry['versionId']}.yml").read_bytes()).hexdigest()
    assert entry["manifest"]["nameChange"] == "Brevo"


def _source(sphere: RecordedSphere) -> SphereHttpSource:
    return SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}), transport=sphere.transport())


async def test_publish_moves_the_latest_and_serves_the_yaml(sphere: RecordedSphere) -> None:
    entry = sphere.scenario("brevo-professional-up")
    source = _source(sphere)
    before = await source.manifest(DEFAULT_ENDPOINT, entry["pricingId"], None)
    assert sphere.publish("brevo-professional-up") == entry
    assert sphere.publish("brevo-professional-up") == entry  # idempotent
    after = await source.manifest(DEFAULT_ENDPOINT, entry["pricingId"], None, if_none_match=before.etag, revalidate=True)
    assert isinstance(after, Manifest) and after.latest_version_id == entry["versionId"]
    assert [v.version_id for v in after.newest_first()][:2] == [entry["versionId"], before.latest_version_id]
    assert after.etag != before.etag
    again = await source.manifest(DEFAULT_ENDPOINT, entry["pricingId"], None, if_none_match=after.etag, revalidate=True)
    assert isinstance(again, NotModified)
    fetched = await source.version_yaml(DEFAULT_ENDPOINT, entry["pricingId"], entry["versionId"], None)
    assert fetched.sha256 == entry["sha256"]


async def test_after_ordering_is_enforced(sphere: RecordedSphere) -> None:
    with pytest.raises(ValueError):
        sphere.publish("brevo-professional-retired")
    sphere.publish("brevo-professional-up")
    entry = sphere.publish("brevo-professional-retired")
    manifest = sphere.manifest(entry["pricingId"])
    assert manifest["latestVersionId"] == entry["versionId"]
    assert [v["version"] for v in manifest["versions"]][:3] == ["2027-01", "2026-11", "2026-10"]


async def test_the_family_rename_changes_the_name_only(sphere: RecordedSphere) -> None:
    entry = sphere.scenario("brevo-renamed-family")
    before = sphere.manifest(entry["pricingId"])
    sphere.publish("brevo-renamed-family")
    after = sphere.manifest(entry["pricingId"])
    assert after["name"] == "Brevo" and after["versions"] == before["versions"]
    assert after["latestVersionId"] == before["latestVersionId"]
