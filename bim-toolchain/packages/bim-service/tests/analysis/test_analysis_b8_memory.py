"""B8 (analysis): what a request body costs in memory before it reaches a slot.

The body is read, parsed and validated in the handler (``app.py:144``, FastAPI's body parsing) before
``Gate.run`` takes a slot, so this cost is paid by every request in flight, not only by the ``max_concurrency`` that
may run.  Measured with ``tracemalloc`` (Python allocations only; no RSS, no container limit) with the operations
replaced by stand-ins, so this is the pre-gate path alone.  The bounds are wide on purpose: they catch an unbounded
copy, not a regression of a few.

Measured on 2026-10-13: compile, 8.4 MB body: peak 31.9 MB (3.8x); evaluate, 7.1 MB body of many small objects: peak
55.9 MB (7.9x).  For a body at the 32 MiB limit that extrapolates to about 130 MiB and 250 MiB per request (not
measured at that size), against the lab's ``mem_limit`` of 256m for the whole process.
"""

from __future__ import annotations

import base64
import json
import os
import tracemalloc

from service_support import async_client, run

from bim_service import operations


def peak_of(app, path: str, payload: bytes) -> tuple[int, int]:
    async def scenario() -> tuple[int, int]:
        async with async_client(app) as client:
            tracemalloc.start()
            try:
                tracemalloc.reset_peak()
                response = await client.post(path, content=payload, headers={"content-type": "application/json"})
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            return response.status_code, peak

    return run(scenario())


def test_the_pre_gate_peak_is_a_bounded_multiple_of_the_body(make_app, monkeypatch) -> None:
    monkeypatch.setattr(operations, "compile_package", lambda data, registered, limits: {"ir": {}})
    monkeypatch.setattr(operations, "evaluate", lambda ir, bindings, execution, on_error: {"results": []})
    app = make_app()

    package = json.dumps({"package": base64.b64encode(os.urandom(6 * 1024 * 1024)).decode()}).encode()
    status, peak = peak_of(app, "/bim/v1/compile", package)
    assert status == 200
    assert peak < 6 * len(package), (peak, len(package))

    items = [{"id": i, "w": 1.5, "tags": ["a", "b"], "n": None} for i in range(6 * 1024 * 1024 // 50)]
    document = json.dumps({"ir": {"items": items}, "bindings": [{}]}).encode()
    status, peak = peak_of(app, "/bim/v1/evaluate", document)
    assert status == 200
    assert peak < 12 * len(document), (peak, len(document))
