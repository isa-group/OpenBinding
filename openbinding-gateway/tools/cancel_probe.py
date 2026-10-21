#!/usr/bin/env python3
"""End-to-end probe of the remote cancellation of a user's job on the bundled ``minizinc-csp`` engine (lab).

It does what a user does and then looks where only the laboratory can look. As the synthetic ``lab-owner`` of
``tools/seed_lab.py`` it signs in through the proxy, uploads a deliberately hard package (the one of
``tools/engine_e2e.py``: 150 tasks x 30 candidates) and launches a LONG ``minizinc-csp`` job over the gateway's
HTTP API, exactly as ``tools/smoke_lab.py`` does. When the job is running and the engine id of its attempt has been
recorded (``job_engine_attempts``) it cancels the job (``POST /v1/jobs/{id}/cancel``) and checks, in this order:

1. the job ends ``cancelled``, and the cancellation reached the solver while it was still working (an engine
   that finished by itself before the gateway sent the ``DELETE`` is a failure, not a pass);
2. the row of ``job_engine_attempts`` of that attempt is ``sent`` (the engine confirmed with 200/204);
3. the engine itself, asked directly (``GET <engine>/internal/v1/jobs/{id}`` with the id of that row), reports THAT
   id as cancelled (``failed`` with an error starting ``cancelled:``);
4. a ``DELETE`` sent by the probe answers 200 ``cancelled`` and a second one answers the same (idempotent).

The probe sends its own ``DELETE`` only after it has read what the gateway left, so it can never be the reason the
engine job is cancelled. A job that still runs when the probe gives up is cancelled at the engine afterwards, to
free the CPU (``cleanup`` in the report); that does not turn a failure into a pass.

The engine id is not exposed by any gateway route, so the row is read from the database with the gateway's own
models (``DATABASE_URL`` of the ``seed`` service). Where that cannot be done the probe says so and is
``inconclusive``: it never guesses.

Output: ONE JSON document on stdout, ``{"tool", "ok", "classification", "reason", "job", "checks": [{name, ok,
detail}], "findings", "timeline", "cleanup"}``. ``classification`` is one of

    passed        every check held
    failed        the cancellation did not work as it must (see ``checks`` and ``findings``)
    inconclusive  the experiment could not be set up or did not stay valid (the solver finished before the cancel,
                  the job was refused, the id could not be read, ...); nothing is claimed about cancellation

Exit code: 0 passed, 1 failed, 2 configuration error, 3 inconclusive. Nothing secret is printed.

Environment (the ``seed`` service passes it; nothing is specific to this tool):
    DEMO_SEED_PASSWORD   required; the password the seed gave every synthetic user.
    SMOKE_BASE_URL       the proxy, default http://web:8080.
    ENGINE_MINIZINC_URL  the engine as the gateway reaches it, default http://engine-minizinc:3000
                         (``compose.lab-process.json``, ``Settings.engine_minizinc_url``).
    DATABASE_URL         the gateway's database, to read ``job_engine_attempts``.
    CANCEL_PROBE_ENGINE_TOKEN  optional bearer token for an engine that requires one (the lab's does not).

Usage (inside the gateway image, as ``lab_compose seed`` runs it, see docs/qa/ENGINE_CANCELLATION_E2E.md):
    DEMO_SEED_TOOL=cancel_probe.py DEMO_SEED_ARGS= lab_compose seed
    python tools/cancel_probe.py [--time-budget-ms 600000] [--cancel-timeout 90] [--tasks 150 --candidates 30]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from smoke_lab import BIM_ZIP, OPTIMIZATION, TERMINAL, Redactor, body_of, describe, mapping, pricing_block

TOOL = "cancel_probe"
EXIT_PASSED, EXIT_FAILED, EXIT_CONFIG, EXIT_INCONCLUSIVE = 0, 1, 2, 3

ENGINE = "minizinc-csp"
MODE = "exact-weighted"
USER = "lab-owner"
DEFAULT_BASE_URL = "http://web:8080"
DEFAULT_ENGINE_URL = "http://engine-minizinc:3000"
JOB_PATH = "/internal/v1/jobs/{id}"

PASSED, FAILED, INCONCLUSIVE = "passed", "failed", "inconclusive"
#: ``job_engine_attempts.cancel_state`` values that end a cancellation.
SETTLED_ROW_STATES = frozenset({"sent", "skipped"})
DETAIL_MAX = 400


class Inconclusive(Exception):
    """The experiment cannot say anything about cancellation; the message is the reason."""


class AttemptsUnavailable(Exception):
    """``job_engine_attempts`` cannot be read here."""


# --------------------------------------------------------------------------
# The package, the database
# --------------------------------------------------------------------------


def hard_package_zip(tasks: int = 150, candidates: int = 30) -> bytes:
    """The multiple-choice knapsack of ``engine_e2e.hard_files`` as the ``.bim.zip`` the gateway stores."""
    from bim_core import InstancePackage
    from engine_e2e import hard_files

    return InstancePackage(hard_files(tasks, candidates)).to_zip()


def read_attempts_from_database(job_id: str) -> list[dict[str, Any]]:
    """The rows of ``job_engine_attempts`` of a job, with the gateway's own models and settings."""

    async def read() -> list[dict[str, Any]]:
        from sqlalchemy import select

        from openbinding_gateway.core.settings import get_settings
        from openbinding_gateway.db import base as db_base
        from openbinding_gateway.db.models import JobEngineAttempt

        url = get_settings().database_url or os.environ.get("DATABASE_URL")
        if not url:
            raise AttemptsUnavailable("no DATABASE_URL is configured")
        db_base.init_engine(url)
        try:
            async with db_base.session_factory()() as session:
                rows = (
                    await session.execute(
                        select(
                            JobEngineAttempt.attempt,
                            JobEngineAttempt.engine_job_id,
                            JobEngineAttempt.endpoint,
                            JobEngineAttempt.cancel_state,
                            JobEngineAttempt.cancel_attempts,
                        )
                        .where(JobEngineAttempt.job_id == uuid.UUID(job_id))
                        .order_by(JobEngineAttempt.attempt)
                    )
                ).all()
        finally:
            await db_base.dispose_engine()
        return [
            {
                "attempt": row.attempt,
                "engineJobId": row.engine_job_id,
                "endpoint": row.endpoint,
                "cancelState": row.cancel_state,
                "cancelAttempts": row.cancel_attempts,
            }
            for row in rows
        ]

    try:
        return asyncio.run(read())
    except AttemptsUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - one line for the report, never a traceback with a URL in it
        raise AttemptsUnavailable(f"{type(exc).__name__}: {str(exc)[:160]}") from exc


# --------------------------------------------------------------------------
# The probe
# --------------------------------------------------------------------------


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    password: str = ""
    user: str = USER
    engine_url: str = DEFAULT_ENGINE_URL
    engine_token: str | None = None
    tasks: int = 150
    candidates: int = 30
    #: What the engine may work on the job: far longer than the probe waits.
    time_budget_ms: int = 600_000
    #: Seconds to wait for the job to run and for its engine id to be recorded.
    running_timeout_s: float = 120.0
    #: Seconds the job has to become ``cancelled`` after the cancel.
    cancel_timeout_s: float = 90.0
    #: Seconds, once the job is cancelled, for the gateway's ``DELETE`` to be confirmed and recorded.
    settle_timeout_s: float = 60.0
    #: An engine that finishes by itself within this many seconds of the cancel proves nothing either way.
    race_window_s: float = 3.0
    poll_interval_s: float = 1.0
    request_timeout_s: float = 60.0


AttemptReader = Callable[[str], list[dict[str, Any]]]


def engine_phase(reply: httpx.Response) -> str:
    """What an engine's ``GET`` of a job says: running, completed, cancelled, failed (by itself), gone or unknown."""
    if reply.status_code == 404:
        return "gone"
    body = mapping(body_of(reply))
    if reply.status_code != 200:
        return "unknown"
    status = body.get("status")
    if status in ("queued", "running"):
        return "running"
    if status == "completed":
        return "completed"
    if status == "failed":
        return "cancelled" if str(body.get("error", "")).startswith("cancelled:") else "failed"
    return "unknown"


class Probe:
    def __init__(
        self,
        config: Config,
        gateway: httpx.Client,
        engine: httpx.Client,
        attempts: AttemptReader,
        *,
        package: Callable[[], bytes] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        redact: Redactor | None = None,
    ) -> None:
        self.config = config
        self.gateway = gateway
        self.engine = engine
        self.attempts = attempts
        self.package = package or (lambda: hard_package_zip(config.tasks, config.candidates))
        self.sleep = sleep
        self.clock = clock
        self.redact = redact or Redactor([config.password])
        self.token: str | None = None
        self.job_id: str | None = None
        self.attempt: dict[str, Any] | None = None
        self.engine_id: str | None = None
        self.engine_base: str = config.engine_url.rstrip("/")
        self.cancel_requested = False
        self.engine_phase_seen = "unknown"
        self.checks: list[dict[str, Any]] = []
        self.findings: list[str] = []
        self.timeline: dict[str, float] = {}
        self.cleanup: dict[str, Any] = {}
        self.reason = ""
        self.started = clock()

    # -- bookkeeping --------------------------------------------------------

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": self.redact(detail)[:DETAIL_MAX]})
        return bool(ok)

    def mark(self, label: str) -> None:
        self.timeline[label] = round(self.clock() - self.started, 1)

    def wait_until(self, predicate: Callable[[], Any], timeout_s: float) -> Any:
        """The first truthy value of ``predicate``, polled every ``poll_interval_s``; the last falsy one on timeout."""
        deadline = self.clock() + timeout_s
        while True:
            value = predicate()
            if value:
                return value
            if self.clock() >= deadline:
                return value
            self.sleep(self.config.poll_interval_s)

    # -- the two services ---------------------------------------------------

    def api(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}))
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        kwargs.setdefault("timeout", self.config.request_timeout_s)
        reply = self.gateway.request(method, f"/api{path}", headers=headers, **kwargs)
        blocked = pricing_block(reply)
        if blocked:
            raise Inconclusive(f"blocked by the remote (SPACE), not by the gateway: {blocked}")
        return reply

    def gateway_job(self) -> Mapping[str, Any]:
        reply = self.api("GET", f"/v1/jobs/{self.job_id}")
        if reply.status_code != 200:
            raise Inconclusive(f"GET /v1/jobs/{{id}} answered {describe(reply)}")
        return mapping(body_of(reply))

    def engine_job(self) -> httpx.Response:
        return self.engine.get(JOB_PATH.replace("{id}", str(self.engine_id)))

    def engine_delete(self) -> httpx.Response:
        """The ``DELETE`` the gateway sends: a JSON content-type and no body."""
        return self.engine.request(
            "DELETE", JOB_PATH.replace("{id}", str(self.engine_id)), headers={"content-type": "application/json"}
        )

    def rows(self) -> list[dict[str, Any]]:
        try:
            return self.attempts(str(self.job_id))
        except AttemptsUnavailable as exc:
            raise Inconclusive(
                f"job_engine_attempts cannot be read ({exc}); without the engine id the engine cannot be asked about it"
            ) from exc

    # -- the experiment -----------------------------------------------------

    def run(self) -> dict[str, Any]:
        try:
            self.setup()
            self.wait_running()
            self.wait_registered()
            self.engine_is_running()
            self.cancel()
            self.observe()
        except Inconclusive as exc:
            self.reason = str(exc)
        except httpx.HTTPError as exc:
            self.reason = f"{type(exc).__name__} talking to a service: {str(exc)[:160]}"
        except Exception as exc:  # noqa: BLE001 - the report is the output; a traceback could echo a credential
            self.reason = f"unexpected {type(exc).__name__}: {str(exc)[:160]}"
        finally:
            self.clean_up()
        return self.report()

    def setup(self) -> None:
        login = self.gateway.post(
            "/api/v1/auth/login",
            json={"username_or_email": self.config.user, "password": self.config.password},
            timeout=self.config.request_timeout_s,
        )
        token = mapping(body_of(login)).get("access_token")
        if login.status_code != 200 or not isinstance(token, str) or not token:
            raise Inconclusive(f"login of {self.config.user} failed ({describe(login)}); was the lab seeded?")
        self.token = token
        self.redact.add(token)

        upload = self.api("POST", "/v1/instances", headers={"Content-Type": BIM_ZIP}, content=self.package())
        snapshot = mapping(body_of(upload)).get("id")
        if upload.status_code not in (200, 201) or not isinstance(snapshot, str):
            raise Inconclusive(f"the hard package was not accepted as a snapshot ({describe(upload)})")

        launch = self.api(
            "POST",
            "/v1/jobs",
            headers={"Idempotency-Key": f"cancel-probe-{uuid.uuid4().hex[:12]}"},
            json={
                "snapshot": snapshot,
                "engine": ENGINE,
                "mode": MODE,
                "optimization": dict(OPTIMIZATION),
                "options": {"time_budget_ms": self.config.time_budget_ms},
            },
        )
        job_id = mapping(body_of(launch)).get("id")
        if launch.status_code != 202 or not isinstance(job_id, str):
            raise Inconclusive(f"the {ENGINE} job was not accepted ({describe(launch)})")
        self.job_id = job_id
        self.mark("launched")

    def wait_running(self) -> None:
        def running() -> str | None:
            status = self.gateway_job().get("status")
            if status == "running":
                return "running"
            if status in TERMINAL:
                raise Inconclusive(f"the job is {status} before it was ever seen running (nothing to cancel)")
            return None

        if not self.wait_until(running, self.config.running_timeout_s):
            raise Inconclusive(f"the job did not start running within {self.config.running_timeout_s:.0f} s")
        self.mark("running")

    def wait_registered(self) -> None:
        def registered() -> list[dict[str, Any]]:
            if self.gateway_job().get("status") in TERMINAL:
                raise Inconclusive("the job ended before the engine id of its attempt was recorded")
            return self.rows()

        rows = self.wait_until(registered, self.config.running_timeout_s)
        if not rows:
            raise Inconclusive(
                f"no engine id was recorded for the running job within {self.config.running_timeout_s:.0f} s "
                "(is the engine asynchronous?)"
            )
        self.attempt = rows[-1]
        self.engine_id = str(self.attempt["engineJobId"])
        if len(rows) > 1:
            self.findings.append(f"the job already has {len(rows)} attempts; the probe follows the last one")
        recorded = str(self.attempt["endpoint"]).rstrip("/")
        self.check(
            "the attempt used the engine the probe asks",
            recorded == self.engine_base,
            f"the attempt used {recorded}, the probe asks {self.engine_base}",
        )
        self.mark("registered")

    def engine_is_running(self) -> None:
        reply = self.engine_job()
        if reply.status_code in (401, 403):
            raise Inconclusive(f"the engine refuses the probe ({reply.status_code}); set CANCEL_PROBE_ENGINE_TOKEN")
        phase = engine_phase(reply)
        self.engine_phase_seen = phase
        if phase == "gone":
            self.check("the engine knows the id the gateway recorded", False, f"{reply.status_code} for {self.engine_id}")
            raise Inconclusive("the engine answers 404 for the id the gateway recorded; nothing to cancel")
        if phase != "running":
            raise Inconclusive(
                f"the engine job is already {phase} before the cancel (the solve finished first); "
                "use a harder package or a larger --time-budget-ms"
            )
        self.check("the engine job is running when it is cancelled", True, f"id {self.engine_id}")

    def cancel(self) -> None:
        reply = self.api("POST", f"/v1/jobs/{self.job_id}/cancel")
        if reply.status_code == 409:
            raise Inconclusive(f"the job was already terminal when it was cancelled ({describe(reply)})")
        self.cancel_requested = reply.status_code == 200
        self.check("the gateway accepts the cancellation (POST /v1/jobs/{id}/cancel)", reply.status_code == 200, describe(reply))
        self.mark("cancel-requested")
        if reply.status_code != 200:
            raise Inconclusive("the cancellation was refused; nothing more can be said")

    def observe(self) -> None:
        cancelled_at = self.clock()
        engine_done_at: float | None = None
        status = "running"

        def settled() -> str | None:
            nonlocal engine_done_at, status
            status = str(self.gateway_job().get("status"))
            phase = engine_phase(self.engine_job())
            self.engine_phase_seen = phase
            if phase in ("completed", "failed") and engine_done_at is None:
                engine_done_at = self.clock()
            return status if status in TERMINAL else None

        ended = self.wait_until(settled, self.config.cancel_timeout_s)
        self.mark("job-ended" if ended else "gave-up-waiting-for-the-job")
        if engine_done_at is not None and engine_done_at - cancelled_at <= self.config.race_window_s:
            raise Inconclusive(
                f"the engine finished by itself {engine_done_at - cancelled_at:.1f} s after the cancel, inside the "
                f"{self.config.race_window_s:.0f} s window in which it cannot be told from a cancellation"
            )
        if not ended:
            self.not_propagated(status)
            return
        if not self.check("the job ends cancelled", ended == "cancelled", f"the job ended {ended}"):
            if ended == "failed":
                self.findings.append(
                    "the job ended failed, not cancelled: the engine did not confirm the stop within the worker's "
                    "deadline, and the gateway does not call a job cancelled while the solver may still be alive "
                    "(the cancellation stays open for the reconciler); look at the engine job below"
                )
                self.engine_phase_seen = engine_phase(self.engine_job())
            return

        # The gateway has cancelled the job; now the engine side. The DELETE is sent after the job is terminal.
        def confirmed() -> list[dict[str, Any]] | None:
            rows = self.rows()
            row = rows[-1] if rows else None
            phase = engine_phase(self.engine_job())
            self.engine_phase_seen = phase
            if row and row["cancelState"] in SETTLED_ROW_STATES and phase != "running":
                return rows
            return None

        rows = self.wait_until(confirmed, self.config.settle_timeout_s)
        self.mark("settled" if rows else "gave-up-waiting-for-the-delete")
        rows = rows or self.rows()
        self.attempt = rows[-1] if rows else self.attempt
        state = self.attempt["cancelState"] if self.attempt else "missing"
        phase = self.engine_phase_seen

        finished_alone = engine_done_at is not None or phase in ("completed", "failed")
        if finished_alone:
            after = f" {engine_done_at - cancelled_at:.0f} s after the cancel" if engine_done_at is not None else ""
            self.findings.append(
                f"the engine finished by itself ({phase}){after}: the job only became cancelled once the solve "
                "returned, so the DELETE came too late to stop anything"
            )
        self.check(
            "the cancellation reached the solver before it finished",
            not finished_alone,
            f"the engine job is {phase}, not cancelled, when the gateway's DELETE arrives" if finished_alone else "",
        )
        self.check(
            "the attempt row is sent (the engine confirmed the DELETE)",
            state == "sent",
            f"cancel_state={state} cancel_attempts={self.attempt['cancelAttempts'] if self.attempt else '?'}",
        )
        self.check(
            "the engine reports that id as cancelled",
            phase == "cancelled",
            f"engine job {self.engine_id} reads {phase}",
        )
        if state in ("pending", "failed", "none"):
            self.findings.append(
                f"the attempt row is still {state}: the DELETE was not confirmed (a 202 is retried by the reconciler's "
                "sweep, which resolves the built-in registration; look at the gateway log for the reason)"
            )
        self.engine_deletes()

    def not_propagated(self, status: str) -> None:
        view = self.gateway_job()
        requested = view.get("cancellation_requested", view.get("cancellationRequested"))
        self.check(
            "the job ends cancelled",
            False,
            f"{self.config.cancel_timeout_s:.0f} s after the cancel the job is still {status} "
            f"(cancellationRequested={requested}) and the engine job is {self.engine_phase_seen}",
        )
        if self.engine_phase_seen == "running":
            self.findings.append(
                "the cancellation did not reach the solver: the job stays running with cancellationRequested set "
                "and the engine keeps solving; the worker is meant to see the request between two polls of the "
                "engine (REMOTE_CANCEL_WATCH_INTERVAL_S) and send the DELETE: check that the registration "
                "declares cancellation (extensions.cancellation + DELETE in its OpenAPI) and the worker's log"
            )
        row = (self.rows() or [None])[-1]
        if row:
            self.attempt = row

    def engine_deletes(self) -> None:
        first, second = self.engine_delete(), self.engine_delete()
        expected = {"id": self.engine_id, "status": "cancelled"}
        self.check(
            "a DELETE of the engine job answers 200 cancelled",
            first.status_code == 200 and mapping(body_of(first)) == expected,
            f"{first.status_code} {first.text[:120]}",
        )
        self.check(
            "a second DELETE is idempotent (same 200 cancelled)",
            second.status_code == 200 and mapping(body_of(second)) == mapping(body_of(first)),
            f"{second.status_code} {second.text[:120]}",
        )

    def clean_up(self) -> None:
        """Leave nothing running: the job's slot and the engine's CPU. Never part of the verdict."""
        if self.job_id is not None and self.token is not None:
            try:
                if not self.cancel_requested:
                    reply = self.api("POST", f"/v1/jobs/{self.job_id}/cancel")
                    self.cleanup["jobCancel"] = reply.status_code
            except (Inconclusive, httpx.HTTPError) as exc:
                self.cleanup["jobCancel"] = f"{type(exc).__name__}"
        if self.engine_id is not None and self.engine_phase_seen in ("running", "unknown"):
            try:
                reply = self.engine_delete()
                self.cleanup["engineDelete"] = reply.status_code
            except httpx.HTTPError as exc:
                self.cleanup["engineDelete"] = f"{type(exc).__name__}"

    # -- the verdict ----------------------------------------------------------

    def classification(self) -> str:
        if self.reason:
            return INCONCLUSIVE
        if any(not item["ok"] for item in self.checks) or not self.checks:
            return FAILED
        return PASSED

    def report(self) -> dict[str, Any]:
        classification = self.classification()
        self.mark("end")
        return {
            "tool": TOOL,
            "ok": classification == PASSED,
            "classification": classification,
            "reason": self.redact(self.reason),
            "baseUrl": self.config.base_url,
            "engine": {"name": ENGINE, "mode": MODE, "url": self.engine_base},
            "job": {
                "id": self.job_id,
                "engineJobId": self.engine_id,
                "attempt": self.attempt["attempt"] if self.attempt else None,
                "cancelState": self.attempt["cancelState"] if self.attempt else None,
            },
            "checks": self.checks,
            "findings": self.findings,
            "timeline": self.timeline,
            "cleanup": self.cleanup,
        }


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------

EXIT_CODES = {PASSED: EXIT_PASSED, FAILED: EXIT_FAILED, INCONCLUSIVE: EXIT_INCONCLUSIVE}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Remote cancellation of a user's job on minizinc-csp, end to end (lab).")
    parser.add_argument("--base-url", default=None, help=f"proxy origin (default $SMOKE_BASE_URL or {DEFAULT_BASE_URL})")
    parser.add_argument("--engine-url", default=None, help=f"the engine (default $ENGINE_MINIZINC_URL or {DEFAULT_ENGINE_URL})")
    parser.add_argument("--user", default=USER, help="synthetic user that owns the job")
    parser.add_argument("--tasks", type=int, default=150, help="tasks of the hard package")
    parser.add_argument("--candidates", type=int, default=30, help="candidates per task of the hard package")
    parser.add_argument("--time-budget-ms", type=int, default=600_000, help="what the engine may spend on the job")
    parser.add_argument("--running-timeout", type=float, default=120.0, help="seconds for the job to run and register its id")
    parser.add_argument("--cancel-timeout", type=float, default=90.0, help="seconds for the job to end after the cancel")
    parser.add_argument("--settle-timeout", type=float, default=60.0, help="seconds for the DELETE to be confirmed and recorded")
    parser.add_argument("--race-window", type=float, default=3.0, help="seconds of the cancel inside which an engine that ends is inconclusive")
    return parser


def main(
    argv: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    *,
    gateway_transport: httpx.BaseTransport | None = None,
    engine_transport: httpx.BaseTransport | None = None,
    attempts: AttemptReader = read_attempts_from_database,
    package: Callable[[], bytes] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    args = build_parser().parse_args(argv)
    source = os.environ if environ is None else environ
    password = source.get("DEMO_SEED_PASSWORD", "")
    if not password:
        print(json.dumps({"tool": TOOL, "ok": False, "classification": "config", "error": "DEMO_SEED_PASSWORD is required"}))
        return EXIT_CONFIG
    if min(args.tasks, args.candidates, args.time_budget_ms) < 1:
        print(json.dumps({"tool": TOOL, "ok": False, "classification": "config", "error": "sizes and budgets must be positive"}))
        return EXIT_CONFIG
    token = source.get("CANCEL_PROBE_ENGINE_TOKEN") or None
    config = Config(
        base_url=(args.base_url or source.get("SMOKE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        password=password,
        user=args.user,
        engine_url=(args.engine_url or source.get("ENGINE_MINIZINC_URL") or DEFAULT_ENGINE_URL).rstrip("/"),
        engine_token=token,
        tasks=args.tasks,
        candidates=args.candidates,
        time_budget_ms=args.time_budget_ms,
        running_timeout_s=args.running_timeout,
        cancel_timeout_s=args.cancel_timeout,
        settle_timeout_s=args.settle_timeout,
        race_window_s=args.race_window,
    )
    redact = Redactor([password, token or ""])
    engine_headers = {"accept": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}
    with (
        httpx.Client(base_url=config.base_url, transport=gateway_transport, follow_redirects=False, trust_env=False) as gateway,
        httpx.Client(
            base_url=config.engine_url, transport=engine_transport, headers=engine_headers, timeout=20.0, trust_env=False
        ) as engine,
    ):
        report = Probe(config, gateway, engine, attempts, package=package, sleep=sleep, clock=clock, redact=redact).run()
    print(redact(json.dumps(report, indent=2)))
    return EXIT_CODES[report["classification"]]


if __name__ == "__main__":
    sys.exit(main())
