"""Static checks of the triggers, permissions and concurrency of ``.github/workflows/ci.yml`` (change
``ci-develop-triggers``), without running a workflow.

The helpers assert instead of raising ``KeyError``, so a missing key or file is an ``AssertionError``.  PyYAML reads
the workflow key ``on`` as ``True``; the triggers are read as ``_ci().get(True)`` (the string key ``'on'`` is also
accepted).

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests/test_ci_triggers.py
"""

from __future__ import annotations

import re
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


AREA_IF = re.compile(r"needs\.changes\.outputs\.(e2e|bim|engines|gateway) == 'true'")


def _check_job_ifs(jobs: dict) -> None:
    """A job-level ``if`` is only ``ci-required``'s ``always()`` or a change-area gate on ``needs: changes``."""
    for name, job in jobs.items():
        if "if" not in job:
            continue
        condition = job["if"]
        if name == "ci-required":
            assert condition == "always()", f"ci-required if: {condition!r}"
            continue
        assert isinstance(condition, str) and AREA_IF.fullmatch(condition), f"job {name!r} if: {condition!r}"
        needs = job.get("needs")
        needs = [needs] if isinstance(needs, str) else needs
        assert isinstance(needs, list) and "changes" in needs, f"job {name!r} gates on changes without needing it"
        for word in ("github.event_name", "github.ref", "pull_request"):
            assert word not in condition, f"job {name!r} if names {word}"


# [utest->req~ci-develop-push~1]
# [utest->req~ci-develop-push~2]
def test_ci_runs_on_push_to_develop():
    trigger = _triggers()
    push = _mapping(trigger, "push")
    assert push.get("branches") == ["develop"], f"push.branches: {push.get('branches')!r}"
    for key in ("paths", "paths-ignore", "tags"):
        assert key not in push, f"the push trigger has a {key} filter"
    pull_request = _mapping(trigger, "pull_request")
    assert pull_request == {"branches": ["main", "develop"]}, f"pull_request: {pull_request!r}"
    assert "schedule" not in trigger
    _check_job_ifs(_ci()["jobs"])


# [utest->req~ci-develop-push~2]
# [utest->req~ci-speed-e2e-shards~1]
def test_job_conditions_read_only_the_change_outputs():
    jobs = _ci()["jobs"]
    gated = {name: AREA_IF.fullmatch(job["if"]).group(1) for name, job in jobs.items()
             if name != "ci-required" and "if" in job}
    assert gated == {"bim-toolchain": "bim", "engines": "engines", "test": "gateway", "frontend-e2e": "e2e"}, gated
    _check_job_ifs(jobs)


# [utest->req~ci-develop-push~1]
# [utest->req~ci-develop-push~2]
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
    _check_job_ifs(jobs)
    for name, job in jobs.items():
        assert "permissions" not in job, f"job {name!r} declares its own permissions"
        for step in job.get("steps", []):
            if step is not check:
                assert "github.event_name" not in str(step.get("if", "")), (
                    f"job {name!r}, step {step.get('name')!r} has an event_name condition"
                )


def _job(name: str) -> dict:
    jobs = _ci()["jobs"]
    assert name in jobs, f"ci.yml has no job {name!r}: {sorted(jobs)}"
    return jobs[name]


# [utest->req~ci-speed-change-detection~1]
def test_changes_job_exposes_the_four_area_outputs():
    job = _job("changes")
    assert job.get("runs-on") == "ubuntu-latest"
    steps = job.get("steps")
    assert isinstance(steps, list), f"changes has no steps: {steps!r}"
    checkouts = [s for s in steps if s.get("uses") == "actions/checkout@v4"]
    assert len(checkouts) == 1, "changes needs exactly one checkout"
    assert (checkouts[0].get("with") or {}).get("fetch-depth") == 0, checkouts[0]
    areas = [s for s in steps if s.get("id") == "areas"]
    assert len(areas) == 1, "changes needs exactly one step with id areas"
    run = areas[0].get("run", "")
    assert "python3 tools/ci_changes.py" in run and "${{" not in run, run
    for flag in ('--base "$BASE_SHA"', '--head "$HEAD_SHA"', '--event "$EVENT"'):
        assert flag in run, f"the areas step lacks {flag}"
    assert areas[0].get("env") == {
        "BASE_SHA": "${{ github.event.pull_request.base.sha }}",
        "HEAD_SHA": "${{ github.sha }}",
        "EVENT": "${{ github.event_name }}",
    }, areas[0].get("env")
    assert job.get("outputs") == {
        area: "${{ steps.areas.outputs." + area + " }}" for area in ("e2e", "bim", "engines", "gateway")
    }, job.get("outputs")
    assert "if" not in job and "needs" not in job


# [utest->req~ci-speed-required-aggregate~1]
def test_ci_required_aggregates_every_other_job():
    jobs = _ci()["jobs"]
    job = _job("ci-required")
    needs = job.get("needs")
    assert isinstance(needs, list), f"ci-required needs: {needs!r}"
    assert sorted(needs) == sorted(set(jobs) - {"ci-required"}), (sorted(needs), sorted(jobs))
    assert job.get("if") == "always()"
    assert "continue-on-error" not in job
    steps = job.get("steps")
    assert isinstance(steps, list), f"ci-required has no steps: {steps!r}"
    assert any(s.get("uses") == "actions/checkout@v4" for s in steps), "ci-required has no checkout"
    runs = [s for s in steps if "python3 tools/ci_required.py" in str(s.get("run", ""))]
    assert len(runs) == 1, f"{len(runs)} steps run ci_required.py"
    assert runs[0].get("env") == {"NEEDS": "${{ toJSON(needs) }}"}, runs[0].get("env")
    assert "continue-on-error" not in runs[0]


# [utest->req~ci-speed-job-timeouts~1]
def test_every_job_has_a_timeout():
    jobs = _ci()["jobs"]
    for name, job in jobs.items():
        value = job.get("timeout-minutes")
        assert isinstance(value, int) and not isinstance(value, bool), f"job {name!r} timeout-minutes: {value!r}"
        assert 1 <= value <= 45, f"job {name!r} timeout-minutes {value}"
    assert {n: jobs[n]["timeout-minutes"] for n in ("changes", "engines", "test", "frontend")} == {
        "changes": 5, "engines": 30, "test": 45, "frontend": 45,
    }
