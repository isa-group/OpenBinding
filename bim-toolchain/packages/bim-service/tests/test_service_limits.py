"""Limits: body size before reading, concurrency (429, 503), the time budget."""

from __future__ import annotations

import asyncio
import threading

import pytest
from service_support import BASE_URL, async_client, bearer, run
from starlette.testclient import TestClient

from bim_service import operations

EVALUATE = "/bim/v1/evaluate"


def evaluate_body(hold: bool = False) -> dict:
    return {"ir": {}, "bindings": [{"hold": True} if hold else {}]}


# --- the body size -----------------------------------------------------------------------------------


async def call_asgi(app, headers: list[tuple[bytes, bytes]], receive):
    """Call the application directly and return the messages it sent."""
    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": "/bim/v1/compile", "raw_path": b"/bim/v1/compile", "query_string": b"", "root_path": "",
        "headers": headers, "client": ("test", 1), "server": ("bim.test", 80),
    }  # fmt: skip
    await app(scope, receive, send)
    return sent


def status_and_body(sent: list[dict]) -> tuple[int, dict]:
    import json

    start = [message for message in sent if message["type"] == "http.response.start"]
    assert len(start) == 1, "exactly one response must be started"
    body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    return start[0]["status"], json.loads(body)


def auth_headers(*extra: tuple[bytes, bytes]) -> list[tuple[bytes, bytes]]:
    return [(b"authorization", bearer()["Authorization"].encode()), (b"content-type", b"application/json"), *extra]


def test_a_declared_length_over_the_limit_is_refused_without_reading_a_byte(make_app) -> None:
    app = make_app(max_body_bytes=1024)

    async def receive():
        raise AssertionError("the body must not be read")

    sent = run(call_asgi(app, auth_headers((b"content-length", b"1000000000")), receive))
    status, body = status_and_body(sent)
    assert status == 413
    assert body["code"] == "payload_too_large" and body["type"] == "urn:bim-toolchain:problem:payload_too_large"
    start = next(message for message in sent if message["type"] == "http.response.start")
    headers = dict(start["headers"])
    assert headers[b"content-type"].startswith(b"application/problem+json") and headers[b"connection"] == b"close"


def test_a_body_that_outgrows_the_limit_while_streaming_is_cut_off(make_app, monkeypatch) -> None:
    def never(*args):
        raise AssertionError("the operation must not run")

    monkeypatch.setattr(operations, "compile_package", never)
    app = make_app(max_body_bytes=1024)
    reads: list[int] = []

    async def receive():
        reads.append(1)
        if len(reads) > 50:
            raise AssertionError("the application kept reading after the limit")
        return {"type": "http.request", "body": b"x" * 600, "more_body": True}

    sent = run(call_asgi(app, auth_headers(), receive))
    status, body = status_and_body(sent)
    assert status == 413 and body["code"] == "payload_too_large"
    assert len(reads) == 2  # 600 bytes pass, the second chunk crosses 1024


def test_a_body_of_exactly_the_limit_is_accepted(make_app, monkeypatch) -> None:
    payload = b'{"package": "", "registeredResources": []}'
    seen: list[bytes] = []

    def spy(data, registered, limits):
        seen.append(data)
        return {"ok": True}

    monkeypatch.setattr(operations, "compile_package", spy)
    client = TestClient(make_app(max_body_bytes=len(payload)), base_url=BASE_URL, headers=bearer())
    headers = {"Content-Type": "application/json"}
    assert client.post("/bim/v1/compile", content=payload, headers=headers).status_code == 200
    assert client.post("/bim/v1/compile", content=payload + b" ", headers=headers).status_code == 413
    assert seen == [b""]


def test_the_limit_applies_through_the_normal_client_too(make_app) -> None:
    client = TestClient(make_app(max_body_bytes=2048), base_url=BASE_URL, headers=bearer())
    response = client.post("/bim/v1/compile", json={"package": "A" * 5000})
    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    assert client.get("/healthz").status_code == 200  # the service is fine afterwards


def test_a_malformed_content_length_is_a_bad_request(make_app) -> None:
    async def receive():
        raise AssertionError("the body must not be read")

    sent = run(call_asgi(make_app(), auth_headers((b"content-length", b"lots")), receive))
    status, body = status_and_body(sent)
    assert status == 400 and body["code"] == "bad_request"


def test_an_unauthenticated_oversized_request_is_refused_as_unauthenticated(make_app) -> None:
    async def receive():
        raise AssertionError("the body must not be read")

    sent = run(call_asgi(make_app(max_body_bytes=10), [(b"content-length", b"999")], receive))
    assert status_and_body(sent)[0] == 401


# --- concurrency -------------------------------------------------------------------------------------


class Blocker:
    """An ``operations.evaluate`` that holds the request whose first binding says ``hold`` until released."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.running = 0

    def __call__(self, ir, bindings, execution, on_error):
        if bindings[0].get("hold"):
            self.running += 1
            self.entered.set()
            assert self.release.wait(10), "the blocked operation was never released"
        return {"results": []}

    async def wait_entered(self) -> None:
        assert await asyncio.get_running_loop().run_in_executor(None, self.entered.wait, 10)


@pytest.fixture
def blocker(monkeypatch) -> Blocker:
    blocker = Blocker()
    monkeypatch.setattr(operations, "evaluate", blocker)
    return blocker


def test_no_free_slot_within_the_wait_is_a_503_with_retry_after(make_app, blocker) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=50, retry_after_seconds=3)

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(client.post(EVALUATE, json=evaluate_body(hold=True)))
            await blocker.wait_entered()
            busy = await client.post(EVALUATE, json=evaluate_body())
            health = await client.get("/healthz")  # the event loop is not blocked by the running operation
            blocker.release.set()
            return busy, health, await first, await client.post(EVALUATE, json=evaluate_body())

    busy, health, first, after = run(scenario())
    assert busy.status_code == 503 and busy.headers["retry-after"] == "3"
    assert busy.headers["content-type"].startswith("application/problem+json")
    assert busy.json()["code"] == "service_busy" and busy.json()["type"].endswith(":service_busy")
    assert health.status_code == 200
    assert first.status_code == 200 and after.status_code == 200  # the slot came back


def test_a_request_that_finds_a_slot_within_the_wait_is_served(make_app, monkeypatch) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=3000)
    entered, release = threading.Event(), threading.Event()

    def operation(ir, bindings, execution, on_error):
        if bindings[0].get("hold"):
            entered.set()
            release.wait(10)
        return {"results": []}

    monkeypatch.setattr(operations, "evaluate", operation)

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(client.post(EVALUATE, json=evaluate_body(hold=True)))
            await asyncio.get_running_loop().run_in_executor(None, entered.wait, 10)
            second = asyncio.create_task(client.post(EVALUATE, json=evaluate_body()))
            await asyncio.sleep(0.1)
            release.set()
            return await first, await second

    first, second = run(scenario())
    assert (first.status_code, second.status_code) == (200, 200)


def test_a_tenant_over_its_share_gets_429_while_others_are_served(make_app, blocker) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=50)
    acme = bearer(**{"X-BIM-Tenant": "acme"})

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(client.post(EVALUATE, json=evaluate_body(hold=True), headers=acme))
            await blocker.wait_entered()
            limited = await client.post(EVALUATE, json=evaluate_body(), headers=acme)
            other = await client.post(EVALUATE, json=evaluate_body(), headers=bearer(**{"X-BIM-Tenant": "other"}))
            anonymous = await client.post(EVALUATE, json=evaluate_body())
            blocker.release.set()
            first_response = await first
            again = await client.post(EVALUATE, json=evaluate_body(), headers=acme)
            return limited, other, anonymous, first_response, again

    limited, other, anonymous, first, again = run(scenario())
    assert limited.status_code == 429 and limited.headers["retry-after"] == "1"
    assert limited.json()["code"] == "rate_limited"
    assert (other.status_code, anonymous.status_code, first.status_code, again.status_code) == (200, 200, 200, 200)


def test_a_rejected_request_does_not_leak_a_tenant_slot(make_app, blocker) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=1, acquire_timeout_ms=20)
    acme = bearer(**{"X-BIM-Tenant": "acme"})
    other = bearer(**{"X-BIM-Tenant": "other"})

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(client.post(EVALUATE, json=evaluate_body(hold=True), headers=other))
            await blocker.wait_entered()
            busy = [await client.post(EVALUATE, json=evaluate_body(), headers=acme) for _ in range(3)]
            blocker.release.set()
            await first
            return busy, await client.post(EVALUATE, json=evaluate_body(), headers=acme)

    busy, final = run(scenario())
    assert [response.status_code for response in busy] == [503, 503, 503]
    assert final.status_code == 200  # the three 503s released the tenant's count


def test_an_operation_that_runs_out_of_time_is_a_503_and_keeps_its_slot_until_it_ends(make_app, blocker) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=20, operation_timeout_seconds=0.2)

    async def scenario():
        async with async_client(app) as client:
            timed_out = await client.post(EVALUATE, json=evaluate_body(hold=True))
            still_busy = await client.post(EVALUATE, json=evaluate_body())
            blocker.release.set()
            for _ in range(100):  # the thread ends; the slot comes back
                served = await client.post(EVALUATE, json=evaluate_body())
                if served.status_code == 200:
                    break
                await asyncio.sleep(0.02)
            return timed_out, still_busy, served

    timed_out, still_busy, served = run(scenario())
    assert timed_out.status_code == 503 and timed_out.json()["code"] == "operation_timeout"
    assert still_busy.status_code == 503 and still_busy.json()["code"] == "service_busy"
    assert served.status_code == 200
