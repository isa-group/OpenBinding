"""Worker processes: the parent side of ``BIM_SERVICE_EXECUTOR=process`` (Linux only).

``N = max_concurrency`` worker *slots* each own at most one child process (:mod:`bim_service._worker`).  A slot is
``EMPTY``, ``STARTING``, ``IDLE``, ``BUSY`` or ``DYING``; a child is started only from ``EMPTY`` and a slot becomes
``EMPTY`` only after ``waitpid`` returned for its previous child, so there are never more than ``N`` children and no
zombies.  The concurrency token stays :attr:`bim_service.runtime.Gate._slots`: whoever holds one is entitled to one slot
that is not busy, taken from a free list.

All blocking parent I/O (sending the request, reading the answer, waiting for a child to exit) runs in a
``ThreadPoolExecutor(max_workers=N)`` named ``bim-io``; the event loop only awaits the futures.  Nothing here is bound to
an event loop (no asyncio transports, no child watchers), workers are started lazily, and they are stopped by the
lifespan of the application, by ``weakref.finalize`` and at interpreter exit.

Children are signalled only through a pidfd (``os.pidfd_open`` / ``signal.pidfd_send_signal``), which cannot hit a
recycled pid.  A child is never reused after a timeout, a disconnect, a crash, a memory failure, a protocol violation or
an identity mismatch.  What a child sends is validated before anything is allocated for it and is never parsed again:
the answer is relayed byte for byte.

Rules of time: the clock of an operation starts when its ``REQUEST`` is first written to a ``READY`` worker; the start
of a child is bounded by :data:`WORKER_START_TIMEOUT` apart.  A slot whose child died is refilled in the background if
the previous start was at least :data:`RESPAWN_INTERVAL` ago, otherwise by the next request that takes the slot;
consecutive start failures back off exponentially (:data:`BACKOFF_BASE`, at most :data:`BACKOFF_CAP`).
"""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import logging
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import weakref
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from starlette.responses import Response

from ._worker import (
    CONFIG,
    FRAME,
    JSON_MEDIA_TYPE,
    MAGIC,
    MAX_HEADER,
    MIB,
    PROBLEM_MEDIA_TYPE,
    READY,
    REQUEST,
    RESPONSE,
    capabilities_identity,
    pack_frame,
    read_status,
)
from .problems import ServiceProblem
from .settings import BimServiceSettings, ServiceConfigError

logger = logging.getLogger("bim_service")

#: Seconds a child may take from its start to ``READY``.
WORKER_START_TIMEOUT = 30.0
#: Seconds between SIGTERM and SIGKILL.
KILL_GRACE = 0.2
#: Least seconds between two starts of the child of one slot, and the first back-off after a failed start.
RESPAWN_INTERVAL = 0.5
BACKOFF_BASE = 0.5
BACKOFF_CAP = 30.0
#: Seconds idle children get to exit at shutdown before they are killed.
SHUTDOWN_GRACE = 2.0
#: A worker whose resident memory grew by more than this since ``READY``, or that gave this many answers, is replaced.
RETIRE_RSS_GROWTH = 16 * MIB
RETIRE_ANSWERS = 1000
#: What a child may say.
ALLOWED_STATUSES = frozenset({200, 400, 413, 415, 422, 429, 500, 503})
ALLOWED_MEDIA_TYPES = frozenset({JSON_MEDIA_TYPE, PROBLEM_MEDIA_TYPE})
OUTCOMES = frozenset({"ok", "problem", "crash", "memory"})
RESPONSE_CHUNK = MIB
#: Share of the memory limit kept free by the fit check.
FIT_MARGIN = 0.10

EMPTY, STARTING, IDLE, BUSY, DYING = "empty", "starting", "idle", "busy", "dying"


class WorkerFailed(Exception):
    """A worker died unexpectedly, crashed, ran out of memory or broke the protocol.

    The request is answered by the generic 500 ``internal_error`` of :class:`~bim_service.middleware.ContextMiddleware`;
    nothing of the worker's state reaches the client.
    """


class ClientDisconnected(Exception):
    """The client went away and its worker was stopped: nobody is waiting for an answer."""


class StartFailed(Exception):
    """A child could not be started (or did not become ready in time)."""


class _Gone(Exception):
    """The child closed the socket or died."""


class _Timedout(Exception):
    """The operation ran out of its time budget."""


class _Violation(Exception):
    """The child sent something that is not a valid frame."""


@dataclass
class Answer:
    status: int
    media_type: str
    headers: dict[str, str]
    body: bytearray
    rss_bytes: int


@dataclass
class Outcome:
    """How a call ended: ``answer``, ``timeout`` (the wall-clock budget), ``cpu`` (the CPU limit, ``SIGXCPU``; also 503
    ``operation_timeout``), ``busy`` (503 ``service_busy``), ``cancelled`` or ``failed``."""

    kind: str
    answer: Answer | None = None


class WorkerSlot:
    """One slot: at most one child process, its socket and its pidfd."""

    def __init__(self, index: int) -> None:
        self.index = index
        self.state = EMPTY
        self.proc: subprocess.Popen[bytes] | None = None
        self.pid: int | None = None
        self.pidfd: int | None = None
        self.sock: socket.socket | None = None
        self.answers = 0
        self.rss_ready = 0
        self.vm_ready = 0
        self.limits: dict[str, int] = {}
        self.seq = 0
        self.call: Call | None = None
        self.abort_reason: str | None = None
        self.last_start = float("-inf")
        self.failures = 0
        self.backoff_until = 0.0
        self.last_error = ""


class Call:
    """One operation handed to the pool.  ``abort`` may be called from any thread."""

    def __init__(self, pool: WorkerPool, op: str, content_type: str | None, body: bytes, correlation_id: str) -> None:
        self.pool = pool
        self.op = op
        self.content_type = content_type
        self.body = body
        self.correlation_id = correlation_id
        self.future: Future[Outcome] | None = None
        self.slot: WorkerSlot | None = None
        self.seq = 0
        self.abort_reason: str | None = None
        self.completed = False

    def abort(self, reason: str) -> None:
        self.pool.abort(self, reason)


class Disconnect:
    """Lets the watcher of a request (in the event loop) abort its call once the call exists."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._call: Call | None = None
        self.fired = False

    def bind(self, call: Call) -> None:
        with self._lock:
            self._call = call
            fired = self.fired
        if fired:
            call.abort("disconnect")

    def fire(self) -> None:
        with self._lock:
            self.fired = True
            call = self._call
        if call is not None:
            call.abort("disconnect")


class BufferResponse(Response):
    """A response whose body is the bytearray read from a worker: relayed in 1 MiB slices, never copied or parsed."""

    def __init__(self, answer: Answer) -> None:
        self.status_code = answer.status
        self.media_type = answer.media_type
        self.background = None
        self.body = answer.body  # type: ignore[assignment]
        self.raw_headers = [
            *((name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in answer.headers.items()),
            (b"content-length", str(len(answer.body)).encode("latin-1")),
            (b"content-type", answer.media_type.encode("latin-1")),
        ]

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers})
        view = memoryview(self.body)
        total = len(view)
        if total == 0:
            await send({"type": "http.response.body", "body": b""})
            return
        for start in range(0, total, RESPONSE_CHUNK):
            end = min(start + RESPONSE_CHUNK, total)
            await send({"type": "http.response.body", "body": view[start:end], "more_body": end < total})


# --- memory ----------------------------------------------------------------------------------------


def read_memory_max(path: str = "/sys/fs/cgroup/memory.max") -> int | None:
    """The memory limit of the cgroup in bytes, ``None`` when there is none (``max``) or it cannot be read."""
    try:
        text = Path(path).read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return int(text) if text.isdigit() else None


@dataclass(frozen=True)
class MemoryFit:
    """``P + Q + N*C + B + N*(L + R) + margin <= M``, term by term (bytes)."""

    terms: dict[str, int]
    margin: int
    required: int
    memory_max: int | None

    @property
    def fits(self) -> bool:
        return self.memory_max is None or self.required <= self.memory_max

    def describe(self) -> str:
        parts = ", ".join(f"{name}={value}" for name, value in self.terms.items())
        return f"{parts}, margin={self.margin}: {self.required} bytes against a memory limit of {self.memory_max}"


def memory_fit(settings: BimServiceSettings, parent_rss: int, child_rss: int, memory_max: int | None) -> MemoryFit:
    """The fit rule of process mode.

    ``P`` the resident size of the parent, ``Q`` the request bodies that may wait in the parent (the cap of pending
    bodies; 0 when it is off), ``N*C`` the children at rest (``C`` the resident size of one when it is ready), ``B`` the
    memory the operations in flight may use (the memory budget, else ``N`` times the allowance of a worker, which is the
    hard bound of its address space), ``N*(L + R)`` the request body and the answer buffered in the parent for each slot
    (``L`` the largest body, ``R`` the largest answer, the allowance), and a margin of 10% of the limit ``M``.
    """
    n = settings.max_concurrency
    allowance = settings.worker_allowance_bytes
    terms = {
        "P": parent_rss,
        "Q": settings.effective_max_pending_body_bytes,
        "N*C": n * child_rss,
        "B": settings.memory_budget_bytes or n * allowance,
        "N*(L+R)": n * (settings.max_body_bytes + allowance),
    }
    margin = int(FIT_MARGIN * memory_max) if memory_max is not None else 0
    return MemoryFit(terms=terms, margin=margin, required=sum(terms.values()) + margin, memory_max=memory_max)


# --- the child process -----------------------------------------------------------------------------


def child_argv(fd: int) -> list[str]:
    """The command line of a worker; ``fd`` is its end of the socket pair."""
    return [sys.executable, "-s", "-c", "from bim_service._worker import main; main()", str(fd)]


def _module_directory(name: str) -> str | None:
    spec = importlib.util.find_spec(name.split(".", 1)[0])
    if spec is None:
        return None
    if spec.submodule_search_locations:
        return str(Path(next(iter(spec.submodule_search_locations))).resolve().parent)
    return str(Path(spec.origin).resolve().parent) if spec.origin else None


def child_environment(preload: tuple[str, ...]) -> dict[str, str]:
    """The whole environment of a worker: no ``BIM_SERVICE_*`` and no token, only what Python needs to start."""
    directories: list[str] = []
    for name in ("bim_service", "bim_core", *preload):
        directory = _module_directory(name)
        if directory and directory not in directories:
            directories.append(directory)
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "PYTHONPATH": os.pathsep.join(directories),
        "PYTHONDONTWRITEBYTECODE": "1",
        "MALLOC_ARENA_MAX": "2",
    }
    if "PYTHONHASHSEED" in os.environ:
        environment["PYTHONHASHSEED"] = os.environ["PYTHONHASHSEED"]
    return environment


def _signal_name(returncode: int | None) -> str:
    if returncode is None:
        return "-"
    if returncode < 0:
        try:
            return signal.Signals(-returncode).name
        except ValueError:
            return str(-returncode)
    return f"exit{returncode}"


def _wait_pidfd(pidfd: int | None, timeout: float) -> bool:
    """Whether the process behind ``pidfd`` has exited (becomes readable) within ``timeout`` seconds."""
    if pidfd is None:
        return True
    poller = select.poll()
    try:
        poller.register(pidfd, select.POLLIN)
        return bool(poller.poll(max(timeout, 0) * 1000))
    except (OSError, ValueError):
        return True


class WorkerPool:
    def __init__(self, settings: BimServiceSettings) -> None:
        if (
            not sys.platform.startswith("linux")
            or not hasattr(os, "pidfd_open")
            or not hasattr(signal, "pidfd_send_signal")
        ):
            raise ServiceConfigError(
                "BIM_SERVICE_EXECUTOR=process needs Linux with os.pidfd_open and signal.pidfd_send_signal"
            )
        try:
            os.close(os.pidfd_open(os.getpid()))
        except OSError as exc:
            raise ServiceConfigError(f"BIM_SERVICE_EXECUTOR=process needs pidfd support from the kernel ({exc})") from exc
        self.settings = settings
        self._size = settings.max_concurrency
        self._max_response = settings.worker_allowance_bytes
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self.slots = [WorkerSlot(index) for index in range(self._size)]
        self._free: deque[WorkerSlot] = deque(self.slots)
        self._io: ThreadPoolExecutor | None = None
        self._closed = False
        self._identity: str | None = None
        #: When the children were started (for tests and diagnostics).
        self.start_times: deque[float] = deque(maxlen=4096)
        self._environment = child_environment(settings.worker_preload)
        self._register_exit(self)

    @staticmethod
    def _register_exit(pool: WorkerPool) -> None:
        """Stop the children before the interpreter joins the threads of the I/O pool (which a busy child would block)."""
        reference = weakref.ref(pool)

        def stop() -> None:
            target = reference()
            if target is not None:
                target.close()

        try:
            threading._register_atexit(stop)  # type: ignore[attr-defined]
        except (AttributeError, RuntimeError):
            pass

    # --- public --------------------------------------------------------------------------------------

    @property
    def identity(self) -> str:
        if self._identity is None:
            self._identity = capabilities_identity()
        return self._identity

    def ready(self) -> bool:
        """``False`` once closed, or while every slot is backing off after failed starts."""
        with self._lock:
            if self._closed:
                return False
            now = time.monotonic()
            return not all(slot.backoff_until > now for slot in self.slots)

    def start(self, check_fit: bool = True) -> list[WorkerSlot]:
        """Start every worker and wait until all are ready; refuse (``ServiceConfigError``) when one cannot start.

        With ``check_fit`` the memory of the container is checked too (:func:`memory_fit`).  Called by the lifespan of the
        application; without it workers start when the first requests need them.
        """
        with self._cond:
            for slot in self.slots:
                if slot.state == EMPTY:
                    slot.state = STARTING
                    self._start_in_background(slot)
            deadline = time.monotonic() + WORKER_START_TIMEOUT + 10
            while any(slot.state == STARTING for slot in self.slots):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            failed = [slot for slot in self.slots if slot.state != IDLE]
        if failed:
            reasons = "; ".join(f"slot {slot.index}: {slot.last_error or slot.state}" for slot in failed)
            self.close()
            raise ServiceConfigError(f"the worker processes did not start ({reasons})")
        if check_fit:
            fit = memory_fit(
                self.settings,
                read_status().get("VmRSS", 0),
                max(slot.rss_ready for slot in self.slots),
                read_memory_max(),
            )
            if not fit.fits:
                self.close()
                raise ServiceConfigError(
                    "the worker processes do not fit the memory of the container; lower BIM_SERVICE_MAX_CONCURRENCY, "
                    f"BIM_SERVICE_MAX_BODY_BYTES or the memory budget ({fit.describe()})"
                )
        return list(self.slots)

    def submit(self, op: str, content_type: str | None, body: bytes, correlation_id: str = "-") -> Call:
        """Hand an operation to the pool; the future of the returned call yields its :class:`Outcome`."""
        with self._lock:
            if self._closed:
                raise ServiceProblem(
                    503,
                    "service_busy",
                    "the service is shutting down",
                    headers={"Retry-After": str(self.settings.retry_after_seconds)},
                )
            if self._io is None:
                self._io = ThreadPoolExecutor(max_workers=self._size, thread_name_prefix="bim-io")
            io = self._io
        call = Call(self, op, content_type, body, correlation_id)
        call.future = io.submit(self._execute, call)
        return call

    def abort(self, call: Call, reason: str) -> None:
        """Stop the call: if its worker is busy with it, signal the worker (SIGTERM) and leave the reaping to the I/O
        thread; if the answer already completed, do nothing."""
        with self._lock:
            if call.completed or call.abort_reason is not None:
                return
            call.abort_reason = reason
            slot = call.slot
            if slot is not None and slot.call is call and slot.state == BUSY:
                self._condemn_locked(slot, reason)

    def close(self) -> None:
        """Stop every child: idle ones get EOF, busy ones SIGTERM, the rest SIGKILL after :data:`SHUTDOWN_GRACE`."""
        with self._cond:
            if self._closed:
                return
            self._closed = True
            idle: list[WorkerSlot] = []
            for slot in self.slots:
                if slot.state == IDLE:
                    slot.state = DYING
                    slot.abort_reason = "shutdown"
                    idle.append(slot)
                    try:
                        if slot.sock is not None:
                            slot.sock.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                elif slot.state == BUSY:
                    self._condemn_locked(slot, "shutdown")
                elif slot.state == STARTING and slot.pidfd is not None:
                    slot.abort_reason = "shutdown"
                    self._signal_locked(slot, signal.SIGKILL)
            self._cond.notify_all()
        deadline = time.monotonic() + SHUTDOWN_GRACE
        for slot in idle:
            _wait_pidfd(slot.pidfd, deadline - time.monotonic())
        for slot in idle:
            self._kill_and_reap(slot, first=None, grace=0.0)
        with self._cond:
            end = time.monotonic() + SHUTDOWN_GRACE + 1
            while any(slot.state != EMPTY for slot in self.slots):
                remaining = end - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            stragglers = [slot for slot in self.slots if slot.state != EMPTY]
        for slot in stragglers:
            self._kill_and_reap(slot, first=signal.SIGKILL, grace=0.0)
        with self._lock:
            io, self._io = self._io, None
        if io is not None:
            io.shutdown(wait=False, cancel_futures=True)

    # --- signals and reaping -------------------------------------------------------------------------

    def _signal_locked(self, slot: WorkerSlot, number: int) -> None:
        if slot.pidfd is None:
            return
        try:
            signal.pidfd_send_signal(slot.pidfd, number)
        except OSError:  # the child is gone already
            pass

    def _condemn_locked(self, slot: WorkerSlot, reason: str) -> None:
        """Mark the child as dying and ask it to stop (SIGTERM); whoever owns the slot reaps it."""
        if slot.abort_reason is None:
            slot.abort_reason = reason
        slot.state = DYING
        self._signal_locked(slot, signal.SIGTERM)

    def _kill_and_reap(self, slot: WorkerSlot, first: int | None = signal.SIGTERM, grace: float = KILL_GRACE) -> int | None:
        """Make sure the child is dead, ``waitpid`` it, close its descriptors and empty the slot.  Returns the exit code
        (negative: the signal that killed it)."""
        with self._lock:
            proc, pidfd = slot.proc, slot.pidfd
            if proc is None:
                if slot.state != STARTING:
                    slot.state = EMPTY
                    self._cond.notify_all()
                return None
            if slot.state != DYING:
                slot.state = DYING
                if slot.abort_reason is None:
                    slot.abort_reason = "killed"
            if first is not None:
                self._signal_locked(slot, first)
        if not _wait_pidfd(pidfd, grace):
            with self._lock:
                if slot.proc is proc:
                    self._signal_locked(slot, signal.SIGKILL)
        returncode = proc.wait()
        with self._lock:
            if slot.proc is proc:
                if slot.sock is not None:
                    try:
                        slot.sock.close()
                    except OSError:
                        pass
                if slot.pidfd is not None:
                    try:
                        os.close(slot.pidfd)
                    except OSError:
                        pass
                slot.proc = slot.pid = slot.pidfd = slot.sock = None
                slot.call = None
                slot.state = EMPTY
                self._cond.notify_all()
        return returncode

    # --- starting children ---------------------------------------------------------------------------

    def _start_in_background(self, slot: WorkerSlot) -> None:
        """Start the child of ``slot`` (already ``STARTING``) in a thread of its own."""

        def run() -> None:
            try:
                self._start_child(slot)
            except StartFailed:
                pass
            except BaseException:  # never leave a slot STARTING
                logger.exception("worker start failed unexpectedly slot=%d", slot.index)
                self._kill_and_reap(slot, first=signal.SIGKILL, grace=0.0)

        threading.Thread(target=run, name="bim-start", daemon=True).start()

    def _config(self) -> dict[str, Any]:
        settings = self.settings
        return {
            "max_body_bytes": settings.max_body_bytes,
            "max_registered_resources": settings.max_registered_resources,
            "max_bindings": settings.max_bindings,
            "neighborhood_max_seconds": settings.neighborhood_max_seconds,
            "limits": dataclasses.asdict(settings.limits),
            "operation_timeout_seconds": settings.operation_timeout_seconds,
            "allowance": settings.worker_allowance_bytes,
            "int_max_str_digits": sys.get_int_max_str_digits(),
            "recursionlimit": sys.getrecursionlimit(),
            "preload": list(settings.worker_preload),
        }

    def _start_child(self, slot: WorkerSlot) -> None:
        """Spawn the child, send ``CONFIG`` and wait for ``READY``.  ``slot`` is ``STARTING`` and belongs to the caller.

        On success the slot is ``IDLE``; on failure it is ``EMPTY`` with its back-off updated, and ``StartFailed`` is raised.
        """
        with self._lock:
            slot.last_start = time.monotonic()
            self.start_times.append(slot.last_start)
            slot.abort_reason = None
        parent_end = child_end = None
        try:
            parent_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            proc = subprocess.Popen(
                child_argv(child_end.fileno()),
                pass_fds=(child_end.fileno(),),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
                env=self._environment,
                cwd="/",
            )
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            for end in (parent_end, child_end):
                if end is not None:
                    end.close()
            self._start_failed(slot, f"cannot spawn: {type(exc).__name__}")
            raise StartFailed(slot.last_error) from exc
        child_end.close()
        try:
            pidfd = os.pidfd_open(proc.pid)
        except OSError as exc:
            proc.kill()  # no pidfd to signal through: the one place a pid is used, on a child that is not yet published
            proc.wait()
            parent_end.close()
            self._start_failed(slot, f"cannot open a pidfd: {type(exc).__name__}")
            raise StartFailed(slot.last_error) from exc
        with self._lock:
            slot.proc, slot.pid, slot.pidfd, slot.sock = proc, proc.pid, pidfd, parent_end
        try:
            deadline = time.monotonic() + WORKER_START_TIMEOUT
            self._send(parent_end, pack_frame(CONFIG, self._config()), deadline)
            ready = self._read_ready(parent_end, proc.pid, deadline)
        except (_Gone, _Timedout, _Violation, ValueError) as exc:
            reason = {_Gone: "died while starting", _Timedout: "did not become ready in time"}.get(
                type(exc), "sent an invalid ready message"
            )
            self._kill_and_reap(slot, first=signal.SIGKILL, grace=0.0)
            self._start_failed(slot, reason)
            raise StartFailed(reason) from exc
        with self._cond:
            if self._closed:
                closed = True
            else:
                closed = False
                slot.rss_ready = ready["rssBytes"]
                slot.vm_ready = ready["vmSizeBytes"]
                slot.limits = ready["limits"]
                slot.answers = 0
                slot.failures = 0
                slot.backoff_until = 0.0
                slot.last_error = ""
                slot.state = IDLE
                self._cond.notify_all()
        if closed:
            self._kill_and_reap(slot, first=signal.SIGKILL, grace=0.0)
            raise StartFailed("the pool is closed")

    def _start_failed(self, slot: WorkerSlot, reason: str) -> None:
        with self._cond:
            slot.last_error = reason
            if not self._closed:
                slot.failures += 1
                delay = min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (slot.failures - 1))
                slot.backoff_until = time.monotonic() + delay
            slot.state = EMPTY
            self._cond.notify_all()
        logger.warning("worker_start_failed slot=%d reason=%s", slot.index, reason)

    def _read_ready(self, sock: socket.socket, pid: int, deadline: float) -> dict[str, Any]:
        header, length = self._read_frame_header(sock, READY, deadline)
        if length:
            raise _Violation("ready with a body")
        limits = header.get("limits")
        if (
            header.get("pid") != pid
            or not _is_count(header.get("rssBytes"))
            or not _is_count(header.get("vmSizeBytes"))
            or not isinstance(limits, dict)
            or not all(isinstance(key, str) and _is_count(value) for key, value in limits.items())
        ):
            raise _Violation("invalid ready message")
        if header.get("identity") != self.identity:
            raise _Violation("the worker runs another toolchain")
        return header

    # --- running calls (I/O threads) -----------------------------------------------------------------

    def _checkout(self) -> WorkerSlot:
        with self._lock:
            if not self._free:
                raise RuntimeError("no worker slot is free")  # a bug: the concurrency token guarantees one
            chosen = next((slot for slot in self._free if slot.state == IDLE), self._free[0])
            self._free.remove(chosen)
            return chosen

    def _checkin(self, slot: WorkerSlot) -> None:
        """Give the slot back, refilling it in the background first when its child was just reaped."""
        with self._lock:
            if (
                not self._closed
                and slot.state == EMPTY
                and slot.backoff_until <= time.monotonic()
                and time.monotonic() - slot.last_start >= RESPAWN_INTERVAL
            ):
                slot.state = STARTING
                self._start_in_background(slot)
            self._free.append(slot)

    def _execute(self, call: Call) -> Outcome:
        slot = self._checkout()
        try:
            return self._run_on(slot, call)
        except BaseException:
            self._kill_and_reap(slot, first=signal.SIGKILL, grace=0.0)
            raise
        finally:
            self._checkin(slot)

    def _ensure_ready(self, slot: WorkerSlot) -> None:
        deadline = time.monotonic() + WORKER_START_TIMEOUT + 5
        with self._cond:
            while True:
                if self._closed:
                    raise StartFailed("the pool is closed")
                if slot.state == IDLE:
                    return
                now = time.monotonic()
                if slot.state == STARTING:  # being refilled in the background
                    if deadline - now <= 0:
                        raise StartFailed("the worker did not become ready in time")
                    self._cond.wait(deadline - now)
                    continue
                if slot.state != EMPTY:
                    raise StartFailed(f"the worker slot is {slot.state}")
                if slot.backoff_until > now:
                    raise StartFailed(slot.last_error or "backing off after failed starts")
                gap = slot.last_start + RESPAWN_INTERVAL - now
                if gap > 0:
                    self._cond.wait(gap)
                    continue
                slot.state = STARTING
                break
        self._start_child(slot)

    def _run_on(self, slot: WorkerSlot, call: Call) -> Outcome:
        try:
            self._ensure_ready(slot)
        except StartFailed as exc:
            logger.warning("worker unavailable slot=%d reason=%s correlation_id=%s", slot.index, exc, call.correlation_id)
            return Outcome("busy")
        with self._lock:
            if slot.state != IDLE or self._closed:
                return Outcome("busy")
            if call.abort_reason is not None:  # the client went away before the request was written
                return Outcome("busy" if call.abort_reason == "shutdown" else "cancelled")
            slot.state = BUSY
            slot.call = call
            slot.seq += 1
            slot.abort_reason = None
            call.slot = slot
            call.seq = slot.seq
        pid, rss_ready = slot.pid, slot.rss_ready
        error: Exception | None = None
        try:
            answer, outcome, details = self._exchange(slot, call)
        except _Timedout as exc:
            error = exc
        except (_Gone, _Violation) as exc:
            error = exc
        if error is None:
            if outcome in ("crash", "memory"):
                self._condemn_slot(slot, outcome)
                returncode = self._kill_and_reap(slot)
                self._log_exit(pid, returncode, call, rss_ready, f"{outcome} {details}".strip())
                return Outcome("failed")
            with self._lock:
                call.completed = True
                if slot.state == BUSY:
                    slot.state = IDLE
                    slot.call = None
                    slot.answers += 1
                    aborted = False
                else:
                    aborted = True
            if aborted:
                reason = slot.abort_reason
                returncode = self._kill_and_reap(slot)
                return self._classify(reason, returncode, pid, call, rss_ready)
            if answer.rss_bytes > slot.rss_ready + RETIRE_RSS_GROWTH or slot.answers >= RETIRE_ANSWERS:
                self._retire(slot)
            return Outcome("answer", answer)
        default = {_Timedout: "timeout", _Violation: "protocol"}.get(type(error), "died")
        reason = self._condemn_slot(slot, default)
        returncode = self._kill_and_reap(slot)
        if isinstance(error, _Violation):
            logger.error("worker protocol violation: %s correlation_id=%s", error, call.correlation_id)
        return self._classify(reason, returncode, pid, call, rss_ready)

    def _condemn_slot(self, slot: WorkerSlot, default_reason: str) -> str | None:
        with self._lock:
            if slot.state == BUSY:
                self._condemn_locked(slot, default_reason)
            return slot.abort_reason

    def _classify(self, reason: str | None, returncode: int | None, pid: int | None, call: Call, rss_ready: int) -> Outcome:
        if reason == "timeout":
            return Outcome("timeout")
        if reason == "disconnect":
            logger.info("worker_exit pid=%s signal=%s op=%s rss_ready=%s correlation_id=%s reason=disconnect",
                        pid, _signal_name(returncode), call.op, rss_ready, call.correlation_id)
            return Outcome("cancelled")
        if reason == "shutdown":
            return Outcome("busy")
        if returncode == -signal.SIGXCPU:
            self._log_exit(pid, returncode, call, rss_ready, "cpu limit")
            return Outcome("cpu")
        self._log_exit(pid, returncode, call, rss_ready, reason or "")
        return Outcome("failed")

    @staticmethod
    def _log_exit(pid: int | None, returncode: int | None, call: Call, rss_ready: int, note: str) -> None:
        logger.warning(
            "worker_exit pid=%s signal=%s op=%s rss_ready=%s correlation_id=%s%s",
            pid, _signal_name(returncode), call.op, rss_ready, call.correlation_id, f" reason={note}" if note else "",
        )

    def _retire(self, slot: WorkerSlot) -> None:
        """Replace a healthy worker: close its socket (it exits at the end of the stream), reap it."""
        with self._lock:
            slot.state = DYING
            slot.abort_reason = "retired"
            slot.call = None
            try:
                if slot.sock is not None:
                    slot.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self._kill_and_reap(slot, first=None)

    def _exchange(self, slot: WorkerSlot, call: Call) -> tuple[Answer, str, str]:
        """Write the request and read the answer; the time budget starts at the first write."""
        sock = slot.sock
        assert sock is not None
        header = {"seq": call.seq, "op": call.op, "contentType": call.content_type}
        deadline = time.monotonic() + self.settings.operation_timeout_seconds
        self._send(sock, pack_frame(REQUEST, header, len(call.body)), deadline)
        if call.body:
            self._send(sock, call.body, deadline)
        reply, length = self._read_frame_header(sock, RESPONSE, deadline, limit=self._max_response)
        status = reply.get("status")
        headers = reply.get("headers")
        if (
            type(reply.get("seq")) is not int
            or reply["seq"] != call.seq
            or type(status) is not int
            or status not in ALLOWED_STATUSES
            or reply.get("mediaType") not in ALLOWED_MEDIA_TYPES
            or reply.get("outcome") not in OUTCOMES
            or not _is_count(reply.get("rssBytes"))
            or not isinstance(headers, dict)
            or not all(
                key == "Retry-After" and isinstance(value, str) and len(value) <= 64 and value.isascii() and value.isprintable()
                for key, value in headers.items()
            )
        ):
            raise _Violation("invalid response header")
        body = bytearray(length)
        if length:
            self._recv_into(sock, memoryview(body), deadline)
        details = ""
        if reply["outcome"] in ("crash", "memory"):
            details = f"exception={_text(reply.get('exception'))} frames={_text(reply.get('frames'))}"
        answer = Answer(status, reply["mediaType"], dict(headers), body, reply["rssBytes"])
        return answer, reply["outcome"], details

    # --- framing -------------------------------------------------------------------------------------

    def _read_frame_header(
        self, sock: socket.socket, expect: int, deadline: float, limit: int = 0
    ) -> tuple[dict[str, Any], int]:
        """Read and validate the prefix and the header of a frame; the body is left unread.  Nothing is allocated before
        the magic, the kind, the header length and the body length have been checked."""
        prefix = bytearray(FRAME.size)
        self._recv_into(sock, memoryview(prefix), deadline)
        magic, kind, header_length, body_length = FRAME.unpack(prefix)
        if magic != MAGIC or kind != expect:
            raise _Violation("bad magic or kind")
        if header_length > MAX_HEADER:
            raise _Violation("header too large")
        if body_length > limit:
            raise _Violation("body too large")
        raw = bytearray(header_length)
        if header_length:
            self._recv_into(sock, memoryview(raw), deadline)
        try:
            header = json.loads(bytes(raw))
        except (ValueError, RecursionError) as exc:
            raise _Violation("header is not JSON") from exc
        if not isinstance(header, dict):
            raise _Violation("header is not an object")
        return header, body_length

    @staticmethod
    def _send(sock: socket.socket, data: bytes, deadline: float) -> None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _Timedout
        try:
            sock.settimeout(remaining)
            sock.sendall(data)
        except TimeoutError as exc:
            raise _Timedout from exc
        except OSError as exc:
            raise _Gone from exc

    @staticmethod
    def _recv_into(sock: socket.socket, view: memoryview, deadline: float) -> None:
        got = 0
        while got < len(view):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _Timedout
            try:
                sock.settimeout(remaining)
                count = sock.recv_into(view[got:])
            except TimeoutError as exc:
                raise _Timedout from exc
            except OSError as exc:
                raise _Gone from exc
            if count == 0:
                raise _Gone
            got += count


def _is_count(value: Any) -> bool:
    return type(value) is int and value >= 0


def _text(value: Any) -> str:
    """A bounded, printable rendering of a field a worker sent about its own failure (it is logged, never answered)."""
    return json.dumps(value, ensure_ascii=True)[:300]
