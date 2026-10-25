"""Static checks of the triggers, permissions and concurrency of ``.github/workflows/ci.yml`` (change
``ci-develop-triggers``), without running a workflow.

The helpers assert instead of raising ``KeyError``, so a missing key or file is an ``AssertionError``.  PyYAML reads
the workflow key ``on`` as ``True``; the triggers are read as ``_ci().get(True)`` (the string key ``'on'`` is also
accepted).

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests/test_ci_triggers.py
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"


def _read(path: Path) -> str:
    assert path.is_file(), f"missing file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def _ci() -> dict:
    data = yaml.safe_load(_read(CI))
    assert isinstance(data, dict) and isinstance(data.get("jobs"), dict), "ci.yml has no jobs"
    return data


def _triggers() -> dict:
    data = _ci()
    trigger = data.get(True) if True in data else data.get("on")
    assert isinstance(trigger, dict), f"ci.yml has no mapping of triggers: {trigger!r}"
    return trigger


def _mapping(trigger: dict, key: str) -> dict:
    assert key in trigger, f"ci.yml does not trigger on {key}: {sorted(map(str, trigger))}"
    value = trigger[key]
    assert isinstance(value, dict), f"the {key} trigger is not a mapping: {value!r}"
    return value


# [utest->req~ci-develop-push~1]
def test_ci_runs_on_push_to_develop():
    trigger = _triggers()
    push = _mapping(trigger, "push")
    assert push.get("branches") == ["develop"], f"push.branches: {push.get('branches')!r}"
    for key in ("paths", "paths-ignore", "tags"):
        assert key not in push, f"the push trigger has a {key} filter"
    pull_request = _mapping(trigger, "pull_request")
    assert pull_request == {"branches": ["main", "develop"]}, f"pull_request: {pull_request!r}"
    for name, job in _ci()["jobs"].items():
        assert "if" not in job, f"job {name!r} has a job-level if"


# [utest->req~ci-develop-push~1]
def test_triggers_leave_permissions_and_pull_request_unchanged():
    assert set(_triggers()) == {"pull_request", "push", "workflow_dispatch"}, sorted(map(str, _triggers()))
    assert _ci().get("permissions") == {"contents": "read"}
    text = _read(CI)
    assert "on:\n  pull_request:\n    branches: [ main, develop ]\n" in text, "the pull_request block changed"


# [utest->req~ci-develop-push-concurrency~1]
def test_push_concurrency_cancels_only_push_runs():
    data = _ci()
    concurrency = data.get("concurrency")
    assert isinstance(concurrency, dict), f"ci.yml has no concurrency mapping: {concurrency!r}"
    assert set(concurrency) == {"group", "cancel-in-progress"}, sorted(concurrency)
    assert concurrency["group"] == (
        "ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.ref || github.run_id }}"
    )
    assert concurrency["cancel-in-progress"] == "${{ github.event_name == 'push' }}"
    for name, job in data["jobs"].items():
        assert "concurrency" not in job, f"job {name!r} defines its own concurrency"


# [utest->req~ci-develop-dispatch~1]
def test_ci_can_be_dispatched_manually():
    trigger = _triggers()
    assert "workflow_dispatch" in trigger, f"ci.yml has no workflow_dispatch trigger: {sorted(map(str, trigger))}"
    dispatch = trigger["workflow_dispatch"]
    assert dispatch is None or isinstance(dispatch, dict), f"workflow_dispatch: {dispatch!r}"
    assert "inputs" not in (dispatch or {}), "workflow_dispatch defines inputs"
    for name, job in _ci()["jobs"].items():
        assert "permissions" not in job, f"job {name!r} declares its own permissions"


# [utest->req~ci-develop-changelog-pr-only~1]
def test_changelog_check_runs_only_on_pull_requests():
    jobs = _ci()["jobs"]
    assert "frontend" in jobs, f"ci.yml has no frontend job: {sorted(jobs)}"
    steps = jobs["frontend"].get("steps")
    assert isinstance(steps, list), f"the frontend job has no steps: {steps!r}"
    checks = [s for s in steps if "tools/generate_changelog.py --check" in str(s.get("run", ""))]
    assert len(checks) == 1, f"{len(checks)} frontend steps run the changelog check"
    check = checks[0]
    assert check.get("if") == "github.event_name == 'pull_request'", f"if: {check.get('if')!r}"
    assert "continue-on-error" not in check, "the changelog check is report-only"
    for name, job in jobs.items():
        assert "if" not in job, f"job {name!r} has a job-level if"
        assert "permissions" not in job, f"job {name!r} declares its own permissions"
        for step in job.get("steps", []):
            if step is not check:
                assert "github.event_name" not in str(step.get("if", "")), (
                    f"job {name!r}, step {step.get('name')!r} has an event_name condition"
                )
