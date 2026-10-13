"""Rotation, saturation and bounded memory: only what ``docs/qa/BIM_LOAD.md`` lists as not covered elsewhere.

Everything runs in-process through the ASGI app (no sockets, no real load).  Time and memory assertions use wide
margins on purpose: they are meant to catch a missing bound, not to measure performance.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import json
import threading
import time
import tracemalloc

import pytest
from service_support import BASE_URL, TOKEN_NEW, TOKEN_OLD, async_client, bearer, run
from starlette.testclient import TestClient

import consumer_fixtures as demo
from bim_service import operations
from bim_service.auth import Authenticator
from bim_service.problems import ServiceProblem
from bim_service.runtime import Gate
from bim_service.settings import BimServiceSettings

CAPABILITIES = "/bim/v1/capabilities"
EVALUATE = "/bim/v1/evaluate"
COMPILE = "/bim/v1/compile"


# --- (a) rotation ------------------------------------------------------------------------------------


def comparable_response(response) -> tuple[int, dict, dict]:
    headers = {key: value for key, value in response.headers.items() if key not in {"traceparent", "content-length"}}
    return response.status_code, headers, response.json()


def test_retiring_the_old_token_takes_effect_on_restart_only(tokens_path, make_app) -> None:
    """The file is read at start only (docs/SERVICE.md): a running app keeps both tokens, the next start has one."""
    running = TestClient(make_app(), base_url=BASE_URL)
    assert running.get(CAPABILITIES, headers=bearer(TOKEN_OLD)).status_code == 200
    assert running.get(CAPABILITIES, headers=bearer(TOKEN_NEW)).status_code == 200

    tokens_path.write_text(TOKEN_NEW + "\n", encoding="utf-8")

    # no reload on request, mtime or signal: the running process is unchanged ...
    assert running.get(CAPABILITIES, headers=bearer(TOKEN_OLD)).status_code == 200
    # ... and the restarted one accepts the new token only
    restarted = TestClient(make_app(), base_url=BASE_URL)
    assert restarted.get(CAPABILITIES, headers=bearer(TOKEN_NEW)).status_code == 200
    assert restarted.get(CAPABILITIES, headers=bearer(TOKEN_OLD)).status_code == 401


def test_a_retired_token_is_indistinguishable_from_any_wrong_token(tokens_path, make_app) -> None:
    tokens_path.write_text(TOKEN_NEW + "\n", encoding="utf-8")
    client = TestClient(make_app(), base_url=BASE_URL)
    retired = client.get(CAPABILITIES, headers=bearer(TOKEN_OLD))
    never_valid = client.get(CAPABILITIES, headers=bearer("never-" + "z" * 40))
    same_prefix = client.get(CAPABILITIES, headers=bearer(TOKEN_NEW[:-1] + "!"))
    assert comparable_response(retired) == comparable_response(never_valid) == comparable_response(same_prefix)
    assert retired.status_code == 401 and retired.json()["code"] == "unauthorized"
    for secret in (TOKEN_OLD, TOKEN_NEW):
        assert secret not in retired.text and secret not in str(dict(retired.headers))


def test_swapping_the_order_in_the_file_changes_nothing(tokens_path, make_app) -> None:
    tokens_path.write_text(f"{TOKEN_NEW}\n{TOKEN_OLD}\n", encoding="utf-8")
    client = TestClient(make_app(), base_url=BASE_URL)
    assert [client.get(CAPABILITIES, headers=bearer(token)).status_code for token in (TOKEN_OLD, TOKEN_NEW)] == [200, 200]


@pytest.mark.parametrize(
    "header",
    [None, b"", b"Bearer", b"Bearer ", b"Bearer " + b" " * 40, b"Bearer \t\t", b"   ", b"Bearer  \t "],
)
def test_an_empty_or_blank_token_is_never_valid(header: bytes | None) -> None:
    assert Authenticator([TOKEN_NEW, TOKEN_OLD]).identify(header) is None


def test_a_token_with_spaces_inside_does_not_match_and_blank_headers_are_401(client) -> None:
    split = TOKEN_NEW[:10] + " " + TOKEN_NEW[10:]
    for header in (f"Bearer {split}", "Bearer " + " " * 40, f"Bearer {TOKEN_NEW[:10]}", "Bearer\t" + TOKEN_NEW + "\t x"):
        assert client.get(CAPABILITIES, headers={"Authorization": header}).status_code == 401


# --- (b) saturation ----------------------------------------------------------------------------------


class Holder:
    """An ``operations.evaluate`` that holds every request whose first binding says ``hold``."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.running = 0
        self.peak = 0

    def __call__(self, ir, bindings, execution, on_error):
        if bindings[0].get("fail"):
            raise RuntimeError("boom")
        if bindings[0].get("hold"):
            with self.lock:
                self.running += 1
                self.peak = max(self.peak, self.running)
            try:
                assert self.release.wait(15), "never released"
            finally:
                with self.lock:
                    self.running -= 1
        return {"results": []}


@pytest.fixture
def holder(monkeypatch) -> Holder:
    holder = Holder()
    monkeypatch.setattr(operations, "evaluate", holder)
    yield holder
    holder.release.set()


def body(**binding) -> dict:
    return {"ir": {}, "bindings": [binding]}


def test_n_concurrent_requests_over_the_slots_get_503_busy_and_the_service_recovers(make_app, holder) -> None:
    slots, total, wait_ms = 2, 10, 100
    app = make_app(max_concurrency=slots, max_concurrency_per_tenant=0, acquire_timeout_ms=wait_ms, retry_after_seconds=2)

    async def scenario():
        async with async_client(app) as client:
            started = time.monotonic()

            async def timed():
                response = await client.post(EVALUATE, json=body(hold=True))
                return response, time.monotonic() - started

            tasks = [asyncio.create_task(timed()) for _ in range(total)]
            deadline = time.monotonic() + 15
            while sum(task.done() for task in tasks) < total - slots:
                assert time.monotonic() < deadline, "the excess requests were not answered"
                await asyncio.sleep(0.01)
            health = await client.get("/healthz")  # the loop is free while the slots are held
            holder.release.set()
            results = [await task for task in tasks]
            return results, health, await client.post(EVALUATE, json=body())

    results, health, after = run(scenario())
    busy = [(response, elapsed) for response, elapsed in results if response.status_code == 503]
    served = [response for response, _ in results if response.status_code == 200]
    assert (len(busy), len(served)) == (total - slots, slots)
    assert holder.peak == slots  # never more operations than slots at once
    for response, elapsed in busy:
        assert response.headers["retry-after"] == "2"
        assert response.json()["code"] == "service_busy"
        assert elapsed >= wait_ms / 1000 * 0.8  # waited for the acquire timeout before giving up
    assert health.status_code == 200 and after.status_code == 200


def test_slots_survive_operations_that_raise(make_app, holder) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=1, acquire_timeout_ms=100)

    async def scenario():
        async with async_client(app) as client:
            failed = [await client.post(EVALUATE, json=body(fail=True)) for _ in range(4)]
            return failed, await client.post(EVALUATE, json=body())

    failed, after = run(scenario())
    assert [response.status_code for response in failed] == [500] * 4
    assert after.status_code == 200  # one slot and one tenant share, both returned four times


def gate_with(**overrides) -> Gate:
    return Gate(BimServiceSettings(tokens_file=None, **overrides))


def test_cancelling_a_waiter_and_a_running_request_returns_slot_and_tenant_share() -> None:
    gate = gate_with(max_concurrency=1, max_concurrency_per_tenant=1, acquire_timeout_ms=5000)
    entered, release = threading.Event(), threading.Event()

    def hold():
        entered.set()
        release.wait(15)
        return "held"

    async def scenario():
        running = asyncio.create_task(gate.run(hold, tenant="a"))
        assert await asyncio.get_running_loop().run_in_executor(None, entered.wait, 15)
        waiter = asyncio.create_task(gate.run(lambda: "never", tenant="b"))
        await asyncio.sleep(0.05)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert gate._tenants == {"a": 1}  # the waiter gave its tenant count back

        running.cancel()  # the client went away; the thread cannot be interrupted
        with pytest.raises(asyncio.CancelledError):
            await running
        assert gate._tenants == {"a": 1}  # still counted: the thread has not ended
        release.set()
        for _ in range(500):
            if not gate._tenants:
                break
            await asyncio.sleep(0.01)
        assert gate._tenants == {}
        return await gate.run(lambda: "again", tenant="a"), await gate.run(lambda: "other", tenant="b")

    try:
        assert run(scenario()) == ("again", "other")
    finally:
        release.set()
        gate.close()


def test_a_timed_out_waiter_for_a_slot_releases_the_tenant_share() -> None:
    gate = gate_with(max_concurrency=1, max_concurrency_per_tenant=1, acquire_timeout_ms=30)
    release = threading.Event()

    async def scenario():
        running = asyncio.create_task(gate.run(lambda: release.wait(15), tenant="a"))
        await asyncio.sleep(0.1)
        for _ in range(3):
            with pytest.raises(ServiceProblem) as busy:
                await gate.run(lambda: None, tenant="b")
            assert (busy.value.status, busy.value.code) == (503, "service_busy")
        assert gate._tenants == {"a": 1}
        release.set()
        await running
        return await gate.run(lambda: "ok", tenant="b")

    try:
        assert run(scenario()) == "ok"
    finally:
        release.set()
        gate.close()


# --- (c) bounded memory ------------------------------------------------------------------------------


LIMIT = 1024 * 1024
CHUNK = b"x" * 65536


async def call_asgi(app, receive, headers):
    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": COMPILE, "raw_path": COMPILE.encode(), "query_string": b"", "root_path": "",
        "headers": headers, "client": ("test", 1), "server": ("bim.test", 80),
    }  # fmt: skip
    await app(scope, receive, send)
    return next(message["status"] for message in sent if message["type"] == "http.response.start")


def headers_for(*extra: tuple[bytes, bytes]) -> list[tuple[bytes, bytes]]:
    return [(b"authorization", bearer()["Authorization"].encode()), (b"content-type", b"application/json"), *extra]


def near_limit_body(limit: int) -> bytes:
    """A JSON request of at most ``limit`` bytes, as close as base64 allows (the package is not a ZIP: 4xx)."""
    overhead = len(json.dumps({"package": "", "registeredResources": []}).encode())
    padding = "A" * ((limit - overhead) // 4 * 4)
    payload = json.dumps({"package": padding, "registeredResources": []}).encode()
    assert limit - 4 <= len(payload) <= limit
    return payload


def measure(coroutine_factory) -> tuple[int, int]:
    """``(status, peak traced bytes)`` of one run, after the caches have been warmed by the caller."""
    gc.collect()
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        baseline = tracemalloc.get_traced_memory()[0]
        status = run(coroutine_factory())
        return status, tracemalloc.get_traced_memory()[1] - baseline
    finally:
        tracemalloc.stop()


def test_a_request_near_the_limit_stays_within_a_multiple_of_the_limit(make_app) -> None:
    app = make_app(max_body_bytes=LIMIT)
    payload = near_limit_body(LIMIT)

    async def once():
        sent = False

        async def receive():
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": payload, "more_body": False}

        return await call_asgi(app, receive, headers_for((b"content-length", str(len(payload)).encode())))

    warm = run(once())
    assert warm not in (413, 500) and warm < 500  # accepted by the size limit, refused (or compiled) as a package
    status, peak = measure(once)
    assert status == warm
    # generous: the body, its JSON text, the base64 text and the decoded bytes are a handful of copies
    assert peak < 32 * LIMIT, f"peak {peak} bytes for a {LIMIT}-byte request"


def test_repeated_requests_near_the_limit_do_not_accumulate(make_app) -> None:
    app = make_app(max_body_bytes=LIMIT)
    payload = near_limit_body(LIMIT)

    async def many():
        for _ in range(6):
            sent = False

            async def receive():
                nonlocal sent
                if sent:
                    return {"type": "http.disconnect"}
                sent = True
                return {"type": "http.request", "body": payload, "more_body": False}

            await call_asgi(app, receive, headers_for())

    run(many())  # warm-up
    gc.collect()
    tracemalloc.start()
    try:
        before = tracemalloc.get_traced_memory()[0]
        run(many())
        gc.collect()
        growth = tracemalloc.get_traced_memory()[0] - before
    finally:
        tracemalloc.stop()
    assert growth < 4 * LIMIT, f"{growth} bytes retained after six requests"


def test_a_stream_far_over_the_limit_never_gets_buffered(make_app) -> None:
    """64 MiB offered in 64 KiB chunks against a 1 MiB limit: cut off early, memory stays a small multiple of it."""
    app = make_app(max_body_bytes=LIMIT)
    offered = 1024

    async def streamed():
        served = 0

        async def receive():
            nonlocal served
            served += 1
            assert served <= offered
            return {"type": "http.request", "body": CHUNK, "more_body": True}

        status = await call_asgi(app, receive, headers_for())
        assert served <= LIMIT // len(CHUNK) + 2, f"{served} chunks were read"
        return status

    assert run(streamed()) == 413
    status, peak = measure(streamed)
    assert status == 413
    assert peak < 4 * LIMIT, f"peak {peak} bytes while refusing a {offered * len(CHUNK)}-byte stream"


# --- (d) determinism under concurrency ---------------------------------------------------------------


def test_identical_concurrent_requests_give_identical_answers(make_app) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0, acquire_timeout_ms=30000)
    package = {"package": base64.b64encode(demo.demo_zip()).decode(), "registeredResources": []}

    async def scenario():
        async with async_client(app) as client:
            reference = await client.post(COMPILE, json=package)
            responses = await asyncio.gather(*[client.post(COMPILE, json=package) for _ in range(16)])
            ir = reference.json()["ir"]
            evaluated = await asyncio.gather(
                *[client.post(EVALUATE, json={"ir": ir, "bindings": [{}]}) for _ in range(16)]
            )
            return reference, responses, evaluated

    reference, responses, evaluated = run(scenario())
    assert reference.status_code == 200
    canonical = json.dumps(reference.json(), sort_keys=True)
    assert [response.status_code for response in responses] == [200] * 16
    assert {json.dumps(response.json(), sort_keys=True) for response in responses} == {canonical}
    assert len({(response.status_code, response.text) for response in evaluated}) == 1
