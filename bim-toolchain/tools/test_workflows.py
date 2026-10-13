"""The workflows of the future repository are well-formed and keep to what was agreed: no secrets, no publishing."""

from __future__ import annotations

import re
from typing import Any

import pytest
import yaml

from packaging_support import ROOT

WORKFLOWS = ROOT / ".github" / "workflows"


def load(name: str) -> dict[str, Any]:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def triggers(workflow: dict[str, Any]) -> Any:
    # YAML 1.1 reads the key `on` as the boolean True.
    return workflow.get("on", workflow.get(True))


@pytest.mark.parametrize("name", ["ci.yml", "release.yml"])
def test_workflows_use_no_secrets_and_never_publish_to_an_index(name: str) -> None:
    text = (WORKFLOWS / name).read_text(encoding="utf-8")
    assert "secrets." not in text
    for forbidden in ("twine", "gh-action-pypi-publish", "id-token", "uv publish", "pip upload"):
        assert forbidden not in text, forbidden
    assert load(name)["permissions"] == {"contents": "read"}


@pytest.mark.parametrize("name", ["ci.yml", "release.yml"])
def test_actions_are_pinned_by_major_version_and_the_todo_is_documented(name: str) -> None:
    text = (WORKFLOWS / name).read_text(encoding="utf-8")
    uses = [step["uses"] for job in load(name)["jobs"].values() for step in job["steps"] if "uses" in step]
    assert uses
    assert all(re.fullmatch(r"[\w./-]+@v\d+", item) for item in uses), uses
    assert "SECURITY TODO" in text


def test_ci_has_the_agreed_jobs() -> None:
    workflow = load("ci.yml")
    assert {"lint", "tests", "golden-corpus", "contracts", "build", "clean-install"} <= set(workflow["jobs"])
    matrix = workflow["jobs"]["tests"]["strategy"]["matrix"]
    assert matrix["python-version"] == ["3.11", "3.12"]
    assert matrix["package"] == ["bim-core", "bim-service", "bim-client"]
    text = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    assert "ruff check" in text
    assert "dump_service_openapi.py --check" in text
    assert "consumer_fixtures.py --check" in text
    assert "smoke_installed.py" in text and " -I " in text
    assert "SKIPPED" in text, "the missing corpus must be announced"


def test_ci_cannot_pass_without_comparing_something() -> None:
    """A green run means that the equivalence was exercised: no silent skip of the corpus, no skipped job."""
    workflow = load("ci.yml")
    jobs = workflow["jobs"]
    assert {"all-packages", "equivalence", "gate"} <= set(jobs)

    # The corpus job fails without a corpus unless the repository opts out explicitly (and says so).
    comparison = next(step for step in jobs["golden-corpus"]["steps"] if step.get("name") == "Compare with the baseline goldens")
    assert comparison["env"]["BIM_REQUIRE_CORPUS"] == "1"
    script = comparison["run"]
    assert "BIM_CORPUS_OPTIONAL" in script and "GITHUB_STEP_SUMMARY" in script
    assert script.count("exit 0") == 1 and script.index("exit 0") < script.index("exit 1")
    assert "tools/baseline_core.py --check" in script

    # The equivalence on synthetic packages does not need the corpus and refuses to skip.
    run = next(step["run"] for step in jobs["equivalence"]["steps"] if "run" in step and "test_zip_dir_equivalence" in step["run"])
    assert "test_limits_near_boundary" in run and 'grep -q "SKIPPED"' in run and "exit 1" in run

    # The suites run together as the release does, on both Pythons, and the gate needs every job to succeed.
    for name in ("all-packages", "equivalence", "golden-corpus", "contracts"):
        assert jobs[name]["strategy"]["matrix"]["python-version"] == ["3.11", "3.12"], name
    gate = jobs["gate"]
    assert set(gate["needs"]) == set(jobs) - {"gate"}
    assert gate["if"] == "${{ always() }}"
    assert "success" in gate["steps"][0]["run"]


def test_release_runs_on_version_tags_and_only_drafts() -> None:
    workflow = load("release.yml")
    assert triggers(workflow) == {"push": {"tags": ["v*.*.*"]}}
    jobs = workflow["jobs"]
    assert "permissions" not in jobs["build"]
    assert jobs["draft-release"]["permissions"] == {"contents": "write"}
    text = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    assert "--draft" in text
    assert "toolchain_json.py" in text and "SHA256SUMS" in text
