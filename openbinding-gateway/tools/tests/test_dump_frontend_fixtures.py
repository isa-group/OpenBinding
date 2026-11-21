"""dump_frontend_fixtures: two runs write the same bytes, and the checked-in fixtures are what it writes."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import dump_frontend_fixtures as tool

TOOL = Path(tool.__file__).resolve()


def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *arguments], capture_output=True, text=True, env=dict(os.environ), timeout=600,
    )


def _tree(directory: Path) -> dict[str, bytes]:
    return {
        path.relative_to(directory).as_posix(): path.read_bytes() for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


@pytest.fixture(scope="module")
def two_runs(tmp_path_factory) -> tuple[Path, Path]:
    first, second = tmp_path_factory.mktemp("first"), tmp_path_factory.mktemp("second")
    for directory in (first, second):
        done = _run("--out", str(directory))
        assert done.returncode == 0, done.stdout + done.stderr
    return first, second


def test_two_runs_write_byte_identical_trees(two_runs) -> None:
    first, second = two_runs
    assert _tree(first / "core") == _tree(second / "core")
    assert _tree(first / "sphere") == _tree(second / "sphere")
    assert sorted(_tree(first / "core")) == sorted(
        [f"{name}.{kind}.json" for name, _ in tool.PACKAGES for kind in ("facts", "validate", "version", "diff")]
        + ["refused.package.json", "refused.validate.json", "plans-pricing.json", "tomatometer-email.facts.json",
           "tomatometer-email.version.json", "tomatometer-email.upstream.json", "templates.json",
           "template.tomatometer.json"]
        + [f"tomatometer.{name}" for name in OPERATION]
        + [f"upstream.{name}" for name in UPSTREAM]
    )


#: F6's upstream fixtures: events of each category, the views with their counts, the inbox and the admin queue.
UPSTREAM = (
    "admin.queues.json", "brevo.2026-10.yaml", "brevo.2026-11.yaml", "me.events.json", "notifications.json",
    "tomatometer.composition.json", "tomatometer.environment.production.json",
    "tomatometer.event.binding-invalid.json", "tomatometer.event.offering-changed.json",
    "tomatometer.event.reviewed.json", "tomatometer.event.unavailable.json", "tomatometer.event.values-changed.json",
    "tomatometer.event.withdrawn.json", "tomatometer.events.json", "tomatometer.events.two.json",
    "tomatometer.versions.json",
)
#: F4's operation fixtures (environments, adoptions, keys, the feed, margins, checks, what-if evaluations).
OPERATION = (
    "adoptions.production.json", "check.production.json", "check.production.newer.json",
    "environment.production.json", "environments.json", "evaluate.revision.json", "evaluate.users.json",
    "feed.production.headers.json", "feed.production.yaml", "key.created.json", "margins.1.0.0.json",
    "margins.1.1.0.json", "runs.derived.json", "versions.json",
)


def test_the_operation_fixtures_hold_what_the_screens_draw(two_runs) -> None:
    core = two_runs[0] / "core"

    def read(name: str):
        return json.loads((core / f"tomatometer.{name}").read_text(encoding="utf-8"))

    production = read("environment.production.json")
    assert production["inEffect"]["adoption"] == 3 and production["inEffect"]["version"]["label"] == "1.0.0"
    assert production["expectedUsers"] == 1000 and production["keyCount"] == 1
    assert [row["ordinal"] for row in read("adoptions.production.json")["adoptions"]] == [3, 2, 1]
    assert [item["slug"] for item in read("environments.json")["environments"]] == ["production", "staging"]
    assert read("margins.1.0.0.json")["status"] == "ok" and read("margins.1.1.0.json")["status"] == "ok"
    assert {row["status"] for row in read("check.production.json")["upstream"]} == {"current"}
    # Only the e-mail plan's family is scripted newer; Dropbox stays current.
    assert {row["task"]: row["status"] for row in read("check.production.newer.json")["upstream"]} == {
        "dailySummary": "newer", "export": "current",
    }
    assert read("key.created.json")["secret"] == tool.FIXTURE_FEED_KEY
    headers = read("feed.production.headers.json")
    assert headers["etag"] == production["feed"]["etag"] and headers["openbinding-adoption"] == "3"
    assert (core / "tomatometer.feed.production.yaml").read_text(encoding="utf-8").startswith("syntaxVersion")
    assert read("evaluate.revision.json")["revision"]["number"] == 4
    assert {item["name"]: item["value"] for item in read("evaluate.revision.json")["revision"]["demand"]} == {
        "monthlyEmails": 60000, "dailyEmails": 2000,
    }
    assert read("evaluate.users.json")["margins"]["users"] == 1000
    (derived,) = read("runs.derived.json")["compositions"]
    assert derived["slug"] == "simple-seq" and derived["derivedVersions"][0]["label"] == "2.0.0"


def test_the_sphere_import_journeys_are_written(two_runs) -> None:
    first, _ = two_runs
    names = set(_tree(first / "sphere"))
    for journey in ("tomatometer-email", "storage"):
        assert {f"expand.{journey}.json", f"apply.{journey}.json", f"recipe.{journey}.json"} <= names
    preview = json.loads((first / "sphere" / "expand.tomatometer-email.json").read_text(encoding="utf-8"))
    applied = json.loads((first / "sphere" / "apply.tomatometer-email.json").read_text(encoding="utf-8"))
    assert preview["valid"] and applied["revision"]["package_digest"] == preview["packageDigest"]
    assert applied["revision"]["origin"] == "sphere" and applied["revision"]["revision"] == 2


def test_the_generated_facts_carry_sources_properties_and_provenance(two_runs) -> None:
    first, _ = two_runs
    facts = json.loads((first / "core" / "tomatometer-email.facts.json").read_text(encoding="utf-8"))
    foundation = next(c for c in facts["candidates"] if c["key"] == "sphere-email/email.mailgun.foundation")
    assert foundation["origins"]["subscription"]["source"]["kind"] == "priced"
    assert foundation["propertyOrigins"]["emailsPerMonth"]["source"]["kind"] == "limit"
    assert foundation["provenance"]["sphere"] == "danruilop1/mailgun"
    # Revision 3 (the template's latest) also offers Dropbox for export and the built-in quotes.
    assert {"sphere-storage/storage.dropbox.plus", "sphere-quotes/quotes.builtin.static"} <= {
        c["key"] for c in facts["candidates"]
    }
    version = json.loads((first / "core" / "tomatometer-email.version.json").read_text(encoding="utf-8"))
    binding = version["document"]["binding"]
    assert binding["dailySummary"]["from"]["plan"] == "PROFESSIONAL" and binding["export"]["from"]["plan"] == "PLUS"
    assert [e["offering"]["status"] for e in version["evaluations"]] == ["read"]
    upstream = json.loads((first / "core" / "tomatometer-email.upstream.json").read_text(encoding="utf-8"))
    assert {e["task"]: e["status"] for e in upstream["entries"] if e["from"]} == {
        "dailySummary": "snapshotted", "export": "snapshotted",
    }


def test_the_sphere_fixtures_pair_every_readable_version_with_its_golden(two_runs) -> None:
    first, _ = two_runs
    every = sorted(_tree(first / "sphere"))
    names = [name for name in every if "/" not in name]
    yamls = {name[: -len(".yml")] for name in names if name.endswith(".yml")}
    goldens = {name[: -len(".normalised.json")] for name in names if name.endswith(".normalised.json")}
    assert yamls == goldens and len(yamls) >= 20
    assert "6ab0a323697330667ccce8cd.6921867e7004563bd918e7e8" in yamls  # TomatoMeter 1.0.0
    assert "derived.mailgun-scale" in yamls
    # A 2.x version (Dropbox 2023) is refused by the normaliser and never reaches the frontend.
    assert "6ab0a323697330667ccce9c1.687e4b68102baa50f3a5c7b5" not in yamls
    # The gateway's own answers about SPHERE, for the frontend's mocks.
    for name in ("tomatometer", "mailgun", "dropbox"):
        assert {f"search.{name}.json", f"manifest.{name}.json", f"version.{name}.json"} <= set(names)
    version = json.loads((first / "sphere" / "version.mailgun.json").read_text(encoding="utf-8"))
    assert version["snapshot"]["owner"] == "danruilop1" and version["summary"]["meteredAddOns"]
    # The upstream classifier goldens and the two YAMLs each compares (the F6 parity test).
    upstream = [name for name in every if name.startswith("upstream/")]
    assert {"upstream/G03-price-raise.json", "upstream/G03-price-raise.old.yml",
            "upstream/G03-price-raise.new.yml"} <= set(upstream)


def test_the_fixtures_hold_the_facts_each_package_was_chosen_for(two_runs) -> None:
    first, _ = two_runs
    first = first / "core"
    fms = json.loads((first / "fms.facts.json").read_text(encoding="utf-8"))
    assert "local" in {task["kind"] for task in fms["tasks"]} and "xor" in json.dumps(fms["workflow"])
    complete = json.dumps(json.loads((first / "json-complete.facts.json").read_text(encoding="utf-8"))["workflow"])
    assert '"and"' in complete and '"loop"' in complete
    ambiguous = json.loads((first / "ambiguous.facts.json").read_text(encoding="utf-8"))
    t1 = next(task for task in ambiguous["tasks"] if task["id"] == "t1")
    assert {item["written"] for item in t1["eligible"]} == {"catalog/c1a", "c1b", "other/c1a"}
    for name, _ in tool.PACKAGES:
        validated = json.loads((first / f"{name}.validate.json").read_text(encoding="utf-8"))
        assert validated["facts"] == json.loads((first / f"{name}.facts.json").read_text(encoding="utf-8"))


def test_each_package_has_a_derived_version_and_a_diff_of_one_candidate(two_runs) -> None:
    first, _ = two_runs
    first = first / "core"
    for name, _ in tool.PACKAGES:
        version = json.loads((first / f"{name}.version.json").read_text(encoding="utf-8"))
        assert version["label"] == "1.0.0" and version["document"]["composition"] == name
        assert version["derivation"]["source"] == "binding" and version["values_status"] == "verified"
        (evaluation,) = version["evaluations"]
        assert evaluation["binding"] and evaluation["outcome"] == "verified"
        diff = json.loads((first / f"{name}.diff.json").read_text(encoding="utf-8"))
        (binding,) = [section for section in diff["sections"] if section["key"] == "binding"]
        assert [(entry["kind"], [change["path"] for change in entry["changes"]]) for entry in binding["entries"]] == [
            ("changed", ["candidate"]),
        ]
        assert diff["from"]["label"] == "1.0.0" and diff["to"]["label"] == "1.1.0"


def test_the_refused_package_is_located_in_every_shape_the_editor_reads(two_runs) -> None:
    first, _ = two_runs
    first = first / "core"
    body = json.loads((first / "refused.validate.json").read_text(encoding="utf-8"))
    assert body["status"] == 422 and body["code"] == "invalid_instance"
    found = {(item["code"], item["resource"], item.get("pointer")): item for item in body["diagnostics"]}
    assert ("feature_value_domain", "candidates.json", "/spec/candidates/auth-edge/features/latency") in found
    expression = found["expression", "constraints.json", "/spec/constraints/end_to_end_latency/assert"]
    assert set(expression["span"]) == {"start", "end"}
    assert found["bpmn_task_ref", "workflow.bpmn", "/process/orphan"]["bpmnElement"] == "orphan"
    assert ("placement_capacity_rule", "placement.json", "/spec/capacityRules/0/resources") in found
    assert ("placement_event_pool", "placement.json", "/spec/events/client-request/latency/1/pool") in found
    # A finding that names its resource by id rather than by file.
    assert any(resource == "placement" for _, resource, _ in found)
    files = json.loads((first / "refused.package.json").read_text(encoding="utf-8"))
    assert set(files) == {path.name for path in tool.REFUSED_SOURCE.iterdir() if path.is_file()}
    assert '"features.latency <= "' in files["constraints.json"] and 'id="orphan"' in files["workflow.bpmn"]


def test_the_checked_in_fixtures_are_up_to_date() -> None:
    done = _run("--check")
    assert done.returncode == 0, done.stdout + done.stderr


def test_ids_and_instants_are_replaced_in_order_of_first_appearance() -> None:
    later, earlier = "2026-11-15T10:00:01.123456+00:00", "2026-11-15T10:00:00Z"
    a, b = "6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10", "0b7d2c1e-1111-4222-8333-444455556666"
    rendered = tool.normalise({
        "b.json": {"z": a, "when": earlier},
        "a.json": {"y": [b, a], "at": later, "digest": "sha256-" + "0" * 64},
    })
    assert rendered == {
        "a.json": {
            "at": "2026-01-01T00:00:00Z",
            "digest": "sha256-" + "0" * 64,
            "y": ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
        },
        "b.json": {"when": "2026-01-01T00:00:01Z", "z": "00000000-0000-4000-8000-000000000002"},
    }


def test_the_upstream_fixtures_hold_each_category_the_screens_draw(two_runs) -> None:
    """F6: what the watcher records for TomatoMeter, as the gateway answers it, after every earlier fixture."""
    first, _ = two_runs
    core = first / "core"

    def read(name: str):
        return json.loads((core / name).read_text(encoding="utf-8"))

    cases = {
        "values-changed": ("values_changed", []), "binding-invalid": ("binding_invalid", ["plan_removed"]),
        "offering-changed": ("offering_changed", []), "unavailable": ("binding_invalid", ["source_unavailable"]),
        "withdrawn": ("binding_invalid", ["source_unavailable"]),
    }
    for name, (category, reasons) in cases.items():
        event = read(f"upstream.tomatometer.event.{name}.json")
        assert event["category"] == category and [r["code"] for r in event["reasons"]] == reasons, name
    assert read("upstream.tomatometer.event.values-changed.json")["diff"]["global"][0]["delta"] == "50.000000"
    assert read("upstream.tomatometer.event.reviewed.json")["state"] == "reviewed"
    assert read("upstream.tomatometer.event.withdrawn.json")["reasons"][0]["detail"] == "version_withdrawn"
    assert read("upstream.tomatometer.composition.json")["upstream"]["open"] == 1
    assert read("upstream.notifications.json")[0]["kind"] == "UpstreamEvent"
    assert read("upstream.admin.queues.json")["upstreamWatch"]["watches"]["active"] == 4
    newer = read("tomatometer.check.production.newer.json")
    assert any(row.get("status") == "newer" and row["latest"]["name"] == "2026-11" for row in newer["upstream"])
    names = sorted(path.name for path in core.iterdir())
    assert names.index("upstream.admin.queues.json") > names.index("tomatometer.versions.json")
