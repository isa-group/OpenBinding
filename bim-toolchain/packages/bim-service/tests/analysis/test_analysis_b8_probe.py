"""B8 (analysis, ``docs/qa/analysis/BIM_B5_B8_M4_IR.md``): what runs in the event loop of ``bim-service``.

Synthetic and local: the ASGI application is driven in-process (``httpx.ASGITransport``), the operations are replaced
by stand-ins, and the cost is measured on the event loop of the test.  Nothing here changes ``bim-service``.

* The tests that pass pin what is already true: the operations run in the bounded pool, and a blocked pool does not
  stop the loop.
* The ``xfail(strict=True)`` tests are open defects: when one is fixed it XPASSes, the suite fails, and the test must
  be turned into a normal test (never into a skip).  The deterministic ones compare thread identities; the timing ones
  compare with the cost of the same work done synchronously, so they do not depend on the speed of the machine.
"""

from __future__ import annotations

import asyncio
import base64
import json
import statistics
import sys
import threading
import time

import pytest
from service_support import async_client, run

from bim_service import app as app_module
from bim_service import models, operations

COMPILE = "/bim/v1/compile"
EVALUATE = "/bim/v1/evaluate"
PACKAGE_BODY = {"package": base64.b64encode(b"x").decode()}


class OpenDefect(AssertionError):
    """The one failure an ``xfail`` below accepts: any other error in a test is a broken test, not the defect."""


def defect(condition: bool, message: str) -> None:
    if not condition:
        raise OpenDefect(message)


async def wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


async def heartbeat(stop: asyncio.Event, lags: list[float], interval: float = 0.005) -> None:
    """How late a 5 ms timer fires: the time the loop was not available."""
    while not stop.is_set():
        before = time.perf_counter()
        await asyncio.sleep(interval)
        lags.append(time.perf_counter() - before - interval)


class Hold:
    """A stand-in for ``operations.compile_package`` that blocks (no CPU) until released."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.running = 0

    def __call__(self, data, registered, limits):
        with self.lock:
            self.running += 1
        try:
            assert self.release.wait(15), "never released"
        finally:
            with self.lock:
                self.running -= 1
        return {"ir": {}}


def busy(stop: threading.Event) -> None:
    """Pure-Python CPU work, like the compiler and the evaluator: it keeps the GIL busy until told to stop."""
    while not stop.is_set():
        sum(i * i for i in range(2000))


# --- what already holds ----------------------------------------------------------------------------------


def test_operations_run_in_the_worker_pool_and_not_in_the_event_loop(make_app, monkeypatch) -> None:
    seen: dict[str, str] = {}

    def stand_in(name, result):
        def call(*args, **kwargs):
            seen[name] = threading.current_thread().name
            return result

        return call

    monkeypatch.setattr(operations, "compile_package", stand_in("compile", {"ir": {}}))
    monkeypatch.setattr(operations, "evaluate", stand_in("evaluate", {"results": []}))
    monkeypatch.setattr(operations, "xml_resource_root", stand_in("xml", {"namespace": "", "localName": "x"}))
    app = make_app()

    async def scenario() -> str:
        async with async_client(app) as client:
            assert (await client.post(COMPILE, json=PACKAGE_BODY)).status_code == 200
            assert (await client.post(EVALUATE, json={"ir": {}, "bindings": [{}]})).status_code == 200
            assert (await client.post("/bim/v1/resources/xml/root", json={"contentBase64": "eA=="})).status_code == 200
        return threading.current_thread().name

    loop_thread = run(scenario())
    assert set(seen) == {"compile", "evaluate", "xml"}
    assert all(name.startswith("bim-op") for name in seen.values()), seen
    assert loop_thread not in seen.values()


def test_healthz_answers_while_every_slot_holds_a_blocked_operation(make_app, monkeypatch) -> None:
    """Blocked (not CPU-bound) workers release the GIL: the loop stays available. Contrast with the CPU test below."""
    hold = Hold()
    monkeypatch.setattr(operations, "compile_package", hold)
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0)

    async def scenario() -> list[float]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(COMPILE, json=PACKAGE_BODY)) for _ in range(4)]
            await wait_until(lambda: hold.running == 4)
            latencies = []
            for _ in range(20):
                started = time.perf_counter()
                assert (await client.get("/healthz")).status_code == 200
                latencies.append(time.perf_counter() - started)
            hold.release.set()
            await asyncio.gather(*tasks)
            return latencies

    try:
        latencies = run(scenario())
    finally:
        hold.release.set()
    assert max(latencies) < 0.25, latencies


def test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load(make_app, monkeypatch) -> None:
    """The cheap mitigation of the GIL contention below, if processes are not adopted at once.

    Measured here with the load of the xfail test that follows (4 CPU-bound operations): /healthz median
    5 ms interval 94-118 ms, 1 ms 21-34 ms, 0.5 ms 38 ms, 0.1 ms 3.6-6.4 ms; the work the 4 threads did per second at
    0.1 ms was about 17% below the 5 ms figure in one run (16.4k against 19.9k; noisy, not repeated).
    """
    original = sys.getswitchinterval()
    stop = threading.Event()
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: (busy(stop), {"ir": {}})[1])
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0, operation_timeout_seconds=30)

    async def scenario() -> list[float]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(COMPILE, json=PACKAGE_BODY)) for _ in range(4)]
            await asyncio.sleep(0.2)
            latencies = []
            for _ in range(15):
                started = time.perf_counter()
                await client.get("/healthz")
                latencies.append(time.perf_counter() - started)
                await asyncio.sleep(0.02)
            stop.set()
            await asyncio.gather(*tasks)
            return latencies

    sys.setswitchinterval(0.0001)
    try:
        latencies = run(scenario())
    finally:
        stop.set()
        sys.setswitchinterval(original)
    assert statistics.median(latencies) < 0.03, latencies


# --- open defects ----------------------------------------------------------------------------------------


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B8: the pool is made of threads, and a compile or an evaluation is pure Python that holds the GIL; with 4 "
        "of them running the event loop gets the GIL one switch interval (5 ms) at a time, many times per request. "
        "Measured here: /healthz median 60-94 ms, p95 about 180 ms, against 0.3 ms idle. Processes (not threads) "
        "remove it."
    ),
)
def test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool(make_app, monkeypatch) -> None:
    stop = threading.Event()
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: (busy(stop), {"ir": {}})[1])
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0, operation_timeout_seconds=30)

    async def scenario() -> list[float]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(COMPILE, json=PACKAGE_BODY)) for _ in range(4)]
            await asyncio.sleep(0.2)
            latencies = []
            for _ in range(15):
                started = time.perf_counter()
                await client.get("/healthz")
                latencies.append(time.perf_counter() - started)
                await asyncio.sleep(0.02)
            stop.set()
            await asyncio.gather(*tasks)
            return latencies

    try:
        latencies = run(scenario())
    finally:
        stop.set()
    median = statistics.median(latencies)
    defect(median < 0.02, f"/healthz median {median * 1000:.0f} ms with 4 CPU-bound operations running")


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason="B8: decode_package_request (json.loads of up to 32 MiB, pydantic, base64) runs in the event loop (app.py:144, :159).",
)
def test_a_package_body_is_decoded_off_the_event_loop(make_app, monkeypatch) -> None:
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: {"ir": {}})
    original = app_module.decode_package_request
    idents: list[int] = []

    def recording(*args, **kwargs):
        idents.append(threading.get_ident())
        return original(*args, **kwargs)

    monkeypatch.setattr(app_module, "decode_package_request", recording)
    app = make_app()

    async def scenario() -> int:
        async with async_client(app) as client:
            assert (await client.post(COMPILE, json=PACKAGE_BODY)).status_code == 200
        return threading.get_ident()

    loop_ident = run(scenario())
    assert idents
    defect(loop_ident not in idents, "the package body was decoded on the event-loop thread")


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B8: FastAPI parses the JSON body and validates the models in the event loop; `_finite` "
        "(models.py:15, bim_core.protocol.contains_non_finite) walks the whole IR in pure Python there."
    ),
)
def test_a_request_model_is_validated_off_the_event_loop(make_app, monkeypatch) -> None:
    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: {"results": []})
    original = models.contains_non_finite
    idents: list[int] = []

    def recording(value):
        idents.append(threading.get_ident())
        return original(value)

    monkeypatch.setattr(models, "contains_non_finite", recording)
    app = make_app()

    async def scenario() -> int:
        async with async_client(app) as client:
            assert (await client.post(EVALUATE, json={"ir": {"a": [1]}, "bindings": [{}]})).status_code == 200
        return threading.get_ident()

    loop_ident = run(scenario())
    assert idents
    defect(loop_ident not in idents, "the request model was validated on the event-loop thread")


def big_ir(approximate_bytes: int) -> dict:
    return {"items": [{"id": i, "w": 1.5, "tags": ["a", "b"], "n": None} for i in range(approximate_bytes // 50)]}


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B8: a 12 MiB body below the 32 MiB limit stalls the loop for about as long as parsing it synchronously "
        "(measured 0.6 s for 14 MB, 1.15 s for 28 MB: about 40 ms per MB), before any slot or tenant limit applies."
    ),
)
def test_the_loop_is_not_stalled_while_a_large_body_is_parsed(make_app, monkeypatch) -> None:
    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: {"results": []})
    app = make_app()
    payload = json.dumps({"ir": big_ir(12 * 1024 * 1024), "bindings": [{}]}).encode()
    started = time.perf_counter()
    json.loads(payload)
    synchronous = time.perf_counter() - started

    async def scenario() -> list[float]:
        async with async_client(app) as client:
            lags: list[float] = []
            stop = asyncio.Event()
            beat = asyncio.create_task(heartbeat(stop, lags))
            await asyncio.sleep(0.05)
            response = await client.post(EVALUATE, content=payload, headers={"content-type": "application/json"})
            assert response.status_code == 200
            stop.set()
            await beat
            return lags

    lags = run(scenario())
    defect(max(lags) < 0.3 * synchronous, f"loop stalled {max(lags):.2f} s; the same parse alone takes {synchronous:.2f} s")


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B8: the body is decoded before a slot is taken (app.py:144 then runtime.py:79), so N waiting requests cost N "
        "decoded bodies in memory although only `max_concurrency` can run."
    ),
)
def test_no_body_is_decoded_for_a_request_that_finds_no_free_slot(make_app, monkeypatch) -> None:
    hold = Hold()
    monkeypatch.setattr(operations, "compile_package", hold)
    original = app_module.decode_package_request
    decoded: list[int] = []

    def counting(*args, **kwargs):
        decoded.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(app_module, "decode_package_request", counting)
    app = make_app(max_concurrency=2, max_concurrency_per_tenant=0, acquire_timeout_ms=30)

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            running = [asyncio.create_task(client.post(COMPILE, json=PACKAGE_BODY)) for _ in range(2)]
            await wait_until(lambda: hold.running == 2)
            refused = await asyncio.gather(*(client.post(COMPILE, json=PACKAGE_BODY) for _ in range(4)))
            statuses = [response.status_code for response in refused]
            hold.release.set()
            await asyncio.gather(*running)
            return statuses

    try:
        statuses = run(scenario())
    finally:
        hold.release.set()
    assert statuses == [503] * 4
    defect(len(decoded) == 2, f"{len(decoded)} bodies decoded for 2 slots")


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B8: an operation that outran its time budget answers 503 but its thread cannot be stopped, so the slot stays "
        "taken until the CPU work ends (runtime.py:7-8, :92-98). bim-core has no time budget for compile/evaluate."
    ),
)
def test_a_timed_out_operation_gives_its_slot_back(make_app, monkeypatch) -> None:
    stop = threading.Event()
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: (busy(stop), {"ir": {}})[1])
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=20, operation_timeout_seconds=0.2)

    async def scenario() -> tuple[int, int]:
        async with async_client(app) as client:
            first = await client.post(COMPILE, json=PACKAGE_BODY)
            await asyncio.sleep(0.3)
            monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: {"ir": {}})
            second = await client.post(COMPILE, json=PACKAGE_BODY)
            return first.status_code, second.status_code

    try:
        first, second = run(scenario())
    finally:
        stop.set()
    assert first == 503
    defect(second == 200, f"answered {second}: the slot is still held by the thread that timed out")
