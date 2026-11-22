"""smoke_lab steps 19-21 (F6): an offering event from the lab's SPHERE stand-in, its review, and a proposal adoption.

A fake answers the gateway's routes the three steps read, the stand-in's control port, the feed consumer and Mailpit
(``Operated`` of the F4 steps, extended); the lab run (``SMOKE_STEPS=19,20,21``) proves them against the real services.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import httpx

import smoke_lab
from test_smoke_lab_operation import PASSWORD, Operated, Ticker

BASE = "/v1/organizations/lab-main/compositions/tomatometer"
EVENT = "11111111-1111-4111-8111-111111111111"


def _rows(basic: str, basic_timers: str) -> list[dict]:
    rows = [("basic", [], basic), ("basic", ["extraTimers"], basic_timers), ("advanced", [], "3.481010"),
            ("advanced", ["extraTimers"], "4.481010"), ("premium", [], "9.481010"),
            ("premium", ["extraTimers"], "10.481010"), ("premium", ["exportAsJson"], "11.481010")]
    return [{"plan": plan, "addOns": add_ons, "margin": margin} for plan, add_ons, margin in rows]


class Upstream(Operated):
    """Operated, plus the stand-in, the upstream events and the proposals of lab-main/tomatometer."""

    def __init__(self, *, stand_in: bool = True, publishes: bool = True, after: str = "0.481010") -> None:
        super().__init__()
        self.stand_in = stand_in
        self.publishes = publishes
        self.after = after
        self.published: list[str] = []
        self.event: dict | None = None
        self.polls = 0
        self.proposals: dict[str, dict] = {}
        self.history: list[dict] = [{"source": "direct", "proposal": None, "version": {"label": "1.0.0"}}]
        self.state_reads = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "sphere-lab":
            return self.control(request)
        path = request.url.path.removeprefix("/api")
        user = request.headers.get("Authorization", "").removeprefix("Bearer token-")
        if path == f"{BASE}/upstream-events":
            return self.events(request)
        if path.startswith(f"{BASE}/upstream-events/"):
            return self.event_route(request, path.removeprefix(f"{BASE}/upstream-events/"), user)
        if path == f"{BASE}/proposals" and request.method == "POST":
            return self.propose(request)
        if path == f"{BASE}/proposals":
            return self._json(200, {"proposals": list(self.proposals.values())})
        if path.startswith("/v1/organizations/lab-main/proposals/"):
            return self.proposal_route(request, path.removeprefix("/v1/organizations/lab-main/proposals/"))
        if path == f"{BASE}/environments/production/adoptions":
            return self._json(200, {"adoptions": list(reversed(self.history)), "nextBefore": None})
        if path == "/v1/organizations/lab-main/runs":
            return self._json(200, {"runs": [], "total": 7})
        if path == "/v1/organizations/lab-main/problems/tomatometer-email/revisions":
            return self._json(200, [{"revision": 1}, {"revision": 2}, {"revision": 3}])
        if path == f"{BASE}/versions":
            return self._json(200, {"versions": [], "total": 2, "limit": 1, "offset": 0})
        if path == f"{BASE}/environments/production" and request.method == "GET":
            return self._json(200, {"slug": "production", "inEffect": {"adoption": self.adoption, "evaluation": {"id": "e1"}}},
                              ETag=f'"env-{self.etag}"')
        response = super().handle(request)
        if path == f"{BASE}/environments/production/adopt" and response.status_code == 200:
            self.history.append({"source": "direct", "proposal": None, "version": {"label": self.version}})
        return response

    # -- the stand-in --------------------------------------------------------------------------------------------

    def control(self, request: httpx.Request) -> httpx.Response:
        if not self.stand_in:
            raise httpx.ConnectError("no such host", request=request)
        if request.url.path == "/_lab/state":
            self.state_reads += 1
            return self._json(200, {"published": self.published, "passthrough": 0,
                                    "requests": {smoke_lab.TOMATOMETER_MANIFEST: {"200": 1, "304": 4}}})
        name = request.url.path.removeprefix("/_lab/publish/")
        if name in self.published:
            return self._json(200, {"status": "already_published", "scenario": name})
        self.published.append(name)
        return self._json(200, {"status": "published", "scenario": name})

    # -- upstream events -----------------------------------------------------------------------------------------

    def events(self, request: httpx.Request) -> httpx.Response:
        if self.published and self.publishes:
            self.polls += 1
            if self.polls >= 3 and self.event is None:  # the third read finds it: a cycle went by
                self.event = {
                    "id": EVENT, "subject": "offering", "category": "offering_changed", "state": "open", "notify": True,
                    "old": {"label": "1.0.0"}, "new": {"label": "1.2.0"}, "environments": ["production"],
                    "note": "", "reviewedBy": None, "resolvedBy": None,
                    "diff": {"margins": {"environments": [{
                        "environment": "production", "users": 1000,
                        "before": {"rows": _rows("-0.508990", "0.491010")},
                        "after": {"rows": _rows(self.after, "1.481010")},
                    }]}},
                }
        events = [] if self.event is None else [{k: v for k, v in self.event.items() if k != "diff"}]
        return self._json(200, {"events": events, "counts": {}, "watches": [], "nextBefore": None})

    def event_route(self, request: httpx.Request, rest: str, user: str) -> httpx.Response:
        if self.event is None or not rest.startswith(EVENT):
            return self._json(404, {"detail": {"code": "not_found"}})
        if rest == EVENT and request.method == "GET":
            return self._json(200, self.event)
        if rest == f"{EVENT}/review" and request.method == "POST":
            body = json.loads(request.content)
            if set(body) - {"note"}:
                return self._json(422, {"code": "request_invalid"})
            if user == "lab-viewer":
                return self._json(403, {"detail": {"code": "organization_forbidden"}})
            if self.event["state"] != "open":
                return self._json(409, {"detail": {"code": "event_not_reviewable"}})
            self.event.update(state="reviewed", note=body.get("note", ""), reviewedBy={"username": user})
            return self._json(200, self.event)
        return self._json(405 if rest == EVENT else 404, {"detail": {"code": "method_not_allowed"}})

    # -- proposals -----------------------------------------------------------------------------------------------

    def propose(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        identifier = f"p{len(self.proposals) + 1}"
        self.proposals[identifier] = {
            "id": identifier, "status": "pending", "version": body["version"], "etag": self.etag,
            "steps": [{"ordinal": 1, "kind": "adopt", "status": "pending"}],
        }
        return self._json(201, self.proposals[identifier])

    def proposal_route(self, request: httpx.Request, rest: str) -> httpx.Response:
        identifier, _, action = rest.partition("/")
        proposal = self.proposals[identifier]
        if action != "confirm":
            return self._json(200, proposal)
        if proposal["etag"] != self.etag:
            proposal["status"] = "stale"
            return self._json(409, {"code": "proposal_stale", "detail": {"code": "proposal_stale"}})
        self.version = proposal["version"]
        self.adoption += 1
        self.etag += 1
        self.history.append({"source": "proposal", "proposal": {"id": identifier}, "version": {"label": self.version}})
        proposal.update(status="completed", steps=[{"ordinal": 1, "kind": "adopt", "status": "done"}])
        return self._json(200, proposal)


def run(fake: Upstream, steps: str = "19,20,21", sphere_url: str = "http://sphere-lab:8080") -> dict:
    ticker = Ticker()
    config = smoke_lab.Config(base_url="http://web:8080", password=PASSWORD, only=smoke_lab.parse_steps(steps),
                              sphere_url=sphere_url, upstream_interval_s=20.0)
    with httpx.Client(base_url="http://web:8080", transport=fake.transport()) as client:
        return smoke_lab.run_smoke(config, client, sleep=ticker.sleep, clock=ticker.clock)


def test_the_three_steps_pass_against_the_stand_in_and_leave_production_on_1_0_0():
    fake = Upstream()
    report = run(fake)
    steps = {step["name"]: step for step in report["steps"]}
    assert list(steps) == ["upstream_offering_event", "upstream_review", "proposal_adopt"]
    assert all(step["ok"] for step in steps.values()), report
    assert fake.published == ["tomatometer-1.2.0"]
    assert fake.event["state"] == "reviewed" and fake.event["note"] == smoke_lab.REVIEW_NOTE
    assert [p["status"] for p in fake.proposals.values()] == ["completed", "stale"]
    assert fake.version == "1.0.0"
    assert [row["source"] for row in fake.history] == ["direct", "proposal", "direct"]
    assert "feed ETags" in steps["proposal_adopt"]["detail"]
    assert report["skipReasons"] == {}


def test_a_margin_that_moves_another_way_fails_step_19():
    report = run(Upstream(after="0.491010"), "19")
    (step,) = report["steps"]
    assert not step["ok"] and "Basic rows move by +0.99" in step["detail"]


def test_an_event_that_never_comes_fails_step_19_after_three_cycles():
    report = run(Upstream(publishes=False), "19")
    (step,) = report["steps"]
    assert not step["ok"] and "within 3 watcher cycles" in step["detail"]


def test_a_second_run_on_the_same_lab_finds_what_the_first_made():
    fake = Upstream()
    run(fake, "19,20")
    report = run(fake, "19,20")
    steps = {step["name"]: step for step in report["steps"]}
    assert all(step["ok"] for step in steps.values()), report
    assert "published on this lab before" in steps["upstream_offering_event"]["detail"]
    assert "already reviewed" in steps["upstream_review"]["detail"]


def test_against_another_sphere_the_steps_are_skipped_with_the_reason():
    fake = Upstream()
    report = run(fake, sphere_url="https://sphere.score.us.es")
    assert report["steps"] == [] and fake.published == [] and fake.state_reads == 0
    assert report["skipReasons"] == {name: "the lab's SPHERE is sphere.score.us.es, not the stand-in sphere-lab"
                                     for name in ("upstream_offering_event", "upstream_review", "proposal_adopt")}


def test_without_the_control_port_the_steps_are_skipped():
    report = run(Upstream(stand_in=False))
    assert report["steps"] == []
    assert set(report["skipReasons"].values()) == {"the stand-in's control port does not answer (ConnectError)"}


def test_the_smoke_reads_the_lab_s_sphere_and_interval_from_the_environment(capsys):
    fake = Upstream()
    code = smoke_lab.main(["--steps", "19"], {"DEMO_SEED_PASSWORD": PASSWORD, "SPHERE_URL": "http://sphere-lab:8080",
                                             "UPSTREAM_POLL_INTERVAL_S": "20"},
                          transport=fake.transport(), sleep=lambda _: None)
    report = json.loads(capsys.readouterr().out)
    assert code == smoke_lab.EXIT_OK, report
    assert [step["name"] for step in report["steps"]] == ["upstream_offering_event"]


def test_the_watcher_interval_never_slows_the_job_and_study_polling(monkeypatch):
    """main() builds Config with the watcher's interval apart: jobs and studies are still polled every second."""
    seen: list[smoke_lab.Config] = []

    def capture(config, client, **kwargs):
        seen.append(config)
        return {"ok": True, "failed": 0, "blocked": 0, "steps": []}

    monkeypatch.setattr(smoke_lab, "run_smoke", capture)
    for environ in ({}, {"UPSTREAM_POLL_INTERVAL_S": "20"}, {"UPSTREAM_POLL_INTERVAL_S": "nonsense"}):
        smoke_lab.main([], {"DEMO_SEED_PASSWORD": PASSWORD, **environ})
    assert [config.poll_interval_s for config in seen] == [1.0, 1.0, 1.0]
    assert [config.upstream_interval_s for config in seen] == [300.0, 20.0, 300.0]
    # A field declared twice collapses into one silently (the later default wins): the class body names each once.
    tree = ast.parse(Path(smoke_lab.__file__).read_text(encoding="utf-8"))
    config = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Config")
    names = [item.target.id for item in config.body if isinstance(item, ast.AnnAssign)]
    assert len(names) == len(set(names)), names
