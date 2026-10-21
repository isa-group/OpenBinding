"""``tools/cancel_probe.py`` against a simulated gateway, engine and database (``httpx.MockTransport``).

The world below has a clock the probe's sleeps advance, so a 90 s wait costs nothing. It can behave the way a
gateway whose cancellation reaches the solver does, and the ways it can fail to: the job stays running while the
engine keeps solving, the engine finishes by itself and the job is cancelled afterwards, the DELETE is never
confirmed. Nothing here reaches a network, a database or a real engine; every name and secret is synthetic.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

import cancel_probe
from cancel_probe import AttemptsUnavailable, Config, Probe, engine_phase

PASSWORD = "lab-password-0001"
TOKEN = "tok-synthetic-0002"
JOB = "11111111-1111-4111-8111-111111111111"
ENGINE_JOB = "engine-job-1"
ENDPOINT = "http://engine-minizinc:3000"
ENGINE_PATH = f"/internal/v1/jobs/{ENGINE_JOB}"


@dataclass
class World:
    """Gateway, engine and ``job_engine_attempts`` as one simulated system on one clock."""

    now: float = 0.0
    running_at: float = 2.0
    registered_at: float = 3.0
    #: The gateway's cancellation reaches the solver: job cancelled and engine DELETEd this long after the cancel.
    propagates: bool = True
    propagation_delay: float = 1.0
    #: The engine finishes by itself at this absolute time...
    engine_done_at: float | None = None
    #: ...or this long after the cancel was requested.
    engine_done_after_cancel: float | None = None
    #: A job whose engine finished by itself is completed by the worker this much later.
    job_lag: float = 5.0
    #: How the job ends once the gateway cancels it.
    job_final: str = "cancelled"
    row_final: str = "sent"
    row_delay: float = 0.5
    attempts_error: str | None = None
    launch_status: int = 202
    login_status: int = 200
    upload_status: int = 201
    second_delete_status: int | None = None
    cancel_status: int = 200
    cancel_at: float | None = None
    job_ended_at: float | None = None
    engine_cancelled_at: float | None = None
    gateway_deleted_at: float | None = None
    gateway_log: list[tuple[str, str, float]] = field(default_factory=list)
    engine_log: list[tuple[str, str, float]] = field(default_factory=list)
    deletes_seen: int = 0

    # -- the clock the probe uses ---------------------------------------------------------------

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    # -- the state -------------------------------------------------------------------------------

    def engine_finish(self) -> float | None:
        if self.engine_done_at is not None:
            return self.engine_done_at
        if self.engine_done_after_cancel is not None and self.cancel_at is not None:
            return self.cancel_at + self.engine_done_after_cancel
        return None

    def job_status(self) -> str:
        if self.now < self.running_at:
            return "queued"
        if self.job_ended_at is not None and self.now >= self.job_ended_at:
            return self.job_final
        finish = self.engine_finish()
        if self.cancel_at is None and finish is not None and self.now >= finish + self.job_lag:
            return "completed"
        return "running"

    def engine_status(self) -> str:
        if self.engine_cancelled_at is not None and self.now >= self.engine_cancelled_at:
            return "cancelled"
        finish = self.engine_finish()
        if finish is not None and self.now >= finish:
            return "completed"
        return "running"

    def row_state(self) -> str:
        if self.gateway_deleted_at is None or self.now < self.gateway_deleted_at + self.row_delay:
            return "pending" if self.cancel_at is not None and self.job_status() == "cancelled" else "none"
        return self.row_final

    def attempts(self, job_id: str) -> list[dict[str, Any]]:
        if self.attempts_error:
            raise AttemptsUnavailable(self.attempts_error)
        if job_id != JOB or self.now < self.registered_at:
            return []
        return [
            {
                "attempt": 1,
                "engineJobId": ENGINE_JOB,
                "endpoint": ENDPOINT,
                "cancelState": self.row_state(),
                "cancelAttempts": 1 if self.row_state() != "none" else 0,
            }
        ]

    # -- the two services --------------------------------------------------------------------------

    def gateway(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.gateway_log.append((method, path, self.now))
        if path == "/api/v1/auth/login":
            if self.login_status != 200:
                return httpx.Response(self.login_status, json={"code": "invalid_credentials"})
            return httpx.Response(200, json={"access_token": TOKEN})
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"code": "unauthorized"})
        if path == "/api/v1/instances":
            return httpx.Response(self.upload_status, json={"id": "snapshot-1"})
        if path == "/api/v1/jobs" and method == "POST":
            body = json.loads(request.content)
            assert body["engine"] == "minizinc-csp" and body["mode"] == "exact-weighted"
            assert body["options"] == {"time_budget_ms": 600_000}
            if self.launch_status == 503:
                return httpx.Response(503, json={"code": "pricing_unavailable", "error": "no contract"})
            if self.launch_status != 202:
                return httpx.Response(self.launch_status, json={"code": "binding_space_too_large"})
            return httpx.Response(202, json={"id": JOB, "status": "queued"})
        if path == f"/api/v1/jobs/{JOB}" and method == "GET":
            return httpx.Response(
                200,
                json={"id": JOB, "status": self.job_status(), "cancellation_requested": self.cancel_at is not None},
            )
        if path == f"/api/v1/jobs/{JOB}/cancel" and method == "POST":
            if self.job_status() in ("completed", "failed", "cancelled"):
                return httpx.Response(409, json={"code": "terminal_job"})
            if self.cancel_status != 200:
                return httpx.Response(self.cancel_status, json={"code": "nope"})
            if self.cancel_at is None:
                self.cancel_at = self.now
                if self.propagates:
                    self.job_ended_at = self.now + self.propagation_delay
                    self.engine_cancelled_at = self.job_ended_at
                    self.gateway_deleted_at = self.job_ended_at
                elif self.engine_finish() is not None and self.job_final == "cancelled":
                    # the worker only notices the request once the solve returns, then sends a late DELETE
                    self.job_ended_at = self.engine_finish() + 1.0
                    self.gateway_deleted_at = self.job_ended_at
                elif self.job_final != "cancelled":
                    self.job_ended_at = self.now + self.propagation_delay
            return httpx.Response(200, json={"id": JOB, "status": "running", "cancellation_requested": True})
        return httpx.Response(599, json={"unexpected": f"{method} {path}"})

    def engine(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.engine_log.append((method, path, self.now))
        if path != ENGINE_PATH:
            return httpx.Response(404, json={"title": "BIM engine error", "status": 404})
        status = self.engine_status()
        if method == "GET":
            if status == "running":
                return httpx.Response(200, json={"id": ENGINE_JOB, "status": "running", "created_at": "t"})
            if status == "completed":
                return httpx.Response(200, json={"id": ENGINE_JOB, "status": "completed", "result": {}})
            return httpx.Response(
                200, json={"id": ENGINE_JOB, "status": "failed", "created_at": "t", "error": "cancelled: by request"}
            )
        assert method == "DELETE" and request.headers["content-type"] == "application/json"
        self.deletes_seen += 1
        if self.second_delete_status and self.deletes_seen >= 2:
            return httpx.Response(self.second_delete_status, json={"status": self.second_delete_status})
        if status == "running":
            self.engine_cancelled_at = self.now
            status = "cancelled"
        return httpx.Response(200, json={"id": ENGINE_JOB, "status": status})

    # -- helpers for the assertions ------------------------------------------------------------------

    def deletes(self) -> list[float]:
        return [at for method, _, at in self.engine_log if method == "DELETE"]


def config(**changes: Any) -> Config:
    return Config(password=PASSWORD, **changes)


def run(world: World, **changes: Any) -> dict[str, Any]:
    gateway = httpx.Client(base_url="http://web:8080", transport=httpx.MockTransport(world.gateway))
    engine = httpx.Client(base_url=ENDPOINT, transport=httpx.MockTransport(world.engine))
    with gateway, engine:
        return Probe(
            config(**changes),
            gateway,
            engine,
            world.attempts,
            package=lambda: b"package",
            sleep=world.sleep,
            clock=world.clock,
        ).run()


def checks(report: dict[str, Any]) -> dict[str, bool]:
    return {item["name"]: item["ok"] for item in report["checks"]}


# -- The classification ----------------------------------------------------------------------------------


def test_a_cancellation_that_reaches_the_solver_passes():
    world = World()

    report = run(world)

    assert report["classification"] == "passed" and report["ok"] is True and report["reason"] == ""
    assert all(checks(report).values()), report["checks"]
    assert set(checks(report)) >= {
        "the engine job is running when it is cancelled",
        "the job ends cancelled",
        "the cancellation reached the solver before it finished",
        "the attempt row is sent (the engine confirmed the DELETE)",
        "the engine reports that id as cancelled",
        "a DELETE of the engine job answers 200 cancelled",
        "a second DELETE is idempotent (same 200 cancelled)",
    }
    assert report["job"] == {"id": JOB, "engineJobId": ENGINE_JOB, "attempt": 1, "cancelState": "sent"}
    assert report["findings"] == [] and report["cleanup"] == {}


def test_the_probe_asks_the_engine_by_the_id_of_the_row_not_by_the_gateways_job_id():
    world = World()

    run(world)

    assert world.engine_log and all(path == ENGINE_PATH for _, path, _ in world.engine_log)
    assert JOB not in "".join(path for _, path, _ in world.engine_log)


def test_the_probe_never_deletes_before_the_gateway_did_and_deletes_twice_to_check_idempotence():
    world = World()

    run(world)

    assert world.gateway_deleted_at is not None
    assert len(world.deletes()) == 2
    assert all(at >= world.gateway_deleted_at for at in world.deletes())  # it never causes the cancellation it checks


def test_a_job_that_stays_running_while_the_engine_solves_fails_and_the_engine_is_cleaned_up_afterwards():
    world = World(propagates=False)

    report = run(world, cancel_timeout_s=30.0)

    assert report["classification"] == "failed" and report["ok"] is False
    assert checks(report)["the job ends cancelled"] is False
    assert any("did not reach the solver" in item for item in report["findings"])
    assert report["cleanup"] == {"engineDelete": 200}  # freed afterwards...
    assert len(world.deletes()) == 1  # ...by exactly one DELETE, and not counted as a check
    assert "a DELETE of the engine job answers 200 cancelled" not in checks(report)
    assert report["timeline"]["gave-up-waiting-for-the-job"] >= 30


def test_an_engine_that_finishes_by_itself_and_a_job_cancelled_only_afterwards_fails():
    world = World(propagates=False, engine_done_after_cancel=30.0)

    report = run(world)

    assert report["classification"] == "failed"
    assert checks(report)["the job ends cancelled"] is True  # the gateway did cancel it...
    assert checks(report)["the cancellation reached the solver before it finished"] is False  # ...too late
    assert checks(report)["the engine reports that id as cancelled"] is False
    assert any("finished by itself" in item for item in report["findings"])


def test_an_engine_that_finished_before_the_cancel_is_inconclusive_and_the_job_is_still_cancelled():
    world = World(engine_done_at=3.0)

    report = run(world)

    assert report["classification"] == "inconclusive" and report["ok"] is False
    assert "already completed" in report["reason"]
    assert world.cancel_at is not None  # the cleanup frees the job's slot
    assert report["cleanup"].get("jobCancel") == 200


def test_an_engine_that_ends_within_the_race_window_of_the_cancel_is_inconclusive():
    world = World(propagates=False, engine_done_after_cancel=1.0)

    report = run(world, cancel_timeout_s=20.0)

    assert report["classification"] == "inconclusive"
    assert "inside the 3 s window" in report["reason"]


def test_a_job_that_ends_in_another_state_than_cancelled_fails():
    world = World(job_final="completed", propagates=False)

    report = run(world, cancel_timeout_s=20.0)

    assert report["classification"] == "failed"
    assert checks(report)["the job ends cancelled"] is False
    assert report["cleanup"] == {"engineDelete": 200}  # the engine was still solving


def test_a_job_failed_because_the_engine_never_confirmed_the_stop_is_reported_as_such():
    # the gateway does not call the job cancelled while the solver may be alive: it fails it honestly
    world = World(job_final="failed", propagates=False)

    report = run(world, cancel_timeout_s=20.0)

    assert report["classification"] == "failed"
    assert checks(report)["the job ends cancelled"] is False
    assert any("did not confirm the stop" in item for item in report["findings"])
    assert report["cleanup"] == {"engineDelete": 200}  # and the probe frees the engine afterwards


@pytest.mark.parametrize("final", ["failed", "pending", "skipped"])
def test_an_attempt_row_that_is_not_sent_fails(final):
    world = World(row_final=final)

    report = run(world, settle_timeout_s=10.0)

    assert report["classification"] == "failed"
    assert checks(report)["the attempt row is sent (the engine confirmed the DELETE)"] is False
    assert report["job"]["cancelState"] == final


def test_a_second_delete_that_is_not_the_same_answer_fails():
    world = World(second_delete_status=404)

    report = run(world)

    assert report["classification"] == "failed"
    assert checks(report)["a DELETE of the engine job answers 200 cancelled"] is True
    assert checks(report)["a second DELETE is idempotent (same 200 cancelled)"] is False


# -- What the probe will not conclude --------------------------------------------------------------------


def test_without_access_to_the_attempts_the_probe_is_inconclusive_and_asks_the_engine_nothing():
    world = World(attempts_error="no DATABASE_URL is configured")

    report = run(world)

    assert report["classification"] == "inconclusive"
    assert "job_engine_attempts cannot be read" in report["reason"] and "no DATABASE_URL" in report["reason"]
    assert world.engine_log == []  # no id: nothing to ask, nothing guessed
    assert report["cleanup"].get("jobCancel") == 200


@pytest.mark.parametrize(
    ("changes", "needle"),
    [
        ({"login_status": 401}, "login of lab-owner failed"),
        ({"upload_status": 422}, "not accepted as a snapshot"),
        ({"launch_status": 422}, "job was not accepted (422 binding_space_too_large)"),
        ({"launch_status": 503}, "blocked by the remote"),
    ],
)
def test_a_job_that_cannot_be_set_up_is_inconclusive(changes, needle):
    world = World(**changes)

    report = run(world)

    assert report["classification"] == "inconclusive" and needle in report["reason"]
    assert report["checks"] == [] and world.engine_log == []


def test_a_job_that_never_starts_running_is_inconclusive():
    world = World(running_at=100.0)

    report = run(world, running_timeout_s=5.0)

    assert report["classification"] == "inconclusive"
    assert "did not start running" in report["reason"]
    assert world.engine_log == [] and report["cleanup"].get("jobCancel") == 200


def test_a_cancel_refused_by_the_gateway_is_inconclusive():
    world = World(cancel_status=403)

    report = run(world)

    assert report["classification"] == "inconclusive"
    assert checks(report)["the gateway accepts the cancellation (POST /v1/jobs/{id}/cancel)"] is False


def test_an_engine_that_does_not_know_the_recorded_id_is_inconclusive():
    world = World()
    real = world.attempts

    def wrong_id(job_id: str) -> list[dict[str, Any]]:
        return [{**row, "engineJobId": "someone-elses"} for row in real(job_id)]

    gateway = httpx.Client(base_url="http://web:8080", transport=httpx.MockTransport(world.gateway))
    engine = httpx.Client(base_url=ENDPOINT, transport=httpx.MockTransport(world.engine))
    with gateway, engine:
        report = Probe(
            config(), gateway, engine, wrong_id, package=lambda: b"p", sleep=world.sleep, clock=world.clock
        ).run()

    assert report["classification"] == "inconclusive" and "404" in report["reason"]


def test_an_attempt_that_used_another_engine_than_the_one_asked_fails_a_check():
    world = World()

    report = run(world, engine_url="http://engine-elsewhere:3000")

    assert checks(report)["the attempt used the engine the probe asks"] is False
    assert report["classification"] == "failed"


# -- The engine's answers ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (200, {"status": "queued"}, "running"),
        (200, {"status": "running"}, "running"),
        (200, {"status": "completed"}, "completed"),
        (200, {"status": "failed", "error": "cancelled: by request"}, "cancelled"),
        (200, {"status": "failed", "error": "minizinc exited with 1"}, "failed"),
        (200, {"status": "weird"}, "unknown"),
        (404, {"status": 404}, "gone"),
        (500, {}, "unknown"),
    ],
)
def test_the_phase_of_an_engine_job(status, body, expected):
    assert engine_phase(httpx.Response(status, json=body)) == expected


# -- The package ------------------------------------------------------------------------------------------


def test_the_hard_package_is_the_150_by_30_knapsack_of_the_engine_harness():
    data = cancel_probe.hard_package_zip()

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())
        catalog = json.loads(archive.read("candidates.json"))
        application = json.loads(archive.read("application.json"))

    assert {"instance.json", "application.json", "candidates.json", "limits.json", "optimization.json"} <= names
    assert len(application["spec"]["tasks"]) == 150
    assert len(catalog["spec"]["candidates"]) == 150 * 30


# -- The command line --------------------------------------------------------------------------------------


def main_with(world: World, argv: list[str], environ: dict[str, str]) -> int:
    return cancel_probe.main(
        argv,
        environ,
        gateway_transport=httpx.MockTransport(world.gateway),
        engine_transport=httpx.MockTransport(world.engine),
        attempts=world.attempts,
        package=lambda: b"package",
        sleep=world.sleep,
        clock=world.clock,
    )


def test_main_prints_one_json_document_without_secrets_and_exits_0_when_passed(capsys):
    world = World()

    code = main_with(world, [], {"DEMO_SEED_PASSWORD": PASSWORD, "SMOKE_BASE_URL": "http://web:8080/"})

    out = capsys.readouterr().out
    report = json.loads(out)
    assert code == 0 and report["classification"] == "passed" and report["tool"] == "cancel_probe"
    assert PASSWORD not in out and TOKEN not in out


@pytest.mark.parametrize(
    ("world", "argv", "code", "classification"),
    [
        (World(propagates=False), ["--cancel-timeout", "10"], 1, "failed"),
        (World(engine_done_at=3.0), [], 3, "inconclusive"),
    ],
)
def test_main_exits_nonzero_unless_the_cancellation_was_verified(capsys, world, argv, code, classification):
    assert main_with(world, argv, {"DEMO_SEED_PASSWORD": PASSWORD}) == code
    assert json.loads(capsys.readouterr().out)["classification"] == classification


def test_main_needs_the_seed_password_and_touches_nothing_without_it(capsys):
    world = World()

    code = main_with(world, [], {})

    assert code == 2
    assert "DEMO_SEED_PASSWORD is required" in capsys.readouterr().out
    assert world.gateway_log == [] and world.engine_log == []


def test_main_reads_the_engine_and_the_proxy_from_the_environment(capsys):
    world = World()
    seen: list[str] = []

    def spy(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return world.engine(request)

    code = cancel_probe.main(
        [],
        {"DEMO_SEED_PASSWORD": PASSWORD, "ENGINE_MINIZINC_URL": ENDPOINT + "/"},
        gateway_transport=httpx.MockTransport(world.gateway),
        engine_transport=httpx.MockTransport(spy),
        attempts=world.attempts,
        package=lambda: b"package",
        sleep=world.sleep,
        clock=world.clock,
    )

    assert code == 0 and seen and all(url.startswith(ENDPOINT + "/internal/v1/jobs/") for url in seen)
    assert json.loads(capsys.readouterr().out)["engine"]["url"] == ENDPOINT


def test_main_refuses_a_non_positive_size(capsys):
    assert main_with(World(), ["--tasks", "0"], {"DEMO_SEED_PASSWORD": PASSWORD}) == 2
