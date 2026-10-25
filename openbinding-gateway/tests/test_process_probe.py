"""``tools/process_probe.py``: the acceptance probe of ``bim-service`` in process mode.

Two kinds of test.  The logic of the probe (its defaults, its pinned digests, its helpers, its configuration errors)
is checked without a service.  The scenarios are run against a real ``bim_service`` application served by uvicorn on a
loopback port in this process: the probe speaks HTTP with raw ``Content-Length`` and chunked bodies, which an ASGI
transport cannot carry.  The service runs with the thread executor, where its costly operation is replaced by a sleep
(the same public route and limits; only the duration is made deterministic), and once with the process executor for
the scenarios that do not need a costly operation.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

from _paths import GATEWAY_ROOT
from _repo import REPO_ROOT

TOOLS = GATEWAY_ROOT / "tools"
TOOLCHAIN = REPO_ROOT / "bim-toolchain"
SERVICE_SRC = TOOLCHAIN / "packages" / "bim-service" / "src"
CONTRACT = TOOLCHAIN / "contracts" / "consumers" / "openbinding" / "compile.json"
MANIFESTS = TOOLCHAIN / "packages" / "bim-core" / "tests" / "fixtures" / "manifests"
COMPOSE_N2 = REPO_ROOT / "compose.lab-process-n2.json"
COMPOSE_PROBE = REPO_ROOT / "compose.lab-process-n2-probe.json"
DEPLOYMENT_DOC = REPO_ROOT / "docs" / "qa" / "PROCESS_DEPLOYMENT.md"
TOKEN = "probe-test-token-" + "0123456789abcdef" * 2
MIB = 1024 * 1024

# bim_service is imported from the checkout (this is how the other gateway tests reach it).
if SERVICE_SRC.is_dir() and str(SERVICE_SRC) not in sys.path:
    sys.path.insert(0, str(SERVICE_SRC))


def load_probe():
    spec = importlib.util.spec_from_file_location("process_probe", TOOLS / "process_probe.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["process_probe"] = module
    spec.loader.exec_module(module)
    return module


probe = load_probe()


def checkout() -> None:
    """The repository around the gateway (the toolchain, the manifests): always there in a checkout, never in the image."""
    if not SERVICE_SRC.is_dir():
        pytest.skip("this environment has only the gateway image, not the repository checkout")


# ------------------------------------------------------------------------------ the logic, without a service


def test_the_defaults_are_the_n2_profile_of_the_manifest() -> None:
    checkout()
    env = json.loads(COMPOSE_N2.read_text(encoding="utf-8"))["services"]["bim-service"]["environment"]
    expected = probe.Expected()
    assert expected.executor == env["BIM_SERVICE_EXECUTOR"] == "process"
    assert expected.max_body_bytes == int(env["BIM_SERVICE_MAX_BODY_BYTES"])
    assert expected.concurrency == int(env["BIM_SERVICE_MAX_CONCURRENCY"])
    assert expected.tenant_limit == int(env["BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT"])
    assert expected.acquire_timeout_ms == int(env["BIM_SERVICE_ACQUIRE_TIMEOUT_MS"])
    assert expected.memory_budget_bytes == int(env["BIM_SERVICE_MEMORY_BUDGET_BYTES"])
    assert expected.pending_body_bytes == int(env["BIM_SERVICE_MAX_PENDING_BODY_BYTES"])
    assert "BIM_SERVICE_OPERATION_TIMEOUT_SECONDS" not in env  # the service default, 60 s
    assert expected.operation_timeout_seconds == probe.DEFAULT_OPERATION_TIMEOUT == 60.0
    probe_env = json.loads(COMPOSE_PROBE.read_text(encoding="utf-8"))["services"]["bim-service"]["environment"]
    assert float(probe_env["BIM_SERVICE_OPERATION_TIMEOUT_SECONDS"]) == probe.PROBE_OPERATION_TIMEOUT == 3.0


def test_the_pinned_digests_and_the_demo_package_are_those_of_the_consumer_contract() -> None:
    checkout()
    first = json.loads(CONTRACT.read_text(encoding="utf-8"))["steps"][0]
    recorded = first["expect"]["body"]
    assert first["request"]["body"]["package"] == probe.b64(probe.demo_zip())
    for key in ("packageDigest", "instanceDigest", "inputDigest"):
        assert probe.PINNED_COMPILE[key] == recorded[key]
    assert probe.PINNED_COMPILE["irSemanticDigest"] == recorded["ir"]["semanticDigest"]
    broken = json.loads(CONTRACT.read_text(encoding="utf-8"))["steps"][2]
    assert broken["request"]["body"]["package"] == probe.b64(probe.demo_zip(broken=True))


def test_the_engine_manifest_is_the_one_of_the_consumer_contract() -> None:
    checkout()
    fixture = json.loads((MANIFESTS / "random-search.json").read_text(encoding="utf-8"))
    assert probe.RANDOM_SEARCH_MANIFEST == fixture


def test_the_fit_rule_reproduces_the_documented_figure_of_the_n2_profile() -> None:
    required = probe.fit_required_bytes(body=2 * MIB, workers=2, budget=16 * MIB, pending=4 * MIB, container=256 * MIB)
    assert required == 261724569
    checkout()
    assert str(required) in DEPLOYMENT_DOC.read_text(encoding="utf-8")
    thread_lab = probe.fit_required_bytes(body=16 * MIB, workers=2, budget=128 * MIB, pending=32 * MIB, container=256 * MIB)
    assert thread_lab > 256 * MIB, "the thread laboratory's limits do not fit a process-mode container"


def test_the_helpers() -> None:
    assert probe.percentile([], 0.5) == 0.0
    assert probe.percentile([5.0], 0.95) == 5.0
    assert probe.percentile([1, 2, 3, 4], 0.5) == 2
    assert probe.percentile(list(range(1, 101)), 0.95) == 95
    assert probe.percentile([9, 1, 5], 1.0) == 9
    body = probe.padded_result_body(100)
    assert len(body) == 100 and json.loads(body)["result"] == "a" * 87
    assert len(b"".join(probe.json_chunks(100_000, close=True))) == 100_000
    assert json.loads(b"".join(probe.json_chunks(5_000, close=True)))["result"].startswith("aaa")
    assert not b"".join(probe.json_chunks(5_000, close=False)).endswith(b"}")
    assert probe.clip("x" * 400).endswith("[400 chars]") and probe.clip("short") == "short"
    reply = probe.Reply(429, {"retry-after": "1", "content-type": "application/problem+json"}, b'{"code":"memory_budget"}', 0.1, 0.0, 0.0)
    assert (reply.code, reply.retry_after, reply.is_problem) == ("memory_budget", 1, True)
    assert probe.Reply(0, {}, b"", 0.0, 0.0, 0.0, "boom").label().startswith("no-answer")


def test_the_comparison_with_bim_core_ignores_what_changes_with_the_toolchain() -> None:
    ir = {"apiVersion": "bim/v1", "kind": "BindingProblem", "spec": {"a": 1, "sourceMap": {"x": 1}}}
    same = {"apiVersion": "bim/v1", "kind": "BindingProblem", "spec": {"a": 1, "sourceMap": {"x": 2}}}
    one = {"ir": ir, "irDigest": "x", "compilationDigest": "y", "toolchain": {"compilerDigest": "a"}, "packageDigest": "p"}
    other = {"ir": same, "irDigest": "z", "compilationDigest": "w", "toolchain": {"compilerDigest": "b"}, "packageDigest": "p"}
    assert probe.comparable(probe.normalize(one)) == probe.comparable(probe.normalize(other))
    assert probe.normalize(one)["ir"]["semanticDigest"] == probe.semantic_digest(ir)
    other["packageDigest"] = "q"
    assert probe.comparable(probe.normalize(one)) != probe.comparable(probe.normalize(other))


def test_the_synthetic_costly_request_is_a_valid_one_that_grows_with_its_size() -> None:
    small, large = probe.costly_body(3, 0.5), probe.costly_body(12, 0.5)
    assert len(large) > 3 * len(small) // 2
    request = json.loads(small)
    assert request["limit"] == 128 and request["seconds"] == 0.5 and len(request["binding"]) == 3
    port = probe.InProcessBim()
    answer = port.neighborhood(request["ir"], request["binding"], limit=128)
    assert answer["coverage"]["total"] == 3 and answer["coverage"]["complete"] is True


def test_a_missing_or_empty_token_file_is_a_configuration_error(tmp_path, capsys) -> None:
    code = probe.main(["--token-file", str(tmp_path / "absent")], {})
    report = json.loads(capsys.readouterr().out)
    assert code == probe.EXIT_CONFIG and report["ok"] is False and "token" in report["error"] and report["steps"] == []
    empty = tmp_path / "empty"
    empty.write_text("\n", encoding="utf-8")
    assert probe.main(["--token-file", str(empty)], {}) == probe.EXIT_CONFIG
    assert "empty" in json.loads(capsys.readouterr().out)["error"]


def test_the_timeout_step_needs_its_flag_and_nothing_to_run_is_refused(tmp_path, capsys) -> None:
    token = tmp_path / "token"
    token.write_text(TOKEN + "\n", encoding="utf-8")
    assert probe.main(["--token-file", str(token), "--steps", "timeout_replacement"], {}) == probe.EXIT_CONFIG
    assert "--timeout-probe" in json.loads(capsys.readouterr().out)["error"]
    assert probe.main(["--token-file", str(token), "--steps", "none"], {}) == probe.EXIT_CONFIG
    assert probe.main(["--token-file", str(token), "--steps", "capabilities", "--repeat", "0"], {}) == probe.EXIT_CONFIG
    assert probe.main(["--token-file", str(token)], {"PROBE_EXPECT_CONCURRENCY": "two"}) == probe.EXIT_CONFIG
    capsys.readouterr()


def test_options_and_environment_set_the_expected_limits(tmp_path) -> None:
    token = tmp_path / "token"
    token.write_text(f"\n{TOKEN}\nsecond\n", encoding="utf-8")
    config, summary = probe.make_config(["--token-file", str(token)], {"BIM_SERVICE_URL": "http://example.test:9/"})
    assert (config.url, config.token, config.expected) == ("http://example.test:9", TOKEN, probe.Expected())
    assert config.steps == probe.STEP_NAMES and not config.timeout_probe and summary is False
    env = {"PROBE_EXPECT_MAX_BODY_BYTES": "6291456", "PROBE_EXPECT_CONCURRENCY": "1", "PROBE_EXPECT_EXECUTOR": "thread"}
    config, summary = probe.make_config(
        ["--token-file", str(token), "--expect-pending-body-bytes", "12582912", "--timeout-probe", "--hold", "2.5", "--summary"], env
    )
    assert summary is True
    assert (config.expected.max_body_bytes, config.expected.concurrency, config.expected.executor) == (6 * MIB, 1, "thread")
    assert config.expected.pending_body_bytes == 12 * MIB and config.expected.operation_timeout_seconds == 3.0
    assert config.timeout_probe and config.hold == 2.5


# ----------------------------------------------------------------------- a real service in this process


def settings_for(tmp_path, **overrides):
    from bim_service.settings import BimServiceSettings

    tokens = tmp_path / "tokens"
    tokens.write_text(TOKEN + "\n", encoding="utf-8")
    tokens.chmod(0o600)
    values = {
        "tokens_file": str(tokens),
        "max_body_bytes": 256 * 1024,
        "max_concurrency": 2,
        "max_concurrency_per_tenant": 0,
        "acquire_timeout_ms": 150,
        "operation_timeout_seconds": 30.0,
        "memory_budget_bytes": 8 * 256 * 1024,
        "max_pending_body_bytes": 2 * 256 * 1024,
        "executor": "thread",
    }
    values.update(overrides)
    return BimServiceSettings(**values)


@contextlib.contextmanager
def running_service(tmp_path, **overrides):
    """``(url, token file)`` of a ``bim_service`` application served by uvicorn on a loopback port."""
    import uvicorn
    from bim_service.app import create_app

    settings = settings_for(tmp_path, **overrides)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), log_level="warning", access_log=False, lifespan="on"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 60
    while not server.started:
        assert thread.is_alive(), "the service did not start"
        assert time.monotonic() < deadline, "the service did not start in time"
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{sock.getsockname()[1]}", tmp_path / "tokens"
    finally:
        server.should_exit = True
        thread.join(30)
        sock.close()


def slow_neighborhood(monkeypatch, seconds: float) -> None:
    """The costly request of the probe (``limit`` 128) takes ``seconds`` more; the route, limits and answer are the real ones."""
    from bim_service import operations

    original = operations.neighborhood

    def slow(*args):
        if args[3] == probe.NEIGHBORHOOD_LIMIT:
            time.sleep(seconds)
        return original(*args)

    monkeypatch.setattr(operations, "neighborhood", slow)


def stuck_neighborhood(monkeypatch) -> threading.Event:
    """The costly request of the probe (``limit`` 128) blocks until the returned event is set (or 60 s) and computes nothing.

    The thread executor cannot cancel a thread, so abandoned ones are blocked rather than competing for the CPU.
    """
    from bim_service import operations

    original = operations.neighborhood
    release = threading.Event()

    def stuck(*args):
        if args[3] == probe.NEIGHBORHOOD_LIMIT:
            release.wait(60)
            return {}
        return original(*args)

    monkeypatch.setattr(operations, "neighborhood", stuck)
    return release


def probe_arguments(token_file, settings, *extra: str) -> list[str]:
    return [
        "--token-file", str(token_file),
        "--expect-executor", settings.executor,
        "--expect-max-body-bytes", str(settings.max_body_bytes),
        "--expect-concurrency", str(settings.max_concurrency),
        "--expect-acquire-timeout-ms", str(settings.acquire_timeout_ms),
        "--expect-memory-budget-bytes", str(settings.memory_budget_bytes),
        "--expect-pending-body-bytes", str(settings.max_pending_body_bytes),
        "--expect-operation-timeout", str(settings.operation_timeout_seconds),
        *extra,
    ]  # fmt: skip


def run_probe(capsys, url, token_file, settings, *extra: str):
    code = probe.main(probe_arguments(token_file, settings, *extra), {"BIM_SERVICE_URL": url})
    captured = capsys.readouterr()
    report = json.loads(captured.out)  # exactly one JSON document on stdout
    return code, report, captured.err


def failures(report) -> list[tuple[str, str, object, object]]:
    return [
        (step["name"], check["name"], check["expected"], check["observed"])
        for step in report["steps"]
        for check in step["checks"]
        if not check["ok"]
    ]


def test_every_scenario_passes_on_a_service_that_meets_the_profile(tmp_path, monkeypatch, capsys) -> None:
    checkout()
    slow_neighborhood(monkeypatch, 0.6)
    settings = settings_for(tmp_path)
    with running_service(tmp_path) as (url, token_file):
        code, report, err = run_probe(capsys, url, token_file, settings, "--cost-seconds", "0.4", "--load-seconds", "2")
    assert failures(report) == []
    assert code == probe.EXIT_OK and report["ok"] is True
    assert [step["name"] for step in report["steps"]] == list(probe.STEP_NAMES)
    assert all(step["ok"] and step["checks"] for step in report["steps"])
    assert TOKEN not in json.dumps(report) and TOKEN not in err
    observations = report["observations"]
    assert observations["skipped"] == [probe.TIMEOUT_STEP]
    assert {entry["phase"] for entry in observations["timeline"]} >= {"probe:start", "capabilities:start", "large_bodies:end", "probe:end"}
    assert all({"monotonic", "epoch"} <= set(entry) for entry in observations["timeline"])
    assert err.count("PHASE ") == len(observations["timeline"])
    steps = {step["name"]: step for step in report["steps"]}
    operations = steps["valid_operations"]["details"]["operations"]
    assert {"compile", "validate", "evaluate", "reevaluate-agreement", "compatibility", "engines-validate"} <= set(operations)
    assert steps["saturation"]["details"]["outcomes"].get("503:service_busy", 0) + steps["saturation"]["details"]["outcomes"].get("429:pending_body_bytes", 0) >= 1
    assert steps["healthz_under_load"]["details"]["healthz"]["ok200"] == steps["healthz_under_load"]["details"]["healthz"]["samples"]
    assert steps["capabilities"]["details"]["toolchain"]["sameToolchain"] is True


def test_the_summary_is_one_compact_line_with_the_failures_and_the_timeline(tmp_path, capsys) -> None:
    checkout()
    with running_service(tmp_path) as (url, token_file):
        code = probe.main(["--token-file", str(token_file), "--steps", "capabilities,hostile_small", "--summary"], {"BIM_SERVICE_URL": url})
        captured = capsys.readouterr()
    lines = captured.out.strip().splitlines()
    assert len(lines) == 1 and len(lines[0]) < 5000, "the compact report is one line that a runner keeping the tail can read"
    summary = json.loads(lines[0])
    full = json.loads(captured.err[captured.err.index("{") :])  # the full report follows the PHASE marks on stderr
    assert code == probe.EXIT_FAILED and summary["ok"] is False and full["ok"] is False
    assert [step["name"] for step in summary["steps"]] == ["capabilities", "hostile_small"]
    assert summary["steps"][1]["ok"] is True and summary["steps"][1]["failed"] == []
    capabilities = summary["steps"][0]
    assert {item["check"] for item in capabilities["failed"]} >= {"limits.service.executor", "limits.service.maxBodyBytes"}
    assert all({"check", "expected", "observed"} == set(item) for item in capabilities["failed"])
    assert summary["observations"]["timeline"][0][0] == "probe:start"
    assert len(full["steps"][0]["checks"]) == capabilities["checks"]
    assert TOKEN not in captured.out and TOKEN not in captured.err


def test_a_service_that_does_not_meet_the_profile_fails_the_probe(tmp_path, capsys) -> None:
    checkout()
    settings = settings_for(tmp_path)
    with running_service(tmp_path) as (url, token_file):
        # the defaults of the probe are the process profile N2: this service is a thread service with other limits
        code = probe.main(["--token-file", str(token_file), "--steps", "capabilities"], {"BIM_SERVICE_URL": url})
        report = json.loads(capsys.readouterr().out)
    assert code == probe.EXIT_FAILED and report["ok"] is False
    names = {check[1] for check in failures(report)}
    assert {"limits.service.executor", "limits.service.maxBodyBytes", "limits.service.memoryBudgetBytes"} <= names
    assert "limits.service.maxConcurrentOperations" not in names  # 2 slots, as in N2: that one is met
    observed = {check[1]: check[3] for check in failures(report)}
    assert observed["limits.service.executor"] == "thread" and observed["limits.service.maxBodyBytes"] == settings.max_body_bytes


def test_a_service_that_is_not_there_is_reported_not_raised(tmp_path, capsys) -> None:
    token = tmp_path / "token"
    token.write_text(TOKEN + "\n", encoding="utf-8")
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()  # nothing listens here
    code = probe.main(["--token-file", str(token), "--steps", "capabilities,hostile_small"], {"BIM_SERVICE_URL": f"http://127.0.0.1:{port}"})
    report = json.loads(capsys.readouterr().out)
    assert code == probe.EXIT_FAILED and not report["ok"]
    assert [step["ok"] for step in report["steps"]] == [False, False]
    assert any("no-answer" in str(check[3]) for check in failures(report))


def test_the_timeout_step_sees_the_503_the_healthz_and_the_next_request(tmp_path, monkeypatch, capsys) -> None:
    checkout()
    release = stuck_neighborhood(monkeypatch)
    overrides = {"max_concurrency": 3, "operation_timeout_seconds": 0.5}
    settings = settings_for(tmp_path, **overrides)
    try:
        with running_service(tmp_path, **overrides) as (url, token_file):
            code, report, err = run_probe(capsys, url, token_file, settings, "--steps", "none", "--timeout-probe", "--hold", "0.2")
    finally:
        release.set()
    assert failures(report) == []
    assert code == probe.EXIT_OK
    (step,) = report["steps"]
    assert step["name"] == probe.TIMEOUT_STEP and step["ok"]
    timeout = step["details"]["timeout"]
    assert 0.45 <= timeout["requestSeconds"] <= 3.5 and timeout["healthzSamples"] >= 2
    phases = [entry["phase"] for entry in report["observations"]["timeline"]]
    for phase in ("timeout:baseline", "timeout:request:start", "timeout:request:end", "timeout:replacement:start", "timeout:replacement:end"):
        assert phase in phases
    assert "hold:timeout:before-request:start" in phases and "hold:timeout:after-replacement:end" in phases
    assert "monotonic=" in err and "epoch=" in err
    assert report["observations"]["timeoutCalibration"]["rungs"][-1]["status"] == 503


def test_the_timeout_step_fails_when_nothing_valid_lasts_longer_than_the_budget(tmp_path, capsys) -> None:
    checkout()
    overrides = {"operation_timeout_seconds": 60.0}
    settings = settings_for(tmp_path, **overrides)
    with running_service(tmp_path, **overrides) as (url, token_file):
        code, report, _ = run_probe(
            capsys, url, token_file, settings, "--steps", "none", "--timeout-probe", "--expect-operation-timeout", "60",
            "--cost-tasks-start", "5", "--cost-body-fraction", "0.05",
        )  # fmt: skip
    assert code == probe.EXIT_FAILED
    names = [check[1] for check in failures(report)]
    assert "a valid request that lasts longer than the time budget could be built within the body cap" in names


def test_the_probe_runs_its_non_costly_scenarios_against_worker_processes(tmp_path, capsys) -> None:
    checkout()
    overrides = {"executor": "process", "acquire_timeout_ms": 2000}
    settings = settings_for(tmp_path, **overrides)
    with running_service(tmp_path, **overrides) as (url, token_file):
        code, report, _ = run_probe(
            capsys, url, token_file, settings, "--steps", "capabilities,valid_operations,hostile_small,large_bodies",
        )  # fmt: skip
    assert failures(report) == []
    assert code == probe.EXIT_OK
    capabilities = report["steps"][0]
    assert capabilities["details"]["fit"]["requiredBytes"] <= capabilities["details"]["fit"]["containerBytes"]
    assert any(check["name"] == "limits.service.executor" and check["observed"] == "process" for check in capabilities["checks"])


def test_the_whole_probe_passes_against_worker_processes_with_the_n2_figures(tmp_path, capsys) -> None:
    """The profile of the demo (N2 figures, 3 s time budget of the probe manifest), the defaults of the probe, real workers.

    Run with ``--summary``, the way it is meant to be run in the lab: the compact line must fit the tail of a runner.
    """
    checkout()
    overrides = {
        "executor": "process",
        "max_body_bytes": 2 * MIB,
        "max_concurrency": 2,
        "memory_budget_bytes": 16 * MIB,
        "max_pending_body_bytes": 4 * MIB,
        "acquire_timeout_ms": 2000,
        "operation_timeout_seconds": 3.0,
    }
    with running_service(tmp_path, **overrides) as (url, token_file):
        code = probe.main(
            ["--token-file", str(token_file), "--timeout-probe", "--load-seconds", "3", "--hold", "0.1", "--summary",
             "--healthz-p95-ms", "2000", "--healthz-max-ms", "5000", "--cost-body-fraction", "0.9"],
            {"BIM_SERVICE_URL": url},
        )  # fmt: skip
        captured = capsys.readouterr()
    report = json.loads(captured.err[captured.err.index("{") :])
    assert failures(report) == []
    assert code == probe.EXIT_OK and report["ok"] is True
    assert [step["name"] for step in report["steps"]] == [*probe.STEP_NAMES, probe.TIMEOUT_STEP]
    steps = {step["name"]: step for step in report["steps"]}
    assert 3.0 * 0.9 <= steps[probe.TIMEOUT_STEP]["details"]["timeout"]["requestSeconds"] <= 6.0
    assert steps["saturation"]["details"]["costly"]["bodyBytes"] <= 0.9 * 2 * MIB
    assert report["observations"]["skipped"] == []
    (line,) = captured.out.strip().splitlines()
    assert len(line) < 5000, f"the compact report has {len(line)} characters"
    summary = json.loads(line)
    assert summary["ok"] is True and [step["name"] for step in summary["steps"]] == [step["name"] for step in report["steps"]]
    labels = [entry[0] for entry in summary["observations"]["timeline"]]
    assert "timeout:request:start" in labels and "hold:timeout:after-request:end" in labels
    assert not [label for label in labels if label.startswith("hold:before:")]
    offset = summary["observations"]["timelineEpochMinusMonotonic"]
    marked = {entry["phase"]: entry for entry in report["observations"]["timeline"]}
    assert all(abs(epoch - marked[label]["monotonic"] - offset) < 0.01 for label, epoch in summary["observations"]["timeline"])
    assert TOKEN not in captured.out and TOKEN not in captured.err
