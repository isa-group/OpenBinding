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
    assert _tree(first) == _tree(second)
    assert sorted(_tree(first)) == sorted(
        f"{name}.{kind}.json" for name, _ in tool.PACKAGES for kind in ("facts", "validate")
    )


def test_the_fixtures_hold_the_facts_each_package_was_chosen_for(two_runs) -> None:
    first, _ = two_runs
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
