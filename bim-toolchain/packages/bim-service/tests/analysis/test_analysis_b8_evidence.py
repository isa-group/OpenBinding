"""B8 (evidence): reproductions behind the root causes recorded for the three open defects of ``test_analysis_b8_probe.py``.

Each test measures the mechanism itself, without ``bim-service`` in the way, and asserts only the direction that cannot
be produced by a slow or loaded machine (a stall can only be *longer* on such a machine, never shorter than the time the
GIL is held).  The numbers go to the "measurements" section that ends the pytest output and are recorded in
``docs/SERVICE.md``.

* The loop is stalled by a large body for as long as ``json.loads`` / pydantic-core hold the GIL: both are one C call.
* A shorter switch interval helps code that is pure Python; its cost in throughput is measured here.
* A thread cannot be stopped from outside.  The only mechanism CPython has, an asynchronous exception, is raised by the
  interpreter between bytecodes: it reaches pure Python at once, and while one C call holds the GIL not even the thread
  that would send it can run.  Whether it would be safe to use is argued in ``docs/SERVICE.md``, not tested here.
"""

from __future__ import annotations

import asyncio
import base64
import ctypes
import json
import statistics
import sys
import threading
import time
import traceback

import pytest
from pydantic import TypeAdapter
from pydantic_core import from_json
from service_support import async_client, run

import consumer_fixtures as demo
from bim_service import models, operations
from bim_service.settings import BimServiceSettings
from bim_service.wire import decode_model_body


def big_ir(approximate_bytes: int) -> dict:
    return {"items": [{"id": i, "w": 1.5, "tags": ["a", "b"], "n": None} for i in range(approximate_bytes // 50)]}


def evaluate_payload(size: int) -> bytes:
    return json.dumps({"ir": big_ir(size), "bindings": [{}]}).encode()


async def max_loop_lag_while(work, interval: float = 0.002) -> float:
    """The longest delay of a timer of ``interval`` s on the loop while ``work`` runs in a thread."""
    lags: list[float] = []
    stop = asyncio.Event()

    async def beat() -> None:
        while not stop.is_set():
            before = time.perf_counter()
            await asyncio.sleep(interval)
            lags.append(time.perf_counter() - before - interval)

    task = asyncio.create_task(beat())
    await asyncio.sleep(0.05)
    await asyncio.get_running_loop().run_in_executor(None, work)
    stop.set()
    await task
    return max(lags)


def timed(call) -> float:
    started = time.perf_counter()
    call()
    return time.perf_counter() - started


# --- the stall of a large body ----------------------------------------------------------------------------


def test_each_stage_of_decoding_a_large_body_in_a_thread_stalls_the_loop(report) -> None:
    """Which stage holds the GIL, measured on a 12 MiB evaluate body handled in a plain worker thread."""
    payload = evaluate_payload(12 * 1024 * 1024)
    document = json.loads(payload)
    adapter = TypeAdapter(models.EvaluateRequest)
    stages = {
        "json.loads": lambda: json.loads(payload),
        "pydantic_core.from_json": lambda: from_json(payload),
        "validate_python(EvaluateRequest)": lambda: adapter.validate_python(document, from_attributes=True),
        "contains_non_finite (pure Python)": lambda: models.contains_non_finite(document),
        "json.dumps": lambda: json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        "decode_model_body (whole)": lambda: decode_model_body(models.EvaluateRequest, "application/json", payload),
    }
    report(f"GIL stall by stage, body {len(payload) / 2**20:.1f} MiB, work in a thread, 2 ms timer on the loop:")
    rows = {}
    for name, work in stages.items():
        synchronous = min(timed(work), timed(work))
        lag = run(max_loop_lag_while(work))
        rows[name] = (synchronous, lag)
        report(f"  {name:34s} alone {synchronous * 1000:5.0f} ms   longest loop stall {lag * 1000:5.0f} ms")
    # The C calls hold the GIL for (nearly) their whole duration: the loop cannot run in between.
    for name in ("json.loads", "pydantic_core.from_json", "json.dumps"):
        synchronous, lag = rows[name]
        assert lag > 0.4 * synchronous, (name, rows[name])
    # The pure Python walk is switched every interval: it does not hold the loop for long.
    synchronous, lag = rows["contains_non_finite (pure Python)"]
    assert lag < 0.5 * synchronous + 0.02, rows["contains_non_finite (pure Python)"]


# --- the cost of a short switch interval -----------------------------------------------------------------


def count_work(seconds: float, threads: int) -> int:
    """Iterations of pure Python work done by ``threads`` threads in ``seconds`` (the throughput of the pool)."""
    totals = [0] * threads
    stop = threading.Event()

    def spin(index: int) -> None:
        count = 0
        while not stop.is_set():
            sum(i * i for i in range(2000))
            count += 1
        totals[index] = count

    pool = [threading.Thread(target=spin, args=(i,)) for i in range(threads)]
    for thread in pool:
        thread.start()
    time.sleep(seconds)
    stop.set()
    for thread in pool:
        thread.join()
    return sum(totals)


def test_the_throughput_cost_of_a_short_switch_interval(report) -> None:
    original = sys.getswitchinterval()
    rounds = 3
    results: dict[float, list[int]] = {original: [], 0.001: [], 0.0001: []}
    try:
        for _ in range(rounds):  # interleaved, so that drift in the machine hits every interval alike
            for interval in results:
                sys.setswitchinterval(interval)
                results[interval].append(count_work(1.0, threads=4))
    finally:
        sys.setswitchinterval(original)
    base = statistics.median(results[original])
    report(f"switch interval and pool throughput: 4 CPU-bound threads, 1 s, {rounds} interleaved rounds:")
    for interval, counts in results.items():
        median = statistics.median(counts)
        report(
            f"  {interval * 1000:6.2f} ms: median {median} iterations ({median / base * 100:5.1f}% of the default), "
            f"min {min(counts)}, max {max(counts)}"
        )
    # Loose: a short interval must not cost more than half the throughput of the pool.
    assert statistics.median(results[0.0001]) > 0.5 * base


def real_requests() -> dict[str, tuple[str, dict]]:
    compiled = operations.compile_package(demo.demo_zip(), [], BimServiceSettings().limits)
    return {
        "compile of the demo package": ("/bim/v1/compile", {"package": base64.b64encode(demo.demo_zip()).decode()}),
        "evaluate of 1000 bindings of the demo IR": (
            "/bim/v1/evaluate",
            {"ir": compiled["ir"], "bindings": [demo.BINDING] * 1000},
        ),
    }


@pytest.mark.parametrize("workload", ["compile of the demo package", "evaluate of 1000 bindings of the demo IR"])
def test_healthz_and_throughput_under_real_operations_by_switch_interval(make_app, report, workload) -> None:
    """The same question with the real compiler and evaluator, four requests at a time, in a loop."""
    path, body = real_requests()[workload]
    original = sys.getswitchinterval()

    async def scenario(app) -> tuple[list[float], float]:
        async with async_client(app) as client:
            stop = asyncio.Event()
            done = 0

            async def keep_going() -> None:
                nonlocal done
                while not stop.is_set():
                    assert (await client.post(path, json=body)).status_code == 200
                    done += 1

            tasks = [asyncio.create_task(keep_going()) for _ in range(4)]
            await asyncio.sleep(0.5)
            counted, started = done, time.perf_counter()
            latencies = []
            for _ in range(30):
                before = time.perf_counter()
                await client.get("/healthz")
                latencies.append(time.perf_counter() - before)
                await asyncio.sleep(0.02)
            elapsed = time.perf_counter() - started
            rate = (done - counted) / elapsed
            stop.set()
            await asyncio.gather(*tasks)
            return latencies, rate

    report(f"real {workload}, 4 clients in a loop, 30 healthz probes per round; 4 slots, one process:")
    rates: dict[float, list[float]] = {original: [], 0.001: [], 0.0001: []}
    medians: dict[float, list[float]] = {original: [], 0.001: [], 0.0001: []}
    try:
        for _ in range(3):  # interleaved
            for interval in rates:
                sys.setswitchinterval(interval)
                latencies, rate = run(scenario(make_app(max_concurrency=4, max_concurrency_per_tenant=0, acquire_timeout_ms=5000)))
                rates[interval].append(rate)
                medians[interval].append(statistics.median(latencies))
    finally:
        sys.setswitchinterval(original)
    for interval in rates:
        report(
            f"  {interval * 1000:6.2f} ms: /healthz median {[round(m * 1000, 1) for m in medians[interval]]} ms per round, "
            f"requests per second {[round(r, 1) for r in rates[interval]]}"
        )
    # Loose: the interval does not make the real operations lose more than half of their throughput.
    assert statistics.median(rates[0.0001]) > 0.5 * statistics.median(rates[original])


# --- what can be done about a thread that outran its budget ----------------------------------------------


class Stopped(Exception):
    pass


def raise_in(thread: threading.Thread, error: type[BaseException]) -> int:
    return ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(thread.ident), ctypes.py_object(error))


def test_an_asynchronous_exception_stops_a_thread_only_where_the_interpreter_looks(report) -> None:
    landed: dict[str, str] = {}

    def python_work() -> None:
        try:
            while True:
                sum(i * i for i in range(2000))
        except Stopped as exc:
            landed["python"] = "".join(traceback.format_tb(exc.__traceback__)[-1:]).strip().replace("\n", " | ")

    payload = evaluate_payload(12 * 1024 * 1024)
    parse_alone = min(timed(lambda: json.loads(payload)), timed(lambda: json.loads(payload)))

    def c_work() -> None:
        try:
            json.loads(payload)
            landed["json.loads"] = "finished"
        except Stopped as exc:
            landed["json.loads"] = "".join(traceback.format_tb(exc.__traceback__)[-1:]).strip().replace("\n", " | ")

    thread = threading.Thread(target=python_work)
    thread.start()
    time.sleep(0.2)
    sent = time.perf_counter()
    assert raise_in(thread, Stopped) == 1
    thread.join(5)
    assert not thread.is_alive()
    python_reaction = time.perf_counter() - sent
    report(f"async exception into pure Python: thread ended {python_reaction * 1000:.1f} ms after it was sent; at {landed['python']}")
    assert python_reaction < 1.0

    started = time.perf_counter()
    thread = threading.Thread(target=c_work)
    thread.start()
    time.sleep(0.05)  # meant to wake up while the C call runs
    woke = time.perf_counter() - started
    assert raise_in(thread, Stopped) == 1
    thread.join(30)
    assert not thread.is_alive()
    ended = time.perf_counter() - started
    report(
        f"async exception into json.loads (parse alone {parse_alone * 1000:.0f} ms): the sender asked to wake after 50 ms "
        f"and ran after {woke * 1000:.0f} ms; the thread ended at {ended * 1000:.0f} ms; {landed.get('json.loads')}"
    )
    # While one C call holds the GIL nothing else runs, the code that would send the exception included (in the service,
    # the event loop that enforces the time budget): the sender could only run once the parse was over.
    assert woke > 0.4 * parse_alone
