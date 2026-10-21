"""B8 phase A: what the memory budget admits, and the cap on request bodies that wait outside the slots.

A request whose estimate can never fit an enabled budget is refused with 413 ``memory_budget_exceeded`` (no
``Retry-After``) before anything is decoded or held; 429 ``memory_budget`` is only for what would fit once the other
operations finish.  The bytes of every body in flight (waiting for a slot or admitted) are counted from the moment the
body starts to be read until the operation's thread ends, and refused with 429 ``pending_body_bytes`` when they do not
fit.  In process through the ASGI application; the operations are stand-ins that block until released.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time

import pytest
from service_support import async_client, bearer, run

from bim_service import jobs, operations
from bim_service.problems import ServiceProblem
from bim_service.runtime import Gate
from bim_service.settings import BODY_MEMORY_FACTOR, BimServiceSettings, ServiceConfigError

COMPILE = "/bim/v1/compile"
EVALUATE = "/bim/v1/evaluate"
JSON = {"Content-Type": "application/json"}
PAYLOAD = json.dumps({"package": base64.b64encode(b"x").decode()}).encode()
LENGTH = len(PAYLOAD)
COST = LENGTH * BODY_MEMORY_FACTOR


async def wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


class Hold:
    """A stand-in for ``operations.compile_package`` that blocks (no CPU) until released."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.running = 0
        self.calls = 0

    def __call__(self, data, registered, limits):
        with self.lock:
            self.running += 1
            self.calls += 1
        try:
            assert self.release.wait(15), "never released"
        finally:
            with self.lock:
                self.running -= 1
        return {"ir": {}}


@pytest.fixture
def hold(monkeypatch) -> Hold:
    hold = Hold()
    monkeypatch.setattr(operations, "compile_package", hold)
    yield hold
    hold.release.set()


def post(client, payload: bytes = PAYLOAD):
    return client.post(COMPILE, content=payload, headers=JSON)


def gate_with(**overrides) -> Gate:
    return Gate(BimServiceSettings(tokens_file=None, **overrides))


def assert_nothing_held(gate: Gate, slots: int) -> None:
    assert gate._charged == 0 and gate._chargers == 0
    assert gate._tenants == {}
    assert gate.bodies.held == 0
    assert all(gate._slots.acquire(blocking=False) for _ in range(slots)), "a slot leaked"
    for _ in range(slots):
        gate._slots.release()


# --- the gate: a cost that can never fit ----------------------------------------------------------------


def test_an_oversized_cost_at_rest_is_413_and_holds_nothing() -> None:
    gate = gate_with(max_concurrency=2, max_concurrency_per_tenant=1, memory_budget_bytes=100)
    called: list[int] = []

    async def scenario():
        with pytest.raises(ServiceProblem) as refused:
            await gate.run(lambda: called.append(1), tenant="a", cost_bytes=101)
        return refused.value

    try:
        problem = run(scenario())
        assert (problem.status, problem.code) == (413, "memory_budget_exceeded")
        assert "Retry-After" not in problem.headers and "never fit" in problem.detail
        assert called == []
        assert_nothing_held(gate, 2)
    finally:
        gate.close()


def test_a_cost_equal_to_the_budget_is_admitted_alone_and_refused_with_429_beside_another() -> None:
    gate = gate_with(max_concurrency=2, memory_budget_bytes=100)
    release = threading.Event()

    async def scenario():
        assert await gate.run(lambda: "exact", cost_bytes=100) == "exact"
        running = asyncio.create_task(gate.run(release.wait, 15, cost_bytes=60))
        await wait_until(lambda: gate._chargers == 1)
        with pytest.raises(ServiceProblem) as later:
            await gate.run(lambda: None, cost_bytes=100)  # fits the budget, not what is left: retryable
        release.set()
        await running
        await wait_until(lambda: gate._charged == 0)
        return later.value

    try:
        later = run(scenario())
        assert (later.status, later.code) == (429, "memory_budget") and later.headers == {"Retry-After": "1"}
        assert_nothing_held(gate, 2)
    finally:
        release.set()
        gate.close()


def test_an_oversized_cost_beside_running_operations_is_413_not_429() -> None:
    gate = gate_with(max_concurrency=3, max_concurrency_per_tenant=2, memory_budget_bytes=100)
    release = threading.Event()
    ran: list[int] = []

    async def scenario():
        running = [asyncio.create_task(gate.run(release.wait, 15, tenant="a", cost_bytes=30)) for _ in range(2)]
        await wait_until(lambda: gate._chargers == 2)
        refused = []
        for tenant in ("a", "b"):
            with pytest.raises(ServiceProblem) as raised:
                await gate.run(lambda: ran.append(1), tenant=tenant, cost_bytes=101)
            refused.append(raised.value)
        assert gate._tenants == {"a": 2} and gate._charged == 60  # the refusals took and left nothing
        release.set()
        await asyncio.gather(*running)
        await wait_until(lambda: gate._charged == 0)
        return refused

    try:
        refused = run(scenario())
        assert [(p.status, p.code) for p in refused] == [(413, "memory_budget_exceeded")] * 2
        assert ran == []
        assert_nothing_held(gate, 3)
    finally:
        release.set()
        gate.close()


def test_concurrent_oversized_and_fitting_requests_are_told_apart() -> None:
    gate = gate_with(max_concurrency=4, memory_budget_bytes=100)
    release = threading.Event()

    async def attempt(cost):
        try:
            return await gate.run(release.wait, 15, cost_bytes=cost)
        except ServiceProblem as problem:
            return problem.code

    async def scenario():
        tasks = [asyncio.create_task(attempt(cost)) for cost in (40, 150, 40, 60, 500, 20)]
        await wait_until(lambda: gate._chargers >= 2)
        await asyncio.sleep(0.05)
        release.set()
        results = await asyncio.gather(*tasks)
        await wait_until(lambda: gate._charged == 0)
        return results

    try:
        # in arrival order: 40 fits, 150 never, 40 fits, 60 would fit alone (40 + 40 + 60 > 100), 500 never, 20 fits
        assert run(scenario()) == [
            True, "memory_budget_exceeded", True, "memory_budget", "memory_budget_exceeded", True,
        ]  # fmt: skip
        assert_nothing_held(gate, 4)
    finally:
        release.set()
        gate.close()


def test_the_charge_and_the_tenant_share_come_back_after_an_error() -> None:
    gate = gate_with(max_concurrency=1, max_concurrency_per_tenant=1, memory_budget_bytes=100, max_pending_body_bytes=100)

    def boom():
        raise RuntimeError("boom")

    async def scenario():
        for _ in range(3):
            reservation = gate.bodies.reservation()
            reservation.ensure(10)
            with pytest.raises(RuntimeError):
                await gate.run(boom, tenant="a", cost_bytes=80, reservation=reservation)
            await wait_until(lambda: gate.bodies.held == 0 and gate._charged == 0)
        return await gate.run(lambda: "again", tenant="a", cost_bytes=100)

    try:
        assert run(scenario()) == "again"
        assert_nothing_held(gate, 1)
    finally:
        gate.close()


def test_the_charge_and_the_body_bytes_come_back_when_the_thread_ends_after_a_cancellation() -> None:
    gate = gate_with(max_concurrency=1, max_concurrency_per_tenant=1, memory_budget_bytes=100, max_pending_body_bytes=100)
    entered, release = threading.Event(), threading.Event()

    def hold():
        entered.set()
        release.wait(15)

    async def scenario():
        reservation = gate.bodies.reservation()
        reservation.ensure(10)
        running = asyncio.create_task(gate.run(hold, tenant="a", cost_bytes=80, reservation=reservation))
        assert await asyncio.get_running_loop().run_in_executor(None, entered.wait, 15)
        running.cancel()  # the client went away; the thread cannot be interrupted
        with pytest.raises(asyncio.CancelledError):
            await running
        reservation.close()  # what the request does when it ends: the gate owns the bytes now
        assert (gate._charged, gate._tenants, gate.bodies.held) == (80, {"a": 1}, 10)
        release.set()
        await wait_until(lambda: gate._charged == 0 and gate.bodies.held == 0)

    try:
        run(scenario())
        assert_nothing_held(gate, 1)
    finally:
        release.set()
        gate.close()


def test_a_refusal_before_the_thread_leaves_the_body_bytes_to_the_request() -> None:
    gate = gate_with(max_concurrency=1, memory_budget_bytes=100, max_pending_body_bytes=100)

    async def scenario():
        reservation = gate.bodies.reservation()
        reservation.ensure(10)
        with pytest.raises(ServiceProblem):
            await gate.run(lambda: None, cost_bytes=101, reservation=reservation)
        assert gate.bodies.held == 10  # not handed off: the request releases it
        reservation.close()
        reservation.close()  # idempotent
        assert gate.bodies.held == 0

    try:
        run(scenario())
        assert_nothing_held(gate, 1)
    finally:
        gate.close()


def test_without_a_budget_nothing_changes() -> None:
    gate = gate_with(max_concurrency=2)
    assert not gate.bodies.enabled

    async def scenario():
        return await gate.run(lambda: "huge", cost_bytes=10**12), await gate.run(lambda: "none", cost_bytes=0)

    try:
        assert run(scenario()) == ("huge", "none")
        assert gate._charged == 0 and gate._chargers == 0
    finally:
        gate.close()


# --- over HTTP: refused before decoding -----------------------------------------------------------------


def test_an_oversized_request_is_refused_before_it_is_decoded(make_app, hold, monkeypatch) -> None:
    def decoder(*args, **kwargs):
        raise AssertionError("the body must not be decoded")

    monkeypatch.setattr(jobs, "decode_package_request", decoder)
    monkeypatch.setattr(jobs, "decode_model_body", decoder)
    app = make_app(max_concurrency=2, max_concurrency_per_tenant=1, memory_budget_bytes=COST - 1)

    async def scenario():
        async with async_client(app) as client:
            responses = [await post(client), await client.post(EVALUATE, content=PAYLOAD, headers=JSON)]
            return responses

    for response in run(scenario()):
        assert (response.status_code, response.json()["code"]) == (413, "memory_budget_exceeded")
        assert "retry-after" not in response.headers
    assert hold.calls == 0
    assert_nothing_held(app.state.gate, 2)


def test_an_oversized_declared_length_is_refused_without_reading_a_byte(make_app) -> None:
    app = make_app(memory_budget_bytes=10_000)
    declared = 10_000 // BODY_MEMORY_FACTOR + 1

    async def receive():
        raise AssertionError("the body must not be read")

    async def scenario():
        return await call_asgi(app, receive, headers_for((b"content-length", str(declared).encode())))

    status, headers, problem = run(scenario())
    assert (status, problem["code"]) == (413, "memory_budget_exceeded")
    assert headers.get("connection") == "close" and "retry-after" not in headers
    assert_nothing_held(app.state.gate, 4)


def test_a_declared_length_that_fits_is_read_and_served(make_app, hold) -> None:
    app = make_app(memory_budget_bytes=COST)
    hold.release.set()

    async def scenario():
        async with async_client(app) as client:
            return await post(client)

    assert run(scenario()).status_code == 200
    run(wait_until(lambda: app.state.gate.bodies.held == 0))
    assert_nothing_held(app.state.gate, 4)


# --- over HTTP: the bytes of the bodies in flight -------------------------------------------------------


def test_waiting_bodies_are_bounded_and_the_excess_is_refused_early(make_app, hold) -> None:
    app = make_app(
        max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=5000, retry_after_seconds=3,
        max_pending_body_bytes=2 * LENGTH,
    )  # fmt: skip
    gate = app.state.gate

    async def scenario():
        async with async_client(app) as client:
            running = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            waiting = asyncio.create_task(post(client))  # waits for the slot, its body is buffered
            await wait_until(lambda: gate.bodies.held == 2 * LENGTH)
            refused = await post(client)
            held_while_full = gate.bodies.held
            hold.release.set()
            statuses = [(await running).status_code, (await waiting).status_code]
            await wait_until(lambda: gate.bodies.held == 0)
            return refused, held_while_full, statuses, (await post(client)).status_code

    refused, held_while_full, statuses, after = run(scenario())
    assert (refused.status_code, refused.json()["code"]) == (429, "pending_body_bytes")
    assert refused.headers["retry-after"] == "3"
    assert refused.headers["content-type"].startswith("application/problem+json")
    assert held_while_full == 2 * LENGTH  # the refused body added nothing
    assert statuses == [200, 200] and after == 200
    assert_nothing_held(gate, 1)


def test_a_body_larger_than_the_whole_cap_is_413_and_not_retryable(make_app, hold) -> None:
    app = make_app(max_pending_body_bytes=LENGTH - 1)

    async def receive():
        raise AssertionError("the body must not be read")

    async def scenario():
        return await call_asgi(app, receive, headers_for((b"content-length", str(LENGTH).encode())))

    status, headers, problem = run(scenario())
    assert (status, problem["code"]) == (413, "pending_body_too_large")
    assert "retry-after" not in headers and headers.get("connection") == "close"
    assert hold.calls == 0
    assert_nothing_held(app.state.gate, 4)


def chunks_of(size: int, offered: int):
    """A ``receive`` that streams ``offered`` chunks of ``size`` bytes, and how many were read."""
    served = 0

    async def receive():
        nonlocal served
        served += 1
        assert served <= offered, "the stream was read to the end"
        return {"type": "http.request", "body": b"x" * size, "more_body": True}

    return receive, lambda: served


def test_a_chunked_body_is_counted_as_it_arrives_and_cut_off(make_app) -> None:
    app = make_app(max_pending_body_bytes=3000)
    receive, served = chunks_of(1000, offered=100)

    status, headers, problem = run(call_asgi(app, receive, headers_for()))
    assert (status, problem["code"]) == (413, "pending_body_too_large")
    assert served() == 4  # the fourth chunk crossed the cap and nothing was read after it
    assert_nothing_held(app.state.gate, 4)


def test_a_chunked_body_that_does_not_fit_beside_the_others_is_429(make_app, hold) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, max_pending_body_bytes=3000, retry_after_seconds=2)
    receive, served = chunks_of(1000, offered=100)

    async def scenario():
        async with async_client(app) as client:
            running = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            refused = await call_asgi(app, receive, headers_for())
            held = app.state.gate.bodies.held
            hold.release.set()
            await running
            await wait_until(lambda: app.state.gate.bodies.held == 0)
            return refused, held

    (status, headers, problem), held = run(scenario())
    assert (status, problem["code"], headers["retry-after"]) == (429, "pending_body_bytes", "2")
    assert served() == 3 and held == LENGTH  # 3000 + the running body did not fit; the refused bytes were given back
    assert_nothing_held(app.state.gate, 1)


def test_the_body_bytes_come_back_when_the_request_ends_in_error(make_app) -> None:
    app = make_app(max_concurrency=1, max_pending_body_bytes=10_000)

    async def scenario():
        async with async_client(app) as client:
            invalid = await client.post(EVALUATE, content=b"{", headers=JSON)
            await wait_until(lambda: app.state.gate.bodies.held == 0)
            return invalid, await client.post(EVALUATE, content=b"{", headers=JSON)

    invalid, again = run(scenario())
    assert invalid.status_code == again.status_code == 422
    assert_nothing_held(app.state.gate, 1)


def test_the_body_bytes_stay_counted_until_the_thread_ends_after_a_disconnect(make_app, hold) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=30, max_pending_body_bytes=2 * LENGTH)
    gate = app.state.gate

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            await asyncio.sleep(0.05)
            still = gate.bodies.held
            busy = await post(client)  # no slot: 503, and its own bytes are given back
            held_after_busy = gate.bodies.held
            hold.release.set()
            await wait_until(lambda: gate.bodies.held == 0)
            return still, busy, held_after_busy

    still, busy, held_after_busy = run(scenario())
    assert still == held_after_busy == LENGTH
    assert (busy.status_code, busy.json()["code"]) == (503, "service_busy")
    assert_nothing_held(gate, 1)


def test_a_body_over_the_size_limit_never_reaches_the_ledger(make_app) -> None:
    app = make_app(max_body_bytes=64, max_pending_body_bytes=10_000)

    async def scenario():
        async with async_client(app) as client:
            return await client.post(COMPILE, content=b"x" * 65, headers=JSON)

    assert run(scenario()).json()["code"] == "payload_too_large"
    assert_nothing_held(app.state.gate, 4)


def test_with_both_off_there_is_no_ledger_in_the_way(make_app, hold) -> None:
    app = make_app()
    assert not app.state.gate.bodies.enabled
    hold.release.set()

    async def scenario():
        async with async_client(app) as client:
            return await post(client, PAYLOAD + b" " * 100_000)

    assert run(scenario()).status_code == 200
    assert app.state.gate.bodies.held == 0


def test_a_budget_of_zero_with_an_explicit_cap_checks_only_the_cap(make_app, hold) -> None:
    app = make_app(memory_budget_bytes=0, max_pending_body_bytes=10 * LENGTH)
    hold.release.set()

    async def scenario():
        async with async_client(app) as client:
            return await post(client), await post(client, PAYLOAD + b" " * (10 * LENGTH))

    fine, too_big = run(scenario())
    assert fine.status_code == 200
    assert (too_big.status_code, too_big.json()["code"]) == (413, "pending_body_too_large")


# --- the setting ----------------------------------------------------------------------------------------


def test_the_cap_is_derived_from_the_budget_unless_set() -> None:
    assert BimServiceSettings().effective_max_pending_body_bytes == 0
    derived = BimServiceSettings(memory_budget_bytes=8000)
    assert derived.effective_max_pending_body_bytes == 2 * (8000 // BODY_MEMORY_FACTOR)
    assert BimServiceSettings(memory_budget_bytes=8000, max_pending_body_bytes=0).effective_max_pending_body_bytes == 0
    assert BimServiceSettings(memory_budget_bytes=8000, max_pending_body_bytes=77).effective_max_pending_body_bytes == 77
    assert BimServiceSettings(max_pending_body_bytes=5).public_limits()["maxPendingBodyBytes"] == 5
    assert derived.public_limits()["maxPendingBodyBytes"] == 2000


def test_the_environment_sets_the_cap() -> None:
    settings = BimServiceSettings.from_env({"BIM_SERVICE_MAX_PENDING_BODY_BYTES": "4096"})
    assert settings.max_pending_body_bytes == 4096 and settings.effective_max_pending_body_bytes == 4096
    assert BimServiceSettings.from_env({"BIM_SERVICE_MAX_PENDING_BODY_BYTES": "0"}).max_pending_body_bytes == 0
    assert BimServiceSettings.from_env({}).max_pending_body_bytes is None


@pytest.mark.parametrize("value", ["-1", "1.5", "lots"])
def test_an_invalid_cap_stops_the_start(value) -> None:
    with pytest.raises(ServiceConfigError, match="BIM_SERVICE_MAX_PENDING_BODY_BYTES"):
        BimServiceSettings.from_env({"BIM_SERVICE_MAX_PENDING_BODY_BYTES": value})


def test_the_capabilities_publish_the_effective_cap(make_app) -> None:
    app = make_app(memory_budget_bytes=8000)

    async def scenario():
        async with async_client(app) as client:
            return (await client.get("/bim/v1/capabilities")).json()["limits"]["service"]

    published = run(scenario())
    assert (published["memoryBudgetBytes"], published["maxPendingBodyBytes"]) == (8000, 2000)


# --- raw ASGI -------------------------------------------------------------------------------------------


def headers_for(*extra: tuple[bytes, bytes]) -> list[tuple[bytes, bytes]]:
    return [(b"authorization", bearer()["Authorization"].encode()), (b"content-type", b"application/json"), *extra]


async def call_asgi(app, receive, headers, path: str = COMPILE):
    """``(status, response headers, problem)`` of one request made directly on the ASGI interface."""
    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "headers": headers, "client": ("test", 1), "server": ("bim.test", 80),
    }  # fmt: skip
    await app(scope, receive, send)
    start = next(message for message in sent if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    response_headers = {key.decode().lower(): value.decode() for key, value in start["headers"]}
    return start["status"], response_headers, json.loads(body)
