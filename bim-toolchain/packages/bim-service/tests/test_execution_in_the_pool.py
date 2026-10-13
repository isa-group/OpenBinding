"""B8-1 and B8-2: decoding, validation and rendering run in the bounded pool; the optional memory budget and switch interval.

Everything runs in process through the ASGI application (no sockets, no real load).  Time assertions use wide margins
and compare orders of magnitude: they are meant to catch a missing bound, not to measure performance.  What thread mode
cannot do (``json.loads`` and pydantic-core hold the GIL, so a large body can still stall the loop; a timed-out
operation keeps its slot) is pinned as strict ``xfail`` in ``tests/analysis/test_analysis_b8_probe.py``.
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
from starlette.responses import JSONResponse

from bim_service import app as app_module
from bim_service import operations
from bim_service.problems import ServiceProblem
from bim_service.runtime import Gate
from bim_service.settings import BODY_MEMORY_FACTOR, BimServiceSettings, ServiceConfigError

COMPILE = "/bim/v1/compile"
EVALUATE = "/bim/v1/evaluate"
JSON = {"Content-Type": "application/json"}
PAYLOAD = json.dumps({"package": base64.b64encode(b"x").decode()}).encode()
COST = len(PAYLOAD) * BODY_MEMORY_FACTOR


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

    def __call__(self, data, registered, limits):
        with self.lock:
            self.running += 1
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


@pytest.fixture
def restore_switch_interval():
    original = sys.getswitchinterval()
    yield original
    sys.setswitchinterval(original)


def post(client, payload: bytes = PAYLOAD):
    return client.post(COMPILE, content=payload, headers=JSON)


async def served_after_release(client, hold: Hold, attempts: int = 100) -> int:
    """Release the held operations and return the status of the first request that is let in again."""
    hold.release.set()
    for _ in range(attempts):
        status = (await post(client)).status_code
        if status != 503 and status != 429:
            return status
        await asyncio.sleep(0.02)
    raise AssertionError("the service never took a request again")


# --- the answers of the framework are unchanged ---------------------------------------------------------


def test_a_body_that_is_not_json_text_is_422_with_the_position(client) -> None:
    response = client.post(EVALUATE, content=b"{", headers=JSON)
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "urn:bim-toolchain:problem:request_invalid",
        "title": "Request invalid",
        "status": 422,
        "detail": "the request does not match the contract",
        "code": "request_invalid",
        "errorType": "ContractError",
        "diagnostics": [{"code": "request_invalid", "pointer": "/body/1", "message": "JSON decode error"}],
        "httpStatus": 422,
    }


@pytest.mark.parametrize("body", [b"", b"null"])
def test_a_missing_body_is_a_required_field(client, body) -> None:
    response = client.post(EVALUATE, content=body, headers=JSON)
    assert response.status_code == 422
    assert response.json()["diagnostics"] == [
        {"code": "request_invalid", "pointer": "/body", "message": "Field required"}
    ]


def test_a_body_that_declares_no_json_media_type_does_not_match_any_model(client) -> None:
    for headers in ({"Content-Type": "text/plain"}, {"Content-Type": ""}):
        response = client.post(EVALUATE, content=b'{"ir": {}, "bindings": [{}]}', headers=headers)
        assert response.status_code == 422, headers
        assert [item["pointer"] for item in response.json()["diagnostics"]] == ["/body"]


def test_a_vendor_json_media_type_is_json(client, monkeypatch) -> None:
    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: {"results": []})
    response = client.post(
        EVALUATE, content=b'{"ir": {}, "bindings": [{}]}', headers={"Content-Type": "application/vnd.bim+json"}
    )
    assert response.status_code == 200 and response.json() == {"results": []}


def test_bytes_that_cannot_be_parsed_are_the_400_of_the_framework(client) -> None:
    response = client.post(EVALUATE, content=b'{"ir": "\xff"}', headers=JSON)
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")
    problem = response.json()
    assert (problem["code"], problem["detail"]) == ("http_error", "There was an error parsing the body")


def test_the_other_refusals_keep_their_codes(make_app) -> None:
    from service_support import BASE_URL, bearer
    from starlette.testclient import TestClient

    small = TestClient(make_app(max_body_bytes=64), base_url=BASE_URL, headers=bearer())
    assert small.post(COMPILE, content=b"x" * 65, headers=JSON).status_code == 413
    assert small.post(COMPILE, content=b"x", headers={"Content-Type": "application/zip"}).status_code == 415
    assert small.get("/bim/v1/nothing").status_code == 404


def test_a_json_answer_is_byte_for_byte_what_the_framework_rendered(client, monkeypatch) -> None:
    result = {"results": [{"name": "café ☃", "w": 1.5, "n": None, "i": 2, "list": [True, False]}]}
    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: result)
    response = client.post(EVALUATE, json={"ir": {}, "bindings": [{}]})
    expected = JSONResponse(result)
    assert response.content == expected.body
    assert response.headers["content-type"] == expected.headers["content-type"] == "application/json"
    assert response.headers["content-length"] == expected.headers["content-length"]


def test_an_answer_with_a_non_finite_number_is_still_a_generic_500(client, monkeypatch) -> None:
    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: {"x": float("nan")})
    response = client.post(EVALUATE, json={"ir": {}, "bindings": [{}]})
    assert response.status_code == 500 and response.json()["code"] == "internal_error"


# --- work in the pool -----------------------------------------------------------------------------------


def test_the_answer_is_rendered_off_the_event_loop(make_app, monkeypatch) -> None:
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: {"ir": {}})
    original = app_module.render_json
    idents: list[int] = []

    def recording(content):
        idents.append(threading.get_ident())
        return original(content)

    monkeypatch.setattr(app_module, "render_json", recording)
    app = make_app()

    async def scenario() -> int:
        async with async_client(app) as client:
            assert (await post(client)).status_code == 200
        return threading.get_ident()

    loop_ident = run(scenario())
    assert idents and loop_ident not in idents


def test_the_limit_checks_of_a_route_still_answer_422(make_app, monkeypatch) -> None:
    from service_support import BASE_URL, bearer
    from starlette.testclient import TestClient

    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: {"results": []})
    small = TestClient(make_app(max_bindings=1), base_url=BASE_URL, headers=bearer())
    response = small.post(EVALUATE, json={"ir": {}, "bindings": [{}, {}]})
    assert response.status_code == 422 and response.json()["code"] == "limit_exceeded"


def test_a_request_that_finds_no_slot_is_busy_whatever_its_body(make_app, hold) -> None:
    """The slot comes first: a body that would be a 422 is not even looked at while every slot is taken."""
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=30)

    async def scenario():
        async with async_client(app) as client:
            running = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            invalid = await client.post(COMPILE, content=b"{", headers=JSON)
            hold.release.set()
            await running
            free = await client.post(COMPILE, content=b"{", headers=JSON)
            return invalid, free

    invalid, free = run(scenario())
    assert (invalid.status_code, invalid.json()["code"]) == (503, "service_busy")
    assert (free.status_code, free.json()["code"]) == (422, "request_invalid")


def test_a_client_that_goes_away_gives_the_slot_back_when_the_thread_ends(make_app, hold) -> None:
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=30)

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            first.cancel()  # the client disconnects
            with pytest.raises(asyncio.CancelledError):
                await first
            busy = await post(client)  # the thread cannot be interrupted: it still holds the slot
            return busy, await served_after_release(client, hold)

    busy, after = run(scenario())
    assert (busy.status_code, busy.json()["code"]) == (503, "service_busy")
    assert after == 200


def test_a_timed_out_operation_keeps_its_slot_until_its_thread_ends(make_app, hold) -> None:
    """Thread mode on purpose: giving the slot back at the timeout would run more threads than slots."""
    app = make_app(max_concurrency=1, max_concurrency_per_tenant=0, acquire_timeout_ms=30, operation_timeout_seconds=0.1)

    async def scenario():
        async with async_client(app) as client:
            first = await post(client)
            second = await post(client)
            return first, second, hold.running, await served_after_release(client, hold)

    first, second, running, after = run(scenario())
    assert (first.status_code, first.json()["code"]) == (503, "operation_timeout")
    assert (second.status_code, second.json()["code"]) == (503, "service_busy")
    assert running == 1  # still one thread, never two
    assert after == 200


# --- the memory budget (B8-2b) ---------------------------------------------------------------------------


def test_the_budget_is_off_by_default(make_app, hold) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0, acquire_timeout_ms=30)
    assert app.state.settings.memory_budget_bytes == 0

    async def scenario():
        async with async_client(app) as client:
            tasks = [asyncio.create_task(post(client, PAYLOAD + b" " * 1000)) for _ in range(4)]
            await wait_until(lambda: hold.running == 4)
            hold.release.set()
            return [(await task).status_code for task in tasks]

    assert run(scenario()) == [200] * 4


def test_a_request_that_does_not_fit_in_the_budget_is_429_memory_budget(make_app, hold) -> None:
    app = make_app(
        max_concurrency=4, max_concurrency_per_tenant=0, acquire_timeout_ms=30, memory_budget_bytes=2 * COST, retry_after_seconds=3
    )

    async def scenario():
        async with async_client(app) as client:
            tasks = [asyncio.create_task(post(client)) for _ in range(2)]
            await wait_until(lambda: hold.running == 2)
            refused = await post(client)
            gate = app.state.gate
            charged = (gate._charged, gate._chargers)
            hold.release.set()
            statuses = [(await task).status_code for task in tasks]
            return refused, charged, statuses, await served_after_release(client, hold)

    refused, charged, statuses, after = run(scenario())
    assert refused.status_code == 429
    assert refused.headers["retry-after"] == "3"
    assert refused.headers["content-type"].startswith("application/problem+json")
    assert refused.json()["code"] == "memory_budget" and refused.json()["status"] == 429
    assert charged == (2 * COST, 2)
    assert statuses == [200, 200] and after == 200


def test_the_charge_is_returned_when_the_thread_ends_not_at_the_timeout(make_app, hold) -> None:
    app = make_app(
        max_concurrency=2, max_concurrency_per_tenant=0, acquire_timeout_ms=30, operation_timeout_seconds=0.1,
        memory_budget_bytes=COST,
    )  # fmt: skip

    async def scenario():
        async with async_client(app) as client:
            timed_out = await post(client)
            gate = app.state.gate
            still_charged = gate._charged
            second = await post(client)  # a slot is free, but the memory of the first thread is not
            return timed_out, still_charged, second, await served_after_release(client, hold), gate._charged

    timed_out, still_charged, second, after, charged = run(scenario())
    assert timed_out.json()["code"] == "operation_timeout"
    assert still_charged == COST
    assert (second.status_code, second.json()["code"]) == (429, "memory_budget")
    assert after == 200 and charged == 0


def test_a_client_that_goes_away_returns_the_charge_when_the_thread_ends(make_app, hold) -> None:
    app = make_app(max_concurrency=2, max_concurrency_per_tenant=0, acquire_timeout_ms=30, memory_budget_bytes=COST)

    async def scenario():
        async with async_client(app) as client:
            first = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            gate = app.state.gate
            held = gate._charged
            refused = await post(client)
            after = await served_after_release(client, hold)
            await wait_until(lambda: gate._charged == 0)
            return held, refused, after

    held, refused, after = run(scenario())
    assert held == COST and refused.json()["code"] == "memory_budget" and after == 200


def test_a_request_larger_than_the_whole_budget_is_never_admitted_not_even_alone(make_app, hold) -> None:
    """The estimate of the request is above the budget: 413, nothing runs, nothing is held, and it is not retryable."""
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0, acquire_timeout_ms=30, memory_budget_bytes=COST - 1)

    async def scenario():
        async with async_client(app) as client:
            refused = await post(client)
            return refused, await post(client)

    refused, again = run(scenario())
    for response in (refused, again):
        assert response.status_code == 413
        assert response.headers["content-type"].startswith("application/problem+json")
        assert "retry-after" not in response.headers
        assert response.json()["code"] == "memory_budget_exceeded" and response.json()["status"] == 413
        assert "never fit" in response.json()["detail"]
    assert hold.running == 0


def test_a_request_larger_than_the_budget_is_refused_whatever_else_runs(make_app, hold) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=0, acquire_timeout_ms=30, memory_budget_bytes=COST + 10)

    async def scenario():
        async with async_client(app) as client:
            small = asyncio.create_task(post(client))
            await wait_until(lambda: hold.running == 1)
            big = await post(client, PAYLOAD + b" " * 100)
            hold.release.set()
            await small
            return big, await post(client, PAYLOAD + b" " * 100)

    big, alone = run(scenario())
    # not 429: waiting for the other operation would not help
    for response in (big, alone):
        assert (response.status_code, response.json()["code"]) == (413, "memory_budget_exceeded")
        assert "retry-after" not in response.headers


def test_the_budget_charge_accounting_of_the_gate() -> None:
    gate = Gate(BimServiceSettings(tokens_file=None, max_concurrency=4, memory_budget_bytes=100))
    release = threading.Event()

    async def scenario():
        running = [asyncio.create_task(gate.run(release.wait, 15, cost_bytes=40)) for _ in range(2)]
        await wait_until(lambda: gate._chargers == 2)
        assert gate._charged == 80
        with pytest.raises(ServiceProblem) as refused:
            await gate.run(lambda: None, cost_bytes=21)
        assert (refused.value.status, refused.value.code) == (429, "memory_budget")
        assert refused.value.headers == {"Retry-After": "1"}
        assert await gate.run(lambda: "fits", cost_bytes=20) == "fits"  # exactly what is left
        assert await gate.run(lambda: "free", cost_bytes=0) == "free"  # nothing to charge
        release.set()
        await asyncio.gather(*running)
        await wait_until(lambda: gate._charged == 0)
        return gate._chargers

    try:
        assert run(scenario()) == 0
        # the refusal gave back its slot: all four are free again
        assert all(gate._slots.acquire(blocking=False) for _ in range(4))
    finally:
        release.set()
        gate.close()


# --- settings and what they publish ----------------------------------------------------------------------


def test_the_defaults_change_nothing() -> None:
    settings = BimServiceSettings()
    assert settings.switch_interval_seconds is None and settings.memory_budget_bytes == 0
    assert BimServiceSettings.from_env({}) == settings
    published = settings.public_limits()
    assert published["memoryBudgetBytes"] == 0 and published["maxPendingBodyBytes"] == 0
    assert published["switchIntervalSeconds"] == sys.getswitchinterval()


def test_the_environment_sets_the_interval_and_the_budget() -> None:
    settings = BimServiceSettings.from_env(
        {"BIM_SERVICE_SWITCH_INTERVAL": "0.0002", "BIM_SERVICE_MEMORY_BUDGET_BYTES": "1048576"}
    )
    assert (settings.switch_interval_seconds, settings.memory_budget_bytes) == (0.0002, 1048576)
    assert settings.public_limits()["memoryBudgetBytes"] == 1048576
    assert BimServiceSettings.from_env({"BIM_SERVICE_MEMORY_BUDGET_BYTES": "0"}).memory_budget_bytes == 0


@pytest.mark.parametrize(
    "name, value",
    [
        ("BIM_SERVICE_SWITCH_INTERVAL", "0"),
        ("BIM_SERVICE_SWITCH_INTERVAL", "-0.1"),
        ("BIM_SERVICE_SWITCH_INTERVAL", "fast"),
        ("BIM_SERVICE_MEMORY_BUDGET_BYTES", "-1"),
        ("BIM_SERVICE_MEMORY_BUDGET_BYTES", "1.5"),
    ],
)
def test_an_invalid_interval_or_budget_stops_the_start(name, value) -> None:
    with pytest.raises(ServiceConfigError, match=name):
        BimServiceSettings.from_env({name: value})


def test_the_published_limits_carry_the_effective_values(make_app, restore_switch_interval) -> None:
    app = make_app(switch_interval_seconds=0.0002, memory_budget_bytes=4096)

    async def scenario():
        async with app.router.lifespan_context(app):
            async with async_client(app) as client:
                return (await client.get("/bim/v1/capabilities")).json()["limits"]["service"]

    published = run(scenario())
    assert published["memoryBudgetBytes"] == 4096
    assert published["maxPendingBodyBytes"] == 2 * (4096 // BODY_MEMORY_FACTOR)
    assert published["switchIntervalSeconds"] == pytest.approx(0.0002)


# --- the switch interval (B8-2a) -------------------------------------------------------------------------


def test_the_interval_is_applied_by_the_lifespan_and_restored_at_shutdown(make_app, restore_switch_interval) -> None:
    original = restore_switch_interval
    app = make_app(switch_interval_seconds=0.0002)
    assert sys.getswitchinterval() == original  # creating the application changes nothing

    async def scenario():
        async with app.router.lifespan_context(app):
            return sys.getswitchinterval()

    assert run(scenario()) == pytest.approx(0.0002)
    assert sys.getswitchinterval() == original


def test_the_interval_is_restored_when_the_application_stops_with_an_error(make_app, restore_switch_interval) -> None:
    original = restore_switch_interval
    app = make_app(switch_interval_seconds=0.0002)

    async def scenario():
        with pytest.raises(RuntimeError):
            async with app.router.lifespan_context(app):
                raise RuntimeError("crash while serving")

    run(scenario())
    assert sys.getswitchinterval() == original


def test_without_the_setting_the_lifespan_leaves_the_interval_alone(make_app, restore_switch_interval) -> None:
    sys.setswitchinterval(0.0123)  # whatever the process (or the host) chose
    app = make_app()

    async def scenario():
        async with app.router.lifespan_context(app):
            during = sys.getswitchinterval()
            sys.setswitchinterval(0.0456)  # changed by someone else while serving
        return during

    assert run(scenario()) == pytest.approx(0.0123)
    assert sys.getswitchinterval() == pytest.approx(0.0456)  # not "restored" over it


def busy(stop: threading.Event) -> None:
    """Pure-Python CPU work, like the compiler and the evaluator: it keeps the GIL busy until told to stop."""
    while not stop.is_set():
        sum(i * i for i in range(2000))


def test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval(
    make_app, monkeypatch, restore_switch_interval
) -> None:
    """The load of ``tests/analysis`` (4 CPU-bound operations): median /healthz 94-118 ms at the default interval of
    5 ms, a few ms at 0.1 ms.  The bound is the one of the analysis test that sets the interval by hand."""
    stop = threading.Event()
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: (busy(stop), {"ir": {}})[1])
    app = make_app(
        max_concurrency=4, max_concurrency_per_tenant=0, operation_timeout_seconds=30, switch_interval_seconds=0.0001
    )

    async def scenario() -> list[float]:
        async with app.router.lifespan_context(app):
            async with async_client(app) as client:
                tasks = [asyncio.create_task(post(client)) for _ in range(4)]
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
    assert statistics.median(latencies) < 0.03, latencies
