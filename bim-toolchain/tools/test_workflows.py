"""The workflows of the future repository are well-formed and keep to what was agreed: no secrets, no publishing."""

from __future__ import annotations

import json
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


ENSURE_XSD = "python3 tools/xsd_inventory.py --ensure"


@pytest.mark.parametrize("name", ["ci.yml", "release.yml"])
def test_every_checkout_is_followed_by_the_verified_download_of_the_omg_xsds(name: str) -> None:
    """The five XSDs are not versioned in Git: a job that builds or tests needs them in place before its first step runs."""
    checkouts = 0
    for job, definition in load(name)["jobs"].items():
        steps = definition["steps"]
        for index, step in enumerate(steps):
            if str(step.get("uses", "")).startswith("actions/checkout@"):
                checkouts += 1
                assert steps[index + 1].get("run") == ENSURE_XSD, f"{name}: {job}"
    assert checkouts >= 1
    assert (WORKFLOWS / name).read_text(encoding="utf-8").count(ENSURE_XSD) == checkouts


def test_the_lint_job_checks_that_git_does_not_version_the_omg_xsds() -> None:
    runs = [step.get("run") for step in load("ci.yml")["jobs"]["lint"]["steps"]]
    assert "python3 tools/xsd_inventory.py --check" in runs
    assert runs.index(ENSURE_XSD) < runs.index("python3 tools/xsd_inventory.py --check")


def test_the_workflows_never_exclude_the_xsds_from_the_artifacts_they_build() -> None:
    for name in ("ci.yml", "release.yml"):
        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        assert "--exclude" not in text and "*.xsd" not in text, name


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


# --- the pins of the actions ------------------------------------------------------------------------------

PIN_MARKER = "PIN-PENDING"
USES_LINE = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)(.*)$")
COMMIT_PIN = re.compile(r"[\w.-]+/[\w.-]+(?:/[\w./-]+)?@[0-9a-f]{40}")
WORKFLOW_FILES = ("ci.yml", "release.yml")


def pin_problems(text: str) -> list[str]:
    """``uses:`` lines that are neither pinned to a full commit SHA nor marked as pending, or are both."""
    found = []
    for number, line in enumerate(text.splitlines(), start=1):
        match = USES_LINE.match(line)
        if match is None:
            continue
        reference, rest = match.groups()
        pinned, marked = COMMIT_PIN.fullmatch(reference) is not None, PIN_MARKER in rest
        if not pinned and not marked:
            found.append(f"line {number}: {reference} is neither pinned to a commit SHA nor marked {PIN_MARKER}")
        if pinned and marked:
            found.append(f"line {number}: {reference} is pinned but still marked {PIN_MARKER}")
    return found


def pending_actions(texts: dict[str, str]) -> dict[str, list[str]]:
    """The actions still marked as pending, with the workflow files that use them."""
    found: dict[str, set[str]] = {}
    for name, text in texts.items():
        for line in text.splitlines():
            match = USES_LINE.match(line)
            if match is not None and PIN_MARKER in match.group(2):
                found.setdefault(match.group(1), set()).add(name)
    return {reference: sorted(files) for reference, files in sorted(found.items())}


def test_every_action_is_pinned_to_a_commit_or_marked_as_pending() -> None:
    for name in WORKFLOW_FILES:
        assert pin_problems((WORKFLOWS / name).read_text(encoding="utf-8")) == [], name


def test_the_list_of_pending_pins_is_exactly_what_the_workflows_still_need() -> None:
    texts = {name: (WORKFLOWS / name).read_text(encoding="utf-8") for name in WORKFLOW_FILES}
    pins = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["action_pins"]
    assert pins["state"] == "pending" and pins["marker"] == PIN_MARKER
    assert {item["uses"]: sorted(item["files"]) for item in pins["pending"]} == pending_actions(texts)
    assert sorted(pending_actions(texts)) == [
        "actions/checkout@v4", "actions/download-artifact@v4", "actions/setup-python@v5",
        "actions/upload-artifact@v4", "astral-sh/setup-uv@v5",
    ]
    assert "invented" in pins["reason"]


def test_the_detector_flags_an_unmarked_action_and_a_stale_marker() -> None:
    sha = "0123456789abcdef0123456789abcdef01234567"
    assert pin_problems("      - uses: actions/checkout@v4\n") != []
    assert pin_problems(f"      - uses: actions/checkout@{sha} # v4.1.0\n") == []
    assert pin_problems("      - uses: actions/checkout@v4 # PIN-PENDING: replace by the full commit SHA\n") == []
    assert pin_problems(f"      - uses: actions/checkout@{sha} # PIN-PENDING\n") != []
    assert pin_problems("      - uses: actions/checkout@0123456789abcdef\n") != []
    assert pending_actions({"a.yml": "      - uses: x/y@v1 # PIN-PENDING\n      - uses: x/y@v1 # PIN-PENDING\n"}) == {"x/y@v1": ["a.yml"]}
    assert pending_actions({"a.yml": f"      - uses: x/y@{sha}\n"}) == {}


def test_the_jobs_that_run_the_suites_leave_out_the_corpus_tier_and_refuse_a_skip() -> None:
    ci = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    steps = load("ci.yml")["jobs"]["all-packages"]["steps"]
    run = next(step["run"] for step in steps if "run" in step and "packages/bim-service/tests" in step["run"])
    assert '-m "not openbinding_corpus"' in run and 'grep -q "SKIPPED"' in run and "exit 1" in run
    release_run = next(
        step["run"] for step in load("release.yml")["jobs"]["build"]["steps"] if "run" in step and "packages/bim-service/tests" in step["run"]
    )
    assert '-m "not openbinding_corpus"' in release_run and 'grep -q "SKIPPED"' in release_run
    for text in (ci, release):
        assert 'tools -rs' in text and text.count('-m "not openbinding_corpus"') >= 2
        assert "tools/verify_release.py --skip-corpus" in text


def test_the_corpus_job_still_compares_with_the_corpus_and_is_not_marked_out() -> None:
    steps = load("ci.yml")["jobs"]["golden-corpus"]["steps"]
    comparison = next(step for step in steps if step.get("name") == "Compare with the baseline goldens")
    assert "openbinding_corpus" not in comparison["run"]
    assert "tools/baseline_core.py --check" in comparison["run"]
