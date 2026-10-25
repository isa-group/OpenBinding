"""Static checks of ``.github/workflows/nightly.yml`` (change ``ci-develop-nightly``), without running a workflow.

The helpers assert instead of raising ``KeyError``, so a missing key or file is an ``AssertionError``.  PyYAML reads
the workflow key ``on`` as ``True``; the triggers are read as ``_nightly().get(True)`` (the string key ``'on'`` is also
accepted).

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests/test_ci_nightly.py
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
NIGHTLY = ROOT / ".github" / "workflows" / "nightly.yml"
CI = ROOT / ".github" / "workflows" / "ci.yml"

RUN = "gh workflow run ci.yml --ref develop"


def _read(path: Path) -> str:
    assert path.is_file(), f"missing file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def _workflow(path: Path) -> dict:
    data = yaml.safe_load(_read(path))
    assert isinstance(data, dict), f"{path.name} is not a mapping"
    return data


def _nightly() -> dict:
    data = _workflow(NIGHTLY)
    assert isinstance(data.get("jobs"), dict), "nightly.yml has no jobs"
    return data


def _triggers(data: dict) -> dict:
    trigger = data.get(True) if True in data else data.get("on")
    assert isinstance(trigger, dict), f"no mapping of triggers: {trigger!r}"
    return trigger


def _the_job() -> dict:
    jobs = _nightly()["jobs"]
    assert len(jobs) == 1, f"nightly.yml has {len(jobs)} jobs: {sorted(jobs)}"
    job = next(iter(jobs.values()))
    assert isinstance(job, dict), f"the job is not a mapping: {job!r}"
    return job


def _the_step() -> dict:
    steps = _the_job().get("steps")
    assert isinstance(steps, list) and len(steps) == 1, f"the job needs exactly one step: {steps!r}"
    assert isinstance(steps[0], dict), f"the step is not a mapping: {steps[0]!r}"
    return steps[0]


def _keys(node) -> set:
    found: set = set()
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            found |= _keys(value)
    elif isinstance(node, list):
        for item in node:
            found |= _keys(item)
    return found


# [utest->req~ci-develop-nightly~1]
# [utest->req~ci-develop-nightly-develop-only~1]
def test_nightly_triggers_only_on_a_schedule():
    triggers = _triggers(_nightly())
    assert set(triggers) == {"schedule"}, f"triggers: {sorted(map(str, triggers))}"
    for forbidden in ("push", "pull_request", "workflow_dispatch", "pull_request_target"):
        assert forbidden not in triggers, f"nightly.yml triggers on {forbidden}"


# [utest->req~ci-develop-nightly~1]
def test_nightly_has_one_off_hour_cron():
    schedule = _triggers(_nightly())["schedule"]
    assert isinstance(schedule, list) and len(schedule) == 1, f"schedule: {schedule!r}"
    assert isinstance(schedule[0], dict) and set(schedule[0]) == {"cron"}, f"schedule entry: {schedule[0]!r}"
    cron = schedule[0]["cron"]
    assert isinstance(cron, str), f"cron: {cron!r}"
    fields = cron.split()
    assert cron == "17 3 * * *", f"cron: {cron!r}"
    assert len(fields) == 5, f"cron needs 5 fields: {cron!r}"
    assert re.fullmatch(r"\d+", fields[0]), f"the minute is not a single number: {cron!r}"
    assert int(fields[0]) not in (0, 30), f"the minute {fields[0]} is a busy start time"


# [utest->req~ci-develop-nightly~1]
def test_nightly_permissions_are_actions_write_only():
    data = _nightly()
    assert data.get("permissions") == {"actions": "write"}, f"top-level permissions: {data.get('permissions')!r}"
    for name, job in data["jobs"].items():
        assert job.get("permissions") == {"actions": "write"}, f"job {name!r} permissions: {job.get('permissions')!r}"


# [utest->req~ci-develop-nightly~1]
def test_nightly_is_one_job_with_one_gh_step_and_no_actions_or_secrets():
    job = _the_job()
    assert job.get("timeout-minutes") == 5, f"timeout-minutes: {job.get('timeout-minutes')!r}"
    step = _the_step()
    assert step.get("run") == RUN, f"run: {step.get('run')!r}"
    assert job.get("runs-on") == "ubuntu-latest", f"runs-on: {job.get('runs-on')!r}"
    # without a checkout gh has no git remote, so GH_REPO names the repository
    assert step.get("env") == {
        "GH_TOKEN": "${{ github.token }}",
        "GH_REPO": "${{ github.repository }}",
    }, f"env: {step.get('env')!r}"
    assert "uses" not in _keys(_nightly()), "nightly.yml uses an action (no checkout, no third-party action)"
    assert "secrets." not in _read(NIGHTLY), "nightly.yml references a secret"


# [utest->req~ci-develop-nightly~1]
def test_nightly_run_line_has_no_expression_and_no_checkout():
    run = _the_step()["run"]
    assert "${{" not in run, f"the run line has an expression: {run!r}"
    assert "checkout" not in run, f"the run line checks out code: {run!r}"


# [utest->req~ci-develop-nightly-develop-only~1]
def test_nightly_dispatches_ci_on_develop_only():
    run = _the_step()["run"]
    assert run == RUN, f"run: {run!r}"
    tokens = run.split()
    assert tokens.count("--ref") == 1 and tokens[tokens.index("--ref") + 1] == "develop", f"run: {run!r}"
    for flag in ("-f", "-F", "--field", "--raw-field", "--json"):
        assert flag not in tokens, f"the dispatch passes inputs with {flag}"
    for text in ("main", "github.ref", "inputs"):
        assert text not in run, f"the run line mentions {text!r}"


# [utest->req~ci-develop-nightly-develop-only~1]
def test_ci_can_be_dispatched_and_has_no_schedule():
    triggers = _triggers(_workflow(CI))
    assert "workflow_dispatch" in triggers, f"ci.yml has no workflow_dispatch trigger: {sorted(map(str, triggers))}"
    assert "schedule" not in triggers, "ci.yml has a schedule trigger"
