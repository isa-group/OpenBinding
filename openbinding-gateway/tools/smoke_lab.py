#!/usr/bin/env python3
"""End-to-end API smoke test of the lab demo, run through the nginx proxy.

It talks only HTTP (httpx) to the ``web`` service, exactly as the browser does, and
logs in as the synthetic users that ``tools/seed_lab.py`` created. It never calls the
registration endpoint (registration creates a SPACE contract), never writes to
SPACE/SPHERE, and never prints a password, a token or a header.

Output: ONE JSON document on stdout, ``{"tool", "ok", "steps": [{name, ok, blockedByRemote, detail}], ...}``.
Exit code: 0 when every step that ran passed, 1 when any failed, 2 on a configuration error, 3 when nothing
failed but some steps were blocked by the remote.

A gateway that cannot read an account's entitlements answers ``503 pricing_unavailable`` (it fails closed). When
SPACE has no service or contract for the synthetic users that is not a defect of the gateway, so the step that
met it is reported ``ok: false, blockedByRemote: true`` with the reason, and the summary counts it under
``blocked`` (and ``blockedSteps``) instead of ``failed``. A step with a real failure is never reported as blocked.

Environment (the ``seed`` compose service passes the gateway's, so nothing is specific to this tool):
    DEMO_SEED_PASSWORD   required; the password the seed gave every synthetic user.
    SMOKE_BASE_URL       optional; default http://web:8080 (the proxy inside the lab network).

Steps (a failure never aborts the next one; 6-9 can be dropped with ``--skip``):
    1 proxy_and_spa     /healthz, SPA index, SPA fallback on a made-up deep route, /api/health/ready
    2 login             admin, owner, member, viewer and outsider sign in (Bearer tokens)
    3 owner_job         owner: profile, projects, a random-search job on the seeded package, result shape
    4 idempotency       same key + body -> same job; same key + other body -> 409; other account -> other job
    5 authorization     401 without token, the viewer/outsider/admin matrix (the viewer launches a personal job but cannot start a study run), redacted options for the viewer
    6 concurrency_limit 5 simultaneous launches -> a 429 with Retry-After, and the slot is freed afterwards
    7 cors              preflight allowed from the lab origin, refused from another origin
    8 body_limit        a JSON body over 16 MiB -> 413 problem+json
    9 login_throttle    12 failed logins of a made-up user -> 429 with Retry-After
   10 plan_usage        (--with-space) the owner's plan and capabilities, without usage counters

The login throttle counts per client address AND identifier (``authrl:login:id:<ip>:<hash>``) and, with a
10x larger budget, per address alone. Step 9 therefore uses an identifier no other step uses and runs last,
so the logins of the other steps are not the ones that get blocked; it still consumes part of the per-address
budget for the length of the window (300 s by default).

Usage:
    python tools/smoke_lab.py [--base-url URL] [--skip 6,7,8,9] [--with-space] [--job-timeout 120]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_BASE_URL = "http://web:8080"
EXIT_OK, EXIT_FAILED, EXIT_CONFIG, EXIT_BLOCKED = 0, 1, 2, 3

#: Synthetic users created by tools/seed_lab.py (name -> platform role).
USERS = {
    "admin": "lab-admin",
    "owner": "lab-owner",
    "member": "lab-member",
    "viewer": "lab-viewer",
    "outsider": "lab-outsider",
}
ADMIN_ROLE = "admin"
#: Never seeded, so the throttle step blocks nobody real.
THROTTLE_USER = "lab-throttle-probe"
THROTTLE_ATTEMPTS = 12
ORG, PROJECT, CASE = "lab-main", "bim-demo", "simple-seq"
EXAMPLE_PATH = "demo/01_simple_seq"
STUDY_SLUG = "smoke-lab"

TERMINAL = frozenset({"completed", "failed", "cancelled"})
TERMINATIONS = frozenset({"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"})
#: random-search has one mode; a job and every study engine must name it explicitly.
MODE = "seeded"
#: Execution-time selection a job must carry (the package's optimization.json only declares the criteria):
#: one criterion, weighted-sum without weights -> the toolchain fills in equal weights.
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
#: The smallest meaningful random-search budget.
MIN_OPTIONS = {"iterations": 10, "seed": 1}
#: Long enough to hold a slot while five launches race, short enough to end by itself.
SLOW_OPTIONS = {"iterations": 1_000_000, "seed": 1, "time_budget_ms": 20_000}
JSON_LIMIT_BYTES = 16 * 1024 * 1024
BIM_ZIP = "application/vnd.bim+zip"
DETAIL_MAX = 500

#: Code of the 503 the gateway answers when SPACE cannot tell what an account's plan allows.
PRICING_UNAVAILABLE = "pricing_unavailable"
BLOCKED_HINT = (
    "SPACE has no service/contract for the synthetic users; "
    "run seed_lab --space-contracts after remote_provision --apply"
)

#: Step number -> optional via --skip.
SKIPPABLE = (6, 7, 8, 9)
#: 9 last: it burns the per-address login budget.
RUN_ORDER = (1, 2, 3, 4, 5, 6, 7, 8, 10, 9)

#: Key words that make a name look like a credential or an address (as security/redaction.py).
SENSITIVE_WORDS = frozenset(
    {"auth", "authorization", "authentication", "credential", "credentials", "secret", "secrets",
     "password", "passwd", "token", "tokens", "bearer", "cookie", "cookies", "header", "headers",
     "private", "certificate", "endpoint", "url", "uri", "host", "signature", "session"}
)
REQUEST_KEYS = frozenset({"bindingProblem", "timeout", "mode", "optimization", "registration"})
REFERENCE_KEYS = frozenset({"namespace", "name", "version", "digest"})
USAGE_COUNTER_WORDS = ("used", "usage", "consumed", "consumption", "counter", "remaining", "spent")


# --------------------------------------------------------------------------
# Secrets never reach the output
# --------------------------------------------------------------------------


class Redactor:
    """Replaces every known secret and anything shaped like a token before text is printed."""

    _SHAPES = (
        re.compile(r"eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}"),
        re.compile(r"(?i)bearer\s+[\w.~+/=-]+"),
        re.compile(r"\bobk_[0-9a-f]{8}_[0-9a-f]+"),
    )

    def __init__(self, secrets: Sequence[str] = ()) -> None:
        self._secrets: set[str] = set()
        for secret in secrets:
            self.add(secret)

    def add(self, secret: str | None) -> None:
        if secret and len(secret) >= 4:
            self._secrets.add(secret)

    def __call__(self, text: object) -> str:
        value = str(text)
        for secret in sorted(self._secrets, key=len, reverse=True):
            value = value.replace(secret, "***")
        for shape in self._SHAPES:
            value = shape.sub("***", value)
        return value


# --------------------------------------------------------------------------
# Configuration, checks, HTTP helpers
# --------------------------------------------------------------------------


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    password: str = ""
    origin: str = "http://localhost:18100"
    evil_origin: str = "http://evil.example"
    job_timeout_s: float = 120.0
    poll_interval_s: float = 1.0
    request_timeout_s: float = 60.0
    max_concurrent: int = 3
    launches: int = 5
    skip: frozenset[int] = frozenset()
    with_space: bool = False


class StepError(Exception):
    """A step cannot continue (a prerequisite is missing); the message is the step's detail."""


class RemoteBlocked(Exception):
    """SPACE cannot say what the account may do, so the request cannot be judged; not a gateway defect."""

    def __init__(self, label: str, cause: str) -> None:
        super().__init__(label)
        self.label = label
        self.cause = cause


class Checks:
    """Named expectations of one step; the step passes when none failed and nothing was blocked."""

    def __init__(self) -> None:
        self.passed = 0
        self.failed: list[str] = []
        self.notes: list[str] = []
        self.blocked: list[str] = []
        self.cause = ""

    def expect(self, condition: object, label: str) -> bool:
        if condition:
            self.passed += 1
            return True
        self.failed.append(label)
        return False

    def note(self, text: str) -> None:
        self.notes.append(text)

    def block(self, label: str, cause: str) -> None:
        """Record a request that SPACE's missing contract kept from being judged (once per label)."""
        if label not in self.blocked:
            self.blocked.append(label)
        self.cause = self.cause or cause

    @property
    def ok(self) -> bool:
        return not self.failed and not self.blocked

    @property
    def blocked_by_remote(self) -> bool:
        """Blocked and nothing else wrong: a real failure keeps the step a failure."""
        return bool(self.blocked) and not self.failed

    def detail(self) -> str:
        notes = f" [{'; '.join(self.notes)}]" if self.notes else ""
        blocked = f"; also blocked by remote at {', '.join(self.blocked)}" if self.blocked else ""
        if self.failed:
            return f"FAILED {len(self.failed)}/{self.passed + len(self.failed)}: {'; '.join(self.failed)}{blocked}{notes}"
        if self.blocked:
            return (
                f"BLOCKED BY REMOTE: {BLOCKED_HINT}. Cause: {self.cause}. "
                f"Blocked at: {', '.join(self.blocked)}. {self.passed} checks passed{notes}"
            )
        return f"{self.passed} checks passed{notes}"


def body_of(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def code_of(response: httpx.Response) -> str:
    """The machine code of an error body (problem+json and the platform shape both carry ``code``)."""
    body = mapping(body_of(response))
    code = body.get("code")
    if not isinstance(code, str):
        code = mapping(body.get("detail")).get("code")
    return code if isinstance(code, str) else ""


def message_of(response: httpx.Response) -> str:
    """The human text of an error body (platform shape ``detail.error``, problem+json ``detail``)."""
    body = mapping(body_of(response))
    detail = body.get("detail")
    message = body.get("error") or mapping(detail).get("error") or (detail if isinstance(detail, str) else "")
    return message if isinstance(message, str) else ""


def pricing_block(response: httpx.Response) -> str | None:
    """Why the gateway could not read the entitlements (``503 pricing_unavailable``), else ``None``.

    The text cannot tell "SPACE has no contract for this account" from "SPACE is not reachable" (the
    gateway wraps both), so the server's message is carried along for whoever reads the report.
    """
    if response.status_code != 503 or code_of(response) != PRICING_UNAVAILABLE:
        return None
    return f"503 {PRICING_UNAVAILABLE}: {message_of(response)}"[:160]


def retry_after_of(response: httpx.Response) -> int | None:
    value = response.headers.get("retry-after", "")
    return int(value) if value.strip().isdigit() else None


def describe(response: httpx.Response) -> str:
    return f"{response.status_code} {code_of(response)}".strip()


def sensitive_name(name: str) -> bool:
    words = [word.lower() for word in re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", name)]
    joined = "".join(words)
    return bool(SENSITIVE_WORDS.intersection(words)) or "apikey" in joined or "privatekey" in joined


def sensitive_keys(value: Any, path: str = "") -> list[str]:
    """Paths of the keys under ``value`` whose names look like a credential or an address."""
    found: list[str] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            here = f"{path}.{key}" if path else str(key)
            if isinstance(key, str) and sensitive_name(key):
                found.append(here)
            found.extend(sensitive_keys(child, here))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(sensitive_keys(child, f"{path}[{index}]"))
    return found


def counter_keys(value: Any, path: str = "") -> list[str]:
    """Paths of keys that name a usage counter."""
    found: list[str] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            here = f"{path}.{key}" if path else str(key)
            if isinstance(key, str) and any(word in key.lower() for word in USAGE_COUNTER_WORDS):
                found.append(here)
            found.extend(counter_keys(child, here))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(counter_keys(child, f"{path}[{index}]"))
    return found


class Lab:
    """The HTTP session of one run: tokens, caches, and the clock used to wait."""

    def __init__(
        self,
        config: Config,
        client: httpx.Client,
        redact: Redactor,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self.client = client
        self.redact = redact
        self.sleep = sleep
        self.clock = clock
        self.run_id = uuid.uuid4().hex[:10]
        self.tokens: dict[str, str] = {}
        self.login_failures: dict[str, str] = {}
        self.snapshots: dict[str, str] = {}
        self.seeded_snapshot = False
        self.example_zip: bytes | None = None
        self.owner_job_id: str | None = None
        self.project_job_id: str | None = None
        self.checks = Checks()

    def begin(self) -> Checks:
        """The checks of the step that starts now; kept so a step cut short by a block still reports them."""
        self.checks = Checks()
        return self.checks

    def guard(self, response: httpx.Response, method: str, path: str, user: str | None) -> httpx.Response:
        """Raise ``RemoteBlocked`` when the gateway could not read the entitlements for this request."""
        cause = pricing_block(response)
        if cause is not None:
            raise RemoteBlocked(f"{USERS.get(user or '', 'anonymous')} {method} {path[:40]}", cause)
        return response

    def require_entitlements(self, user: str) -> None:
        """Fail fast as blocked when ``user``'s plan cannot be read (study runs would otherwise just stay queued)."""
        self.call("GET", "/v1/users/me", user)

    # -- requests ----------------------------------------------------------

    def call(
        self,
        method: str,
        path: str,
        user: str | None = None,
        *,
        api: bool = True,
        headers: Mapping[str, str] | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        """One request. ``api`` paths are the gateway's and get the proxy's ``/api`` prefix."""
        merged = dict(headers or {})
        if user is not None:
            merged["Authorization"] = f"Bearer {self.login(user)}"
        target = f"/api{path}" if api else path
        kwargs.setdefault("timeout", self.config.request_timeout_s)
        return self.guard(self.client.request(method, target, headers=merged, **kwargs), method, path, user)

    def login(self, user: str, *, username: str | None = None, password: str | None = None) -> str:
        """The Bearer token of a seeded user; signs in once and remembers the outcome."""
        if user in self.tokens:
            return self.tokens[user]
        if user in self.login_failures:
            raise StepError(self.login_failures[user])
        name = username or USERS[user]
        response = self.client.post(
            "/api/v1/auth/login",
            json={"username_or_email": name, "password": self.config.password if password is None else password},
            timeout=self.config.request_timeout_s,
        )
        body = mapping(body_of(response))
        token = body.get("access_token")
        if response.status_code != 200 or not isinstance(token, str) or not token:
            self.login_failures[user] = f"login of {name} failed: {describe(response)}"
            raise StepError(self.login_failures[user])
        self.redact.add(token)
        self.redact.add(body.get("refresh_token") if isinstance(body.get("refresh_token"), str) else None)
        self.tokens[user] = token
        return token

    # -- the seeded package ------------------------------------------------

    def example_package(self) -> bytes:
        if self.example_zip is None:
            response = self.call("GET", f"/v1/examples/{EXAMPLE_PATH}")
            if response.status_code != 200 or not response.content:
                raise StepError(f"example package {EXAMPLE_PATH}: {describe(response)}")
            self.example_zip = response.content
        return self.example_zip

    def upload_snapshot(self, user: str) -> str:
        response = self.call(
            "POST", "/v1/instances", user, headers={"Content-Type": BIM_ZIP}, content=self.example_package()
        )
        snapshot = mapping(body_of(response)).get("id")
        if response.status_code != 201 or not isinstance(snapshot, str):
            raise StepError(f"snapshot upload as {user}: {describe(response)}")
        return snapshot

    def case_revision(self) -> Mapping[str, Any]:
        response = self.call("GET", f"/v1/organizations/{ORG}/projects/{PROJECT}/cases/{CASE}/revisions", "owner")
        listing = body_of(response) if response.status_code == 200 else None
        revisions = [item for item in listing if isinstance(item, Mapping)] if isinstance(listing, list) else []
        if not revisions:
            raise StepError(f"case {ORG}/{PROJECT}/{CASE} has no revision: {describe(response)}")
        return max(revisions, key=lambda item: item.get("revision", 0))

    def snapshot(self, user: str) -> str:
        """A snapshot the user owns: the seeded one for the owner, an upload of the same package otherwise."""
        if user not in self.snapshots:
            seeded = None
            if user == "owner":
                candidate = self.case_revision().get("source_snapshot_id")
                if isinstance(candidate, str):
                    found = self.call("GET", f"/v1/instances/{candidate}", user)
                    seeded = candidate if found.status_code == 200 else None
            self.snapshots[user] = seeded or self.upload_snapshot(user)
            self.seeded_snapshot = seeded is not None and user == "owner"
        return self.snapshots[user]

    # -- jobs --------------------------------------------------------------

    def launch(
        self, user: str, *, key: str | None = None, options: Mapping[str, Any] | None = None, snapshot: str | None = None
    ) -> httpx.Response:
        body = {
            "snapshot": snapshot or self.snapshot(user), "engine": "random-search", "mode": MODE,
            "optimization": dict(OPTIMIZATION), "options": dict(options or MIN_OPTIONS),
        }
        headers = {"Idempotency-Key": key} if key else {}
        return self.call("POST", "/v1/jobs", user, headers=headers, json=body)

    def wait_for_job(self, user: str, job_id: str) -> tuple[str, Mapping[str, Any]]:
        """Poll until the job is terminal; ``("timeout", last body)`` after ``job_timeout_s``."""
        deadline = self.clock() + self.config.job_timeout_s
        last: Mapping[str, Any] = {}
        while True:
            response = self.call("GET", f"/v1/jobs/{job_id}", user)
            if response.status_code == 200:
                last = mapping(body_of(response))
                if last.get("status") in TERMINAL:
                    return str(last["status"]), last
            elif response.status_code >= 400 and response.status_code != 429:
                return f"http-{response.status_code}", last
            if self.clock() >= deadline:
                return "timeout", last
            self.sleep(self.config.poll_interval_s)

    def drain(self, user: str, job_ids: Sequence[str], *, cancel: bool = False) -> list[str]:
        """Wait for the jobs to end (cancelling them first if asked); ids that did not end in time."""
        stuck = []
        for job_id in job_ids:
            if cancel:
                self.call("POST", f"/v1/jobs/{job_id}/cancel", user)
            state, _ = self.wait_for_job(user, job_id)
            if state not in TERMINAL:
                stuck.append(job_id)
        return stuck


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------


def step_proxy_and_spa(lab: Lab) -> Checks:
    checks = lab.begin()
    health = lab.call("GET", "/healthz", api=False)
    checks.expect(health.status_code == 200 and health.text.strip() == "ok", f"/healthz answers ok ({health.status_code})")

    index = lab.call("GET", "/", api=False, headers={"Accept": "text/html"})
    html = index.text.lower()
    checks.expect(
        index.status_code == 200 and "text/html" in index.headers.get("content-type", "") and "<html" in html and "<script" in html,
        f"/ is the SPA index ({index.status_code} {index.headers.get('content-type', '')})",
    )

    deep = lab.call("GET", f"/cases/{uuid.uuid4().hex}/deep/route", api=False, headers={"Accept": "text/html"})
    checks.expect(
        deep.status_code == 200 and deep.text == index.text, f"a made-up deep route falls back to the index ({deep.status_code})"
    )

    ready = lab.call("GET", "/health/ready")
    checks.expect(ready.status_code == 200 and mapping(body_of(ready)).get("status") == "ready", f"/api/health/ready ({describe(ready)})")
    return checks


def step_login(lab: Lab) -> Checks:
    checks = lab.begin()
    for user, username in USERS.items():
        try:
            lab.login(user)
        except StepError as error:
            checks.expect(False, str(error))
            continue
        try:
            me = lab.call("GET", "/v1/users/me", user)
        except RemoteBlocked as blocked:
            checks.block(blocked.label, blocked.cause)
            continue
        profile = mapping(body_of(me))
        expected_role = ADMIN_ROLE if user == "admin" else "user"
        checks.expect(
            me.status_code == 200
            and profile.get("username") == username
            and str(profile.get("role", "")).lower() == expected_role,
            f"{username} signs in with the {expected_role} platform role ({me.status_code})",
        )
    return checks


def inspect_result(checks: Checks, job: Mapping[str, Any]) -> None:
    """Shape of a finished job and the proof that the gateway, not the engine, evaluated it."""
    result = mapping(job.get("result"))
    checks.expect(result.get("termination") in TERMINATIONS, f"result.termination is one of {sorted(TERMINATIONS)}")
    solutions = result.get("solutions")
    checks.expect(isinstance(solutions, list), "result.solutions is a list")
    solution_list = solutions if isinstance(solutions, list) else []
    complete = all(
        isinstance(item, Mapping)
        and mapping(item.get("decision")).get("kind") == "binding"
        and isinstance(mapping(item.get("decision")).get("binding"), Mapping)
        and all(key in item for key in ("features", "objectives", "penalties", "violations"))
        for item in solution_list
    )
    checks.expect(complete, "every solution carries decision.binding, features, objectives, penalties and violations")
    if not solution_list:
        checks.note(f"no solutions (termination {result.get('termination')})")

    provenance = mapping(job.get("provenance"))
    checks.expect(
        str(provenance.get("evaluator", "")).startswith("bim-reference-evaluator") and bool(provenance.get("evaluatorDigest")),
        "provenance names the reference evaluator and its digest (authoritative reevaluation)",
    )
    checks.expect(bool(provenance.get("compilerDigest")) and bool(provenance.get("irDigest")), "provenance pins the compiler and the IR")
    checks.expect("engineReported" in mapping(result.get("provenance")), "engine-reported values are kept apart from the authoritative ones")
    toolchain = [key for key in list(provenance) + list(mapping(result.get("provenance"))) if "toolchain" in key.lower()]
    if toolchain:
        value = provenance.get(toolchain[0], mapping(result.get("provenance")).get(toolchain[0]))
        shown = value if isinstance(value, str) else (sorted(value) if isinstance(value, Mapping) else type(value).__name__)
        checks.note(f"toolchain field {toolchain[0]}={str(shown)[:60]}")
    else:
        checks.note("no toolchain field in the provenance")


def step_owner_job(lab: Lab) -> Checks:
    checks = lab.begin()
    try:
        me = mapping(body_of(lab.call("GET", "/v1/users/me", "owner")))
        checks.expect(me.get("username") == USERS["owner"], "owner profile")
    except RemoteBlocked as blocked:
        checks.block(blocked.label, blocked.cause)

    organizations = body_of(lab.call("GET", "/v1/organizations", "owner")) or []
    main = next((item for item in organizations if mapping(item).get("slug") == ORG), None)
    checks.expect(main is not None and mapping(main).get("effective_role") == "OWNER", f"owner is OWNER of {ORG}")
    projects = body_of(lab.call("GET", f"/v1/organizations/{ORG}/projects", "owner")) or []
    checks.expect(any(mapping(item).get("slug") == PROJECT for item in projects), f"project {ORG}/{PROJECT} is visible")

    lab.snapshot("owner")
    created = lab.launch("owner", key=f"smoke-{lab.run_id}-job")
    accepted = mapping(body_of(created))
    job_id = accepted.get("id")
    if not checks.expect(created.status_code == 202 and isinstance(job_id, str), f"launch accepted ({describe(created)})"):
        return checks
    lab.owner_job_id = job_id
    checks.expect(accepted.get("status") in {"queued", "running", "completed"} and bool(accepted.get("irDigest")), "202 body: status and irDigest")

    state, job = lab.wait_for_job("owner", job_id)
    if not checks.expect(state == "completed", f"job reaches completed (got {state})"):
        checks.note(str(mapping(job.get("result")).get("error", ""))[:120])
        return checks
    inspect_result(checks, job)
    checks.note(f"snapshot {'seeded' if lab.seeded_snapshot else 'uploaded'}")
    return checks


def step_idempotency(lab: Lab) -> Checks:
    checks = lab.begin()
    key = f"smoke-{lab.run_id}-idem"
    first = lab.launch("owner", key=key)
    first_id = mapping(body_of(first)).get("id")
    if not checks.expect(first.status_code == 202 and isinstance(first_id, str), f"first launch accepted ({describe(first)})"):
        return checks

    replay = lab.launch("owner", key=key)
    replayed = mapping(body_of(replay))
    checks.expect(
        replay.status_code == 202 and replayed.get("id") == first_id and replayed.get("idempotent") is True,
        f"same key and body -> same job with idempotent:true ({describe(replay)})",
    )
    other_body = lab.launch("owner", key=key, options={**MIN_OPTIONS, "iterations": MIN_OPTIONS["iterations"] + 1})
    checks.expect(
        other_body.status_code == 409 and code_of(other_body) == "idempotency_conflict",
        f"same key and another body -> 409 idempotency_conflict ({describe(other_body)})",
    )

    foreign = lab.launch("member", key=key)
    foreign_body = mapping(body_of(foreign))
    foreign_id = foreign_body.get("id")
    checks.expect(
        foreign.status_code == 202 and isinstance(foreign_id, str) and foreign_id != first_id and not foreign_body.get("idempotent"),
        f"the same key of another account creates another job ({describe(foreign)})",
    )
    leak = lab.call("GET", f"/v1/jobs/{first_id}", "member")
    checks.expect(leak.status_code in {403, 404}, f"the other account cannot read the first job ({leak.status_code})")

    stuck = lab.drain("owner", [first_id]) + (lab.drain("member", [foreign_id]) if isinstance(foreign_id, str) else [])
    checks.expect(not stuck, "the jobs of this step ended (slots free for the next steps)")
    return checks


def ensure_project_job(lab: Lab) -> str:
    """A completed job of the seeded project (they only come from study runs); runs a one-cell study if none exists."""
    jobs_path = f"/v1/organizations/{ORG}/projects/{PROJECT}/jobs"

    def completed() -> str | None:
        response = lab.call("GET", jobs_path, "owner")
        listing = body_of(response) if response.status_code == 200 else None
        for job in listing if isinstance(listing, list) else []:
            if mapping(job).get("status") == "completed" and mapping(job).get("project_id"):
                return str(job["id"])
        return None

    if lab.project_job_id is None:
        lab.project_job_id = completed()
    if lab.project_job_id is not None:
        return lab.project_job_id

    # A study run is accepted (202) even when the plan cannot be read, and then just stays queued.
    lab.require_entitlements("owner")
    revision = lab.case_revision().get("id")
    engines = mapping(body_of(lab.call("GET", "/v1/engines", "owner"))).get("engines") or []
    engine = next((item for item in engines if mapping(item).get("name") == "random-search"), None)
    if not isinstance(revision, str) or engine is None:
        raise StepError("cannot build a study: no case revision or no random-search engine")
    study_path = f"/v1/organizations/{ORG}/projects/{PROJECT}/studies"
    created = lab.call(
        "POST", study_path, "owner",
        json={
            "slug": STUDY_SLUG, "name": "Smoke lab study", "description": "Created by tools/smoke_lab.py.",
            "definition": {
                "case_revision_ids": [revision],
                "engines": [{
                    **{key: engine[key] for key in ("namespace", "name", "version", "digest")},
                    "mode": MODE, "optimization": dict(OPTIMIZATION),
                }],
                "parameter_sets": [{"iterations": MIN_OPTIONS["iterations"]}],
                "seeds": [MIN_OPTIONS["seed"]],
            },
        },
    )
    if created.status_code not in {201, 409}:
        raise StepError(f"study creation: {describe(created)}")
    run = lab.call("POST", f"{study_path}/{STUDY_SLUG}/runs", "owner")
    if run.status_code != 202:
        raise StepError(f"study run: {describe(run)}")
    deadline = lab.clock() + lab.config.job_timeout_s
    while lab.project_job_id is None:
        lab.project_job_id = completed()
        if lab.project_job_id is None:
            if lab.clock() >= deadline:
                raise StepError("the study job did not complete in time")
            lab.sleep(lab.config.poll_interval_s)
    return lab.project_job_id


def check_viewer_redaction(checks: Checks, job: Mapping[str, Any]) -> None:
    options = mapping(job.get("options"))
    allowed = {"iterations", "seed", "time_budget_ms"}
    checks.expect(set(options) <= allowed, f"viewer options only hold allow-listed names ({sorted(set(options) - allowed)})")
    request = mapping(job.get("original_request"))
    checks.expect(set(request) <= REQUEST_KEYS, f"viewer original_request keys {sorted(set(request) - REQUEST_KEYS)} are extra")
    provenance = mapping(job.get("provenance"))
    registration = mapping(provenance.get("registration"))
    checks.expect(set(registration) <= REFERENCE_KEYS, "viewer sees the registration only as a pinned reference")
    exposed = {
        "options": options,
        "requestedOptions": provenance.get("requestedOptions"),
        "registration": registration,
        "engineReported": provenance.get("engineReported"),
        "request": {key: value for key, value in request.items() if key != "bindingProblem"},
    }
    leaks = sensitive_keys(exposed)
    checks.expect(not leaks, f"no credential- or address-like keys in what the viewer reads ({leaks[:3]})")


def step_authorization(lab: Lab) -> Checks:
    checks = lab.begin()
    job_id = lab.owner_job_id or str(uuid.uuid4())
    base = f"/v1/organizations/{ORG}/projects/{PROJECT}"

    for method, path in (("GET", "/v1/users/me"), ("GET", "/v1/organizations"), ("GET", f"/v1/jobs/{job_id}"),
                         ("POST", "/v1/jobs"), ("GET", f"{base}/jobs"), ("GET", "/v1/admin/overview")):
        response = lab.call(method, path)
        checks.expect(response.status_code == 401, f"anonymous {method} {path[:40]} -> 401 ({response.status_code})")

    # POST /v1/jobs is personal work on snapshots the caller owns and stores no project, so an
    # organization role does not gate it; the role gates the organization's resources (study runs).
    try:
        viewer_launch = lab.launch("viewer")
    except RemoteBlocked as blocked:
        checks.block(blocked.label, blocked.cause)
    else:
        checks.expect(viewer_launch.status_code == 202, f"viewer CAN launch a personal job on their own snapshot ({describe(viewer_launch)})")
        if viewer_launch.status_code == 202:
            viewer_job = mapping(body_of(viewer_launch)).get("id")
            if isinstance(viewer_job, str):
                stuck = lab.drain("viewer", [viewer_job], cancel=True)
                checks.expect(not stuck, "the viewer's personal job ended or was cancelled within the timeout")

    try:
        project_job = ensure_project_job(lab)
    except RemoteBlocked as blocked:
        checks.block(blocked.label, blocked.cause)
    except StepError as error:
        checks.expect(False, f"no project job to read as viewer: {error}")
    else:
        seen = lab.call("GET", f"{base}/jobs", "viewer", params={"job_id": project_job})
        listing = body_of(seen) if seen.status_code == 200 else []
        visible = next((item for item in listing if mapping(item).get("id") == project_job), None) if isinstance(listing, list) else None
        if checks.expect(visible is not None, f"viewer reads the project's job ({seen.status_code})"):
            job = mapping(visible)
            checks.expect(job.get("status") == "completed" and job.get("result") is not None, "viewer sees the state and the result")
            check_viewer_redaction(checks, job)
    run = lab.call("POST", f"{base}/studies/{STUDY_SLUG}/runs", "viewer")
    checks.expect(run.status_code in {403, 404}, f"viewer CANNOT start a study run in the org project ({describe(run)})")

    for label, path in (("project", base), ("project jobs", f"{base}/jobs"), ("organization", f"/v1/organizations/{ORG}")):
        denied = lab.call("GET", path, "outsider")
        checks.expect(denied.status_code in {403, 404}, f"outsider cannot read the {label} ({describe(denied)})")
    foreign = lab.call("GET", f"/v1/jobs/{job_id}", "outsider")
    checks.expect(foreign.status_code == 404, f"outsider cannot read the owner's job ({foreign.status_code})")

    for user in ("owner", "member", "viewer", "outsider"):
        refused = lab.call("GET", "/v1/admin/overview", user)
        checks.expect(refused.status_code == 403, f"{USERS[user]} gets 403 on /v1/admin/overview ({refused.status_code})")
    allowed = lab.call("GET", "/v1/admin/overview", "admin")
    checks.expect(allowed.status_code == 200, f"lab-admin reads /v1/admin/overview ({allowed.status_code})")
    return checks


def step_concurrency_limit(lab: Lab) -> Checks:
    checks = lab.begin()
    snapshot = lab.snapshot("owner")
    token = lab.login("owner")
    tag = f"smoke-{lab.run_id}-race"

    def attempt(index: int) -> httpx.Response:
        body = {
            "snapshot": snapshot, "engine": "random-search", "mode": MODE,
            "optimization": dict(OPTIMIZATION), "options": SLOW_OPTIONS,
        }
        return lab.client.post(
            "/api/v1/jobs", json=body, headers={"Authorization": f"Bearer {token}", "Idempotency-Key": f"{tag}-{index}"},
            timeout=lab.config.request_timeout_s,
        )

    with ThreadPoolExecutor(max_workers=lab.config.launches) as pool:
        responses = list(pool.map(attempt, range(lab.config.launches)))
    accepted = [mapping(body_of(item)).get("id") for item in responses if item.status_code == 202]
    refused = [item for item in responses if item.status_code == 429]
    accepted_ids = [item for item in accepted if isinstance(item, str)]
    blocks = [cause for cause in map(pricing_block, responses) if cause]
    if blocks and not accepted_ids:
        raise RemoteBlocked(f"{USERS['owner']} POST /v1/jobs x{len(blocks)}", blocks[0])
    checks.expect(
        len(accepted_ids) + len(refused) == len(responses),
        f"every launch is 202 or 429 ({sorted(item.status_code for item in responses)})",
    )
    checks.expect(len(accepted_ids) <= lab.config.max_concurrent, f"at most {lab.config.max_concurrent} accepted ({len(accepted_ids)})")
    checks.expect(bool(refused), "at least one launch got a 429")
    limited = [item for item in refused if code_of(item) == "concurrency_limit_exceeded"]
    checks.expect(bool(limited), "a 429 is concurrency_limit_exceeded")
    checks.expect(any((retry_after_of(item) or 0) > 0 for item in limited), "that 429 carries Retry-After")

    stuck = lab.drain("owner", accepted_ids, cancel=True)
    checks.expect(not stuck, "the accepted jobs ended or were cancelled within the timeout")
    after = lab.launch("owner", key=f"{tag}-after")
    after_id = mapping(body_of(after)).get("id")
    checks.expect(after.status_code == 202, f"a launch is accepted again once slots are free ({describe(after)})")
    if isinstance(after_id, str):
        lab.drain("owner", [after_id])
    return checks


def step_cors(lab: Lab) -> Checks:
    checks = lab.begin()
    request_headers = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    allowed = lab.call("OPTIONS", "/v1/users/me", headers={"Origin": lab.config.origin, **request_headers})
    checks.expect(
        allowed.status_code == 200 and allowed.headers.get("access-control-allow-origin") == lab.config.origin,
        f"preflight from {lab.config.origin} is allowed ({allowed.status_code})",
    )
    checks.expect("GET" in allowed.headers.get("access-control-allow-methods", "").upper(), "preflight allows GET")

    refused = lab.call("OPTIONS", "/v1/users/me", headers={"Origin": lab.config.evil_origin, **request_headers})
    echoed = refused.headers.get("access-control-allow-origin")
    checks.expect(echoed not in {lab.config.evil_origin, "*"}, f"preflight from {lab.config.evil_origin} is not allowed (status {refused.status_code})")
    simple = lab.call("GET", "/health/live", headers={"Origin": lab.config.evil_origin})
    checks.expect(
        simple.headers.get("access-control-allow-origin") not in {lab.config.evil_origin, "*"},
        "a simple request from the other origin gets no allow-origin header",
    )
    return checks


def step_body_limit(lab: Lab) -> Checks:
    checks = lab.begin()
    prefix, suffix = b'{"username_or_email":"x","password":"', b'"}'
    padding = JSON_LIMIT_BYTES + 1024 - len(prefix) - len(suffix)
    started = lab.clock()
    try:
        response = lab.call(
            "POST", "/v1/auth/login", headers={"Content-Type": "application/json"},
            content=prefix + b"A" * padding + suffix, timeout=30,
        )
    except httpx.HTTPError as error:
        checks.expect(False, f"oversized body: {type(error).__name__} (the request must be refused, not hang)")
        return checks
    checks.expect(response.status_code == 413, f"JSON over 16 MiB -> 413 ({response.status_code})")
    checks.expect("problem+json" in response.headers.get("content-type", ""), "the 413 is application/problem+json")
    checks.expect(code_of(response) == "payload_too_large", f"the 413 code is payload_too_large ({code_of(response)})")
    checks.note(f"answered in {lab.clock() - started:.1f}s")
    return checks


def step_login_throttle(lab: Lab) -> Checks:
    checks = lab.begin()
    statuses: list[int] = []
    limited: httpx.Response | None = None
    for _ in range(THROTTLE_ATTEMPTS):
        response = lab.client.post(
            "/api/v1/auth/login",
            json={"username_or_email": THROTTLE_USER, "password": "not-the-password-0000"},
            timeout=lab.config.request_timeout_s,
        )
        statuses.append(response.status_code)
        if response.status_code == 429:
            limited = response
            break
    checks.expect(all(status in {401, 429} for status in statuses), f"failed logins answer 401 until the limit ({sorted(set(statuses))})")
    if checks.expect(limited is not None, f"a 429 within {THROTTLE_ATTEMPTS} failed logins"):
        wait = retry_after_of(limited) if limited is not None else None
        checks.expect(wait is not None and wait > 0, "the 429 carries Retry-After")
        checks.note(f"429 at attempt {len(statuses)}, Retry-After {wait}s")
    return checks


def step_plan_usage(lab: Lab) -> Checks:
    checks = lab.begin()
    response = lab.call("GET", "/v1/users/me/usage", "owner")
    body = mapping(body_of(response))
    if not checks.expect(response.status_code == 200, f"GET /v1/users/me/usage ({describe(response)})"):
        return checks
    checks.expect(isinstance(body.get("plan"), str) and bool(body["plan"]), "the plan is named")
    checks.expect(isinstance(body.get("features"), Mapping), "features are listed")
    capabilities = mapping(body.get("capabilities"))
    checks.expect(
        bool(capabilities) and all(value is None or isinstance(value, (int, float)) for value in capabilities.values()),
        "capabilities are limits (number or null)",
    )
    counters = counter_keys(body)
    checks.expect(not counters, f"no usage counters in the answer ({counters[:3]})")
    checks.note(f"plan {body.get('plan')}")
    return checks


STEPS: dict[int, tuple[str, Callable[[Lab], Checks]]] = {
    1: ("proxy_and_spa", step_proxy_and_spa),
    2: ("login", step_login),
    3: ("owner_job", step_owner_job),
    4: ("idempotency", step_idempotency),
    5: ("authorization", step_authorization),
    6: ("concurrency_limit", step_concurrency_limit),
    7: ("cors", step_cors),
    8: ("body_limit", step_body_limit),
    9: ("login_throttle", step_login_throttle),
    10: ("plan_usage", step_plan_usage),
}


# --------------------------------------------------------------------------
# Running and reporting
# --------------------------------------------------------------------------


def run_step(lab: Lab, number: int) -> dict[str, Any]:
    name, function = STEPS[number]
    blocked = False
    try:
        checks = function(lab)
        ok, detail, blocked = checks.ok, checks.detail(), checks.blocked_by_remote
    except RemoteBlocked as error:
        checks = lab.checks
        checks.block(error.label, error.cause)
        ok, detail, blocked = False, checks.detail(), checks.blocked_by_remote
    except StepError as error:
        ok, detail = False, str(error)
    except Exception as error:  # noqa: BLE001 - one step's crash must not stop the next ones
        ok, detail = False, f"{type(error).__name__}: {str(error)[:160]}"
    return {"name": name, "ok": ok, "blockedByRemote": blocked, "detail": lab.redact(detail)[:DETAIL_MAX]}


def run_smoke(
    config: Config,
    client: httpx.Client,
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    redact = Redactor([config.password])
    lab = Lab(config, client, redact, sleep=sleep, clock=clock)
    started = clock()
    steps: list[dict[str, Any]] = []
    skipped: list[str] = []
    for number in RUN_ORDER:
        name = STEPS[number][0]
        if number in config.skip or (number == 10 and not config.with_space):
            skipped.append(name)
            continue
        steps.append(run_step(lab, number))
    blocked_steps = [step["name"] for step in steps if step["blockedByRemote"]]
    return {
        "tool": "smoke_lab",
        "baseUrl": config.base_url,
        "ok": bool(steps) and all(step["ok"] for step in steps),
        "passed": sum(1 for step in steps if step["ok"]),
        "failed": sum(1 for step in steps if not step["ok"] and not step["blockedByRemote"]),
        "blocked": len(blocked_steps),
        "blockedSteps": blocked_steps,
        "skipped": skipped,
        "elapsedS": round(clock() - started, 1),
        "steps": steps,
    }


def parse_skip(value: str) -> frozenset[int]:
    names = {name: number for number, (name, _) in STEPS.items()}
    skipped: set[int] = set()
    for item in (part.strip() for part in value.split(",") if part.strip()):
        number = int(item) if item.isdigit() else names.get(item)
        if number not in SKIPPABLE:
            raise argparse.ArgumentTypeError(f"only steps {SKIPPABLE} can be skipped, not {item!r}")
        skipped.add(number)
    return frozenset(skipped)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="API smoke test of the lab demo through the nginx proxy.")
    parser.add_argument("--base-url", default=None, help=f"proxy origin (default $SMOKE_BASE_URL or {DEFAULT_BASE_URL})")
    parser.add_argument("--skip", type=parse_skip, default=frozenset(), help="optional steps to leave out: numbers or names among 6-9")
    parser.add_argument("--with-space", action="store_true", help="also check the owner's plan and capabilities (needs SPACE contracts)")
    parser.add_argument("--origin", default="http://localhost:18100", help="origin that must pass CORS")
    parser.add_argument("--evil-origin", default="http://evil.example", help="origin that must not pass CORS")
    parser.add_argument("--job-timeout", type=float, default=120.0, help="seconds to wait for a job to end")
    parser.add_argument("--max-concurrent", type=int, default=3, help="MAX_CONCURRENT_JOBS_PER_USER of the lab")
    return parser


def main(
    argv: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    *,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    args = build_parser().parse_args(argv)
    source = os.environ if environ is None else environ
    password = source.get("DEMO_SEED_PASSWORD", "")
    base_url = (args.base_url or source.get("SMOKE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    if not password:
        print(json.dumps({"tool": "smoke_lab", "ok": False, "error": "DEMO_SEED_PASSWORD is required", "steps": []}))
        return EXIT_CONFIG
    config = Config(
        base_url=base_url, password=password, origin=args.origin, evil_origin=args.evil_origin,
        job_timeout_s=args.job_timeout, max_concurrent=args.max_concurrent, skip=args.skip, with_space=args.with_space,
    )
    with httpx.Client(base_url=base_url, transport=transport, follow_redirects=False) as client:
        report = run_smoke(config, client, sleep=sleep)
    print(Redactor([password])(json.dumps(report, indent=2)))
    if report["ok"]:
        return EXIT_OK
    return EXIT_BLOCKED if report["failed"] == 0 and report["blocked"] else EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
