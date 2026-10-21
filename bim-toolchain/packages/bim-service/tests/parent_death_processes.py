"""The processes of the parent-death tests: a reaper and a synthetic parent, run as scripts by ``test_process_parent_death.py``.

``python parent_death_processes.py reaper <config>`` is the grandparent of the workers.  It makes itself a *child subreaper*
(``PR_SET_CHILD_SUBREAPER``: what ``init`` is for orphans, here for the test only), starts the synthetic parent and then only
reaps: every child of its own that exits (the parent, and the workers once the parent is dead) is reported on stdout as one JSON
line with the exit code (negative: the signal) and the CPU it used (``wait4``).  When its stdin is closed, or after the
deadline, it kills whatever is left and ends.  It never signals anything else, and the test signals only processes it started.

``python parent_death_processes.py parent <config>`` is the synthetic parent: a :class:`bim_service.workers.WorkerPool` of
``workers`` real worker processes (the stand-ins of ``process_standins``), optionally with one operation in flight, that then
waits to be killed (or, for the clean-exit cases, exits by itself, handles ``SIGTERM`` with ``sys.exit`` or runs the real
application under ``uvicorn``, with no help from the test).  Nothing of the service is changed or hooked for this: the pool and
the application are the production ones.

Events (one JSON object per line, ``t`` is ``time.monotonic()``, which all processes of the machine share):
``reaper``, ``starting``, ``ready`` (pids of the workers), ``busy`` (pids of the workers that serve the operation),
``exiting``, ``reaped`` (``pid``, ``exit``, ``cpu``) and ``done`` (the reaper has no child left).
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time

SCRIPT = os.path.abspath(__file__)
PR_SET_CHILD_SUBREAPER = 36
MIB = 1024 * 1024


def emit(**event: object) -> None:
    """One line on stdout, written with one ``write`` (atomic below ``PIPE_BUF``, so the reaper and the parent can share it)."""
    event["t"] = time.monotonic()
    try:
        os.write(1, (json.dumps(event) + "\n").encode())
    except OSError:  # nobody reads any more
        pass


def parent_of(pid: int) -> int | None:
    """The parent pid of a process from ``/proc`` (``None`` if it does not exist)."""
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="replace") as handle:
            return int(handle.read().rsplit(")", 1)[1].split()[1])
    except (OSError, IndexError, ValueError):
        return None


def children_of(pid: int) -> list[int]:
    """The pids whose parent is ``pid`` (zombies included)."""
    return [int(entry) for entry in os.listdir("/proc") if entry.isdigit() and parent_of(int(entry)) == pid]


def _sweep(me: int) -> None:
    """``SIGKILL`` every child of this process.  They are unreaped, so their pids cannot have been reused."""
    for pid in children_of(me):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def reaper(config: dict) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")
    me = os.getpid()
    parent = subprocess.Popen([sys.executable, SCRIPT, "parent", json.dumps(config)], stdin=subprocess.DEVNULL)
    emit(event="reaper", pid=me, parent=parent.pid)
    deadline = time.monotonic() + config["deadline"]
    stdin_open = True
    sweeping = False
    while True:
        if stdin_open:
            if select.select([0], [], [], 0.01)[0] and os.read(0, 4096) == b"":
                stdin_open = False
                sweeping = True
        else:
            time.sleep(0.01)
        if time.monotonic() > deadline:
            sweeping = True
        if sweeping:
            _sweep(me)
        try:
            while True:
                pid, status, usage = os.wait4(-1, os.WNOHANG)
                if pid == 0:
                    break
                emit(
                    event="reaped",
                    pid=pid,
                    exit=os.waitstatus_to_exitcode(status),
                    cpu=usage.ru_utime + usage.ru_stime,
                )
        except ChildProcessError:
            break
    emit(event="done")


def start_operation(pool, command: str) -> None:
    """Hand ``command`` (a stand-in operation of ``process_standins``) to the pool and say which workers are busy with it."""
    from bim_service.workers import BUSY

    body = json.dumps({"package": base64.b64encode(command.encode()).decode()}).encode()
    pool.submit("compile", "application/json", body)
    deadline = time.monotonic() + 30
    while True:
        busy = [slot.pid for slot in pool.slots if slot.state == BUSY]
        if busy:
            break
        if time.monotonic() > deadline:
            raise SystemExit("no worker became busy")
        time.sleep(0.005)
    emit(event="busy", pids=busy)


def serve(config: dict, settings) -> None:
    """The real thing: ``uvicorn`` runs the real application (its lifespan starts and stops the workers) on a Unix socket, and
    handles ``SIGTERM`` as it does in production.  Nobody connects to it."""
    import threading

    import uvicorn

    from bim_service import workers
    from bim_service.app import create_app

    workers.read_memory_max = lambda: None  # the fit check of the lifespan depends on the container this runs in
    app = create_app(settings)
    pool = app.state.gate.pool
    server = uvicorn.Server(uvicorn.Config(app, uds=config["uds"], lifespan="on", log_level="warning"))

    def announce() -> None:
        deadline = time.monotonic() + 30
        while not server.started:
            if time.monotonic() > deadline:
                os._exit(3)
            time.sleep(0.005)
        emit(event="ready", pid=os.getpid(), workers=[slot.pid for slot in pool.slots])
        if config["command"] is not None:
            start_operation(pool, config["command"])

    emit(event="starting", pid=os.getpid())
    threading.Thread(target=announce, daemon=True).start()
    server.run()


def parent(config: dict) -> None:
    from bim_service.settings import BimServiceSettings
    from bim_service.workers import WorkerPool

    if config["action"] == "term-handler":  # what a server does with SIGTERM: leave through the normal exit
        signal.signal(signal.SIGTERM, lambda number, frame: sys.exit(0))
    settings = BimServiceSettings(
        allow_anonymous_dev=True,
        executor="process",
        worker_preload=("process_standins",),
        max_concurrency=config["workers"],
        max_concurrency_per_tenant=0,
        max_body_bytes=MIB,
        operation_timeout_seconds=config["timeout"],
    )
    if config["action"] == "uvicorn":
        serve(config, settings)
        return
    pool = WorkerPool(settings)
    emit(event="starting", pid=os.getpid())
    pool.start(check_fit=False)
    emit(event="ready", pid=os.getpid(), workers=[slot.pid for slot in pool.slots])
    if config["command"] is not None:
        start_operation(pool, config["command"])
    if config["action"] == "exit":
        time.sleep(0.5)
        emit(event="exiting")
        sys.exit(0)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    {"reaper": reaper, "parent": parent}[sys.argv[1]](json.loads(sys.argv[2]))
