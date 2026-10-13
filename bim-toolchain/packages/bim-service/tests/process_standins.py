"""Stand-ins for the operations, loaded in the worker processes through ``BimServiceSettings.worker_preload``.

A monkeypatch in the test process does not reach a worker, which is another interpreter.  Importing this module in the
worker replaces ``operations.compile_package`` and ``operations.evaluate`` with functions driven by the request data: the
package bytes of ``/compile`` (``{"package": base64(command)}``) or the ``cmd`` member of the ``ir`` of ``/evaluate``.

======================  =======================================================================================
``spin:<seconds>``      burn CPU for that long (pure Python, like the compiler)
``spin:forever``        burn CPU until killed
``sleep:<seconds>``     block without CPU
``alloc:<bytes>``       allocate that much (a ``MemoryError`` above the allowance of the worker)
``hold:<bytes>``        allocate and keep that much, touched (the resident size of the worker grows)
``segv``                crash the interpreter (``ctypes.string_at(0)``)
``raise``               an unexpected exception whose message must never reach the client
``print``               garbage on file descriptors 1 and 2
``big:<bytes>``         an answer with that many bytes of payload
``rlimits``             the resource limits and the environment names of the worker
``proc``                its ``oom_score_adj`` and niceness
anything else           a trivial valid answer
======================  =======================================================================================

Every answer carries the ``pid`` of the worker that gave it.
"""

from __future__ import annotations

import ctypes
import os
import time

from bim_service import operations

_HELD: list[bytes] = []


def _burn(seconds: float | None) -> None:
    end = None if seconds is None else time.perf_counter() + seconds
    while end is None or time.perf_counter() < end:
        sum(i * i for i in range(2000))


def act(command: str) -> dict:
    kind, _, argument = command.partition(":")
    extra: dict = {}
    if kind == "big":
        extra["data"] = "x" * int(argument)
    elif kind == "rlimits":
        import resource

        extra["cpu"] = resource.getrlimit(resource.RLIMIT_CPU)[0]
        extra["as"] = resource.getrlimit(resource.RLIMIT_AS)[0]
        extra["environ"] = sorted(os.environ)
    elif kind == "proc":
        with open("/proc/self/oom_score_adj", encoding="ascii") as handle:
            extra["oom"] = int(handle.read())
        extra["nice"] = os.nice(0)
    elif kind == "spin":
        _burn(None if argument == "forever" else float(argument))
    elif kind == "sleep":
        time.sleep(float(argument))
    elif kind == "alloc":
        block = bytearray(int(argument))
        block[-1] = 1
    elif kind == "hold":
        _HELD.append(b"\x01" * int(argument))
    elif kind == "segv":
        ctypes.string_at(0)
    elif kind == "raise":
        raise RuntimeError("SECRET-MESSAGE from the worker")
    elif kind == "print":
        os.write(1, b"garbage on stdout\n" * 2000)
        os.write(2, b"garbage on stderr\n" * 2000)
        print("garbage from print")
    return {"pid": os.getpid(), "command": command[:40], **extra}


def compile_package(data, registered, limits):
    return {"ir": {}, **act(bytes(data).decode("utf-8", "replace"))}


def evaluate(ir, bindings, execution, on_error):
    return {"results": [], **act(str(ir.get("cmd", "")))}


operations.compile_package = compile_package
operations.evaluate = evaluate
