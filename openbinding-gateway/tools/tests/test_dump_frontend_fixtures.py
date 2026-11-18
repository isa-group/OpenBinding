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
    return {path.name: path.read_bytes() for path in sorted(directory.iterdir())}


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
        + ["refused.package.json", "refused.validate.json", "plans-pricing.json", "tomatometer-email.facts.json"]
    )


def test_the_generated_facts_carry_sources_properties_and_provenance(two_runs) -> None:
    first, _ = two_runs
    facts = json.loads((first / "core" / "tomatometer-email.facts.json").read_text(encoding="utf-8"))
    foundation = next(c for c in facts["candidates"] if c["key"] == "sphere-email/email.mailgun.foundation")
    assert foundation["origins"]["subscription"]["source"]["kind"] == "priced"
    assert foundation["propertyOrigins"]["emailsPerMonth"]["source"]["kind"] == "limit"
    assert foundation["provenance"]["sphere"] == "danruilop1/mailgun"


def test_the_sphere_fixtures_pair_every_readable_version_with_its_golden(two_runs) -> None:
    first, _ = two_runs
    names = sorted(_tree(first / "sphere"))
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
