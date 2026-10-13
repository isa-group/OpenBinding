"""``BIM_SERVICE_EXECUTOR=process``: operations in worker processes (Linux only).

Parent monkeypatches do not reach a worker (another interpreter), so these tests load ``process_standins`` in the
workers (``process_app``): operations driven by the request data (``spin:<s>``, ``sleep:<s>``, ``alloc:<bytes>``,
``segv``, ``raise``, ``print``...).  The comments P1-P13 are the acceptance tests of the design; the tests of thread mode
stay in the other files and are not touched by this one.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import signal
import sys
import time
import tracemalloc
import zipfile

import pytest
from service_support import async_client, bearer, run

import consumer_fixtures as demo
from bim_service import _worker, workers
from bim_service.runtime import Gate
from bim_service.settings import BimServiceSettings, ServiceConfigError

COMPILE = "/bim/v1/compile"
EVALUATE = "/bim/v1/evaluate"
JSON = {"Content-Type": "application/json"}
TRACE = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
CORRELATION_ID = "0af7651916cd43dd8448eb211c80319c"
MIB = 1024 * 1024


# --- helpers -------------------------------------------------------------------------------------------


def command(text: str) -> dict:
    """The body of a ``/compile`` request that ``process_standins`` reads as a command."""
    return {"package": base64.b64encode(text.encode()).decode()}


async def post(client, text: str, **kwargs):
    return await client.post(COMPILE, json=command(text), **kwargs)


async def wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


def children() -> list[int]:
    """The pids of the children of this process (zombies included), from ``/proc``."""
    me = os.getpid()
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", encoding="ascii", errors="replace") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if int(fields[1]) == me:
            found.append(int(entry))
    return found


def busy_pids(app) -> list[int]:
    return [slot.pid for slot in app.state.gate.pool.slots if slot.state == workers.BUSY and slot.pid]


def reaped(pid: int) -> bool:
    """Whether ``waitpid`` has nothing to say about ``pid`` any more (it was reaped by its parent).

    A zombie still has its ``/proc`` entry; looking there first keeps the test from reaping a child behind the pool's back.
    """
    if os.path.exists(f"/proc/{pid}"):
        return False
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return True
    return False


def open_pidfds() -> int:
    count = 0
    for entry in os.listdir("/proc/self/fd"):
        try:
            if os.readlink(f"/proc/self/fd/{entry}") == "anon_inode:[pidfd]":
                count += 1
        except OSError:
            continue
    return count


def assert_nothing_held(gate: Gate, slots: int) -> None:
    assert gate._charged == 0 and gate._chargers == 0
    assert gate._tenants == {}
    assert gate.bodies.held == 0
    assert all(gate._slots.acquire(blocking=False) for _ in range(slots)), "a slot leaked"
    for _ in range(slots):
        gate._slots.release()


def one(app, path: str, body: bytes, content_type: str = "application/json", headers: dict | None = None):
    """``(status, content-type, retry-after, body bytes)`` of one request."""

    async def scenario():
        async with async_client(app) as client:
            response = await client.post(path, content=body, headers={"Content-Type": content_type, **(headers or {})})
            return (
                response.status_code,
                response.headers.get("content-type"),
                response.headers.get("retry-after"),
                response.content,
            )

    return run(scenario())


# --- settings ------------------------------------------------------------------------------------------


def test_the_executor_is_thread_by_default_and_validated() -> None:
    assert BimServiceSettings().executor == "thread"
    assert BimServiceSettings.from_env({}).executor == "thread"
    assert BimServiceSettings.from_env({"BIM_SERVICE_EXECUTOR": "process"}).executor == "process"
    assert BimServiceSettings.from_env({"BIM_SERVICE_EXECUTOR": " Thread "}).executor == "thread"
    for bad in ("threads", "fork", "1", "processes"):
        with pytest.raises(ServiceConfigError, match="BIM_SERVICE_EXECUTOR"):
            BimServiceSettings.from_env({"BIM_SERVICE_EXECUTOR": bad})
    with pytest.raises(ServiceConfigError, match="BIM_SERVICE_EXECUTOR"):
        BimServiceSettings(executor="greenlets")


def test_the_executor_is_published_and_the_preload_is_neither_read_nor_published() -> None:
    assert BimServiceSettings().public_limits()["executor"] == "thread"
    assert BimServiceSettings(executor="process").public_limits()["executor"] == "process"
    assert "worker_preload" not in BimServiceSettings(worker_preload=("x",)).public_limits()
    assert not any("preload" in key.lower() for key in BimServiceSettings(worker_preload=("x",)).public_limits())
    assert BimServiceSettings.from_env({"BIM_SERVICE_WORKER_PRELOAD": "os"}).worker_preload == ()


def test_process_mode_is_refused_where_pidfd_is_missing(make_app, monkeypatch) -> None:
    monkeypatch.delattr(os, "pidfd_open")
    with pytest.raises(ServiceConfigError, match="pidfd"):
        make_app(executor="process")
    with pytest.raises(ServiceConfigError, match="pidfd"):
        Gate(BimServiceSettings(executor="process"))
    assert make_app(executor="thread").state.gate.pool is None  # thread mode needs nothing of the kind


def test_thread_mode_starts_no_process(make_app) -> None:
    app = make_app()
    assert app.state.gate.process_mode is False and app.state.gate.pool is None
    assert children() == []


def test_the_published_limits_say_which_executor_runs(process_app, make_app) -> None:
    async def published(app):
        async with async_client(app) as client:
            return (await client.get("/bim/v1/capabilities")).json()["limits"]["service"]["executor"]

    assert run(published(process_app(max_concurrency=1))) == "process"
    assert run(published(make_app())) == "thread"


# --- the happy path ------------------------------------------------------------------------------------


def test_requests_are_answered_by_a_worker_and_the_answer_is_relayed_as_it_came(process_app) -> None:
    app = process_app(max_concurrency=1)
    status, content_type, _, body = one(app, COMPILE, json.dumps(command("plain")).encode())
    answer = json.loads(body)
    assert (status, content_type) == (200, "application/json")
    assert answer["pid"] not in (os.getpid(), None) and answer["command"] == "plain"
    assert app.state.gate.pool.slots[0].pid == answer["pid"]
    # a deterministic error comes back as the same problem document and the worker is kept
    status, content_type, _, body = one(app, EVALUATE, b"{")
    problem = json.loads(body)
    assert (status, content_type, problem["code"]) == (422, "application/problem+json", "request_invalid")
    assert app.state.gate.pool.slots[0].pid == answer["pid"] and app.state.gate.pool.slots[0].state == workers.IDLE


def test_an_answer_larger_than_a_slice_is_relayed_whole_with_its_length(process_app) -> None:
    app = process_app(max_concurrency=1, max_body_bytes=MIB)
    status, _, _, body = one(app, COMPILE, json.dumps(command("big:3000000")).encode())
    assert status == 200 and len(body) > 3_000_000
    assert json.loads(body)["data"] == "x" * 3_000_000

    async def headers():
        async with async_client(app) as client:
            response = await post(client, "big:3000000")
            return response.headers["content-length"], len(response.content)

    declared, received = run(headers())
    assert int(declared) == received


def test_an_answer_above_the_allowance_is_a_500_and_the_worker_is_replaced(process_app) -> None:
    app = process_app(max_concurrency=1, max_body_bytes=MIB)  # the allowance is 8 MiB
    pool = app.state.gate.pool
    first = json.loads(one(app, COMPILE, json.dumps(command("plain")).encode())[3])["pid"]
    status, _, _, body = one(app, COMPILE, json.dumps(command("big:20000000")).encode())
    assert (status, json.loads(body)["code"]) == (500, "internal_error")
    assert reaped(first)
    after = json.loads(one(app, COMPILE, json.dumps(command("plain")).encode())[3])["pid"]
    assert after != first and pool.slots[0].pid == after


def test_the_worker_is_a_hardened_process(process_app) -> None:
    app = process_app(max_concurrency=1, operation_timeout_seconds=60)
    slot = app.state.gate.pool.slots[0]
    assert slot.limits["core"] == 0 and slot.limits["fsize"] == 0 and slot.limits["nofile"] == 64
    assert 0 < slot.limits["as"] < 1 << 62  # the address space is capped (virtual size, not resident memory)
    assert slot.vm_ready > slot.rss_ready > 0
    answer = json.loads(one(app, COMPILE, json.dumps(command("proc")).encode())[3])
    assert answer["oom"] == 1000 and answer["nice"] >= 10
    limits = json.loads(one(app, COMPILE, json.dumps(command("rlimits")).encode())[3])
    assert limits["as"] == slot.limits["as"]
    # the soft CPU limit of the request: CPU used so far + the time budget + 2 s
    assert 62 <= limits["cpu"] <= 62 + 30


def test_the_worker_environment_has_no_service_variables_and_no_token(process_app, monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("BIM_SERVICE_TOKENS_FILE", str(tmp_path / "tokens"))
    monkeypatch.setenv("BIM_SERVICE_MAX_CONCURRENCY", "9")
    monkeypatch.setenv("DEPLOY_TOKEN", "super-secret-value")
    monkeypatch.setenv("BIM_MAX_ENTRIES", "1")
    app = process_app(max_concurrency=1)
    pid = app.state.gate.pool.slots[0].pid
    with open(f"/proc/{pid}/environ", "rb") as handle:
        entries = [item for item in handle.read().split(b"\0") if item]
    text = b"\n".join(entries).decode()
    assert "TOKEN" not in text and "super-secret-value" not in text
    assert not any(item.startswith(b"BIM_") for item in entries)
    allowed = {"PATH", "LANG", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "MALLOC_ARENA_MAX", "PYTHONHASHSEED"}
    assert {item.split(b"=", 1)[0].decode() for item in entries} <= allowed
    names = json.loads(one(app, COMPILE, json.dumps(command("rlimits")).encode())[3])["environ"]
    assert not any(name.startswith("BIM_") or "TOKEN" in name for name in names)


# --- P1: never more children than slots ----------------------------------------------------------------


def test_p1_twice_the_slots_of_concurrent_requests_never_make_more_children_than_slots(process_app) -> None:
    app = process_app(max_concurrency=2, max_concurrency_per_tenant=0, operation_timeout_seconds=30)

    async def scenario():
        counts: list[int] = []
        stop = asyncio.Event()

        async def sample():
            while not stop.is_set():
                counts.append(len(children()))
                await asyncio.sleep(0.005)

        sampler = asyncio.create_task(sample())
        async with async_client(app) as client:
            responses = await asyncio.gather(*(post(client, "spin:1") for _ in range(4)))
        stop.set()
        await sampler
        return counts, responses

    counts, responses = run(scenario())
    assert max(counts) == 2, "two children serve, never more"
    assert sorted(response.status_code for response in responses) == [200, 200, 503, 503]
    for response in responses:
        if response.status_code == 503:
            assert response.json()["code"] == "service_busy" and response.headers["retry-after"] == "1"


# --- P2 and P3: the slot comes back when the child is gone -----------------------------------------------


def test_p2_a_timed_out_operation_kills_and_reaps_its_worker_and_the_next_request_is_served(process_app) -> None:
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0, operation_timeout_seconds=0.5)
    pool = app.state.gate.pool

    async def scenario():
        async with async_client(app) as client:
            task = asyncio.create_task(post(client, "spin:forever"))
            await wait_until(lambda: busy_pids(app))
            pid = busy_pids(app)[0]
            response = await task
            await wait_until(lambda: reaped(pid), timeout=1.0)
            pidfds_while_empty = open_pidfds()
            follow_up = await post(client, "plain")
            return pid, response, pidfds_while_empty, follow_up

    pid, response, pidfds_after, follow_up = run(scenario())
    assert (response.status_code, response.json()["code"]) == (503, "operation_timeout")
    assert response.json()["detail"] == "the operation exceeded its time budget of 0.5 s"
    assert pidfds_after <= 1 and pool.slots[0].pid != pid
    assert follow_up.status_code == 200 and follow_up.json()["pid"] != pid
    assert_nothing_held(app.state.gate, 1)


def test_p3_a_client_that_goes_away_stops_the_worker_and_everything_it_held_comes_back(process_app) -> None:
    app = process_app(
        max_concurrency=2,
        max_concurrency_per_tenant=1,
        memory_budget_bytes=100_000,
        max_pending_body_bytes=100_000,
        operation_timeout_seconds=30,
    )
    gate = app.state.gate

    async def scenario():
        async with async_client(app) as client:
            task = asyncio.create_task(post(client, "spin:forever"))
            await wait_until(lambda: busy_pids(app))
            pid = busy_pids(app)[0]
            held = (gate._charged > 0, dict(gate._tenants), gate.bodies.held > 0)
            task.cancel()  # the client disconnects
            with pytest.raises(asyncio.CancelledError):
                await task
            await wait_until(lambda: reaped(pid), timeout=1.0)
            await wait_until(lambda: gate._charged == 0 and gate._tenants == {} and gate.bodies.held == 0, timeout=1.0)
            return pid, held, await post(client, "plain")

    pid, held, follow_up = run(scenario())
    assert held == (True, {"default": 1}, True)
    assert follow_up.status_code == 200 and follow_up.json()["pid"] != pid
    assert_nothing_held(gate, 2)


def test_p3_the_disconnect_message_of_the_server_stops_the_worker(process_app) -> None:
    """Under a real server the handler is not cancelled: the watcher sees ``http.disconnect`` and aborts the call."""
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0, operation_timeout_seconds=30)
    body = json.dumps(command("spin:forever")).encode()
    sent: list[dict] = []

    async def scenario():
        messages = [{"type": "http.request", "body": body, "more_body": False}]
        disconnect_at = 0.0

        async def receive():
            nonlocal disconnect_at
            if messages:
                return messages.pop(0)
            await wait_until(lambda: busy_pids(app))
            await asyncio.sleep(0.2)
            disconnect_at = time.monotonic()
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": COMPILE, "raw_path": COMPILE.encode(), "query_string": b"", "root_path": "",
            "headers": [
                (b"authorization", bearer()["Authorization"].encode()),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
            "client": ("test", 1), "server": ("bim.test", 80),
        }  # fmt: skip
        pids: list[int] = []

        async def remember():
            await wait_until(lambda: busy_pids(app))
            pids.extend(busy_pids(app))

        remembered = asyncio.create_task(remember())
        await app(scope, receive, send)
        await remembered
        elapsed = time.monotonic() - disconnect_at
        await wait_until(lambda: reaped(pids[0]), timeout=1.0)
        return elapsed

    elapsed = run(scenario())
    assert elapsed < 1.0
    assert sent and sent[0]["status"] == 499
    assert_nothing_held(app.state.gate, 1)


# --- P4: no storm of spawns ------------------------------------------------------------------------------


def test_p4_fifty_consecutive_timeouts_are_not_a_storm_of_spawns(process_app) -> None:
    app = process_app(
        max_concurrency=2, max_concurrency_per_tenant=0, operation_timeout_seconds=0.1, acquire_timeout_ms=100
    )
    pool = app.state.gate.pool

    async def scenario():
        counts: list[int] = []
        stop = asyncio.Event()

        async def sample():
            while not stop.is_set():
                counts.append(len(children()))
                await asyncio.sleep(0.005)

        sampler = asyncio.create_task(sample())
        codes = []
        async with async_client(app) as client:
            for _ in range(50):
                response = await post(client, "spin:forever")
                codes.append((response.status_code, response.json()["code"]))
            final = await post(client, "plain")
        stop.set()
        await sampler
        return counts, codes, final

    counts, codes, final = run(scenario())
    assert max(counts) <= 2
    assert codes == [(503, "operation_timeout")] * 50
    times = sorted(pool.start_times)
    assert len(times) >= 50
    # at most two starts in any half second: one per slot per workers.RESPAWN_INTERVAL
    assert all(times[i + 2] - times[i] >= workers.RESPAWN_INTERVAL - 0.02 for i in range(len(times) - 2))
    assert final.status_code == 200
    assert_nothing_held(app.state.gate, 2)


# --- P5 to P8: what a worker can do to itself --------------------------------------------------------------


def test_p5_a_worker_killed_from_outside_is_a_generic_500_and_the_service_goes_on(process_app) -> None:
    app = process_app(max_concurrency=2, max_concurrency_per_tenant=0, operation_timeout_seconds=30)

    async def scenario():
        async with async_client(app) as client:
            task = asyncio.create_task(post(client, "spin:forever", headers={"traceparent": TRACE}))
            await wait_until(lambda: busy_pids(app))
            os.kill(busy_pids(app)[0], signal.SIGKILL)  # what the OOM killer does
            during = (await client.get("/healthz")).status_code
            response = await task
            after = (await client.get("/healthz")).status_code
            return during, response, after, await post(client, "plain")

    during, response, after, follow_up = run(scenario())
    assert during == after == 200
    assert response.status_code == 500
    problem = response.json()
    assert problem["code"] == "internal_error" and problem["detail"] == "the service failed to process the request"
    assert problem["correlationId"] == CORRELATION_ID == response.headers["traceparent"].split("-")[1]
    assert follow_up.status_code == 200
    assert_nothing_held(app.state.gate, 2)


def test_p6_memory_above_the_allowance_is_a_500_and_the_worker_is_replaced_not_reused(process_app) -> None:
    app = process_app(max_concurrency=1, max_body_bytes=MIB, max_concurrency_per_tenant=0)  # allowance 8 MiB

    async def scenario():
        async with async_client(app) as client:
            first = await post(client, "plain")
            failed = await post(client, "alloc:400000000", headers={"traceparent": TRACE})
            second = await post(client, "plain")
            return first, failed, second

    first, failed, second = run(scenario())
    assert failed.status_code == 500 and failed.json()["code"] == "internal_error"
    assert failed.json()["correlationId"] == CORRELATION_ID
    assert second.status_code == 200 and second.json()["pid"] != first.json()["pid"]
    assert reaped(first.json()["pid"])


def test_p7_a_crashing_worker_is_a_500_with_a_correlation_id_and_has_no_core_limit(process_app) -> None:
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)
    pool = app.state.gate.pool
    assert pool.slots[0].limits["core"] == 0
    pid = pool.slots[0].pid

    async def scenario():
        async with async_client(app) as client:
            crashed = await post(client, "segv", headers={"traceparent": TRACE})
            return crashed, await post(client, "plain")

    crashed, follow_up = run(scenario())
    assert crashed.status_code == 500 and crashed.json()["correlationId"] == CORRELATION_ID
    assert "SECRET" not in crashed.text
    assert reaped(pid) and follow_up.status_code == 200 and follow_up.json()["pid"] != pid


def test_p7_an_unexpected_exception_in_a_worker_is_generic_and_retires_the_worker(process_app, caplog) -> None:
    import logging

    caplog.set_level(logging.DEBUG)
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)

    async def scenario():
        async with async_client(app) as client:
            first = await post(client, "plain")
            failed = await post(client, "raise", headers={"traceparent": TRACE})
            return first, failed, await post(client, "plain")

    first, failed, second = run(scenario())
    assert failed.status_code == 500 and failed.json()["code"] == "internal_error"
    assert "SECRET" not in failed.text and "RuntimeError" not in failed.text
    assert "SECRET" not in caplog.text, "the message of the exception must not be logged"
    assert "worker_exit" in caplog.text and f"correlation_id={CORRELATION_ID}" in caplog.text
    assert "RuntimeError" in caplog.text
    assert second.json()["pid"] != first.json()["pid"]


def test_p8_garbage_on_the_standard_streams_of_a_worker_does_not_disturb_the_answer(process_app) -> None:
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)

    async def scenario():
        async with async_client(app) as client:
            return await post(client, "print"), await post(client, "plain")

    garbage, plain = run(scenario())
    assert garbage.status_code == 200 and garbage.json()["command"] == "print"
    assert plain.json()["pid"] == garbage.json()["pid"], "the worker is reused"


# --- P9: a worker that breaks the protocol ------------------------------------------------------------------


@pytest.mark.parametrize(
    "behaviour",
    [
        "bad-magic", "huge-header", "huge-body", "bad-json", "wrong-seq", "status-302", "set-cookie",
        "long-retry-after", "media-type", "wrong-kind",
    ],
)  # fmt: skip
def test_p9_a_worker_that_breaks_the_protocol_is_killed_and_the_answer_is_a_500(process_app, monkeypatch, behaviour) -> None:
    monkeypatch.setattr(
        workers,
        "child_argv",
        lambda fd: [sys.executable, "-s", "-c", "from fake_worker import main; main()", str(fd)],
    )
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)
    pool = app.state.gate.pool
    pid = pool.slots[0].pid
    rss_before = _worker.read_status()["VmRSS"]
    tracemalloc.start()
    tracemalloc.reset_peak()
    try:
        status, _, _, body = one(app, COMPILE, json.dumps(command(behaviour)).encode(), headers={"traceparent": TRACE})
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    rss_after = _worker.read_status()["VmRSS"]
    assert (status, json.loads(body)["code"]) == (500, "internal_error")
    assert json.loads(body)["correlationId"] == CORRELATION_ID
    assert reaped(pid), "the worker was not killed and reaped"
    assert peak < 64 * MIB and rss_after - rss_before < 64 * MIB, "the declared length was allocated"


def test_p9_the_fake_worker_is_a_valid_worker_until_it_misbehaves(process_app, monkeypatch) -> None:
    monkeypatch.setattr(
        workers,
        "child_argv",
        lambda fd: [sys.executable, "-s", "-c", "from fake_worker import main; main()", str(fd)],
    )
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)
    status, content_type, _, body = one(app, COMPILE, json.dumps(command("ok")).encode())
    assert (status, content_type, body) == (200, "application/json", b'{"ok":true}')


def test_a_worker_of_another_toolchain_is_killed_before_it_serves(make_app, monkeypatch) -> None:
    monkeypatch.setattr(workers, "capabilities_identity", lambda: "not-the-identity-of-the-child")
    app = make_app(executor="process", max_concurrency=1, worker_preload=("process_standins",))
    gate = app.state.gate
    try:
        with pytest.raises(ServiceConfigError, match="did not start"):
            gate.start_workers(check_fit=False)
        assert children() == []
    finally:
        gate.close()


# --- P10: shutdown ---------------------------------------------------------------------------------------


def test_p10_shutdown_with_busy_and_idle_workers_reaps_them_all_in_time(process_app) -> None:
    app = process_app(max_concurrency=4, max_concurrency_per_tenant=0, operation_timeout_seconds=60)
    gate = app.state.gate

    async def scenario():
        async with async_client(app) as client:
            tasks = [asyncio.create_task(post(client, "spin:forever")) for _ in range(2)]
            await wait_until(lambda: len(busy_pids(app)) == 2)
            assert len(children()) == 4
            started = time.monotonic()
            await asyncio.to_thread(gate.close)
            elapsed = time.monotonic() - started
            responses = await asyncio.gather(*tasks)
            return elapsed, responses

    elapsed, responses = run(scenario())
    assert elapsed < 3.0
    assert children() == [], "a child outlived the shutdown (or is a zombie)"
    assert [response.status_code for response in responses] == [503, 503]
    assert open_pidfds() == 0
    assert gate.ready() is False


def test_the_lifespan_starts_the_workers_and_stops_them(make_app, monkeypatch) -> None:
    monkeypatch.setattr(workers, "read_memory_max", lambda: None)
    app = make_app(executor="process", max_concurrency=2, worker_preload=("process_standins",))
    assert children() == [], "nothing starts before the lifespan (or the first request)"

    async def scenario():
        async with app.router.lifespan_context(app):
            running = len(children())
            async with async_client(app) as client:
                response = await post(client, "plain")
            return running, response

    running, response = run(scenario())
    assert running == 2 and response.status_code == 200
    assert children() == []


def test_workers_start_lazily_without_a_lifespan_and_stop_with_the_gate(make_app) -> None:
    app = make_app(executor="process", max_concurrency=2, worker_preload=("process_standins",))
    gate = app.state.gate
    try:
        assert children() == []
        status = one(app, COMPILE, json.dumps(command("plain")).encode())[0]
        assert status == 200 and len(children()) >= 1
    finally:
        gate.close()
    assert children() == []


# --- start failures: back-off and readiness --------------------------------------------------------------------


def test_failed_starts_back_off_and_the_service_is_not_ready_while_every_slot_does(make_app, monkeypatch) -> None:
    app = make_app(executor="process", max_concurrency=2, max_concurrency_per_tenant=0, worker_preload=("process_standins",))
    gate = app.state.gate
    pool = gate.pool

    async def scenario():
        async with async_client(app) as client:
            with monkeypatch.context() as patch:
                patch.setattr(
                    workers, "child_argv", lambda fd: [sys.executable, "-s", "-c", "raise SystemExit(3)", str(fd)]
                )
                first = await post(client, "plain")
                second = await post(client, "plain")
                third = await post(client, "plain")  # inside the back-off: no new attempt
                ready = await client.get("/readyz")
                health = await client.get("/healthz")
                attempts = len(pool.start_times)
            await asyncio.sleep(1.1)  # the back-off of the first failure (0.5 s) is over
            recovered = await post(client, "plain")
            return first, second, third, ready, health, attempts, recovered, await client.get("/readyz")

    try:
        first, second, third, ready, health, attempts, recovered, ready_again = run(scenario())
    finally:
        gate.close()
    for response in (first, second, third):
        assert (response.status_code, response.json()["code"]) == (503, "service_busy")
        assert response.headers["retry-after"] == "1"
    assert attempts == 2, "the third request did not try to start a worker"
    assert (ready.status_code, ready.json()["code"]) == (503, "not_ready")
    assert health.status_code == 200
    assert recovered.status_code == 200 and ready_again.status_code == 200


# --- the fit rule ------------------------------------------------------------------------------------------------


def test_the_fit_rule_adds_the_documented_terms() -> None:
    settings = BimServiceSettings(
        executor="process", max_concurrency=2, max_body_bytes=16 * MIB, memory_budget_bytes=128 * MIB,
        max_pending_body_bytes=32 * MIB,
    )  # fmt: skip
    fit = workers.memory_fit(settings, parent_rss=55 * MIB, child_rss=60 * MIB, memory_max=256 * MIB)
    allowance = 8 * 16 * MIB
    assert fit.terms == {
        "P": 55 * MIB, "Q": 32 * MIB, "N*C": 120 * MIB, "B": 128 * MIB, "N*(L+R)": 2 * (16 * MIB + allowance),
    }  # fmt: skip
    assert fit.margin == int(0.1 * 256 * MIB)
    assert fit.required == sum(fit.terms.values()) + fit.margin
    assert not fit.fits
    assert workers.memory_fit(settings, 1, 1, None).fits  # no limit
    huge = workers.memory_fit(settings, 55 * MIB, 60 * MIB, 1 << 40)
    assert huge.fits
    off = BimServiceSettings(executor="process", max_concurrency=3, max_body_bytes=MIB)
    terms = workers.memory_fit(off, 0, 0, None).terms
    assert terms["B"] == 3 * 8 * MIB and terms["Q"] == 0  # no budget: the hard bound of the workers


def test_a_service_that_does_not_fit_the_container_refuses_to_start_and_leaves_no_child(make_app, monkeypatch) -> None:
    app = make_app(executor="process", max_concurrency=1, max_body_bytes=MIB, worker_preload=("process_standins",))
    gate = app.state.gate
    try:
        monkeypatch.setattr(workers, "read_memory_max", lambda: 64 * MIB)
        with pytest.raises(ServiceConfigError, match="do not fit"):
            gate.start_workers()
        assert children() == []
    finally:
        gate.close()
    again = make_app(executor="process", max_concurrency=1, max_body_bytes=MIB, worker_preload=("process_standins",))
    try:
        monkeypatch.setattr(workers, "read_memory_max", lambda: 1 << 40)
        again.state.gate.start_workers()  # fits
        assert len(children()) == 1
    finally:
        again.state.gate.close()


# --- P13: retiring --------------------------------------------------------------------------------------------


def test_p13_a_worker_whose_memory_grew_is_replaced_after_its_answer(process_app) -> None:
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)

    async def scenario():
        async with async_client(app) as client:
            grown = await post(client, "hold:40000000")
            after = await post(client, "plain")
            return grown, after, await post(client, "plain")

    grown, after, again = run(scenario())
    assert grown.status_code == 200, "the answer that made it grow is still delivered"
    assert after.json()["pid"] != grown.json()["pid"]
    assert again.json()["pid"] == after.json()["pid"], "a worker that did not grow is reused"
    assert reaped(grown.json()["pid"])


def test_a_worker_is_replaced_after_its_thousandth_answer(process_app, monkeypatch) -> None:
    monkeypatch.setattr(workers, "RETIRE_ANSWERS", 3)
    app = process_app(max_concurrency=1, max_concurrency_per_tenant=0)

    async def scenario():
        async with async_client(app) as client:
            return [(await post(client, "plain")).json()["pid"] for _ in range(5)]

    pids = run(scenario())
    assert len(set(pids[:3])) == 1 and pids[3] != pids[0] and pids[3] == pids[4]


# --- P12: the same answers, byte for byte ---------------------------------------------------------------------


def _zip_bomb() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("instance.json", b"\0" * (20 * MIB))
    return buffer.getvalue()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _multipart(*parts: tuple[str, bytes]) -> bytes:
    out = b""
    for name, content in parts:
        out += b"--b\r\nContent-Disposition: form-data; name=\"" + name.encode() + b"\"\r\n\r\n" + content + b"\r\n"
    return out + b"--b--\r\n"


def corpus() -> list[tuple[str, str, str, bytes]]:
    """Hostile and ordinary requests: ``(name, path, content type, body)``."""
    xml_ns = b'<?xml version="1.0"?><a xmlns="urn:x"/>'
    xxe = b'<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>'
    laughs = (
        b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">'
        b'<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>'
    )
    resource = {
        "namespace": "n", "name": "a", "version": "1", "digest": "sha256-" + "0" * 64,
        "mediaType": "application/json", "contentBase64": "e30=",
    }  # fmt: skip
    many = [{**resource, "version": str(index)} for index in range(3)]
    package = {"package": _b64(demo.demo_zip())}
    multipart_type = "multipart/form-data; boundary=b"
    json_type = "application/json"
    items = [
        ("deep-nesting-evaluate", EVALUATE, json_type, b"[" * 200_000 + b"1" + b"]" * 200_000),
        ("deep-nesting-compile", COMPILE, json_type, b'{"a":' * 200_000 + b"1" + b"}" * 200_000),
        ("deep-nesting-member", "/bim/v1/validate-result", json_type, b'{"result": ' + b"[" * 100_000 + b"]" * 100_000 + b"}"),
        ("nan", EVALUATE, json_type, b'{"ir": {}, "bindings": [NaN]}'),
        ("infinity", "/bim/v1/validate-result", json_type, b'{"result": Infinity}'),
        ("minus-infinity", "/bim/v1/validate-result", json_type, b'{"result": -Infinity}'),
        ("huge-exponent", "/bim/v1/validate-result", json_type, b'{"result": 1e999}'),
        ("int-5000-digits", "/bim/v1/validate-result", json_type, b'{"result": 1' + b"0" * 5000 + b"}"),
        ("invalid-utf8", EVALUATE, json_type, b'{"ir": "\xff"}'),
        ("not-json", EVALUATE, json_type, b"{"),
        ("empty", EVALUATE, json_type, b""),
        ("null", EVALUATE, json_type, b"null"),
        ("bad-base64-pointer", "/bim/v1/resources/xml/root", json_type, b'{"contentBase64": "@@@"}'),
        ("bad-base64-package", COMPILE, json_type, b'{"package": "@@@not-base64@@@"}'),
        ("multipart-duplicate", COMPILE, multipart_type, _multipart(("package", b"xx"), ("package", b"yy"))),
        ("multipart-unknown-part", COMPILE, multipart_type, _multipart(("package", b"xx"), ("extra", b"yy"))),
        ("multipart-no-boundary", COMPILE, "multipart/form-data", b"--b\r\n"),
        ("multipart-no-header-block", COMPILE, multipart_type, b"--b\r\nContent-Disposition: form-data; name=package"),
        ("multipart-package-only", COMPILE, multipart_type, _multipart(("package", demo.demo_zip()))),
        ("unsupported-media-type", COMPILE, "application/zip", demo.demo_zip()),
        ("text-plain", EVALUATE, "text/plain", b'{"ir": {}, "bindings": [{}]}'),
        ("unknown-member-evaluate", EVALUATE, json_type, b'{"ir": {}, "bindings": [{}], "bogus": 1}'),
        ("unknown-member-compile", COMPILE, json_type, b'{"package": "", "surprise": 1}'),
        ("xxe", "/bim/v1/resources/xml/root", json_type, json.dumps({"contentBase64": _b64(xxe)}).encode()),
        ("xxe-bpmn", "/bim/v1/resources/xml/validate-bpmn", json_type, json.dumps({"contentBase64": _b64(xxe)}).encode()),
        ("billion-laughs", "/bim/v1/resources/xml/root", json_type, json.dumps({"contentBase64": _b64(laughs)}).encode()),
        ("xml-root", "/bim/v1/resources/xml/root", json_type, json.dumps({"contentBase64": _b64(xml_ns)}).encode()),
        ("xml-not-bpmn", "/bim/v1/resources/xml/validate-bpmn", json_type, json.dumps({"contentBase64": _b64(xml_ns)}).encode()),
        ("zip-bomb", COMPILE, json_type, json.dumps({"package": _b64(_zip_bomb())}).encode()),
        ("not-a-zip", COMPILE, json_type, json.dumps({"package": _b64(b"not a zip")}).encode()),
        ("registered-resources-over-the-limit", COMPILE, json_type, json.dumps({**package, "registeredResources": many}).encode()),
        ("registered-resource-twice", COMPILE, json_type, json.dumps({**package, "registeredResources": [resource, resource]}).encode()),
        ("bindings-over-the-limit", EVALUATE, json_type, json.dumps({"ir": {}, "bindings": [{}, {}, {}]}).encode()),
        ("neighborhood-over-the-ceiling", "/bim/v1/neighborhood", json_type, json.dumps({"ir": {}, "binding": {}, "seconds": 99}).encode()),
        ("validate-resource", "/bim/v1/resources/validate", json_type, json.dumps(
            {"document": {"a": 1}, "apiVersion": "x/v1", "kind": "K", "mediaType": "application/json", "resource": "r.json"}
        ).encode()),
        ("validate-engine-empty", "/bim/v1/engines/validate", json_type, b'{"document": {}}'),
        ("validate-engine-spec", "/bim/v1/engines/validate", json_type, b'{"document": {"spec": 1}}'),
    ]  # fmt: skip
    return items


def script_requests(app) -> list[tuple[str, str, bytes]]:
    """The requests of the consumer fixtures (every route with a real package), as run against ``app``."""
    recorded: list[tuple[str, str, bytes]] = []
    step = {"index": 0}

    def execute(method, path, body):
        raw = json.dumps(body).encode()
        status, _, _, answer = one(app, path, raw)
        step["index"] += 1
        recorded.append((f"script-{step['index']}", path, raw))
        return status, json.loads(answer)

    for fixture in demo.scripts().values():
        demo.run_steps(fixture["steps"], execute)
    return recorded


def test_p12_every_route_answers_the_same_bytes_in_both_executors_and_in_fresh_workers(make_app, process_app) -> None:
    limits = {"max_registered_resources": 2, "max_bindings": 2, "max_concurrency_per_tenant": 0}
    thread = make_app(**limits)
    cases = [(name, path, content_type, body) for name, path, content_type, body in corpus()]
    cases += [(name, path, "application/json", body) for name, path, body in script_requests(thread)]
    assert len(cases) > 60
    expected = {name: one(thread, path, body, content_type) for name, path, content_type, body in cases}
    statuses = {status for status, *_ in expected.values()}
    assert {200, 400, 413, 415, 422} & statuses >= {200, 400, 415, 422}
    differences = []
    for fresh in range(3):  # three fresh children, so three hash seeds
        app = process_app(max_concurrency=1, worker_preload=(), **limits)
        for name, path, content_type, body in cases:
            found = one(app, path, body, content_type)
            if found != expected[name]:
                differences.append((fresh, name, found[0], expected[name][0]))
        assert app.state.gate.pool.slots[0].state == workers.IDLE, "a worker died on the corpus"
    assert not differences, f"thread and process mode differ (a difference between runs is a bim-core determinism bug): {differences}"


def test_p12_the_answers_of_the_hostile_corpus_are_what_the_contract_says(make_app) -> None:
    """A guard on the corpus itself: the thread executor gives controlled answers for every hostile request."""
    app = make_app(max_registered_resources=2, max_bindings=2, max_concurrency_per_tenant=0)
    for name, path, content_type, body in corpus():
        status, media, _, answer = one(app, path, body, content_type)
        assert status != 500, (name, answer[:200])
        if status >= 400:
            assert media == "application/problem+json", name
