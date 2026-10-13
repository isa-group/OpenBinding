"""smoke_lab: each step's logic, secret redaction and exit codes, against a simulated gateway.

Nothing here opens a socket: ``FakeLab`` answers through ``httpx.MockTransport`` and mimics what the
gateway and the nginx proxy answer (shapes read from routes/ and the existing tests). A ``fault`` makes
it misbehave in one way so each step is shown to fail when, and only when, it should.
"""

from __future__ import annotations

import json
import threading
import uuid
from collections import Counter

import httpx
import pytest

import smoke_lab

PASSWORD = "synthetic-smoke-password-1"
ORIGIN = "http://localhost:18100"
INDEX = "<!doctype html><html><head></head><body><div id=root></div><script src=/assets/app.js></script></body></html>"
ROLES = {"lab-owner": "OWNER", "lab-member": "MEMBER", "lab-viewer": "VIEWER"}
LIMIT = 3
ALL_STEPS = [
    "proxy_and_spa", "login", "owner_job", "idempotency", "authorization",
    "concurrency_limit", "cors", "body_limit", "plan_usage", "login_throttle",
]


class FakeLab:
    """The proxy plus the gateway, as far as the smoke test can tell."""

    def __init__(self, *faults: str) -> None:
        self.faults = set(faults)
        self.lock = threading.Lock()
        self.requests: list[tuple[str, str]] = []
        self.tokens: dict[str, str] = {}
        self.issued = 0
        self.login_hits: Counter[str] = Counter()
        self.snapshots = {"snap-seed": "lab-owner"}
        self.jobs: dict[str, dict] = {}
        self.keys: dict[tuple[str, str], tuple[str, str]] = {}
        self.project_jobs: list[dict] = []
        self.studies: set[str] = set()

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        with self.lock:
            self.requests.append((request.method, request.url.path))
            return self.route(request)

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def reply(status: int, body=None, headers=None, media="application/json") -> httpx.Response:
        content = json.dumps(body).encode() if body is not None else b""
        return httpx.Response(status, content=content, headers={"content-type": media, **(headers or {})})

    def problem(self, status: int, code: str, headers=None) -> httpx.Response:
        return self.reply(status, {"type": code, "title": code, "status": status, "code": code, "detail": code}, headers,
                          media="application/problem+json")

    def user_of(self, request: httpx.Request) -> str | None:
        header = request.headers.get("authorization", "")
        return self.tokens.get(header.removeprefix("Bearer ")) if header.startswith("Bearer ") else None

    def role_in_org(self, user: str | None) -> str | None:
        return ROLES.get(user or "")

    # -- routing -----------------------------------------------------------

    def route(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if "explode" in self.faults and path == "/healthz":
            raise RuntimeError(f"connection failed for {PASSWORD}")
        if path == "/healthz":
            return httpx.Response(200, text="ok\n", headers={"content-type": "text/plain"})
        if not path.startswith("/api/"):
            if "spa_404" in self.faults and path != "/":
                return httpx.Response(404, text="not found")
            return httpx.Response(200, text=INDEX, headers={"content-type": "text/html"})
        sub = path.removeprefix("/api")
        user = self.user_of(request)

        if sub == "/health/ready":
            return self.reply(200, {"status": "ready", "dependencies": {}})
        if sub == "/health/live":
            return self.reply(200, {"status": "ok"}, self.cors_headers(request, simple=True))
        if sub == "/v1/auth/login" and method == "POST":
            return self.login(request)
        if method == "OPTIONS":
            return self.preflight(request)
        if sub == "/v1/examples/demo/01_simple_seq":
            return httpx.Response(200, content=b"PK-example", headers={"content-type": "application/vnd.bim+zip"})
        if user is None:
            return self.problem(401, "unauthorized")
        if sub == "/v1/users/me":
            return self.reply(200, {"username": user, "role": "admin" if user == "lab-admin" else "user"})
        if sub == "/v1/users/me/usage":
            return self.usage()
        if sub.startswith("/v1/admin/"):
            allowed = user == "lab-admin" or "admin_open" in self.faults
            return self.reply(200, {"users": 6}) if allowed else self.problem(403, "forbidden")
        if sub == "/v1/engines":
            return self.reply(200, {"engines": [{"name": "random-search", "namespace": "bim.builtin", "version": "1.0.0", "digest": "sha256-e"}]})
        if sub.startswith("/v1/organizations"):
            return self.organizations(request, sub, user)
        if sub == "/v1/instances" and method == "POST":
            snapshot = f"snap-{len(self.snapshots)}"
            self.snapshots[snapshot] = user
            return self.reply(201, {"id": snapshot})
        if sub.startswith("/v1/instances/"):
            return self.reply(200, {}) if self.snapshots.get(sub.rsplit("/", 1)[-1]) == user else self.problem(404, "not_found")
        if sub == "/v1/jobs" and method == "POST":
            return self.create_job(request, user)
        if sub.startswith("/v1/jobs/"):
            return self.job(sub, method, user)
        return self.problem(404, "not_found")

    def login(self, request: httpx.Request) -> httpx.Response:
        if len(request.content) > smoke_lab.JSON_LIMIT_BYTES and "no_body_limit" not in self.faults:
            if "hang" in self.faults:
                raise httpx.ReadTimeout("timed out")
            return self.problem(413, "payload_too_large")
        body = json.loads(request.content)
        name = body["username_or_email"]
        self.login_hits[name] += 1
        if self.login_hits[name] > 10 and "no_throttle" not in self.faults:
            return self.problem(429, "rate_limit_exceeded", {"Retry-After": "287"})
        known = name.startswith("lab-") and name != smoke_lab.THROTTLE_USER and name not in self.missing_users()
        if not known or body["password"] != PASSWORD:
            return self.problem(401, "invalid_credentials")
        self.issued += 1
        access = f"access-token-{name}-{self.issued}"
        self.tokens[access] = name
        return self.reply(200, {"access_token": access, "refresh_token": f"refresh-token-{name}-{self.issued}",
                                "token_type": "bearer", "expires_in": 900})

    def missing_users(self) -> set[str]:
        return {fault.removeprefix("missing:") for fault in self.faults if fault.startswith("missing:")}

    def cors_headers(self, request: httpx.Request, *, simple: bool = False) -> dict[str, str]:
        origin = request.headers.get("origin", "")
        if origin == ORIGIN or ("cors_open" in self.faults and origin):
            return {"access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE"}
        return {}

    def preflight(self, request: httpx.Request) -> httpx.Response:
        headers = self.cors_headers(request)
        return self.reply(200 if headers else 400, None, headers)

    def usage(self) -> httpx.Response:
        capabilities: dict = {"maxConcurrentJobs": 3, "maxTimeBudgetS": None}
        if "usage_counters" in self.faults:
            capabilities["jobsUsed"] = 2
        return self.reply(200, {"plan": "BASIC", "contract_pending": False, "features": {"solve": True}, "capabilities": capabilities})

    def organizations(self, request: httpx.Request, sub: str, user: str) -> httpx.Response:
        role = self.role_in_org(user)
        if sub == "/v1/organizations":
            return self.reply(200, [{"slug": "lab-main", "effective_role": role}] if role else [])
        if role is None:
            return self.problem(403, "organization_forbidden")
        base = "/v1/organizations/lab-main/projects"
        if sub == base:
            return self.reply(200, [{"slug": "bim-demo"}])
        if sub == f"{base}/bim-demo/cases/simple-seq/revisions":
            return self.reply(200, [{"id": "rev-1", "revision": 1, "source_snapshot_id": "snap-seed"}])
        if sub == f"{base}/bim-demo/jobs":
            return self.reply(200, [self.project_job_view(job, role, request) for job in self.project_jobs
                                    if request.url.params.get("job_id") in (None, job["id"])])
        if sub == f"{base}/bim-demo/studies" and request.method == "POST":
            if role == "VIEWER":
                return self.problem(403, "organization_forbidden")
            slug = json.loads(request.content)["slug"]
            created = slug not in self.studies
            self.studies.add(slug)
            return self.reply(201, {"slug": slug}) if created else self.problem(409, "slug_conflict")
        if sub == f"{base}/bim-demo/studies/smoke-lab/runs" and request.method == "POST":
            if role == "VIEWER":
                return self.problem(403, "organization_forbidden")
            self.project_jobs.append({"id": str(uuid.uuid4()), "project_id": "project-1"})
            return self.reply(202, {"id": "run-1", "state": "running"})
        return self.reply(200, {})

    def project_job_view(self, job: dict, role: str, request: httpx.Request) -> dict:
        options = {"iterations": 10, "seed": 1}
        original = {"bindingProblem": {"kind": "BindingProblem"}, "timeout": 30, "mode": {}, "registration": {"name": "random-search"}}
        provenance = {"registration": {"name": "random-search", "version": "1.0.0"}, "options": options}
        if "leak_viewer" in self.faults:
            options = {**options, "engine_url": "http://engine-random-search:8080"}
            original["auth"] = {"token": "secret"}
            provenance["registration"] = {"name": "random-search", "endpoint": "http://engine:8080"}
        return {"id": job["id"], "status": "completed", "project_id": job["project_id"], "options": options,
                "original_request": original, "provenance": provenance, "result": {"termination": "FEASIBLE", "solutions": []},
                "role": role}

    # -- jobs --------------------------------------------------------------

    def create_job(self, request: httpx.Request, user: str) -> httpx.Response:
        body = json.loads(request.content)
        if self.snapshots.get(body["snapshot"]) != user:
            return self.problem(404, "not_found")
        key = request.headers.get("idempotency-key")
        fingerprint = json.dumps(body, sort_keys=True)
        if key and (user, key) in self.keys and "broken_idempotency" not in self.faults:
            job_id, previous = self.keys[(user, key)]
            if previous != fingerprint:
                return self.problem(409, "idempotency_conflict")
            return self.reply(202, {"id": job_id, "status": "queued", "idempotent": True, "irDigest": "sha256-ir"})
        active = sum(1 for job in self.jobs.values() if job["owner"] == user and job["status"] in {"queued", "running"})
        if active >= LIMIT and "no_limit" not in self.faults:
            return self.problem(429, "concurrency_limit_exceeded", {"Retry-After": "15"})
        job_id = str(uuid.uuid4())
        slow = body["options"].get("iterations", 0) >= 1_000_000
        self.jobs[job_id] = {"owner": user, "status": "queued", "polls": 0, "slow": slow}
        if key:
            self.keys[(user, key)] = (job_id, fingerprint)
        return self.reply(202, {"id": job_id, "status": "queued", "profile": "qos-binding/v1", "irDigest": "sha256-ir"})

    def job(self, sub: str, method: str, user: str) -> httpx.Response:
        parts = sub.split("/")
        job = self.jobs.get(parts[3])
        if job is None or job["owner"] != user:
            return self.problem(404, "not_found")
        if method == "POST" and parts[-1] == "cancel":
            job["status"] = "cancelled"
            return self.reply(200, {"id": parts[3], "status": "cancelled"})
        job["polls"] += 1
        if "stuck" in self.faults:
            job["status"] = "running"
        elif not job["slow"] and job["polls"] >= 2 and job["status"] != "cancelled":
            job["status"] = "completed"
        elif job["status"] == "queued":
            job["status"] = "running"
        body: dict = {"id": parts[3], "status": job["status"]}
        if job["status"] == "completed":
            body.update(self.finished())
        return self.reply(200, body)

    def finished(self) -> dict:
        solution = {"decision": {"kind": "binding", "binding": {"t1": "c1"}}, "features": {}, "objectives": {"cost": 1.0},
                    "penalties": [], "violations": []}
        provenance = {"evaluator": "bim-reference-evaluator/v1", "evaluatorDigest": "sha256-ev", "compilerDigest": "sha256-cd",
                      "irDigest": "sha256-ir"}
        if "toolchain" in self.faults:
            provenance["toolchain"] = "bim-toolchain 1.2.3"
        if "no_evaluator" in self.faults:
            provenance.pop("evaluator")
        return {"provenance": provenance,
                "result": {"termination": "FEASIBLE", "solutions": [solution], "provenance": {**provenance, "engineReported": {}}}}


# -- helpers -------------------------------------------------------------------


class Ticker:
    """A clock that only moves when somebody sleeps, so a timeout costs no real time."""

    def __init__(self) -> None:
        self.now_s = 0.0

    def clock(self) -> float:
        return self.now_s

    def sleep(self, seconds: float) -> None:
        self.now_s += max(seconds, 1.0) * 10


def smoke(fake: FakeLab, **overrides) -> dict:
    config = smoke_lab.Config(password=PASSWORD, **overrides)
    ticker = Ticker()
    with httpx.Client(base_url=config.base_url, transport=fake.transport()) as client:
        return smoke_lab.run_smoke(config, client, sleep=ticker.sleep, clock=ticker.clock)


def steps_of(report: dict) -> dict[str, dict]:
    return {step["name"]: step for step in report["steps"]}


def failing(report: dict) -> list[str]:
    return [step["name"] for step in report["steps"] if not step["ok"]]


def run_main(fake: FakeLab, capsys, *args: str, environ: dict | None = None) -> tuple[int, dict, str]:
    env = {"DEMO_SEED_PASSWORD": PASSWORD} if environ is None else environ
    code = smoke_lab.main(["--with-space", *args], env, transport=fake.transport(), sleep=lambda _: None)
    out = capsys.readouterr().out
    return code, json.loads(out), out


# -- a healthy lab -------------------------------------------------------------


def test_every_step_passes_against_a_healthy_lab():
    report = smoke(FakeLab(), with_space=True)
    assert failing(report) == [], [step for step in report["steps"] if not step["ok"]]
    assert [step["name"] for step in report["steps"]] == ALL_STEPS
    assert report["ok"] is True and report["passed"] == 10 and report["failed"] == 0 and report["skipped"] == []


def test_the_login_throttle_runs_last_so_it_cannot_block_the_other_steps():
    assert smoke_lab.RUN_ORDER[-1] == 9
    fake = FakeLab()
    smoke(fake, with_space=True)
    assert [path for _, path in fake.requests[-11:]] == ["/api/v1/auth/login"] * 11
    assert fake.login_hits[smoke_lab.THROTTLE_USER] == 11


def test_the_smoke_never_registers_users_and_only_uses_the_seeded_ones():
    fake = FakeLab()
    smoke(fake, with_space=True)
    assert all("register" not in path for _, path in fake.requests)
    assert {name for name in fake.login_hits} == set(smoke_lab.USERS.values()) | {smoke_lab.THROTTLE_USER}


def test_main_prints_one_json_document_and_exits_zero(capsys):
    code, report, out = run_main(FakeLab(), capsys)
    assert code == 0 and report["tool"] == "smoke_lab" and report["ok"] is True
    assert set(report["steps"][0]) == {"name", "ok", "detail"}
    assert out.count('"tool"') == 1


def test_no_password_token_or_header_reaches_the_output(capsys):
    fake = FakeLab()
    _, _, out = run_main(fake, capsys)
    assert PASSWORD not in out
    assert not any(token in out for token in fake.tokens)
    assert "Bearer" not in out and '"authorization":' not in out.lower() and "refresh-token" not in out
    assert "access-token" not in out and "Idempotency-Key" not in out


def test_toolchain_field_is_reported_when_the_provenance_has_one():
    with_field = steps_of(smoke(FakeLab("toolchain")))["owner_job"]
    without = steps_of(smoke(FakeLab()))["owner_job"]
    assert with_field["ok"] and "toolchain field toolchain=bim-toolchain 1.2.3" in with_field["detail"]
    assert without["ok"] and "no toolchain field" in without["detail"]


# -- exit codes and independence -----------------------------------------------


def test_a_failing_step_gives_exit_one_and_does_not_stop_the_next_ones(capsys):
    code, report, _ = run_main(FakeLab("spa_404"), capsys)
    assert code == 1 and report["ok"] is False
    assert failing(report) == ["proxy_and_spa"]
    assert len(report["steps"]) == 10


def test_a_missing_password_is_a_configuration_error(capsys):
    code, report, _ = run_main(FakeLab(), capsys, environ={})
    assert code == 2 and report["ok"] is False and report["steps"] == []
    assert "DEMO_SEED_PASSWORD" in report["error"]


def test_an_unreachable_lab_fails_every_step_without_a_traceback(capsys):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    code = smoke_lab.main([], {"DEMO_SEED_PASSWORD": PASSWORD}, transport=httpx.MockTransport(refuse), sleep=lambda _: None)
    report = json.loads(capsys.readouterr().out)
    assert code == 1 and report["failed"] == 9
    assert all("ConnectError" in step["detail"] for step in report["steps"])


def test_a_user_that_cannot_sign_in_fails_the_login_step_and_what_needs_it():
    report = smoke(FakeLab("missing:lab-viewer"))
    failed = steps_of(report)
    assert not failed["login"]["ok"] and "lab-viewer" in failed["login"]["detail"]
    assert not failed["authorization"]["ok"]
    assert failed["proxy_and_spa"]["ok"] and failed["owner_job"]["ok"] and failed["idempotency"]["ok"]


def test_skip_leaves_out_optional_steps_and_the_space_step_needs_its_flag():
    report = smoke(FakeLab(), skip=frozenset({6, 7, 8, 9}))
    assert [step["name"] for step in report["steps"]] == ["proxy_and_spa", "login", "owner_job", "idempotency", "authorization"]
    assert report["skipped"] == ["concurrency_limit", "cors", "body_limit", "plan_usage", "login_throttle"]
    assert report["ok"] is True


def test_skip_accepts_numbers_and_names_but_only_for_steps_six_to_nine():
    assert smoke_lab.parse_skip("6, cors,body_limit") == frozenset({6, 7, 8})
    for bad in ("1", "login", "10", "nonsense"):
        with pytest.raises(Exception, match="can be skipped"):
            smoke_lab.parse_skip(bad)
    with pytest.raises(SystemExit) as exit_info:
        smoke_lab.build_parser().parse_args(["--skip", "3"])
    assert exit_info.value.code == 2


def test_an_unexpected_exception_in_a_step_is_reported_redacted():
    report = smoke(FakeLab("explode"))
    step = steps_of(report)["proxy_and_spa"]
    assert not step["ok"] and "RuntimeError" in step["detail"]
    assert PASSWORD not in step["detail"] and "***" in step["detail"]
    assert failing(report) == ["proxy_and_spa"] and len(report["steps"]) == 9


# -- step 1 --------------------------------------------------------------------


def test_the_spa_fallback_must_return_the_index():
    detail = steps_of(smoke(FakeLab("spa_404")))["proxy_and_spa"]["detail"]
    assert "deep route" in detail


# -- step 3 --------------------------------------------------------------------


def test_the_owner_job_step_reports_a_timeout_instead_of_hanging():
    step = steps_of(smoke(FakeLab("stuck")))["owner_job"]
    assert not step["ok"] and "timeout" in step["detail"]


def test_the_result_must_show_the_authoritative_reevaluation():
    step = steps_of(smoke(FakeLab("no_evaluator")))["owner_job"]
    assert not step["ok"] and "reference evaluator" in step["detail"]


# -- step 4 --------------------------------------------------------------------


def test_idempotency_failures_are_named():
    step = steps_of(smoke(FakeLab("broken_idempotency")))["idempotency"]
    assert not step["ok"]
    assert "same key and body" in step["detail"]


def test_the_same_key_of_another_account_gives_another_job():
    fake = FakeLab()
    smoke(fake, skip=frozenset({6, 7, 8, 9}))
    owners = [job["owner"] for job in fake.jobs.values()]
    assert "lab-member" in owners and owners.count("lab-owner") >= 2


# -- step 5 --------------------------------------------------------------------


def test_the_viewer_reads_the_project_job_with_redacted_options():
    fake = FakeLab()
    step = steps_of(smoke(fake))["authorization"]
    assert step["ok"], step["detail"]
    assert fake.studies == {"smoke-lab"} and len(fake.project_jobs) == 1


def test_a_second_run_reuses_the_project_job_instead_of_starting_another_study():
    fake = FakeLab()
    smoke(fake, skip=frozenset({6, 7, 8, 9}))
    smoke(fake, skip=frozenset({6, 7, 8, 9}))
    assert len(fake.project_jobs) == 1


def test_options_that_leak_to_the_viewer_fail_the_authorization_step():
    step = steps_of(smoke(FakeLab("leak_viewer")))["authorization"]
    assert not step["ok"]
    assert "allow-listed" in step["detail"]


def test_viewer_redaction_names_each_kind_of_leak():
    leaked = {
        "options": {"iterations": 10, "engine_url": "http://engine"},
        "original_request": {"bindingProblem": {}, "auth": {"token": "x"}},
        "provenance": {"registration": {"name": "random-search", "endpoint": "http://engine"}},
    }
    checks = smoke_lab.Checks()
    smoke_lab.check_viewer_redaction(checks, leaked)
    assert len(checks.failed) == 4
    assert any("allow-listed" in label for label in checks.failed)
    assert any("original_request" in label for label in checks.failed)
    assert any("pinned reference" in label for label in checks.failed)
    assert any("credential- or address-like" in label for label in checks.failed)
    clean = smoke_lab.Checks()
    smoke_lab.check_viewer_redaction(clean, {"options": {"iterations": 10, "seed": 1}, "original_request": {"bindingProblem": {"url": "kept"}}})
    assert clean.ok


def test_non_admins_must_get_403_and_the_admin_200_on_admin_routes():
    assert steps_of(smoke(FakeLab()))["authorization"]["ok"]
    step = steps_of(smoke(FakeLab("admin_open")))["authorization"]
    assert not step["ok"] and "403" in step["detail"]


# -- step 6 --------------------------------------------------------------------


def test_five_simultaneous_launches_hit_the_concurrency_limit_and_the_slot_is_freed():
    fake = FakeLab()
    step = steps_of(smoke(fake))["concurrency_limit"]
    assert step["ok"], step["detail"]
    assert all(job["status"] in {"completed", "cancelled"} for job in fake.jobs.values())


def test_a_gateway_without_the_limit_fails_the_concurrency_step():
    step = steps_of(smoke(FakeLab("no_limit")))["concurrency_limit"]
    assert not step["ok"] and "at least one launch got a 429" in step["detail"]


# -- step 7 --------------------------------------------------------------------


def test_cors_allows_the_lab_origin_and_refuses_another():
    assert steps_of(smoke(FakeLab()))["cors"]["ok"]
    step = steps_of(smoke(FakeLab("cors_open")))["cors"]
    assert not step["ok"] and "evil.example" in step["detail"]


# -- step 8 --------------------------------------------------------------------


def test_a_body_over_16_mib_is_a_413_problem_json():
    step = steps_of(smoke(FakeLab()))["body_limit"]
    assert step["ok"], step["detail"]


def test_a_gateway_that_accepts_the_oversized_body_fails_and_a_hang_is_reported():
    assert not steps_of(smoke(FakeLab("no_body_limit")))["body_limit"]["ok"]
    hung = steps_of(smoke(FakeLab("hang")))["body_limit"]
    assert not hung["ok"] and "ReadTimeout" in hung["detail"]


# -- step 9 --------------------------------------------------------------------


def test_twelve_failed_logins_end_in_a_429_with_retry_after():
    fake = FakeLab()
    step = steps_of(smoke(fake))["login_throttle"]
    assert step["ok"] and "Retry-After 287s" in step["detail"]
    assert fake.login_hits[smoke_lab.THROTTLE_USER] == 11
    assert all(fake.login_hits[name] == 1 for name in smoke_lab.USERS.values())


def test_a_gateway_without_throttling_fails_the_step():
    step = steps_of(smoke(FakeLab("no_throttle")))["login_throttle"]
    assert not step["ok"] and "429" in step["detail"]


# -- step 10 -------------------------------------------------------------------


def test_the_plan_step_wants_plan_and_capabilities_without_counters():
    ok = steps_of(smoke(FakeLab(), with_space=True))["plan_usage"]
    assert ok["ok"] and "plan BASIC" in ok["detail"]
    bad = steps_of(smoke(FakeLab("usage_counters"), with_space=True))["plan_usage"]
    assert not bad["ok"] and "usage counters" in bad["detail"]


# -- helpers -------------------------------------------------------------------


def test_redactor_hides_known_secrets_and_token_shapes():
    redact = smoke_lab.Redactor([PASSWORD, "ab"])
    jwt = "eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl"
    text = redact(f"{PASSWORD} Bearer abc.def {jwt} key obk_0123abcd_deadbeef ab")
    assert PASSWORD not in text and jwt not in text and "abc.def" not in text and "obk_0123abcd" not in text
    assert text.endswith(" ab")  # too short to be treated as a secret


def test_error_codes_are_read_from_both_error_shapes():
    problem = httpx.Response(429, json={"code": "concurrency_limit_exceeded", "detail": "x"})
    legacy = httpx.Response(401, json={"detail": {"code": "invalid_credentials"}})
    assert smoke_lab.code_of(problem) == "concurrency_limit_exceeded"
    assert smoke_lab.code_of(legacy) == "invalid_credentials"
    assert smoke_lab.code_of(httpx.Response(502, text="bad gateway")) == ""
    assert smoke_lab.retry_after_of(httpx.Response(429, headers={"Retry-After": "15"})) == 15
    assert smoke_lab.retry_after_of(httpx.Response(429)) is None


def test_sensitive_and_counter_key_detection():
    assert smoke_lab.sensitive_keys({"a": {"engineUrl": 1, "apiKey": 2, "iterations": 3}, "b": [{"auth": 1}]}) == [
        "a.engineUrl", "a.apiKey", "b[0].auth",
    ]
    assert smoke_lab.sensitive_keys({"iterations": 1, "seed": 2, "time_budget_ms": 3}) == []
    assert smoke_lab.counter_keys({"capabilities": {"jobsUsed": 1, "maxJobs": 3}, "remaining": 2}) == ["capabilities.jobsUsed", "remaining"]


def test_checks_summarise_passes_and_failures():
    checks = smoke_lab.Checks()
    checks.expect(True, "a")
    assert checks.ok and checks.detail() == "1 checks passed"
    checks.expect(False, "b")
    checks.note("n")
    assert not checks.ok and checks.detail() == "FAILED 1/2: b [n]"
