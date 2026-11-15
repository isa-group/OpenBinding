"""``tools/latency_probe.py``: the lab latency probe of the problem upload, ``createRun`` and ``POST /v1/bim/validate``.

The gateway is a fake behind ``httpx.MockTransport`` and the clock is injected, so the durations are chosen by the test
and nothing here depends on the wall clock.
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import sys
from collections.abc import Mapping, Sequence

import httpx
import pytest

from _paths import GATEWAY_ROOT

TOOL = GATEWAY_ROOT / "tools" / "latency_probe.py"
PASSWORD = "pw-secret-123456"
TOKEN = "tok-abcdef-0123456789"
ENV = {"DEMO_SEED_PASSWORD": PASSWORD}
SIZES = {"a": 100, "b": 300, "c": 200, "d": 400, "e": 50}


@pytest.fixture
def probe():
    assert TOOL.is_file(), "tools/latency_probe.py"
    spec = importlib.util.spec_from_file_location("latency_probe", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules["latency_probe"] = module
    spec.loader.exec_module(module)
    return module


class Clock:
    """Two reads per timed request: the first returns a start, the second start + the next duration (seconds)."""

    def __init__(self, durations: Sequence[float]) -> None:
        self.durations = itertools.cycle(durations)
        self.reads = 0

    def __call__(self) -> float:
        self.reads += 1
        if self.reads % 2:
            self.base = float(self.reads)
            return self.base
        return self.base + next(self.durations)


class Gateway:
    """A fake gateway; ``calls`` is the ordered list of (method, path) it was asked."""

    def __init__(self, *, jobs_status: int = 202, validate_statuses: Sequence[int] = (), pricing: bool = False,
                 failing_examples: Mapping[str, int] | None = None,
                 problem_statuses: Sequence[int] = (), unreadable: str = "", existing: bool = False) -> None:
        self.failing_examples = dict(failing_examples or {})
        self.problem_statuses = iter(problem_statuses)
        self.unreadable = unreadable
        self.calls: list[tuple[str, str]] = []
        self.jobs_status = jobs_status
        self.validate_statuses = iter(validate_statuses)
        self.pricing = pricing
        self.job_headers: list[str] = []
        self.job_bodies: list[dict] = []
        self.cancelled: set[str] = set()
        self.problems: set[str] = {"latency-a"} if existing else set()
        self.count = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path.removeprefix("/api")
        self.calls.append((method, path))
        if path == "/v1/auth/login":
            if json.loads(request.content)["password"] != PASSWORD:
                return httpx.Response(401, json={"code": "invalid_credentials"})
            return httpx.Response(200, json={"access_token": TOKEN})
        assert request.headers.get("authorization") == f"Bearer {TOKEN}" or path == "/openapi.json"
        if path == "/openapi.json":
            return httpx.Response(200, json={"info": {"version": "1.2.3"}})
        if path == "/v1/bim/templates":
            if self.unreadable == "examples":
                return httpx.Response(200, content=b"<html>not json</html>")
            return httpx.Response(200, json={"templates": list(SIZES)})
        if path.startswith("/v1/bim/templates/"):
            name = path.rsplit("/", 1)[-1]
            if name in self.failing_examples:
                return httpx.Response(self.failing_examples[name], json={"code": "unavailable"})
            if name not in SIZES:
                return httpx.Response(404, json={"code": "not_found"})
            return httpx.Response(200, content=b"z" * SIZES[name])
        if path == "/v1/organizations/lab-main/problems" and method == "POST":
            status = next(self.problem_statuses, None)
            if status is not None and status != 201:
                return httpx.Response(status, json={"detail": {"code": "forbidden"}})
            slug = request.url.params["slug"]
            if slug in self.problems:
                return httpx.Response(409, json={"detail": {"code": "slug_conflict"}})
            self.problems.add(slug)
            return httpx.Response(201, json={"revision": {"id": f"rev-{slug}"}, "created": True})
        if path.startswith("/v1/organizations/lab-main/problems/") and path.endswith("/revisions") and method == "POST":
            slug = path.split("/")[-2]
            return httpx.Response(200, json={"revision": {"id": f"rev-{slug}"}, "created": False})
        if path == "/v1/bim/validate":
            status = next(self.validate_statuses, 200)
            return httpx.Response(status, json={"valid": True})
        if path == RUNS:
            if self.pricing:
                return httpx.Response(503, json={"code": "pricing_unavailable", "detail": "SPACE"})
            self.count += 1
            self.job_headers.append(request.headers["idempotency-key"])
            self.job_bodies.append(json.loads(request.content))
            if self.unreadable == "jobs":
                return httpx.Response(self.jobs_status, content=b"<html>not json</html>")
            return httpx.Response(self.jobs_status, json={"id": f"job-{self.count}"})
        if path.endswith("/cancel"):
            self.cancelled.add(path.split("/")[-2])
            return httpx.Response(202, json={})
        if path.startswith(f"{RUNS}/"):
            job = path.rsplit("/", 1)[-1]
            return httpx.Response(200, json={"status": "cancelled" if job in self.cancelled else "running"})
        return httpx.Response(404)


UPLOAD = "POST /v1/organizations/{org}/problems/{problem}/revisions"
RUNS = "/v1/organizations/lab-main/runs"
ROUTES = [(UPLOAD, "package"), ("POST /v1/organizations/{org}/runs", "revision"), ("POST /v1/bim/validate", "package")]


def run(probe, gateway, durations=(0.1,), argv=("--samples", "4", "--warmup", "1", "--examples", "a"), env=ENV):
    code = probe.main(list(argv), env, transport=httpx.MockTransport(gateway), clock=Clock(durations), sleep=lambda _s: None)
    return code


def report_of(capsys) -> dict:
    return json.loads(capsys.readouterr().out)


def test_percentile_is_nearest_rank(probe):
    values = list(range(100, 0, -1))
    assert probe.percentile(values, 0.50) == 50
    assert probe.percentile(values, 0.95) == 95
    assert probe.percentile([7.0], 0.95) == 7.0
    assert probe.percentile([], 0.95) == 0.0


def test_report_keys_and_percentiles(probe, capsys):
    assert run(probe, Gateway(), durations=(0.1, 0.2, 0.3, 0.4)) == 0
    out = capsys.readouterr().out
    report = json.loads(out)
    assert {"tool", "ok", "measuredAt", "baseUrl", "gatewayVersion", "config", "packages", "routes"} <= set(report)
    assert report["tool"] == "latency_probe" and report["ok"] is True
    assert report["gatewayVersion"] == "1.2.3"
    assert report["packages"] == [{"path": "a", "bytes": 100}]
    assert [(r["route"], r["variant"]) for r in report["routes"]] == ROUTES
    row = report["routes"][2]
    assert set(row) == {"route", "variant", "package", "samples", "errors", "errorAnswers", "p50Ms", "p95Ms", "maxMs", "targetMs",
                        "meetsTarget"}
    assert report["config"]["org"] == "lab-main" and report["skippedExamples"] == []
    assert row["samples"] == 4 and row["errors"] == 0
    assert row["targetMs"] == 2000.0
    assert report["routes"][0]["targetMs"] == 2000.0
    assert report["routes"][1]["targetMs"] == 500.0
    assert report["routes"][1]["p50Ms"] > 0 and report["routes"][1]["p95Ms"] >= report["routes"][1]["p50Ms"]
    assert "samples\": [" not in out


def test_percentiles_of_known_durations(probe, capsys):
    # Five requests per route with the first (warmup) one slow: the timed ones are 100..400 ms.
    code = run(probe, Gateway(), durations=(9.0, 0.1, 0.2, 0.3, 0.4), argv=("--samples", "4", "--warmup", "1", "--examples", "a"))
    row = report_of(capsys)["routes"][2]
    assert code == 0
    assert row["p50Ms"] == pytest.approx(200.0) and row["p95Ms"] == pytest.approx(400.0) and row["maxMs"] == pytest.approx(400.0)


@pytest.mark.parametrize(("duration_s", "meets", "code"), [(0.5, True, 0), (0.5005, False, 1)])
def test_verdict_at_and_over_the_jobs_target(probe, capsys, duration_s, meets, code):
    gateway = Gateway(validate_statuses=())
    assert run(probe, gateway, durations=(duration_s,)) == code
    rows = report_of(capsys)["routes"]
    assert rows[1]["meetsTarget"] is meets
    assert rows[0]["meetsTarget"] is rows[2]["meetsTarget"] is True  # 2 s targets


def test_validate_target_boundary(probe, capsys):
    assert run(probe, Gateway(), durations=(2.0,)) == 1  # jobs miss, validate is exactly on target
    rows = report_of(capsys)["routes"]
    assert rows[2]["meetsTarget"] is True and rows[0]["meetsTarget"] is True and rows[1]["meetsTarget"] is False
    assert run(probe, Gateway(), durations=(0.1,), argv=("--samples", "2", "--warmup", "0", "--examples", "a",
                                                           "--validate-target-ms", "99")) == 1
    assert report_of(capsys)["routes"][2]["meetsTarget"] is False


def test_unexpected_answers_are_counted_and_not_timed(probe, capsys):
    # Validate answers 500 twice in its 5 requests (warmup 1): the first answer is the warmup one.
    gateway = Gateway(validate_statuses=[500, 200, 500, 500, 200])
    run(probe, gateway, durations=(0.1,))
    row = report_of(capsys)["routes"][2]
    assert row["errors"] == 2 and row["samples"] == 2


def test_a_failing_jobs_answer_is_a_miss(probe, capsys):
    assert run(probe, Gateway(jobs_status=500)) == 1
    rows = report_of(capsys)["routes"]
    assert rows[1]["errorAnswers"] == {"500": 4}


def test_the_job_runs_the_uploaded_revision(probe, capsys):
    gateway = Gateway()
    assert run(probe, gateway) == 0
    capsys.readouterr()
    assert {body["revision"] for body in gateway.job_bodies} == {"rev-latency-a"}
    assert ("POST", "/v1/organizations/lab-main/problems") in gateway.calls


def test_a_problem_left_by_an_earlier_run_is_reused(probe, capsys):
    gateway = Gateway(existing=True)
    assert run(probe, gateway) == 0
    capsys.readouterr()
    assert {body["revision"] for body in gateway.job_bodies} == {"rev-latency-a"}
    assert gateway.problems == {"latency-a"}


def test_a_row_with_an_error_does_not_meet_its_target(probe, capsys):
    assert run(probe, Gateway(validate_statuses=[200, 500, 200, 200, 200])) == 1
    row = report_of(capsys)["routes"][2]
    assert row["samples"] == 3 and row["errors"] == 1 and row["p95Ms"] <= row["targetMs"]
    assert row["meetsTarget"] is False


def test_the_clock_is_read_only_around_the_requests(probe, capsys):
    clock = Clock((0.1,))
    code = probe.main(["--samples", "4", "--warmup", "1", "--examples", "a"], ENV, transport=httpx.MockTransport(Gateway()),
                      clock=clock, sleep=lambda _s: None)
    capsys.readouterr()
    assert code == 0
    assert clock.reads == 2 * (1 + 4) * 3  # upload, accept and validate; the drain does not read it


def test_the_idempotency_key_is_built_before_the_clock_starts(probe):
    events: list[str] = []
    timed = probe.Probe(probe.Config(samples=2, warmup=1), None, lambda: events.append("clock") or 0.0, lambda _s: None)

    def prepare():
        events.append("prepare")
        return lambda: events.append("send") or httpx.Response(200, json={})

    timed.measure(prepare, 200)
    assert events == ["prepare", "clock", "send", "clock"] * 3


@pytest.mark.parametrize("selection", ["", ",", " , "])
def test_an_empty_selection_exits_2(probe, capsys, selection):
    assert run(probe, Gateway(), argv=("--examples", selection)) == 2
    assert report_of(capsys)["error"].endswith("no example selected")


def test_examples_the_gateway_does_not_serve_are_skipped_and_listed(probe, capsys):
    gateway = Gateway(failing_examples={"b": 500, "d": 404})
    assert run(probe, gateway, argv=("--samples", "1", "--warmup", "0")) == 0
    report = report_of(capsys)
    assert report["skippedExamples"] == [{"path": "b", "status": 500}, {"path": "d", "status": 404}]
    assert [p["path"] for p in report["packages"]] == ["c", "a", "e"]
    assert run(probe, Gateway(failing_examples={"b": 500}), argv=("--samples", "1", "--warmup", "0", "--markdown")) == 0
    assert "Skipped examples: `b` (500)" in capsys.readouterr().out


def test_no_fetchable_example_is_a_configuration_error(probe, capsys):
    assert run(probe, Gateway(failing_examples={name: 500 for name in SIZES}), argv=("--examples", "all")) == 2
    report = report_of(capsys)
    assert report["error"].endswith("no example could be fetched")
    assert len(report["skippedExamples"]) == len(SIZES)


def test_a_named_example_that_fails_is_a_hard_error(probe, capsys):
    assert run(probe, Gateway(failing_examples={"b": 500}), argv=("--examples", "a,b")) == 2
    report = report_of(capsys)
    assert report["error"].endswith("example b: 500") and report["skippedExamples"] == []


def test_a_failure_keeps_the_rows_already_measured(probe, capsys):
    gateway = Gateway(problem_statuses=(201, 403))
    code = run(probe, gateway, argv=("--samples", "2", "--warmup", "0", "--examples", "a,b"))
    captured = capsys.readouterr()
    report = json.loads(captured.out)
    assert code == 1
    assert "problem upload: 403" in report["error"] and report["ok"] is False
    assert [(r["variant"], r["package"]) for r in report["routes"]] == [("package", "b"), ("revision", "b"), ("package", "b")]  # b is the larger package
    assert "Traceback" not in captured.out + captured.err


def test_an_unreadable_answer_is_a_reported_error(probe, capsys):
    assert run(probe, Gateway(unreadable="jobs")) == 1
    captured = capsys.readouterr()
    report = json.loads(captured.out)
    assert report["ok"] is False and report["error"].startswith("JSONDecodeError") and report["packages"] != []
    assert "Traceback" not in captured.out + captured.err
    assert run(probe, Gateway(unreadable="examples"), argv=("--examples", "all")) == 2
    report = report_of(capsys)
    assert report["error"].startswith("JSONDecodeError") and report["packages"] == []


def test_failed_jobs_are_errors_and_never_drained(probe, capsys):
    gateway = Gateway(jobs_status=500)
    assert run(probe, gateway) == 1
    rows = report_of(capsys)["routes"]
    assert rows[1]["errors"] == 4 and rows[1]["samples"] == 0 and rows[1]["meetsTarget"] is False
    assert not any(path.endswith("/cancel") for _, path in gateway.calls)


def test_warmup_is_not_counted(probe, capsys):
    run(probe, Gateway(), durations=(9.0, 9.0, 0.1, 0.1), argv=("--samples", "2", "--warmup", "2", "--examples", "a"))
    for row in report_of(capsys)["routes"]:
        assert row["samples"] == 2 and row["errors"] == 0 and row["maxMs"] == pytest.approx(100.0)


def test_each_job_is_cancelled_and_drained_before_the_next_accept(probe, capsys):
    gateway = Gateway()
    run(probe, gateway)
    capsys.readouterr()
    job_posts = [i for i, call in enumerate(gateway.calls) if call == ("POST", RUNS)]
    assert len(job_posts) == 5  # 1 warmup + 4 samples
    for number, (first, following) in enumerate(zip(job_posts, job_posts[1:] + [len(gateway.calls)], strict=True), start=1):
        between = gateway.calls[first + 1:following]
        assert ("POST", f"{RUNS}/job-{number}/cancel") in between
        assert ("GET", f"{RUNS}/job-{number}") in between
        assert between.index(("POST", f"{RUNS}/job-{number}/cancel")) < between.index(("GET", f"{RUNS}/job-{number}"))
    assert len(set(gateway.job_headers)) == 5


def test_a_job_that_never_ends_does_not_hang(probe, capsys):
    gateway = Gateway()
    original = gateway.__call__

    def stuck(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/cancel"):
            return httpx.Response(202, json={})
        return original(request)

    code = probe.main(["--samples", "1", "--warmup", "0", "--examples", "a"], ENV, transport=httpx.MockTransport(stuck),
                      clock=Clock((0.1,)), sleep=lambda _s: None)
    report = report_of(capsys)
    assert code == 1 and "did not end" in report["error"]


def test_pricing_unavailable_is_blocked_not_a_miss(probe, capsys):
    assert run(probe, Gateway(pricing=True)) == 3
    report = report_of(capsys)
    assert report["ok"] is False and "pricing_unavailable" in report["blocked"]


def test_configuration_errors_exit_2(probe, capsys):
    assert run(probe, Gateway(), env={}) == 2
    assert "DEMO_SEED_PASSWORD" in report_of(capsys)["error"]
    assert run(probe, Gateway(), env={"DEMO_SEED_PASSWORD": "wrong-password-1"}) == 2
    assert "login" in report_of(capsys)["error"]
    assert run(probe, Gateway(), argv=("--examples", "zzz")) == 2
    assert "example zzz" in report_of(capsys)["error"]


def test_top3_selection_by_size_and_named_choices(probe, capsys):
    run(probe, Gateway(), argv=("--samples", "1", "--warmup", "0"))
    report = report_of(capsys)
    assert report["packages"] == [{"path": "d", "bytes": 400}, {"path": "b", "bytes": 300}, {"path": "c", "bytes": 200}]
    assert len(report["routes"]) == 9
    run(probe, Gateway(), argv=("--samples", "1", "--warmup", "0", "--examples", "all"))
    assert [p["path"] for p in report_of(capsys)["packages"]] == ["d", "b", "c", "a", "e"]
    run(probe, Gateway(), argv=("--samples", "1", "--warmup", "0", "--examples", "e,a"))
    assert [p["path"] for p in report_of(capsys)["packages"]] == ["a", "e"]


def test_markdown_report(probe, capsys):
    assert run(probe, Gateway(), argv=("--samples", "2", "--warmup", "0", "--examples", "a", "--markdown")) == 0
    out = capsys.readouterr().out
    assert out.startswith("# Latency probe")
    assert "| route | variant | package | samples | errors | p50 ms | p95 ms | max ms | target ms | meets |" in out
    assert out.count("| POST /v1/") == 3 and "`a` (100 B)" in out
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)


def test_password_and_token_never_reach_the_output(probe, capsys):
    for gateway in (Gateway(), Gateway(pricing=True), Gateway(jobs_status=500)):
        run(probe, gateway)
        run(probe, gateway, argv=("--samples", "1", "--warmup", "0", "--examples", "a", "--markdown"))
        run(probe, gateway, env={"DEMO_SEED_PASSWORD": "wrong-password-1"})
    captured = capsys.readouterr()
    assert PASSWORD not in captured.out + captured.err and TOKEN not in captured.out + captured.err
    assert "wrong-password-1" not in captured.out + captured.err
