"""smoke_lab steps 16-18 (F4): the feed through nginx, the provider switch through the lab's consumer, the restore.

A small fake answers the gateway's environment routes, the feed consumer and Mailpit, so each step's checks run
without a stack; the lab run (``SMOKE_STEPS=16,17,18``) proves them against the real services.
"""

from __future__ import annotations

import json

import httpx

import seed_lab
import smoke_lab

PASSWORD = "synthetic-lab-password-1"
CONTENT = {"1.0.0": b"version: 1.0.0\n", "1.1.0": b"version: 1.1.0\n"}
CANDIDATES = {"1.0.0": "email.brevo.professional", "1.1.0": "email.resend.pro"}


class Operated:
    """lab-main/tomatometer in production, its feed consumer and Mailpit, as the smoke reads them."""

    def __init__(self, *, seeded: bool = True, switch: bool = True) -> None:
        self.seeded = seeded
        self.switch = switch
        self.version = "1.0.0"
        self.adoption = 1
        self.etag = 1
        self.messages: dict[str, dict] = {}
        self.adopts: list[tuple[str, str | None]] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _json(self, status: int, body: dict, **headers: str) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers)

    def handle(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        if host == "feed-consumer":
            return self.consumer(request, path)
        if host == "mailpit":
            return self.mailpit(request, path.removeprefix("/mailpit/api/v1"))
        path = path.removeprefix("/api")
        if path == "/v1/auth/login":
            return self._json(200, {"access_token": f"token-{json.loads(request.content)['username_or_email']}"})
        user = request.headers.get("Authorization", "").removeprefix("Bearer token-")
        key = request.headers.get("X-API-Key")
        base = "/v1/organizations/lab-main/compositions/tomatometer"
        if path == f"{base}/environments/production/composition":
            if key is None:
                return self._json(401, {"detail": {"code": "unauthorized"}})
            if key != smoke_lab.derived_feed_key(PASSWORD):
                return self._json(404, {"detail": {"code": "not_found"}})
            tag = f'"sha256-{self.version}"'
            headers = {"ETag": tag, "Vary": "Authorization, X-API-Key", "OpenBinding-Composition-Version": self.version,
                       "OpenBinding-Adoption": str(self.adoption)}
            if request.headers.get("If-None-Match") == tag:
                return httpx.Response(304, headers=headers)
            return httpx.Response(200, content=CONTENT[self.version], headers=headers)
        if path == "/v1/users/me" and key:
            return self._json(401, {"detail": {"code": "environment_key_elsewhere"}})
        if not self.seeded:
            return self._json(404, {"detail": {"code": "not_found"}})
        if path.startswith(f"{base}/versions/") and path.endswith("/content"):
            label = path.split("/")[-2]
            return httpx.Response(200, content=CONTENT[label], headers={"ETag": f'"sha256-{label}"'})
        if path == f"{base}/versions/1.0.0/evaluations":
            return self._json(200, {"evaluation": {}})
        if path == f"{base}/versions/1.0.0/margins":
            rows = [{"plan": "basic", "addOns": [], "margin": "-0.508990"}] + [{"plan": "p", "addOns": [], "margin": "1"}] * 6
            return self._json(200, {"status": "ok", "rows": rows, "costPerUser": "0.508990"})
        if path == f"{base}/environments/production" and request.method == "GET":
            return self._json(200, {"slug": "production", "inEffect": {"evaluation": {"id": "e1"}}},
                              ETag=f'"env-{self.etag}"')
        if path == f"{base}/environments/production/adopt":
            if_match = request.headers.get("If-Match")
            self.adopts.append((user, if_match))
            if not if_match:
                return self._json(428, {"detail": {"code": "precondition_required"}})
            if user != "lab-owner":
                return self._json(403, {"detail": {"code": "organization_forbidden"}})
            self.version = json.loads(request.content)["version"]
            self.adoption += 1
            self.etag += 1
            return self._json(200, {"environment": {}})
        return self._json(404, {"detail": {"code": "not_found"}})

    def consumer(self, request: httpx.Request, path: str) -> httpx.Response:
        version = self.version if self.switch else "1.0.0"
        candidate = CANDIDATES[version]
        provider = candidate.split(".")[1]
        if path == "/state":
            return self._json(200, {"status": "following", "provider": provider, "candidate": candidate,
                                    "version": version, "adoption": str(self.adoption)})
        identifier = f"m{len(self.messages) + 1}"
        self.messages[identifier] = {"ID": identifier, "Subject": "TomatoMeter daily summary",
                                     "Tags": [f"provider-{provider}", f"adoption-{self.adoption}"], "provider": provider}
        return self._json(200, {"status": "sent", "provider": provider, "messageId": identifier})

    def mailpit(self, request: httpx.Request, path: str) -> httpx.Response:
        if path == "/search":
            tag = request.url.params["query"].removeprefix("tag:")
            return self._json(200, {"messages": [m for m in self.messages.values() if tag in m["Tags"]]})
        identifier = path.split("/")[2]
        message = self.messages[identifier]
        if path.endswith("/headers"):
            return self._json(200, {"X-Openbinding-Provider": [message["provider"]]})
        return self._json(200, message)


class Ticker:
    def __init__(self) -> None:
        self.now = 0.0

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def run(fake: Operated, steps: str = "16,17,18") -> dict:
    ticker = Ticker()
    config = smoke_lab.Config(base_url="http://web:8080", password=PASSWORD, only=smoke_lab.parse_steps(steps))
    with httpx.Client(base_url="http://web:8080", transport=fake.transport()) as client:
        return smoke_lab.run_smoke(config, client, sleep=ticker.sleep, clock=ticker.clock)


def test_the_smoke_derives_the_seeds_keys():
    assert smoke_lab.derived_feed_key(PASSWORD) == seed_lab.feed_key_for(PASSWORD, "lab-main", "tomatometer", "production").secret
    assert smoke_lab.derived_api_key(PASSWORD, "lab-outsider") == seed_lab.api_key_for(PASSWORD, "lab-outsider")[0]


def test_the_three_steps_pass_and_restore_the_seeds_state():
    fake = Operated()
    report = run(fake)
    steps = {step["name"]: step for step in report["steps"]}
    assert list(steps) == ["environment_feed", "adopt_switches_provider", "restore_operation"]
    assert all(step["ok"] for step in steps.values()), report
    assert fake.version == "1.0.0" and fake.adoption == 3
    assert [m["provider"] for m in fake.messages.values()] == ["brevo", "resend", "brevo"]
    assert ("lab-owner", None) in fake.adopts and any(user == "lab-member" for user, _ in fake.adopts)
    assert smoke_lab.derived_feed_key(PASSWORD) not in json.dumps(report)


def test_a_consumer_that_does_not_follow_the_adoption_fails_step_17_after_its_wait():
    report = run(Operated(switch=False), "17")
    (step,) = report["steps"]
    assert not step["ok"] and "Resend within 15 s" in step["detail"]


def test_without_the_seeds_environments_the_steps_are_skipped():
    report = run(Operated(seeded=False))
    assert report["steps"] == [] and {"environment_feed", "adopt_switches_provider", "restore_operation"} <= set(
        report["skipped"])


def test_steps_are_chosen_by_number_or_name():
    assert smoke_lab.parse_steps("16, adopt_switches_provider") == frozenset({16, 17})
