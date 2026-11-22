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
    SPHERE_URL           the lab's SPHERE; steps 19-21 run only when it is the stand-in (http://sphere-lab:8080).
    UPSTREAM_POLL_INTERVAL_S  the watcher's interval (default 300); step 19 waits up to three of them.

Steps (a failure never aborts the next one; 8-11 can be dropped with ``--skip``; they run in the order of ``RUN_ORDER``):
    1 proxy_and_spa     /healthz, SPA index, SPA fallback on a made-up deep route, /api/health/ready
    2 login             admin, owner, member, viewer and outsider sign in (Bearer tokens)
    3 upload            owner: the template validates, is uploaded as a new problem of lab-main, and its revision is that package
    4 owner_job         owner: profile, problems, a random-search run of the uploaded revision, result shape
    5 study             owner: a study of the revision x random-search x 2 seeds, run, every cell completed, the definition frozen
    6 idempotency       same key + body -> same run; same key + other body -> 409; other account -> other run, readable by both
    7 authorization     401 without token, the viewer/outsider/admin matrix (the viewer reads the problem and the owner's run, redacted, but launches no run and starts no study run)
    8 concurrency_limit 5 simultaneous launches -> a 429 with Retry-After, and the slot is freed afterwards
    9 cors              preflight allowed from the lab origin, refused from another origin
   10 body_limit        a JSON body over 16 MiB -> 413 problem+json
   11 login_throttle    12 failed logins of a made-up user -> 429 with Retry-After
   12 plan_usage        (--with-space) the owner's plan and capabilities, without usage counters
   13 public_compositions  anonymous: the public list holds lab-other's two public compositions, the public linked one
                        reads 200, and the private one answers 404 with the body of a missing one
   14 sphere_candidates the seeded tomatometer-email revision 2 came from SPHERE: origin sphere, and its facts give its
                        generated candidates value sources (a priced subscription) and provenance
   15 sphere_engines    one run of tomatometer-email revision 2 on each built-in single-objective engine (MiniZinc,
                        random search, the elitist genetic search), each completing with an eligible e-mail candidate

   16 environment_feed  the seeded production environment of lab-main/tomatometer through the lab nginx: its feed key
                        (derived from DEMO_SEED_PASSWORD as the seed derives it) reads 1.0.0's bytes with 1.0.0's
                        content ETag; If-None-Match gives a 304 that keeps ETag and Vary; the outsider's key is a 404,
                        no credential a 401, the feed key on /v1/users/me a 401 environment_key_elsewhere;
                        re-evaluating 1.0.0 leaves the ETag; the margins of the pinned evaluation at 1000 users are ok,
                        7 rows, basic negative
   17 adopt_switches_provider  the lab's feed consumer follows Brevo and mails through it (Mailpit, tag
                        provider-brevo); lab-owner adopts 1.1.0 with If-Match; the feed's ETag becomes 1.1.0's; the
                        consumer switches to Resend within 15 s and mails with tag provider-resend; an adopt without
                        If-Match is 428 and lab-member's adopt is 403
   18 restore_operation lab-owner adopts 1.0.0 again (the walks start from the seed's state); the next mail is Brevo's

   19 upstream_offering_event  the lab's SPHERE stand-in publishes TomatoMeter 1.2.0 (``tomatometer-1.2.0``: Basic gains
                        Daily summary and a price of 0.99); within three watcher cycles lab-main/tomatometer has one open
                        ``offering_changed`` event whose production margins move Basic (with and without extraTimers)
                        by +0.99 per user and every other row by 0.000000; production's feed ETag, its adoption number
                        and the counts of runs, revisions, versions and proposals are unchanged; the stand-in had
                        answered TomatoMeter's manifest with a 304 at least once before
   20 upstream_review   lab-viewer's review is 403, a body that asks for ``state: resolved`` is refused, lab-owner's
                        review with a note makes the event ``reviewed``, a second review is 409 ``event_not_reviewable``,
                        and no route resolves an event
   21 proposal_adopt    on production: lab-owner proposes adopting 1.1.0 and confirms it (``completed``; the adoption
                        history says ``source: proposal``; the feed's ETag becomes 1.1.0's); a second proposal (1.0.0)
                        made stale by a direct adoption of 1.0.0 is refused with 409 ``proposal_stale`` and changes
                        nothing; production ends on 1.0.0, as step 18 leaves it

Steps 14 and 15 are reported ``skipped`` when the seed skipped SPHERE (it was disabled or unreachable): the problem
then has no revision 2, as ``plan_usage`` is skipped without ``--with-space``. Steps 16 to 18 are skipped likewise
when the seed made no TomatoMeter environments. Steps 19 to 21 run only against the lab's SPHERE stand-in: the
smoke's ``SPHERE_URL`` (the seed service gets the gateway's) must name the host ``sphere-lab`` and its control port
(``http://sphere-lab:8081/_lab/state``) must answer; otherwise they are skipped, and ``skipReasons`` says why (in the
public mode the stand-in still runs, so the control port alone would not tell). Each scenario publishes once per lab:
on a lab where step 19 already ran, it finds the event it made, and step 20 the review. ``--steps 16,17,18`` runs only
the steps named.

Steps 3 to 5 are the F0b walk (upload, run, study) on the organization's paths. Every smoke uploads one problem
(``smoke-<run id>``) and creates one study of it in lab-main; nothing is deleted, since runs keep their problem.

The login throttle counts per client address AND identifier (``authrl:login:id:<ip>:<hash>``) and, with a
10x larger budget, per address alone. Step 11 therefore uses an identifier no other step uses and runs last,
so the logins of the other steps are not the ones that get blocked; it still consumes part of the per-address
budget for the length of the window (300 s by default).

Usage:
    python tools/smoke_lab.py [--base-url URL] [--skip 8,9,10,11] [--steps 16,17,18] [--with-space] [--job-timeout 120]
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit

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
ORG, CASE = "lab-main", "simple-seq"
#: The seeded problem (``/v1/organizations/{org}/problems/{problem}``).
PROBLEM = f"/v1/organizations/{ORG}/problems/{CASE}"
#: The problems, runs and studies of the lab organization.
PROBLEMS = f"/v1/organizations/{ORG}/problems"
RUNS = f"/v1/organizations/{ORG}/runs"
STUDIES = f"/v1/organizations/{ORG}/studies"
EXAMPLE_PATH = "demo/01_simple_seq"
#: The seeds of the study step: one cell each.
STUDY_SEEDS = (1, 2)
#: The compositions tools/seed_lab.py made in lab-other: the two public ones (sorted) and the private one.
PUBLIC_ORG = "lab-other"
PUBLIC_COMPOSITIONS = ("order-desk", "sequential-workflow")
PRIVATE_COMPOSITION = "internal-draft"
#: The problem tools/seed_lab.py builds from SPHERE pricings when SPHERE is reachable.
SPHERE_PROBLEM = f"/v1/organizations/{ORG}/problems/tomatometer-email"
#: The engines and options of step 15: every built-in single-objective engine, with the same explicit weights.
SPHERE_ENGINES = (
    ("minizinc-csp", "exact-weighted", {"solver": "gecode", "time_budget_ms": 10_000}),
    ("random-search", "seeded", {"iterations": 256, "seed": 7}),
    ("evolutionary-heuristics", "elitist-genetic",
     {"algorithm": "elitist-genetic", "population_size": 16, "max_evaluations": 256, "seed": 7}),
)
SPHERE_OPTIMIZATION = {
    "type": "SINGLE", "scalarization": "weighted-sum",
    "weights": [{"criteria": name, "value": 1 / 3} for name in ("subscription", "availability", "latency")],
}

#: The operation of lab-main/tomatometer the seed made (F4): its production environment, read through the lab nginx,
#: and the lab's feed consumer and Mailpit, reached by their names on the compose network.
TOMATOMETER = f"/v1/organizations/{ORG}/compositions/tomatometer"
PRODUCTION = f"{TOMATOMETER}/environments/production"
FEED = f"{PRODUCTION}/composition"
FEED_CONSUMER = "http://feed-consumer:8090"
MAILPIT_API = "http://mailpit:8025/mailpit/api/v1"
#: How long the consumer may take to leave waiting_for_handoff, and to follow an adoption (it polls every 3 s).
CONSUMER_READY_S = 30.0
CONSUMER_SWITCH_S = 15.0

TERMINAL = frozenset({"completed", "failed", "cancelled"})
#: A study run that is over (``partial``: some cells failed or were cancelled).
STUDY_TERMINAL = frozenset({"completed", "partial", "failed", "cancelled"})
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
SKIPPABLE = (8, 9, 10, 11)
#: 11 last: it burns the per-address login budget.
RUN_ORDER = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 20, 21, 12, 11)

#: Key words that make a name look like a credential or an address (as security/redaction.py).
SENSITIVE_WORDS = frozenset(
    {"auth", "authorization", "authentication", "credential", "credentials", "secret", "secrets",
     "password", "passwd", "token", "tokens", "bearer", "cookie", "cookies", "header", "headers",
     "private", "certificate", "endpoint", "url", "uri", "host", "signature", "session"}
)
REQUEST_KEYS = frozenset({"timeout", "mode", "optimization", "registration"})
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
    #: Only these steps (``--steps``); ``None`` runs them all.
    only: frozenset[int] | None = None
    #: The lab's SPHERE (``SPHERE_URL``): steps 19-21 need the stand-in.
    sphere_url: str = ""
    #: The upstream watcher's interval (``UPSTREAM_POLL_INTERVAL_S``); step 19 waits for up to three cycles. Not the
    #: job and study polling above (``poll_interval_s``), which stays at one second.
    upstream_interval_s: float = 300.0


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
        self.revision_id: str | None = None
        self.problem_slug = f"smoke-{self.run_id}"
        self.study_slug = f"smoke-{self.run_id}"
        self.example_zip: bytes | None = None
        self.owner_job_id: str | None = None
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
        # The smoke is a script: it calls the API with bearer tokens only. A login also sets the browser session cookie,
        # and a session cookie presented at the next login is revoked (``replaced``), which would end the token of the
        # user signed in before; the client keeps no cookie.
        self.client.cookies.clear()
        body = mapping(body_of(response))
        token = body.get("access_token")
        if response.status_code != 200 or not isinstance(token, str) or not token:
            self.login_failures[user] = f"login of {name} failed: {describe(response)}"
            raise StepError(self.login_failures[user])
        self.redact.add(token)
        self.tokens[user] = token
        return token

    # -- the seeded package ------------------------------------------------

    def example_package(self) -> bytes:
        if self.example_zip is None:
            response = self.call("GET", f"/v1/bim/templates/{EXAMPLE_PATH}")
            if response.status_code != 200 or not response.content:
                raise StepError(f"template package {EXAMPLE_PATH}: {describe(response)}")
            self.example_zip = response.content
        return self.example_zip

    def upload_problem(self) -> Mapping[str, Any]:
        """The template package uploaded by the owner as the new problem ``problem_slug`` of ``ORG``; the answer."""
        response = self.call(
            "POST", PROBLEMS, "owner",
            params={"slug": self.problem_slug}, headers={"Content-Type": BIM_ZIP}, content=self.example_package(),
        )
        body = mapping(body_of(response))
        revision = mapping(body.get("revision")).get("id")
        if response.status_code != 201 or not isinstance(revision, str):
            raise StepError(f"problem upload as owner: {describe(response)}")
        self.revision_id = revision
        return body

    def seeded_revision(self, user: str) -> str | None:
        """The latest revision of the seeded problem ``ORG/CASE`` as ``user`` reads it, or ``None``."""
        listing = body_of(self.call("GET", f"{PROBLEM}/revisions", user))
        revisions = [item for item in listing if isinstance(item, Mapping)] if isinstance(listing, list) else []
        latest = max(revisions, key=lambda item: item.get("revision", 0), default={})
        return latest.get("id") if isinstance(latest.get("id"), str) else None

    def revision(self) -> str:
        """The revision runs and the study are of: the one the upload step made (made now when that step did not run)."""
        if self.revision_id is None:
            self.upload_problem()
        assert self.revision_id is not None
        return self.revision_id

    # -- jobs --------------------------------------------------------------

    def launch(
        self, user: str, *, key: str | None = None, options: Mapping[str, Any] | None = None, revision: str | None = None
    ) -> httpx.Response:
        body = {
            "revision": revision or self.revision(), "engine": "random-search", "mode": MODE,
            "optimization": dict(OPTIMIZATION), "options": dict(options or MIN_OPTIONS),
        }
        headers = {"Idempotency-Key": key} if key else {}
        return self.call("POST", RUNS, user, headers=headers, json=body)

    def wait_for_job(self, user: str, job_id: str) -> tuple[str, Mapping[str, Any]]:
        """Poll until the job is terminal; ``("timeout", last body)`` after ``job_timeout_s``."""
        deadline = self.clock() + self.config.job_timeout_s
        last: Mapping[str, Any] = {}
        while True:
            response = self.call("GET", f"{RUNS}/{job_id}", user)
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
                self.call("POST", f"{RUNS}/{job_id}/cancel", user)
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


def step_upload(lab: Lab) -> Checks:
    checks = lab.begin()
    archive = lab.example_package()
    checked = lab.call("POST", "/v1/bim/validate", "owner", headers={"Content-Type": BIM_ZIP}, content=archive)
    report = mapping(body_of(checked))
    checks.expect(checked.status_code == 200 and report.get("valid") is True, f"the template validates ({describe(checked)})")

    uploaded = lab.upload_problem()
    revision = mapping(uploaded.get("revision"))
    checks.expect(revision.get("revision") == 1, "the upload is revision 1 of a new problem")
    checks.expect(
        bool(revision.get("package_digest")) and revision.get("package_digest") == report.get("packageDigest"),
        "the revision is the package that was validated (same packageDigest)",
    )
    base = f"{PROBLEMS}/{lab.problem_slug}/revisions/1"
    source = lab.call("GET", f"{base}/source", "owner")
    checks.expect(source.status_code == 200 and source.content == archive, f"its source is the uploaded package, byte for byte ({source.status_code})")
    compilation = lab.call("GET", f"{base}/compilation", "owner")
    modes = mapping(body_of(compilation)).get("compatible_modes")
    runnable = [item for item in modes if isinstance(item, Mapping) and item.get("compatible")] if isinstance(modes, list) else []
    checks.expect(
        compilation.status_code == 200 and any(mapping(item.get("engine")).get("name") == "random-search" for item in runnable),
        f"its compilation says random-search can run it ({describe(compilation)})",
    )
    listed = mapping(body_of(lab.call("GET", PROBLEMS, "owner"))).get("problems") or []
    checks.expect(any(mapping(item).get("slug") == lab.problem_slug for item in listed), f"problem {lab.problem_slug} is listed in {ORG}")
    return checks


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
    problems = mapping(body_of(lab.call("GET", f"/v1/organizations/{ORG}/problems", "owner"))).get("problems") or []
    checks.expect(any(mapping(item).get("slug") == CASE for item in problems), f"problem {ORG}/{CASE} is visible")

    lab.revision()
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
    revision = mapping(job.get("revision"))
    checks.expect(revision.get("id") == lab.revision_id, "the run names the uploaded revision")
    return checks


def engine_reference(lab: Lab, name: str) -> Mapping[str, Any]:
    """The full reference (namespace, name, version, digest) of an engine the owner can use."""
    listing = mapping(body_of(lab.call("GET", "/v1/engines", "owner"))).get("engines")
    for item in listing if isinstance(listing, list) else []:
        reference = mapping(mapping(item).get("ref")) or mapping(item)
        if reference.get("name") == name and all(reference.get(key) for key in REFERENCE_KEYS):
            return {key: reference[key] for key in sorted(REFERENCE_KEYS)}
    raise StepError(f"engine {name} is not in /v1/engines")


def wait_for_study_run(lab: Lab, path: str) -> tuple[str, Mapping[str, Any]]:
    """Poll a study run until it is over; ``("timeout", last body)`` after ``job_timeout_s``."""
    deadline = lab.clock() + lab.config.job_timeout_s
    last: Mapping[str, Any] = {}
    while True:
        response = lab.call("GET", path, "owner")
        if response.status_code == 200:
            last = mapping(body_of(response))
            if last.get("state") in STUDY_TERMINAL:
                return str(last["state"]), last
        elif response.status_code >= 400 and response.status_code != 429:
            return f"http-{response.status_code}", last
        if lab.clock() >= deadline:
            return "timeout", last
        lab.sleep(lab.config.poll_interval_s)


def step_study(lab: Lab) -> Checks:
    checks = lab.begin()
    revision = lab.revision()
    engine = {**engine_reference(lab, "random-search"), "mode": MODE, "optimization": dict(OPTIMIZATION)}
    definition = {
        "revision_ids": [revision], "engines": [engine],
        "parameter_sets": [{"iterations": MIN_OPTIONS["iterations"]}], "seeds": list(STUDY_SEEDS),
    }
    created = lab.call("POST", STUDIES, "owner", json={"slug": lab.study_slug, "name": f"Smoke {lab.run_id}", "definition": definition})
    if not checks.expect(created.status_code == 201, f"study {lab.study_slug} created ({describe(created)})"):
        return checks
    started = lab.call("POST", f"{STUDIES}/{lab.study_slug}/runs", "owner")
    run = mapping(body_of(started))
    run_id = run.get("id")
    if not checks.expect(started.status_code == 202 and isinstance(run_id, str), f"study run accepted ({describe(started)})"):
        return checks
    frozen = mapping(run.get("definition"))
    problems = [mapping(item) for item in frozen.get("problems") or [] if isinstance(item, Mapping)]
    checks.expect(bool(run.get("definition_digest")), "the run carries the digest of its frozen definition")
    checks.expect(
        [item.get("revisionId") for item in problems] == [revision] and all(item.get("compilationId") for item in problems),
        "the frozen definition names the revision and the compilation it runs",
    )

    path = f"{STUDIES}/{lab.study_slug}/runs/{run_id}"
    state, last = wait_for_study_run(lab, path)
    checks.expect(state == "completed", f"the study run completes (got {state})")
    cells = body_of(lab.call("GET", f"{path}/cells", "owner"))
    rows = [mapping(item) for item in cells] if isinstance(cells, list) else []
    checks.expect(len(rows) == len(STUDY_SEEDS), f"one cell per seed ({len(rows)})")
    checks.expect(bool(rows) and all(item.get("state") == "completed" for item in rows), "every cell completed")
    checks.expect(last.get("definition_digest") == run.get("definition_digest"), "the frozen definition did not change while it ran")
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
    # A run is the organization's: the member reads the owner's run.
    shared = lab.call("GET", f"{RUNS}/{first_id}", "member")
    checks.expect(shared.status_code == 200, f"a member of the organization reads the owner's run ({shared.status_code})")

    stuck = lab.drain("owner", [first_id]) + (lab.drain("member", [foreign_id]) if isinstance(foreign_id, str) else [])
    checks.expect(not stuck, "the jobs of this step ended (slots free for the next steps)")
    return checks


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
        "request": dict(request),
    }
    leaks = sensitive_keys(exposed)
    checks.expect(not leaks, f"no credential- or address-like keys in what the viewer reads ({leaks[:3]})")


def step_authorization(lab: Lab) -> Checks:
    checks = lab.begin()
    job_id = lab.owner_job_id or str(uuid.uuid4())

    for method, path in (("GET", "/v1/users/me"), ("GET", "/v1/organizations"), ("GET", f"{RUNS}/{job_id}"),
                         ("POST", RUNS), ("GET", RUNS), ("GET", "/v1/admin/overview")):
        response = lab.call(method, path)
        checks.expect(response.status_code == 401, f"anonymous {method} {path[:40]} -> 401 ({response.status_code})")

    problem = lab.call("GET", PROBLEM, "viewer")
    checks.expect(problem.status_code == 200, f"viewer reads the organization's problem ({describe(problem)})")
    # A run belongs to the organization of its problem: a VIEWER of that organization reads it, and is refused
    # a launch before anything is compiled, reserved or charged to a plan.
    # Of the uploaded revision, or of the seeded problem when nothing was uploaded: no upload is attempted for it.
    viewer_launch = lab.launch("viewer", revision=lab.revision_id or lab.seeded_revision("viewer") or str(uuid.uuid4()))
    checks.expect(
        viewer_launch.status_code == 403 and code_of(viewer_launch) == "insufficient_role",
        f"viewer CANNOT launch a run of the organization's problem ({describe(viewer_launch)})",
    )

    if lab.owner_job_id is None:
        try:
            lab.require_entitlements("owner")
        except RemoteBlocked as blocked:
            checks.block(blocked.label, blocked.cause)
        else:
            checks.expect(False, "no run of the owner to read as viewer (the owner_job step launched none)")
    else:
        seen = lab.call("GET", f"{RUNS}/{lab.owner_job_id}", "viewer")
        if checks.expect(seen.status_code == 200, f"viewer reads the owner's run ({seen.status_code})"):
            job = mapping(body_of(seen))
            checks.expect(job.get("status") == "completed" and job.get("result") is not None, "viewer sees the state and the result")
            check_viewer_redaction(checks, job)
    run = lab.call("POST", f"{STUDIES}/{lab.study_slug}/runs", "viewer")
    checks.expect(run.status_code in {403, 404}, f"viewer CANNOT start a study run in the organization ({describe(run)})")

    for label, path in (("problem", PROBLEM), ("runs", RUNS), ("organization", f"/v1/organizations/{ORG}")):
        denied = lab.call("GET", path, "outsider")
        checks.expect(denied.status_code in {403, 404}, f"outsider cannot read the {label} ({describe(denied)})")
    foreign = lab.call("GET", f"{RUNS}/{job_id}", "outsider")
    checks.expect(foreign.status_code == 404, f"outsider cannot read the owner's run ({foreign.status_code})")

    for user in ("owner", "member", "viewer", "outsider"):
        refused = lab.call("GET", "/v1/admin/overview", user)
        checks.expect(refused.status_code == 403, f"{USERS[user]} gets 403 on /v1/admin/overview ({refused.status_code})")
    allowed = lab.call("GET", "/v1/admin/overview", "admin")
    checks.expect(allowed.status_code == 200, f"lab-admin reads /v1/admin/overview ({allowed.status_code})")
    return checks


def step_concurrency_limit(lab: Lab) -> Checks:
    checks = lab.begin()
    revision = lab.revision()
    token = lab.login("owner")
    tag = f"smoke-{lab.run_id}-race"

    def attempt(index: int) -> httpx.Response:
        body = {
            "revision": revision, "engine": "random-search", "mode": MODE,
            "optimization": dict(OPTIMIZATION), "options": SLOW_OPTIONS,
        }
        return lab.client.post(
            f"/api{RUNS}", json=body, headers={"Authorization": f"Bearer {token}", "Idempotency-Key": f"{tag}-{index}"},
            timeout=lab.config.request_timeout_s,
        )

    with ThreadPoolExecutor(max_workers=lab.config.launches) as pool:
        responses = list(pool.map(attempt, range(lab.config.launches)))
    accepted = [mapping(body_of(item)).get("id") for item in responses if item.status_code == 202]
    refused = [item for item in responses if item.status_code == 429]
    accepted_ids = [item for item in accepted if isinstance(item, str)]
    blocks = [cause for cause in map(pricing_block, responses) if cause]
    if blocks and not accepted_ids:
        raise RemoteBlocked(f"{USERS['owner']} POST {RUNS} x{len(blocks)}", blocks[0])
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


def step_public_compositions(lab: Lab) -> Checks:
    """What a visitor (no credential) reads of compositions: the public list and lab-other's public and private ones."""
    checks = lab.begin()
    listed = lab.call("GET", "/v1/compositions", params={"limit": 100})
    body = mapping(body_of(listed))
    rows = [mapping(item) for item in body.get("compositions") or []]
    names = sorted(f"{mapping(row.get('organization')).get('slug')}/{row.get('slug')}" for row in rows)
    expected = [f"{PUBLIC_ORG}/{slug}" for slug in PUBLIC_COMPOSITIONS]
    checks.expect(listed.status_code == 200, f"a visitor lists the public compositions ({describe(listed)})")
    checks.expect(body.get("total") == 2 and names == expected, f"the public list holds {expected} ({body.get('total')}: {names})")

    base = f"/v1/organizations/{PUBLIC_ORG}/compositions"
    public = lab.call("GET", f"{base}/{PUBLIC_COMPOSITIONS[1]}")
    checks.expect(
        public.status_code == 200 and mapping(body_of(public)).get("visibility") == "public",
        f"a visitor reads the public composition {PUBLIC_COMPOSITIONS[1]} ({describe(public)})",
    )
    hidden = lab.call("GET", f"{base}/{PRIVATE_COMPOSITION}")
    missing = lab.call("GET", f"{base}/smoke-{lab.run_id}-missing")
    checks.expect(
        hidden.status_code == 404 and code_of(hidden) == "not_found",
        f"the private composition {PRIVATE_COMPOSITION} is not found ({describe(hidden)})",
    )
    checks.expect(hidden.content == missing.content, "the private composition answers the body of a missing one")
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


def sphere_revision(lab: Lab) -> Mapping[str, Any] | None:
    """Revision 2 of the seeded SPHERE problem as the owner reads it, or ``None`` when the seed skipped SPHERE."""
    if not hasattr(lab, "_sphere_revision"):
        response = lab.call("GET", f"{SPHERE_PROBLEM}/revisions", "owner")
        listing = body_of(response) if response.status_code == 200 else []
        found = [mapping(item) for item in listing if mapping(item).get("revision") == 2] if isinstance(listing, list) else []
        lab._sphere_revision = found[0] if found else None  # type: ignore[attr-defined]
    return lab._sphere_revision  # type: ignore[attr-defined]


def step_sphere_candidates(lab: Lab) -> Checks:
    checks = lab.begin()
    revision = sphere_revision(lab)
    if not checks.expect(revision is not None, "tomatometer-email has a revision 2"):
        return checks
    checks.expect(revision.get("origin") == "sphere", f"revision 2 came from SPHERE ({revision.get('origin')})")
    checks.expect(bool(mapping(revision.get("sphere")).get("sources")), "the revision names the pricings it was read from")
    compilation = lab.call("GET", f"{SPHERE_PROBLEM}/revisions/2/compilation", "owner")
    compiled = mapping(body_of(compilation))
    if not checks.expect(compilation.status_code == 200 and compiled.get("id"), f"revision 2 compiles ({describe(compilation)})"):
        return checks
    facts = mapping(body_of(lab.call("GET", f"{SPHERE_PROBLEM}/revisions/2/compilations/{compiled['id']}/facts", "owner")))
    generated = [mapping(item) for item in facts.get("candidates") or [] if mapping(item).get("provenance")]
    checks.expect(len(generated) >= 5, f"generated candidates carry provenance ({len(generated)})")
    priced = [item for item in generated
              if mapping(mapping(mapping(item.get("origins")).get("subscription")).get("source")).get("kind") == "priced"]
    checks.expect(priced, "a generated candidate's subscription is priced from SPHERE")
    checks.note(f"{len(generated)} candidates from SPHERE")
    return checks


def step_sphere_engines(lab: Lab) -> Checks:
    checks = lab.begin()
    revision = sphere_revision(lab)
    if not checks.expect(revision is not None and revision.get("id"), "tomatometer-email has a revision 2"):
        return checks
    compiled = mapping(body_of(lab.call("GET", f"{SPHERE_PROBLEM}/revisions/2/compilation", "owner")))
    facts = mapping(body_of(lab.call("GET", f"{SPHERE_PROBLEM}/revisions/2/compilations/{compiled.get('id')}/facts", "owner")))
    eligible = {
        item["candidate"] for task in facts.get("tasks") or [] if mapping(task).get("id") == "dailySummary"
        for item in mapping(task).get("eligible") or [] if isinstance(item, Mapping)
    }
    modes = [mapping(item) for item in compiled.get("compatible_modes") or []]
    chosen: dict[str, str] = {}
    for engine, mode, options in SPHERE_ENGINES:
        match = next((item for item in modes if item.get("compatible") and mapping(item.get("engine")).get("name") == engine
                      and item.get("mode") == mode), None)
        if not checks.expect(match is not None, f"{engine}/{mode} is compatible"):
            continue
        accepted = lab.call("POST", RUNS, "owner", json={
            "revision": revision["id"], "engine": match["engine"], "registration": match["registration"],
            "mode": mode, "options": options, "optimization": SPHERE_OPTIMIZATION,
        })
        job_id = mapping(body_of(accepted)).get("id")
        if not checks.expect(accepted.status_code == 202 and isinstance(job_id, str), f"{engine} launch ({describe(accepted)})"):
            continue
        state, job = lab.wait_for_job("owner", job_id)
        if not checks.expect(state == "completed", f"{engine} completes (got {state})"):
            continue
        solutions = mapping(job.get("result")).get("solutions") or []
        binding = mapping(mapping(mapping(solutions[0]).get("decision")).get("binding")) if solutions else {}
        email = mapping(binding.get("dailySummary"))
        key = f"{email.get('resource')}/{email.get('id')}"
        checks.expect(key in eligible, f"{engine} binds an eligible e-mail candidate ({key})")
        chosen[engine] = key
    checks.expect(len(set(chosen.values())) <= 1, f"the engines agree on the e-mail candidate ({chosen})")
    checks.note(", ".join(f"{engine}: {key}" for engine, key in chosen.items()))
    return checks


# --------------------------------------------------------------------------
# The operation of TomatoMeter (F4): the feed, the lab's consumer and Mailpit
# --------------------------------------------------------------------------


def derived_feed_key(password: str, environment: str = "production") -> str:
    """The seed's feed key of a lab-main/tomatometer environment (``seed_lab.feed_key_for``, by HMAC of the
    password); the smoke derives it, as the live walks do, and never reads the hand-off file."""
    message = f"openbinding-lab-seed:feedkey:{ORG}/tomatometer/{environment}".encode()
    digest = hmac.new(password.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return f"obe_{digest[:8]}_{digest[8:]}"


def derived_api_key(password: str, username: str) -> str:
    """A synthetic user's personal key as the seed derives it (``seed_lab.api_key_for``)."""
    digest = hmac.new(password.encode("utf-8"), f"openbinding-lab-seed:apikey:{username}".encode(), hashlib.sha256)
    hexed = digest.hexdigest()
    return f"obk_{hexed[:8]}_{hexed[8:]}"


def feed_key(lab: Lab) -> str:
    key = derived_feed_key(lab.config.password)
    lab.redact.add(key)
    return key


def read_feed(lab: Lab, **headers: str) -> httpx.Response:
    return lab.call("GET", FEED, headers={"X-API-Key": feed_key(lab), **headers})


def content_tag(lab: Lab, label: str) -> tuple[str | None, bytes]:
    content = lab.call("GET", f"{TOMATOMETER}/versions/{label}/content", "owner")
    return content.headers.get("ETag"), content.content


def adopt(lab: Lab, user: str, label: str, *, if_match: bool = True) -> httpx.Response:
    headers = {}
    if if_match:
        headers["If-Match"] = lab.call("GET", PRODUCTION, user).headers.get("ETag", "")
    return lab.call("POST", f"{PRODUCTION}/adopt", user, headers=headers,
                    json={"version": label, "note": "smoke_lab"})


def consumer_state(lab: Lab) -> Mapping[str, Any]:
    response = lab.client.get(f"{FEED_CONSUMER}/state", timeout=10.0)
    return mapping(body_of(response)) if response.status_code == 200 else {}


def wait_for_provider(lab: Lab, provider: str | None, within_s: float) -> Mapping[str, Any]:
    """The consumer's state once it follows ``provider`` (any provider when ``None``), or the last state seen."""
    deadline = lab.clock() + within_s
    state: Mapping[str, Any] = {}
    while True:
        state = consumer_state(lab)
        if state.get("status") == "following" and (provider is None or state.get("provider") == provider):
            return state
        if lab.clock() >= deadline:
            return state
        lab.sleep(1.0)


def send_summary(lab: Lab, checks: Checks, provider: str, adoption: str) -> str | None:
    """Ask the consumer for the daily summary and find it in Mailpit with the provider's tag and headers."""
    sent = lab.client.post(f"{FEED_CONSUMER}/send", json={}, timeout=15.0)
    body = mapping(body_of(sent))
    if not checks.expect(sent.status_code == 200 and body.get("provider") == provider,
                         f"the consumer mails through {provider} ({sent.status_code} {body.get('provider')})"):
        return None
    identifier = body.get("messageId")
    message = mapping(body_of(lab.client.get(f"{MAILPIT_API}/message/{identifier}", timeout=10.0)))
    tags = list(message.get("Tags") or [])
    checks.expect(f"provider-{provider}" in tags and f"adoption-{adoption}" in tags,
                  f"Mailpit's message is tagged provider-{provider} and adoption-{adoption} ({tags})")
    headers = mapping(body_of(lab.client.get(f"{MAILPIT_API}/message/{identifier}/headers", timeout=10.0)))
    checks.expect(list(headers.get("X-Openbinding-Provider") or headers.get("X-OpenBinding-Provider") or []) == [provider],
                  f"the message says X-OpenBinding-Provider: {provider}")
    found = mapping(body_of(lab.client.get(f"{MAILPIT_API}/search", params={"query": f"tag:provider-{provider}"},
                                          timeout=10.0)))
    ids = [mapping(item).get("ID") for item in found.get("messages") or []]
    checks.expect(identifier in ids, f"Mailpit's search tag:provider-{provider} finds it")
    checks.note(f"{message.get('Subject')} tags={tags}")
    return identifier


def step_environment_feed(lab: Lab) -> Checks:
    checks = lab.begin()
    read = read_feed(lab)
    tag, content = content_tag(lab, "1.0.0")
    if not checks.expect(read.status_code == 200, f"the seed's feed key reads production's feed ({describe(read)})"):
        return checks
    etag = read.headers.get("ETag")
    checks.expect(bool(etag) and etag == tag, f"the feed's ETag is 1.0.0's content ETag ({etag})")
    checks.expect(read.content == content, "the feed's bytes are 1.0.0's content")
    checks.expect(read.headers.get("OpenBinding-Composition-Version") == "1.0.0", "the feed says version 1.0.0")
    cached = read_feed(lab, **{"If-None-Match": etag or ""})
    checks.expect(cached.status_code == 304 and cached.headers.get("ETag") == etag
                  and "X-API-Key" in (cached.headers.get("Vary") or ""),
                  f"If-None-Match gives a 304 that keeps ETag and Vary through nginx ({describe(cached)})")
    outsider = lab.call("GET", FEED, headers={"X-API-Key": derived_api_key(lab.config.password, USERS["outsider"])})
    checks.expect(outsider.status_code == 404, f"the outsider's personal key is a 404 ({describe(outsider)})")
    anonymous = lab.call("GET", FEED)
    checks.expect(anonymous.status_code == 401, f"no credential is a 401 ({describe(anonymous)})")
    elsewhere = lab.call("GET", "/v1/users/me", headers={"X-API-Key": feed_key(lab)})
    checks.expect(elsewhere.status_code == 401 and code_of(elsewhere) == "environment_key_elsewhere",
                  f"the feed key opens nothing else ({describe(elsewhere)})")
    reevaluated = lab.call("POST", f"{TOMATOMETER}/versions/1.0.0/evaluations", "owner")
    checks.expect(reevaluated.status_code in (200, 201), f"1.0.0 is re-evaluated ({describe(reevaluated)})")
    again = read_feed(lab)
    checks.expect(again.headers.get("ETag") == etag, "re-evaluating 1.0.0 leaves the feed's ETag")
    production = mapping(body_of(lab.call("GET", PRODUCTION, "owner")))
    pinned = mapping(mapping(production.get("inEffect")).get("evaluation")).get("id")
    margins = lab.call("GET", f"{TOMATOMETER}/versions/1.0.0/margins", "owner",
                       params={"users": 1000, "evaluation": pinned})
    answer = mapping(body_of(margins))
    rows = [mapping(row) for row in answer.get("rows") or []]
    basic = next((row for row in rows if row.get("plan") == "basic" and not row.get("addOns")), {})
    checks.expect(margins.status_code == 200 and answer.get("status") == "ok" and len(rows) == 7,
                  f"margins of the pinned evaluation at 1000 users ({answer.get('status')}, {len(rows)} rows)")
    checks.expect(str(basic.get("margin", "")).startswith("-"), f"basic's margin is negative ({basic.get('margin')})")
    checks.note(f"feed 200 {etag}, 304 {cached.headers.get('ETag')}; costPerUser {answer.get('costPerUser')}")
    return checks


def step_adopt_switches_provider(lab: Lab) -> Checks:
    checks = lab.begin()
    state = wait_for_provider(lab, None, CONSUMER_READY_S)
    if not checks.expect(state.get("provider") == "brevo",
                         f"the feed consumer follows Brevo ({state.get('status')}, {state.get('provider')})"):
        return checks
    send_summary(lab, checks, "brevo", str(state.get("adoption")))
    adopted = adopt(lab, "owner", "1.1.0")
    if not checks.expect(adopted.status_code == 200, f"lab-owner adopts 1.1.0 with If-Match ({describe(adopted)})"):
        return checks
    tag, _ = content_tag(lab, "1.1.0")
    switched = read_feed(lab)
    checks.expect(switched.status_code == 200 and switched.headers.get("ETag") == tag,
                  f"the feed's ETag is now 1.1.0's ({switched.headers.get('ETag')})")
    state = wait_for_provider(lab, "resend", CONSUMER_SWITCH_S)
    if checks.expect(state.get("provider") == "resend" and state.get("version") == "1.1.0",
                     f"the consumer follows Resend within {CONSUMER_SWITCH_S:.0f} s ({state.get('provider')})"):
        send_summary(lab, checks, "resend", str(state.get("adoption")))
    unconditional = adopt(lab, "owner", "1.0.0", if_match=False)
    checks.expect(unconditional.status_code == 428 and code_of(unconditional) == "precondition_required",
                  f"an adopt without If-Match is 428 ({describe(unconditional)})")
    member = adopt(lab, "member", "1.0.0")
    checks.expect(member.status_code == 403, f"lab-member may not adopt in production ({describe(member)})")
    checks.note(f"feed 200 {switched.headers.get('ETag')} after the adoption")
    return checks


def step_restore_operation(lab: Lab) -> Checks:
    checks = lab.begin()
    restored = adopt(lab, "owner", "1.0.0")
    if not checks.expect(restored.status_code == 200, f"lab-owner adopts 1.0.0 again ({describe(restored)})"):
        return checks
    tag, _ = content_tag(lab, "1.0.0")
    read = read_feed(lab)
    checks.expect(read.headers.get("ETag") == tag, "the feed serves 1.0.0's ETag again")
    state = wait_for_provider(lab, "brevo", CONSUMER_SWITCH_S)
    if checks.expect(state.get("provider") == "brevo", f"the consumer follows Brevo again ({state.get('provider')})"):
        send_summary(lab, checks, "brevo", str(state.get("adoption")))
    return checks


# --------------------------------------------------------------------------
# Upstream events and proposals (F6): a new upstream version from the lab's SPHERE stand-in
# --------------------------------------------------------------------------

#: The stand-in's control port, inside the compose network only (no published port; nginx never proxies it).
SPHERE_LAB_CONTROL = "http://sphere-lab:8081"
STAND_IN_HOST = "sphere-lab"
#: The scenario step 19 publishes (TomatoMeter 1.2.0: Basic gains Daily summary and a price of 0.99).
OFFERING_SCENARIO = "tomatometer-1.2.0"
OFFERING_LABEL = "1.2.0"
TOMATOMETER_MANIFEST = "/api/v1/public/pricings/6ab0a323697330667ccce8cd"
UPSTREAM_EVENTS = f"{TOMATOMETER}/upstream-events"
PROPOSALS = f"{TOMATOMETER}/proposals"
ORG_PROPOSALS = f"/v1/organizations/{ORG}/proposals"
#: Watcher cycles step 19 waits for the event (plus a margin of EVENT_MARGIN_S).
EVENT_CYCLES = 3
EVENT_MARGIN_S = 15.0
#: Basic's revenue per user rises by 0.99 (0.00 -> 0.99, and 1.00 -> 1.99 with extraTimers); the costs do not move.
BASIC_DELTA = Decimal("0.99")
REVIEW_NOTE = "smoke_lab: seen; Basic now earns 0.99 per user in production"


def stand_in(lab: Lab, method: str, path: str) -> httpx.Response:
    return lab.client.request(method, f"{SPHERE_LAB_CONTROL}{path}", timeout=10.0)


def upstream_skip_reason(lab: Lab) -> str | None:
    """Why steps 19-21 cannot run here (asked once), or ``None`` when the lab's SPHERE is the stand-in."""
    if not hasattr(lab, "_upstream_reason"):
        host = urlsplit(lab.config.sphere_url).hostname or ""
        reason: str | None = None
        if host != STAND_IN_HOST:
            reason = f"the lab's SPHERE is {host or 'not configured'}, not the stand-in {STAND_IN_HOST}"
        else:
            try:
                answer = stand_in(lab, "GET", "/_lab/state")
                if answer.status_code != 200:
                    reason = f"the stand-in's control port answers {answer.status_code}"
            except httpx.HTTPError as error:
                reason = f"the stand-in's control port does not answer ({type(error).__name__})"
        if reason is None and not _operation_seeded(lab):
            reason = "the seed made no TomatoMeter environments"
        lab._upstream_reason = reason  # type: ignore[attr-defined]
    return lab._upstream_reason  # type: ignore[attr-defined]


def operation_counts(lab: Lab) -> dict[str, Any]:
    """Production's feed ETag and adoption number, and what only a person's action may add (runs, revisions,
    versions, proposals)."""
    production = mapping(body_of(lab.call("GET", PRODUCTION, "owner")))
    revisions = body_of(lab.call("GET", f"{SPHERE_PROBLEM}/revisions", "owner"))
    proposals = mapping(body_of(lab.call("GET", PROPOSALS, "owner", params={"limit": 100}))).get("proposals")
    return {
        "feedEtag": read_feed(lab).headers.get("ETag"),
        "adoption": mapping(production.get("inEffect")).get("adoption"),
        "runs": mapping(body_of(lab.call("GET", RUNS, "owner", params={"limit": 1}))).get("total"),
        "revisions": len(revisions) if isinstance(revisions, list) else None,
        "versions": mapping(body_of(lab.call("GET", f"{TOMATOMETER}/versions", "owner", params={"limit": 1}))).get("total"),
        "proposals": len(proposals) if isinstance(proposals, list) else None,
    }


def manifest_304s(lab: Lab) -> int:
    requests = mapping(mapping(body_of(stand_in(lab, "GET", "/_lab/state"))).get("requests"))
    return int(mapping(requests.get(TOMATOMETER_MANIFEST)).get("304") or 0)


def offering_event(lab: Lab) -> Mapping[str, Any] | None:
    """lab-main/tomatometer's offering event for TomatoMeter 1.2.0, in any state, or ``None``."""
    listing = mapping(body_of(lab.call("GET", UPSTREAM_EVENTS, "owner", params={"subject": "offering", "limit": 100})))
    for event in listing.get("events") or []:
        event = mapping(event)
        if mapping(event.get("new")).get("label") == OFFERING_LABEL:
            return event
    return None


def margin_deltas(environment: Mapping[str, Any]) -> list[tuple[str, tuple[str, ...], Decimal | None]]:
    """Each margin row of an environment as (plan, add-ons, after - before); ``None`` when a side has no margin."""
    def rows(side: str) -> dict[tuple[str, tuple[str, ...]], Any]:
        found = mapping(environment.get(side)).get("rows") or []
        return {(str(mapping(row).get("plan")), tuple(mapping(row).get("addOns") or [])): mapping(row).get("margin")
                for row in found}

    before, after = rows("before"), rows("after")
    deltas = []
    for key in sorted(set(before) | set(after)):
        try:
            delta: Decimal | None = Decimal(str(after[key])) - Decimal(str(before[key]))
        except (KeyError, InvalidOperation):
            delta = None
        deltas.append((key[0], key[1], delta))
    return deltas


def step_upstream_offering_event(lab: Lab) -> Checks:
    checks = lab.begin()
    before = operation_counts(lab)
    lab.feed_etags = [before["feedEtag"]]  # type: ignore[attr-defined]
    deadline = lab.clock() + 2 * lab.config.upstream_interval_s + EVENT_MARGIN_S
    revalidated = manifest_304s(lab)
    while revalidated < 1 and lab.clock() < deadline:
        lab.sleep(2.0)
        revalidated = manifest_304s(lab)
    checks.expect(revalidated >= 1, f"the watcher had revalidated TomatoMeter's manifest with a 304 ({revalidated})")
    published = stand_in(lab, "POST", f"/_lab/publish/{OFFERING_SCENARIO}")
    status = mapping(body_of(published)).get("status")
    if not checks.expect(published.status_code == 200 and status in {"published", "already_published"},
                         f"the stand-in publishes {OFFERING_SCENARIO} ({published.status_code} {status})"):
        return checks
    again = status == "already_published"
    if again:
        checks.note(f"{OFFERING_SCENARIO} was published on this lab before: the event it made is checked")
    deadline = lab.clock() + EVENT_CYCLES * lab.config.upstream_interval_s + EVENT_MARGIN_S
    event = offering_event(lab)
    while event is None and lab.clock() < deadline:
        lab.sleep(2.0)
        event = offering_event(lab)
    if not checks.expect(event is not None,
                         f"an offering event for TomatoMeter {OFFERING_LABEL} within {EVENT_CYCLES} watcher cycles"):
        return checks
    assert event is not None
    lab.offering_event_id = event.get("id")  # type: ignore[attr-defined]
    checks.expect(event.get("category") == "offering_changed" and event.get("subject") == "offering"
                  and event.get("notify") is True,
                  f"it is a told offering_changed event ({event.get('category')}, notify {event.get('notify')})")
    checks.expect(again or event.get("state") == "open", f"it is open ({event.get('state')})")
    checks.expect("production" in list(event.get("environments") or []), "it names production")
    detail = mapping(body_of(lab.call("GET", f"{UPSTREAM_EVENTS}/{event.get('id')}", "owner")))
    margins = mapping(mapping(detail.get("diff")).get("margins"))
    production = next((mapping(item) for item in margins.get("environments") or []
                       if mapping(item).get("environment") == "production"), {})
    deltas = margin_deltas(production)
    basic = [delta for plan, _, delta in deltas if plan == "basic"]
    others = [delta for plan, _, delta in deltas if plan != "basic"]
    checks.expect(len(basic) == 2 and all(delta == BASIC_DELTA for delta in basic),
                  f"production's Basic rows move by +0.99 per user ({[str(d) for d in basic]})")
    checks.expect(others and all(delta is not None and f"{delta:.6f}" == "0.000000" for delta in others),
                  f"every other row of production moves by 0.000000 ({[str(d) for d in others]})")
    checks.expect(production.get("users") == 1000, f"at production's 1000 expected users ({production.get('users')})")
    after = operation_counts(lab)
    lab.feed_etags.append(after["feedEtag"])  # type: ignore[attr-defined]
    checks.expect(after == before, f"the feed's ETag, the adoption and the counts are unchanged ({before} -> {after})")
    checks.note(f"event {event.get('id')} {event.get('category')} {mapping(event.get('old')).get('label')} -> "
                f"{OFFERING_LABEL}; E0 {before['feedEtag']}; 304s before the publish {revalidated}")
    return checks


def step_upstream_review(lab: Lab) -> Checks:
    checks = lab.begin()
    event_id = getattr(lab, "offering_event_id", None) or mapping(offering_event(lab)).get("id")
    if not checks.expect(bool(event_id), f"the offering event of TomatoMeter {OFFERING_LABEL} exists (step 19)"):
        return checks
    event_path = f"{UPSTREAM_EVENTS}/{event_id}"
    start = mapping(body_of(lab.call("GET", event_path, "owner"))).get("state")
    viewer = lab.call("POST", f"{event_path}/review", "viewer", json={"note": "viewer"})
    checks.expect(viewer.status_code == 403, f"lab-viewer may not review it ({describe(viewer)})")
    resolving = lab.call("POST", f"{event_path}/review", "owner", json={"state": "resolved"})
    checks.expect(resolving.status_code == 422, f"a review that asks for state: resolved is refused ({describe(resolving)})")
    if start == "open":
        reviewed = lab.call("POST", f"{event_path}/review", "owner", json={"note": REVIEW_NOTE})
        body = mapping(body_of(reviewed))
        checks.expect(reviewed.status_code == 200 and body.get("state") == "reviewed" and body.get("note") == REVIEW_NOTE
                      and mapping(body.get("reviewedBy")).get("username") == USERS["owner"],
                      f"lab-owner's review with a note makes it reviewed ({describe(reviewed)} {body.get('state')})")
    else:
        checks.note(f"the event was already {start} on this lab")
    twice = lab.call("POST", f"{event_path}/review", "owner", json={"note": "again"})
    checks.expect(twice.status_code == 409 and code_of(twice) == "event_not_reviewable",
                  f"a second review is refused ({describe(twice)})")
    for method, path in (("POST", f"{event_path}/resolve"), ("PATCH", event_path), ("PUT", event_path)):
        answer = lab.call(method, path, "owner", json={"state": "resolved"})
        checks.expect(answer.status_code in (404, 405), f"no route resolves an event: {method} {path[-40:]} "
                                                        f"({describe(answer)})")
    final = mapping(body_of(lab.call("GET", event_path, "owner")))
    checks.expect(final.get("state") == "reviewed" and final.get("resolvedBy") is None,
                  f"the offering event ends reviewed, never resolved ({final.get('state')})")
    etags = getattr(lab, "feed_etags", None)
    current = read_feed(lab).headers.get("ETag")
    if etags:
        checks.expect(current == etags[-1], f"the review leaves the feed's ETag ({current})")
        etags.append(current)
    return checks


def step_proposal_adopt(lab: Lab) -> Checks:
    checks = lab.begin()
    etags = getattr(lab, "feed_etags", None) or []
    first_tag, _ = content_tag(lab, "1.0.0")
    switched_tag, _ = content_tag(lab, "1.1.0")
    start = read_feed(lab).headers.get("ETag")
    etags.append(start)
    if not checks.expect(start == first_tag, f"production starts on 1.0.0 ({start})"):
        return checks
    created = lab.call("POST", PROPOSALS, "owner",
                       json={"kind": "adopt", "environment": "production", "version": "1.1.0", "note": "smoke_lab proposal"})
    proposal = mapping(body_of(created))
    steps = [mapping(step) for step in proposal.get("steps") or []]
    if not checks.expect(created.status_code == 201 and proposal.get("status") == "pending"
                         and [step.get("kind") for step in steps] == ["adopt"],
                         f"lab-owner proposes adopting 1.1.0 in production ({describe(created)})"):
        return checks
    confirmed = lab.call("POST", f"{ORG_PROPOSALS}/{proposal.get('id')}/confirm", "owner", json={})
    done = mapping(body_of(confirmed))
    checks.expect(confirmed.status_code == 200 and done.get("status") == "completed"
                  and [mapping(step).get("status") for step in done.get("steps") or []] == ["done"],
                  f"confirming it completes it ({describe(confirmed)} {done.get('status')})")
    adopted = read_feed(lab).headers.get("ETag")
    etags.append(adopted)
    checks.expect(adopted == switched_tag, f"the feed's ETag is now 1.1.0's ({adopted})")
    history = [mapping(row) for row in mapping(body_of(lab.call("GET", f"{PRODUCTION}/adoptions", "owner"))).get(
        "adoptions") or []]
    newest = history[0] if history else {}
    checks.expect(newest.get("source") == "proposal" and mapping(newest.get("proposal")).get("id") == proposal.get("id")
                  and mapping(newest.get("version")).get("label") == "1.1.0",
                  f"the adoption history says source: proposal ({newest.get('source')})")
    stale = lab.call("POST", PROPOSALS, "owner",
                     json={"kind": "adopt", "environment": "production", "version": "1.0.0", "note": "smoke_lab stale"})
    second = mapping(body_of(stale))
    if not checks.expect(stale.status_code == 201 and second.get("status") == "pending",
                         f"a second proposal adopts 1.0.0 ({describe(stale)})"):
        return checks
    direct = adopt(lab, "owner", "1.0.0")
    checks.expect(direct.status_code == 200, f"a direct adoption of 1.0.0 moves production first ({describe(direct)})")
    moved = read_feed(lab).headers.get("ETag")
    etags.append(moved)
    adoption = mapping(mapping(body_of(lab.call("GET", PRODUCTION, "owner"))).get("inEffect")).get("adoption")
    refused = lab.call("POST", f"{ORG_PROPOSALS}/{second.get('id')}/confirm", "owner", json={})
    checks.expect(refused.status_code == 409 and code_of(refused) == "proposal_stale",
                  f"confirming the second proposal is refused as stale ({describe(refused)})")
    status = mapping(body_of(lab.call("GET", f"{ORG_PROPOSALS}/{second.get('id')}", "owner"))).get("status")
    checks.expect(status == "stale", f"the second proposal is stale ({status})")
    end = read_feed(lab).headers.get("ETag")
    etags.append(end)
    after = mapping(mapping(body_of(lab.call("GET", PRODUCTION, "owner"))).get("inEffect")).get("adoption")
    checks.expect(end == moved == first_tag and after == adoption,
                  f"nothing changed: production stays on 1.0.0 with adoption #{adoption} ({end}, #{after})")
    state = wait_for_provider(lab, "brevo", CONSUMER_SWITCH_S)
    checks.expect(state.get("provider") == "brevo", f"the consumer follows Brevo again ({state.get('provider')})")
    checks.note("feed ETags " + " -> ".join(str(tag) for tag in etags))
    return checks


def _operation_seeded(lab: Lab) -> bool:
    """Whether the seed made TomatoMeter's production environment (an environment view answers its slug); asked once."""
    if not hasattr(lab, "_operation_seeded"):
        try:
            response = lab.call("GET", PRODUCTION, "owner")
            seeded = response.status_code == 200 and mapping(body_of(response)).get("slug") == "production"
        except (StepError, RemoteBlocked, httpx.HTTPError):
            seeded = False
        lab._operation_seeded = seeded  # type: ignore[attr-defined]
    return lab._operation_seeded  # type: ignore[attr-defined]


STEPS: dict[int, tuple[str, Callable[[Lab], Checks]]] = {
    1: ("proxy_and_spa", step_proxy_and_spa),
    2: ("login", step_login),
    3: ("upload", step_upload),
    4: ("owner_job", step_owner_job),
    5: ("study", step_study),
    6: ("idempotency", step_idempotency),
    7: ("authorization", step_authorization),
    8: ("concurrency_limit", step_concurrency_limit),
    9: ("cors", step_cors),
    10: ("body_limit", step_body_limit),
    11: ("login_throttle", step_login_throttle),
    12: ("plan_usage", step_plan_usage),
    13: ("public_compositions", step_public_compositions),
    14: ("sphere_candidates", step_sphere_candidates),
    15: ("sphere_engines", step_sphere_engines),
    16: ("environment_feed", step_environment_feed),
    17: ("adopt_switches_provider", step_adopt_switches_provider),
    18: ("restore_operation", step_restore_operation),
    19: ("upstream_offering_event", step_upstream_offering_event),
    20: ("upstream_review", step_upstream_review),
    21: ("proposal_adopt", step_proposal_adopt),
}
#: The steps that need the seed's SPHERE problem.
SPHERE_STEPS = (14, 15)
#: The steps that need the seed's TomatoMeter environments (F4), in this order: 17 adopts, 18 restores.
OPERATION_STEPS = (16, 17, 18)
#: The steps that need the lab's SPHERE stand-in (F6), in this order: 19 publishes, 20 reviews, 21 proposes.
UPSTREAM_STEPS = (19, 20, 21)


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
    reasons: dict[str, str] = {}
    for number in RUN_ORDER:
        name = STEPS[number][0]
        if number in config.skip or (number == 12 and not config.with_space):
            skipped.append(name)
            continue
        if config.only is not None and number not in config.only:
            skipped.append(name)
            continue
        if number in SPHERE_STEPS and not _sphere_seeded(lab):
            skipped.append(name)
            continue
        if number in OPERATION_STEPS and not _operation_seeded(lab):
            skipped.append(name)
            continue
        if number in UPSTREAM_STEPS and upstream_skip_reason(lab) is not None:
            skipped.append(name)
            reasons[name] = upstream_skip_reason(lab) or ""
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
        "skipReasons": reasons,
        "elapsedS": round(clock() - started, 1),
        "steps": steps,
    }


def _sphere_seeded(lab: Lab) -> bool:
    try:
        return sphere_revision(lab) is not None
    except (StepError, RemoteBlocked, httpx.HTTPError):
        return False


def parse_skip(value: str) -> frozenset[int]:
    names = {name: number for number, (name, _) in STEPS.items()}
    skipped: set[int] = set()
    for item in (part.strip() for part in value.split(",") if part.strip()):
        number = int(item) if item.isdigit() else names.get(item)
        if number not in SKIPPABLE:
            raise argparse.ArgumentTypeError(f"only steps {SKIPPABLE} can be skipped, not {item!r}")
        skipped.add(number)
    return frozenset(skipped)


def parse_steps(value: str) -> frozenset[int]:
    names = {name: number for number, (name, _) in STEPS.items()}
    chosen: set[int] = set()
    for item in (part.strip() for part in value.split(",") if part.strip()):
        number = int(item) if item.isdigit() else names.get(item)
        if number not in STEPS:
            raise argparse.ArgumentTypeError(f"no step {item!r}")
        chosen.add(number)
    return frozenset(chosen)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="API smoke test of the lab demo through the nginx proxy.")
    parser.add_argument("--base-url", default=None, help=f"proxy origin (default $SMOKE_BASE_URL or {DEFAULT_BASE_URL})")
    parser.add_argument("--skip", type=parse_skip, default=frozenset(), help="optional steps to leave out: numbers or names among 8-11")
    parser.add_argument("--steps", type=parse_steps, default=None, help="run only these steps: numbers or names")
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
    try:
        upstream_interval_s = float(source.get("UPSTREAM_POLL_INTERVAL_S") or 300)
    except ValueError:
        upstream_interval_s = 300.0
    config = Config(
        base_url=base_url, password=password, origin=args.origin, evil_origin=args.evil_origin,
        job_timeout_s=args.job_timeout, max_concurrent=args.max_concurrent, skip=args.skip, with_space=args.with_space,
        only=args.steps, sphere_url=source.get("SPHERE_URL", ""), upstream_interval_s=upstream_interval_s,
    )
    with httpx.Client(base_url=base_url, transport=transport, follow_redirects=False) as client:
        report = run_smoke(config, client, sleep=sleep)
    print(Redactor([password])(json.dumps(report, indent=2)))
    if report["ok"]:
        return EXIT_OK
    return EXIT_BLOCKED if report["failed"] == 0 and report["blocked"] else EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
