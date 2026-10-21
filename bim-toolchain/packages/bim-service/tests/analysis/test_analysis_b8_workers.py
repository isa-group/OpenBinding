"""B8 phase B (analysis): what worker processes cost, measured.

Nothing here asserts a speed.  The figures are printed in the "measurements" section that ends the pytest session and are the
ones ``docs/SERVICE.md`` quotes (with the environment: CPython, kernel, CPUs, and the memory limit of the cgroup, which is a
limit and not a resident size).  The assertions only check that the runs worked and that both executors give the same bytes.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import platform
import statistics
import sys
import time

import pytest
from service_support import async_client, run

import consumer_fixtures as demo
from bim_service import _worker, workers
from bim_service.settings import BimServiceSettings

MIB = 1024 * 1024
EVALUATE = "/bim/v1/evaluate"
COMPILE = "/bim/v1/compile"
#: Resident size of the process of the laboratory container (``docs/SERVICE.md``, "Measured resident memory").
LAB_PARENT_RSS = 55_451_648


def environment() -> str:
    limit = workers.read_memory_max()
    return (
        f"environment: CPython {platform.python_version()}, Linux {platform.release()}, {os.cpu_count()} CPUs, "
        f"cgroup memory.max {limit if limit is not None else 'none'} (a limit, not a resident size)"
    )


def test_the_worker_at_ready_and_the_fit_rule(make_app, report) -> None:
    report(f"workers: {environment()}")
    starts, sizes = [], []
    for _ in range(3):
        app = make_app(executor="process", max_concurrency=1)
        gate = app.state.gate
        try:
            started = time.perf_counter()
            gate.start_workers(check_fit=False)
            starts.append(time.perf_counter() - started)
            slot = gate.pool.slots[0]
            sizes.append((slot.rss_ready, slot.vm_ready, slot.limits["as"]))
        finally:
            gate.close()
    rss, vm, as_limit = sizes[-1]
    parent = _worker.read_status()["VmRSS"]
    report(
        "workers: child at READY (bim_core imported, warmed up): "
        f"VmRSS {rss} bytes ({rss / MIB:.1f} MiB), VmSize {vm} bytes ({vm / MIB:.1f} MiB), RLIMIT_AS {as_limit} bytes; "
        f"RSS over 3 starts {[round(size[0] / MIB, 1) for size in sizes]} MiB"
    )
    report(
        "workers: cold start to READY (spawn, imports, warm-up, handshake) "
        f"{[round(seconds * 1000) for seconds in starts]} ms over 3 starts, median {statistics.median(starts) * 1000:.0f} ms"
    )
    report(f"workers: the parent (this test process, the runner included) holds VmRSS {parent} bytes ({parent / MIB:.1f} MiB)")
    assert rss > 0 and vm > rss and statistics.median(starts) < workers.WORKER_START_TIMEOUT

    memory_max = workers.read_memory_max()
    here = BimServiceSettings(executor="process", max_concurrency=1, max_body_bytes=MIB)
    fit = workers.memory_fit(here, parent, rss, memory_max)
    report(f"workers: fit rule in this container with N=1 and a body limit of 1 MiB: {fit.describe()}; fits {fit.fits}")

    lab = BimServiceSettings(
        executor="process", max_concurrency=2, max_body_bytes=16 * MIB, memory_budget_bytes=128 * MIB,
        max_pending_body_bytes=32 * MIB,
    )  # fmt: skip
    lab_fit = workers.memory_fit(lab, LAB_PARENT_RSS, rss, 256 * MIB)
    report(
        f"workers: fit rule for the laboratory (256 MiB, N=2, L=16 MiB, B=128 MiB, Q=32 MiB, P={LAB_PARENT_RSS}, C={rss}): "
        f"{lab_fit.describe()}; fits {lab_fit.fits}"
    )
    assert lab_fit.required > 0
    for slots in (2, 1):
        best = None
        for megabytes in range(16, 0, -1):
            settings = BimServiceSettings(
                executor="process", max_concurrency=slots, max_body_bytes=megabytes * MIB,
                memory_budget_bytes=8 * megabytes * MIB, max_pending_body_bytes=2 * megabytes * MIB,
            )  # fmt: skip
            candidate = workers.memory_fit(settings, LAB_PARENT_RSS, rss, 256 * MIB)
            if candidate.fits:
                best = (megabytes, candidate)
                break
        if best is None:
            report(f"workers: laboratory with N={slots}: no body limit of 1 MiB or more fits")
        else:
            report(
                f"workers: laboratory with N={slots}: the largest body limit that fits is {best[0]} MiB with "
                f"B={8 * best[0]} MiB and Q={2 * best[0]} MiB ({best[1].required} of {256 * MIB} bytes required)"
            )


def test_a_32_mib_body_crosses_to_the_worker_without_stalling_the_loop(process_app, report) -> None:
    app = process_app(max_concurrency=1, operation_timeout_seconds=120)
    padding = 24 * MIB - 1024  # base64 and the JSON envelope bring the body to just under the 32 MiB limit
    body = json.dumps({"package": base64.b64encode(b"plain" + b" " * padding).decode()}).encode()
    assert len(body) <= 32 * MIB

    async def scenario():
        lags: list[float] = []
        stop = asyncio.Event()

        async def heartbeat():
            while not stop.is_set():
                before = time.perf_counter()
                await asyncio.sleep(0.005)
                lags.append(time.perf_counter() - before - 0.005)

        async with async_client(app) as client:
            warm = await client.post(COMPILE, content=b'{"package": ""}', headers={"content-type": "application/json"})
            beat = asyncio.create_task(heartbeat())
            await asyncio.sleep(0.05)
            started = time.perf_counter()
            response = await client.post(COMPILE, content=body, headers={"content-type": "application/json"})
            elapsed = time.perf_counter() - started
            stop.set()
            await beat
            return warm, response, elapsed, lags

    warm, response, elapsed, lags = run(scenario())
    assert warm.status_code == 200 and response.status_code == 200
    report(
        f"workers: a {len(body)} byte request (just under the 32 MiB limit) through the worker, answered by a stand-in: "
        f"{elapsed * 1000:.0f} ms from the first byte offered to the answer, in which the parent decoded nothing and the "
        f"worker parsed it; longest stall of a 5 ms timer on the loop {max(lags) * 1000:.0f} ms ({len(lags)} ticks)"
    )
    assert max(lags) < 1.0


def test_thread_and_process_on_the_same_evaluate_payload(make_app, process_app, report) -> None:
    clients, rounds, bindings = 4, 6, 1000
    thread = make_app(max_concurrency=4, max_concurrency_per_tenant=0)
    process = process_app(max_concurrency=4, max_concurrency_per_tenant=0, worker_preload=())

    async def load(app, ir):
        payload = {"ir": ir, "bindings": [demo.BINDING] * bindings}
        latencies: list[float] = []
        probes: list[float] = []
        stop = asyncio.Event()
        async with async_client(app) as client:
            await asyncio.gather(*(client.post(EVALUATE, json=payload) for _ in range(clients)))  # warm every worker

            async def probe():
                while not stop.is_set():
                    started = time.perf_counter()
                    await client.get("/healthz")
                    probes.append(time.perf_counter() - started)
                    await asyncio.sleep(0.02)

            async def one_client():
                answers = []
                for _ in range(rounds):
                    started = time.perf_counter()
                    response = await client.post(EVALUATE, json=payload)
                    latencies.append(time.perf_counter() - started)
                    assert response.status_code == 200
                    answers.append(response.content)
                return answers

            prober = asyncio.create_task(probe())
            started = time.perf_counter()
            answers = await asyncio.gather(*(one_client() for _ in range(clients)))
            wall = time.perf_counter() - started
            stop.set()
            await prober
        return wall, latencies, probes, answers

    async def scenario():
        async with async_client(thread) as client:
            compiled = (await client.post(COMPILE, json={"package": base64.b64encode(demo.demo_zip()).decode()})).json()
        return {name: await load(app, compiled["ir"]) for name, app in (("thread", thread), ("process", process))}

    results = run(scenario())
    report(
        f"workers: evaluate of {bindings} bindings of the demo IR, {clients} concurrent clients x {rounds} requests, "
        f"{clients} slots, same machine: {environment()}"
    )
    for name, (wall, latencies, probes, _) in results.items():
        ordered = sorted(latencies)
        report(
            f"workers: {name}: {len(latencies) / wall:.1f} requests/s, latency median {statistics.median(ordered) * 1000:.0f} ms, "
            f"p95 {ordered[int(0.95 * (len(ordered) - 1))] * 1000:.0f} ms, max {ordered[-1] * 1000:.0f} ms; "
            f"/healthz meanwhile median {statistics.median(probes) * 1000:.1f} ms, max {max(probes) * 1000:.1f} ms"
        )
    thread_answers = {answer for per_client in results["thread"][3] for answer in per_client}
    process_answers = {answer for per_client in results["process"][3] for answer in per_client}
    assert thread_answers == process_answers and len(thread_answers) == 1, "both executors give the same bytes"


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux only")
def test_the_cgroup_memory_limit_is_read_apart_from_resident_sizes(report) -> None:
    limit = workers.read_memory_max()
    assert limit is None or limit > 0
    report(f"workers: {environment()}")
