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
    "proxy_and_spa", "login", "upload", "owner_job", "study", "idempotency", "authorization",
    "concurrency_limit", "cors", "body_limit", "public_compositions", "sphere_candidates", "sphere_engines",
    "plan_usage", "login_throttle",
]
#: The steps that need the seed's SPHERE problem; a lab without it skips them.
SPHERE_STEPS = ("sphere_candidates", "sphere_engines")
NOT_FOUND = {"detail": {"code": "not_found", "error": "Composition not found."}, "code": "not_found", "status": 404}
TEMPLATE = b"PK-example"
ENGINE = {"name": "random-search", "namespace": "bim.builtin", "version": "1.0.0", "digest": "sha256-e"}


class FakeLab:
    """The proxy plus the gateway, as far as the smoke test can tell."""

    def __init__(self, *faults: str) -> None:
        self.faults = set(faults)
        self.lock = threading.Lock()
        self.requests: list[tuple[str, str]] = []
        self.tokens: dict[str, str] = {}
        self.issued = 0
        self.login_hits: Counter[str] = Counter()
        self.revisions: dict[str, str] = {"rev-1": "simple-seq"}
        if "sphere" in self.faults:
            self.revisions["rev-tm-2"] = "tomatometer-email"
        self.problems: dict[str, bytes] = {}
        self.jobs: dict[str, dict] = {}
        self.keys: dict[tuple[str, str], tuple[str, str]] = {}
        self.studies: set[str] = set()
        self.study_runs = 0
        self.study_polls = 0
        self.job_bodies: list[dict] = []
        self.study_definitions: list[dict] = []

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

    def pricing_unavailable(self, shape: str = "platform") -> httpx.Response:
        """What the gateway answers when SPACE cannot tell the plan: the platform shape, on /users/* and on the runs alike."""
        message = "SPACE has no contract for this account."
        if shape == "run":
            return self.reply(503, {"type": "pricing_unavailable", "title": "pricing_unavailable", "status": 503,
                                    "code": "pricing_unavailable",
                                    "detail": {"code": "pricing_unavailable", "error": message}})
        return self.reply(503, {"detail": {"code": "pricing_unavailable", "error": f"Entitlements cannot be read right now: {message}"}})

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
        if sub == "/v1/bim/templates/demo/01_simple_seq":
            return httpx.Response(200, content=TEMPLATE, headers={"content-type": "application/vnd.bim+zip"})
        if sub == "/v1/compositions" and method == "GET":
            return self.public_list()
        if sub.startswith("/v1/organizations/lab-other/compositions/") and method == "GET" and user is None:
            return self.public_composition(sub.rsplit("/", 1)[-1])
        if user is None:
            return self.problem(401, "unauthorized")
        if sub in {"/v1/users/me", "/v1/users/me/usage"} and "pricing_blocked" in self.faults:
            return self.pricing_unavailable()
        if sub == "/v1/users/me" and "me_503_other" in self.faults:
            return self.problem(503, "database_unavailable")
        if sub == "/v1/users/me":
            return self.reply(200, {"username": user, "role": "admin" if user == "lab-admin" else "user"})
        if sub == "/v1/users/me/usage":
            return self.usage()
        if sub.startswith("/v1/admin/"):
            allowed = user == "lab-admin" or "admin_open" in self.faults
            return self.reply(200, {"users": 6}) if allowed else self.problem(403, "forbidden")
        if sub == "/v1/engines":
            return self.reply(200, {"engines": [{**ENGINE, "id": "bim.builtin/random-search", "ref": ENGINE, "modes": []}]})
        if sub == "/v1/bim/validate" and method == "POST":
            if "invalid_template" in self.faults:
                return self.problem(422, "invalid_package")
            return self.reply(200, {"valid": True, "packageDigest": self.digest(request.content), "diagnostics": []})
        if sub.startswith("/v1/organizations"):
            return self.organizations(request, sub, user)
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

    @staticmethod
    def digest(content: bytes) -> str:
        return f"sha256-{len(content):064d}"

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

    def public_list(self) -> httpx.Response:
        """lab-other's two public compositions; ``public_extra`` publishes the private one too."""
        slugs = ["sequential-workflow", "order-desk"] + (["internal-draft"] if "public_extra" in self.faults else [])
        rows = [{"organization": {"slug": "lab-other", "name": "Lab Other Organization"}, "slug": slug} for slug in slugs]
        return self.reply(200, {"compositions": rows, "total": len(rows), "limit": 100, "offset": 0})

    def public_composition(self, slug: str) -> httpx.Response:
        """A visitor's read: the public ones, redacted; the private one as a missing one (``private_readable`` and
        ``private_403`` break that)."""
        if slug in {"sequential-workflow", "order-desk"}:
            return self.reply(200, {"slug": slug, "visibility": "public", "created_by_id": None})
        if slug == "internal-draft" and "private_readable" in self.faults:
            return self.reply(200, {"slug": slug, "visibility": "private"})
        if slug == "internal-draft" and "private_403" in self.faults:
            return self.reply(403, {"detail": {"code": "organization_forbidden", "error": "Not a member."}})
        return self.reply(404, NOT_FOUND)

    def usage(self) -> httpx.Response:
        capabilities: dict = {"maxConcurrentJobs": 3, "maxTimeBudgetS": None}
        if "usage_counters" in self.faults:
            capabilities["jobsUsed"] = 2
        return self.reply(200, {"plan": "BASIC", "contract_pending": False, "features": {"solve": True}, "capabilities": capabilities})

    def organizations(self, request: httpx.Request, sub: str, user: str) -> httpx.Response:
        role = self.role_in_org(user)
        if sub == "/v1/organizations":
            return self.reply(200, [{"slug": "lab-main", "effective_role": role}] if role else [])
        runs = "/v1/organizations/lab-main/runs"
        if sub == runs or sub.startswith(f"{runs}/"):
            # The runs of an organization read as missing to a non-member.
            if role is None:
                return self.problem(404, "not_found")
            if sub == runs and request.method == "POST":
                return self.create_job(request, user)
            if sub == runs:
                return self.reply(200, {"runs": [], "total": 0})
            return self.job(sub, request.method, user, role)
        if role is None:
            return self.problem(403, "organization_forbidden")
        problems = "/v1/organizations/lab-main/problems"
        if sub == problems and request.method == "POST":
            return self.upload(request, role)
        if sub == problems:
            listed = [{"slug": "simple-seq"}, *({"slug": slug} for slug in self.problems)]
            return self.reply(200, {"problems": listed, "total": len(listed)})
        if sub == f"{problems}/simple-seq/revisions":
            return self.reply(200, [{"id": "rev-1", "revision": 1}])
        if sub.startswith(f"{problems}/tomatometer-email"):
            return self.sphere_problem(sub.removeprefix(f"{problems}/tomatometer-email"))
        if sub.startswith(f"{problems}/") and sub.removeprefix(f"{problems}/").split("/")[0] in self.problems:
            return self.revision_part(sub.removeprefix(f"{problems}/"))
        studies = "/v1/organizations/lab-main/studies"
        if sub.startswith(f"{studies}/") and request.method == "GET":
            return self.study_run(sub.removeprefix(f"{studies}/"))
        if sub == "/v1/organizations/lab-main/studies" and request.method == "POST":
            if role == "VIEWER":
                return self.problem(403, "organization_forbidden")
            if "pricing_blocked" in self.faults:
                return self.pricing_unavailable()
            document = json.loads(request.content)
            slug = document["slug"]
            engines = document["definition"]["engines"]
            if not all(engine.get("mode") and isinstance(engine.get("optimization"), dict) for engine in engines):
                return self.problem(422, "validation_error")
            self.study_definitions.append(document["definition"])
            created = slug not in self.studies
            self.studies.add(slug)
            return self.reply(201, {"slug": slug}) if created else self.problem(409, "slug_conflict")
        if sub.startswith(f"{studies}/") and sub.endswith("/runs") and request.method == "POST":
            if sub.split("/")[5] not in self.studies:
                return self.problem(404, "not_found")
            if role == "VIEWER" and "viewer_run_open" not in self.faults:
                return self.problem(403, "organization_forbidden")
            self.study_runs += 1
            revision = self.study_definitions[-1]["revision_ids"][0]
            frozen = {"problems": [{"revisionId": revision, "compilationId": "compilation-1"}]}
            return self.reply(202, {"id": "run-1", "state": "running", "definition": frozen, "definition_digest": "sha256-frozen"})
        return self.reply(200, {})

    def upload(self, request: httpx.Request, role: str) -> httpx.Response:
        if role == "VIEWER":
            return self.problem(403, "insufficient_role")
        if "pricing_blocked" in self.faults:
            return self.pricing_unavailable()
        slug = request.url.params.get("slug", "")
        if slug in self.problems or slug == "simple-seq":
            return self.problem(409, "slug_conflict")
        self.problems[slug] = request.content
        revision = f"rev-{slug}"
        self.revisions[revision] = slug
        digest = "sha256-other" if "digest_mismatch" in self.faults else self.digest(request.content)
        return self.reply(201, {"problem": {"slug": slug}, "revision": {"id": revision, "revision": 1, "package_digest": digest},
                                "created": True, "compilation": {"id": "compilation-1"}})

    def revision_part(self, rest: str) -> httpx.Response:
        slug, *tail = rest.split("/")
        if tail == ["revisions", "1", "source"]:
            return httpx.Response(200, content=self.problems[slug], headers={"content-type": "application/vnd.bim+zip"})
        if tail == ["revisions", "1", "compilation"]:
            modes = [{"engine": ENGINE, "mode": "seeded", "compatible": "no_engine" not in self.faults}]
            return self.reply(200, {"id": "compilation-1", "compatible_modes": modes})
        return self.problem(404, "not_found")

    def sphere_problem(self, rest: str) -> httpx.Response:
        """The seed's SPHERE problem: revision 1 uploaded, revision 2 generated (only with ``sphere``: a seed that
        reached SPHERE)."""
        if "sphere" not in self.faults:
            return self.problem(404, "not_found")
        if rest == "/revisions":
            return self.reply(200, [
                {"id": "rev-tm-1", "revision": 1, "origin": "upload", "sphere": None},
                {"id": "rev-tm-2", "revision": 2, "origin": "sphere",
                 "sphere": {"recipeDigest": "sha256-recipe", "sources": [{"title": "Mailgun", "versionLabel": "2026-10"}]}},
            ])
        if rest == "/revisions/2/compilation":
            modes = [{"engine": {"name": name}, "registration": {"name": name}, "mode": mode, "compatible": True}
                     for name, mode, _ in smoke_lab.SPHERE_ENGINES]
            return self.reply(200, {"id": "compilation-tm", "compatible_modes": modes})
        if rest == "/revisions/2/compilations/compilation-tm/facts":
            generated = [
                {"key": f"sphere-email/email.{name}", "provenance": {"sphere": f"danruilop1/{name.split('.')[0]}"},
                 "origins": {"subscription": {"source": {"kind": "priced"}}}}
                for name in ("mailgun.foundation", "mailgun.scale", "resend.pro", "sendgrid.pro", "brevo.professional")
            ]
            eligible = [{"candidate": item["key"]} for item in generated]
            return self.reply(200, {"tasks": [{"id": "dailySummary", "eligible": eligible}], "candidates": generated})
        return self.problem(404, "not_found")

    def study_run(self, rest: str) -> httpx.Response:
        parts = rest.split("/")
        if len(parts) < 3 or parts[0] not in self.studies or parts[2] != "run-1":
            return self.problem(404, "not_found")
        self.study_polls += 1
        done = self.study_polls >= 2 and "study_stuck" not in self.faults
        state = ("partial" if "cell_failed" in self.faults else "completed") if done else "running"
        if parts[3:] == ["cells"]:
            seeds = self.study_definitions[-1]["seeds"]
            cells = [{"id": f"cell-{seed}", "seed": seed, "state": "completed" if done else "running"} for seed in seeds]
            if "cell_failed" in self.faults:
                cells[0]["state"] = "failed"
            return self.reply(200, cells)
        return self.reply(200, {"id": "run-1", "state": state, "definition_digest": "sha256-frozen"})

    def viewer_job_view(self, job_id: str) -> dict:
        """A run as a VIEWER reads it: completed, with the options and the request redacted (unless a fault leaks them)."""
        options = {"iterations": 10, "seed": 1}
        original = {"timeout": 30, "mode": {}, "registration": {"name": "random-search"}}
        provenance = {"registration": {"name": "random-search", "version": "1.0.0"}, "options": options}
        if "leak_viewer" in self.faults:
            options = {**options, "engine_url": "http://engine-random-search:8080"}
            original["auth"] = {"token": "secret"}
            provenance["registration"] = {"name": "random-search", "endpoint": "http://engine:8080"}
        return {"id": job_id, "status": "completed", "options": options,
                "original_request": original, "provenance": provenance, "result": {"termination": "FEASIBLE", "solutions": []}}

    # -- jobs --------------------------------------------------------------

    def create_job(self, request: httpx.Request, user: str) -> httpx.Response:
        body = json.loads(request.content)
        role = self.role_in_org(user)
        if body.get("revision") not in self.revisions or "refuse_runs" in self.faults:
            return self.problem(404, "not_found")
        if role == "VIEWER":
            return self.problem(403, "insufficient_role")
        self.job_bodies.append(body)
        # The gateway resolves the optimization (bim-service) before it reads the plan (SPACE).
        if not isinstance(body.get("optimization"), dict):
            return self.problem(422, "optimization_required")
        sphere_modes = {mode for _, mode, _ in smoke_lab.SPHERE_ENGINES}
        if body.get("mode") != "seeded" and not (body.get("revision") == "rev-tm-2" and body.get("mode") in sphere_modes):
            return self.problem(422, "engine_mode_incompatible")
        if "pricing_blocked" in self.faults:
            return self.pricing_unavailable("run")
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
        self.jobs[job_id] = {"owner": user, "status": "queued", "polls": 0, "slow": slow, "revision": body["revision"]}
        if key:
            self.keys[(user, key)] = (job_id, fingerprint)
        return self.reply(202, {"id": job_id, "status": "queued", "profile": "qos-binding/v1", "irDigest": "sha256-ir"})

    def job(self, sub: str, method: str, user: str, role: str) -> httpx.Response:
        parts = sub.split("/")
        job_id = parts[5]
        job = self.jobs.get(job_id)
        if job is None:
            return self.problem(404, "not_found")
        if method == "POST" and parts[-1] == "cancel":
            if role == "VIEWER":
                return self.problem(403, "insufficient_role")
            job["status"] = "cancelled"
            return self.reply(200, {"id": job_id, "status": "cancelled"})
        if job["owner"] != user:
            # Another member's run: what it ended as; a VIEWER reads it redacted.
            return self.reply(200, self.viewer_job_view(job_id) if role == "VIEWER" else {"id": job_id, "status": job["status"]})
        job["polls"] += 1
        if "stuck" in self.faults:
            job["status"] = "running"
        elif not job["slow"] and job["polls"] >= 2 and job["status"] != "cancelled":
            job["status"] = "completed"
        elif job["status"] == "queued":
            job["status"] = "running"
        body: dict = {"id": job_id, "status": job["status"], "revision": {"id": job["revision"], "revision": 1}}
        if job["status"] == "completed":
            body.update(self.finished())
            if job["revision"] == "rev-tm-2":
                email = {"resource": "sphere-email", "id": "email.mailgun.foundation"}
                body["result"]["solutions"][0]["decision"]["binding"] = {"dailySummary": email}
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
    report = smoke(FakeLab("sphere"), with_space=True)
    assert failing(report) == [], [step for step in report["steps"] if not step["ok"]]
    assert [step["name"] for step in report["steps"]] == ALL_STEPS
    assert report["ok"] is True and report["passed"] == 15 and report["failed"] == 0 and report["skipped"] == []
    assert report["blocked"] == 0 and report["blockedSteps"] == []
    assert not any(step["blockedByRemote"] for step in report["steps"])


def test_jobs_and_study_engines_carry_the_mode_and_the_execution_optimization():
    fake = FakeLab()
    report = smoke(fake)
    assert report["ok"] is True, [step for step in report["steps"] if not step["ok"]]
    assert fake.job_bodies and all(
        body["mode"] == "seeded" and body["optimization"] == {"type": "SINGLE", "scalarization": "weighted-sum"}
        for body in fake.job_bodies
    )
    # The study step's one study: its engine is the full reference, with the mode and the optimization.
    assert len(fake.study_definitions) == 1
    assert fake.study_definitions[0]["engines"] == [{**ENGINE, "mode": "seeded", "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}}]
    assert fake.study_definitions[0]["seeds"] == [1, 2]


def test_a_job_without_the_execution_optimization_is_what_the_gateway_refuses_with_422():
    fake = FakeLab()
    token = "access-token-lab-owner-0"
    fake.tokens[token] = "lab-owner"
    with httpx.Client(transport=fake.transport(), base_url="http://web:8080") as client:
        refused = client.post("/api/v1/organizations/lab-main/runs", headers={"Authorization": f"Bearer {token}"},
                              json={"revision": "rev-1", "engine": "random-search", "options": smoke_lab.MIN_OPTIONS})
    assert refused.status_code == 422 and smoke_lab.code_of(refused) == "optimization_required"


# -- steps blocked by the remote -----------------------------------------------

BLOCKED_STEPS = ["login", "upload", "owner_job", "study", "idempotency", "authorization", "concurrency_limit", "plan_usage"]


def test_missing_spaces_contracts_block_the_steps_that_need_a_plan_and_are_not_failures():
    fake = FakeLab("pricing_blocked")
    report = smoke(fake, with_space=True)
    assert report["ok"] is False
    assert report["failed"] == 0 and report["blocked"] == len(BLOCKED_STEPS)
    assert report["blockedSteps"] == [name for name in ALL_STEPS if name in BLOCKED_STEPS]
    by_name = steps_of(report)
    for name in BLOCKED_STEPS:
        step = by_name[name]
        assert step["ok"] is False and step["blockedByRemote"] is True, step
        assert "BLOCKED BY REMOTE" in step["detail"]
        assert "seed_lab --space-contracts after remote_provision --apply" in step["detail"]
        assert "pricing_unavailable" in step["detail"]
    for name in ("proxy_and_spa", "cors", "body_limit", "public_compositions", "login_throttle"):
        assert by_name[name]["ok"] is True and by_name[name]["blockedByRemote"] is False
    # no problem is uploaded and no study is started either
    assert fake.problems == {} and fake.studies == set() and fake.study_runs == 0


def test_a_blocked_step_still_judges_what_does_not_depend_on_the_plan():
    step = steps_of(smoke(FakeLab("pricing_blocked")))["authorization"]
    # the viewer's launch is refused on its role first; the owner's plan is the first that is read
    assert step["blockedByRemote"] is True and "lab-owner GET /v1/users/me" in step["detail"]
    broken = steps_of(smoke(FakeLab("pricing_blocked", "admin_open")))["authorization"]
    assert broken["ok"] is False and broken["blockedByRemote"] is False
    assert "403" in broken["detail"] and "also blocked by remote" in broken["detail"]


def test_the_login_step_reports_every_blocked_user_and_still_checks_the_others():
    step = steps_of(smoke(FakeLab("pricing_blocked", "missing:lab-viewer")))["login"]
    assert step["ok"] is False and step["blockedByRemote"] is False
    assert "lab-viewer" in step["detail"] and "also blocked by remote" in step["detail"]
    only_blocked = steps_of(smoke(FakeLab("pricing_blocked")))["login"]
    for username in smoke_lab.USERS.values():
        assert username in only_blocked["detail"]


def test_a_503_that_is_not_pricing_unavailable_stays_a_failure():
    report = smoke(FakeLab("me_503_other"))
    login = steps_of(report)["login"]
    assert login["ok"] is False and login["blockedByRemote"] is False and "503" in login["detail"]
    assert report["blocked"] == 0 and report["failed"] >= 1


def test_main_exits_three_when_the_only_problem_is_the_remote(capsys):
    code, report, _ = run_main(FakeLab("pricing_blocked"), capsys)
    assert code == 3 and report["ok"] is False
    assert report["failed"] == 0 and report["blocked"] == len(report["blockedSteps"]) > 0


def test_main_exits_one_when_a_real_failure_comes_with_the_blocks(capsys):
    code, report, _ = run_main(FakeLab("pricing_blocked", "spa_404"), capsys)
    assert code == 1 and report["failed"] == 1 and report["blocked"] > 0


def test_only_a_503_pricing_unavailable_counts_as_blocked_by_the_remote():
    platform = httpx.Response(503, json={"detail": {"code": "pricing_unavailable", "error": "no plan"}})
    problem = httpx.Response(503, json={"code": "pricing_unavailable", "detail": "no plan"})
    assert smoke_lab.pricing_block(platform) == smoke_lab.pricing_block(problem) == "503 pricing_unavailable: no plan"
    assert smoke_lab.pricing_block(httpx.Response(503, json={"code": "database_unavailable"})) is None
    assert smoke_lab.pricing_block(httpx.Response(503, text="<html>bad gateway</html>")) is None
    assert smoke_lab.pricing_block(httpx.Response(429, json={"code": "pricing_unavailable"})) is None


def test_the_login_throttle_runs_last_so_it_cannot_block_the_other_steps():
    assert smoke_lab.RUN_ORDER[-1] == 11
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
    assert set(report["steps"][0]) == {"name", "ok", "blockedByRemote", "detail"}
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
    assert len(report["steps"]) == 13


def test_a_missing_password_is_a_configuration_error(capsys):
    code, report, _ = run_main(FakeLab(), capsys, environ={})
    assert code == 2 and report["ok"] is False and report["steps"] == []
    assert "DEMO_SEED_PASSWORD" in report["error"]


def test_an_unreachable_lab_fails_every_step_without_a_traceback(capsys):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    code = smoke_lab.main([], {"DEMO_SEED_PASSWORD": PASSWORD}, transport=httpx.MockTransport(refuse), sleep=lambda _: None)
    report = json.loads(capsys.readouterr().out)
    assert code == 1 and report["failed"] == 12
    assert all("ConnectError" in step["detail"] for step in report["steps"])


def test_a_user_that_cannot_sign_in_fails_the_login_step_and_what_needs_it():
    report = smoke(FakeLab("missing:lab-viewer"))
    failed = steps_of(report)
    assert not failed["login"]["ok"] and "lab-viewer" in failed["login"]["detail"]
    assert not failed["authorization"]["ok"]
    assert failed["proxy_and_spa"]["ok"] and failed["owner_job"]["ok"] and failed["idempotency"]["ok"]
    assert failed["upload"]["ok"] and failed["study"]["ok"]


def test_skip_leaves_out_optional_steps_and_the_space_step_needs_its_flag():
    report = smoke(FakeLab(), skip=frozenset({8, 9, 10, 11}))
    assert [step["name"] for step in report["steps"]] == [
        "proxy_and_spa", "login", "upload", "owner_job", "study", "idempotency", "authorization", "public_compositions",
    ]
    assert report["skipped"] == [
        "concurrency_limit", "cors", "body_limit", "sphere_candidates", "sphere_engines", "plan_usage", "login_throttle",
    ]
    assert report["ok"] is True


def test_without_with_space_every_other_step_completes_and_the_usage_endpoint_is_never_called(capsys):
    fake = FakeLab()
    report = smoke(fake)
    assert report["ok"] is True and report["failed"] == 0 and report["blocked"] == 0
    assert [step["name"] for step in report["steps"]] == [
        name for name in ALL_STEPS if name != "plan_usage" and name not in SPHERE_STEPS
    ]
    assert report["skipped"] == [*SPHERE_STEPS, "plan_usage"]
    assert not [request for request in fake.requests if request[1].endswith("/users/me/usage")]

    fake = FakeLab()
    code = smoke_lab.main([], {"DEMO_SEED_PASSWORD": PASSWORD}, transport=fake.transport(), sleep=lambda _: None)
    assert code == smoke_lab.EXIT_OK
    assert json.loads(capsys.readouterr().out)["skipped"] == [*SPHERE_STEPS, "plan_usage"]
    assert not [request for request in fake.requests if request[1].endswith("/users/me/usage")]


def test_with_space_the_plan_step_does_call_the_usage_endpoint():
    fake = FakeLab()
    smoke(fake, with_space=True)
    assert ("GET", "/api/v1/users/me/usage") in fake.requests


def test_skip_accepts_numbers_and_names_but_only_for_steps_eight_to_eleven():
    assert smoke_lab.parse_skip("8, cors,body_limit") == frozenset({8, 9, 10})
    for bad in ("1", "login", "study", "12", "nonsense"):
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
    assert failing(report) == ["proxy_and_spa"] and len(report["steps"]) == 12


# -- step 1 --------------------------------------------------------------------


def test_the_spa_fallback_must_return_the_index():
    detail = steps_of(smoke(FakeLab("spa_404")))["proxy_and_spa"]["detail"]
    assert "deep route" in detail


# -- step 3 --------------------------------------------------------------------


def test_the_upload_step_uploads_the_template_it_validated_as_a_new_problem():
    fake = FakeLab()
    report = smoke(fake, skip=frozenset({8, 9, 10, 11}))
    step = steps_of(report)["upload"]
    assert step["ok"], step["detail"]
    assert list(fake.problems.values()) == [TEMPLATE]
    (slug,) = fake.problems
    assert slug.startswith("smoke-")
    # The run, the study and the idempotency launches are of the uploaded revision.
    assert {job["revision"] for job in fake.jobs.values()} == {f"rev-{slug}"}
    assert fake.study_definitions[0]["revision_ids"] == [f"rev-{slug}"]


@pytest.mark.parametrize(
    ("fault", "expected"),
    [
        ("invalid_template", "the template validates"),
        ("digest_mismatch", "same packageDigest"),
        ("no_engine", "random-search can run it"),
    ],
)
def test_the_upload_step_names_what_went_wrong(fault, expected):
    step = steps_of(smoke(FakeLab(fault)))["upload"]
    assert not step["ok"] and expected in step["detail"]


# -- step 4 --------------------------------------------------------------------


def test_the_owner_job_step_reports_a_timeout_instead_of_hanging():
    step = steps_of(smoke(FakeLab("stuck")))["owner_job"]
    assert not step["ok"] and "timeout" in step["detail"]


def test_the_result_must_show_the_authoritative_reevaluation():
    step = steps_of(smoke(FakeLab("no_evaluator")))["owner_job"]
    assert not step["ok"] and "reference evaluator" in step["detail"]


# -- step 5 --------------------------------------------------------------------


def test_the_study_step_runs_one_cell_per_seed_and_waits_for_them():
    fake = FakeLab()
    step = steps_of(smoke(fake))["study"]
    assert step["ok"], step["detail"]
    assert fake.study_runs == 1 and len(fake.studies) == 1


def test_a_study_run_that_does_not_end_or_loses_a_cell_fails_the_step():
    stuck = steps_of(smoke(FakeLab("study_stuck")))["study"]
    assert not stuck["ok"] and "timeout" in stuck["detail"]
    partial = steps_of(smoke(FakeLab("cell_failed")))["study"]
    assert not partial["ok"] and "every cell completed" in partial["detail"] and "partial" in partial["detail"]


# -- step 6 --------------------------------------------------------------------


def test_idempotency_failures_are_named():
    step = steps_of(smoke(FakeLab("broken_idempotency")))["idempotency"]
    assert not step["ok"]
    assert "same key and body" in step["detail"]


def test_the_same_key_of_another_account_gives_another_job():
    fake = FakeLab()
    smoke(fake, skip=frozenset({8, 9, 10, 11}))
    owners = [job["owner"] for job in fake.jobs.values()]
    assert "lab-member" in owners and owners.count("lab-owner") >= 2


# -- step 7 --------------------------------------------------------------------


def test_the_viewer_reads_the_owners_run_with_redacted_options():
    fake = FakeLab()
    step = steps_of(smoke(fake))["authorization"]
    assert step["ok"], step["detail"]
    # The one study run is the study step's: the viewer started none.
    assert fake.study_runs == 1


def test_without_a_run_of_the_owner_the_viewer_read_fails_the_authorization_step():
    fake = FakeLab("refuse_runs")  # every launch is refused, so the owner_job step leaves no run to read
    step = steps_of(smoke(fake, skip=frozenset({8, 9, 10, 11})))["authorization"]
    assert not step["ok"]
    assert "no run of the owner" in step["detail"]


def test_the_viewer_can_neither_launch_a_run_of_the_organizations_problem_nor_start_a_study_run():
    fake = FakeLab()
    step = steps_of(smoke(fake))["authorization"]
    assert step["ok"], step["detail"]
    assert not any(job["owner"] == "lab-viewer" for job in fake.jobs.values())


def test_a_viewer_that_can_start_a_study_run_fails_the_authorization_step():
    step = steps_of(smoke(FakeLab("viewer_run_open")))["authorization"]
    assert not step["ok"]
    assert "CANNOT start a study run" in step["detail"]


def test_options_that_leak_to_the_viewer_fail_the_authorization_step():
    step = steps_of(smoke(FakeLab("leak_viewer")))["authorization"]
    assert not step["ok"]
    assert "allow-listed" in step["detail"]


def test_viewer_redaction_names_each_kind_of_leak():
    leaked = {
        "options": {"iterations": 10, "engine_url": "http://engine"},
        "original_request": {"timeout": 30, "auth": {"token": "x"}},
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
    smoke_lab.check_viewer_redaction(clean, {"options": {"iterations": 10, "seed": 1}, "original_request": {"timeout": 30}})
    assert clean.ok


def test_non_admins_must_get_403_and_the_admin_200_on_admin_routes():
    assert steps_of(smoke(FakeLab()))["authorization"]["ok"]
    step = steps_of(smoke(FakeLab("admin_open")))["authorization"]
    assert not step["ok"] and "403" in step["detail"]


# -- step 8 --------------------------------------------------------------------


def test_five_simultaneous_launches_hit_the_concurrency_limit_and_the_slot_is_freed():
    fake = FakeLab()
    step = steps_of(smoke(fake))["concurrency_limit"]
    assert step["ok"], step["detail"]
    assert all(job["status"] in {"completed", "cancelled"} for job in fake.jobs.values())


def test_a_gateway_without_the_limit_fails_the_concurrency_step():
    step = steps_of(smoke(FakeLab("no_limit")))["concurrency_limit"]
    assert not step["ok"] and "at least one launch got a 429" in step["detail"]


# -- step 9 --------------------------------------------------------------------


def test_cors_allows_the_lab_origin_and_refuses_another():
    assert steps_of(smoke(FakeLab()))["cors"]["ok"]
    step = steps_of(smoke(FakeLab("cors_open")))["cors"]
    assert not step["ok"] and "evil.example" in step["detail"]


# -- step 10 -------------------------------------------------------------------


def test_a_body_over_16_mib_is_a_413_problem_json():
    step = steps_of(smoke(FakeLab()))["body_limit"]
    assert step["ok"], step["detail"]


def test_a_gateway_that_accepts_the_oversized_body_fails_and_a_hang_is_reported():
    assert not steps_of(smoke(FakeLab("no_body_limit")))["body_limit"]["ok"]
    hung = steps_of(smoke(FakeLab("hang")))["body_limit"]
    assert not hung["ok"] and "ReadTimeout" in hung["detail"]


# -- step 11 -------------------------------------------------------------------


def test_twelve_failed_logins_end_in_a_429_with_retry_after():
    fake = FakeLab()
    step = steps_of(smoke(fake))["login_throttle"]
    assert step["ok"] and "Retry-After 287s" in step["detail"]
    assert fake.login_hits[smoke_lab.THROTTLE_USER] == 11
    assert all(fake.login_hits[name] == 1 for name in smoke_lab.USERS.values())


def test_a_gateway_without_throttling_fails_the_step():
    step = steps_of(smoke(FakeLab("no_throttle")))["login_throttle"]
    assert not step["ok"] and "429" in step["detail"]


# -- step 13 -------------------------------------------------------------------


def test_a_visitor_lists_the_two_public_compositions_and_reads_only_those():
    fake = FakeLab()
    step = steps_of(smoke(fake))["public_compositions"]
    assert step["ok"], step["detail"]
    # Every request of the step is anonymous.
    reads = [path for _, path in fake.requests if "/compositions" in path]
    assert reads == [
        "/api/v1/compositions", "/api/v1/organizations/lab-other/compositions/sequential-workflow",
        "/api/v1/organizations/lab-other/compositions/internal-draft", reads[3],
    ] and reads[3].endswith("-missing")


@pytest.mark.parametrize(
    ("fault", "expected"),
    [
        ("public_extra", "the public list holds"),
        ("private_readable", "is not found"),
        ("private_403", "the body of a missing one"),
    ],
)
def test_the_public_compositions_step_names_what_went_wrong(fault, expected):
    step = steps_of(smoke(FakeLab(fault)))["public_compositions"]
    assert not step["ok"] and expected in step["detail"]


# -- step 12 -------------------------------------------------------------------


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


def test_the_sphere_steps_check_the_generated_problem_and_one_run_per_engine():
    fake = FakeLab("sphere")
    report = smoke(fake)
    steps = steps_of(report)
    assert steps["sphere_candidates"]["ok"] and steps["sphere_engines"]["ok"], report["steps"]
    sphere_runs = [body for body in fake.job_bodies if body["revision"] == "rev-tm-2"]
    assert sorted(body["engine"]["name"] for body in sphere_runs) == sorted(name for name, _, _ in smoke_lab.SPHERE_ENGINES)
    assert all(body["optimization"] == smoke_lab.SPHERE_OPTIMIZATION for body in sphere_runs)


def test_the_sphere_steps_are_skipped_when_the_seed_skipped_sphere():
    report = smoke(FakeLab())
    assert report["ok"] is True
    assert "sphere_candidates" in report["skipped"] and "sphere_engines" in report["skipped"]
    assert "sphere_candidates" not in steps_of(report)
