"""``BIM_SERVICE_EXECUTOR=process``: what the workers do when their parent dies (Linux only, real processes).

Every case starts a *synthetic parent* of its own (``parent_death_processes.py``: the production ``WorkerPool`` with real
workers, in a process of its own) under a *reaper* (a child subreaper, the ``init`` of the case), and kills only that parent,
through a pidfd the test opened on it.  The workers are watched through pidfds opened when they were ready, so the time they
take to die is measured by the test and cannot be confused with a recycled pid; the reaper reports how each of them ended
(``wait4``: exit code or signal, and the CPU it used) and that nothing is left.  No signal is mocked, no constant is lowered and
nothing is added to the service for this.

What the code does (``workers.py``, ``_worker.py``): the socket pair is the only link.  When the parent dies the kernel closes its
end.  An *idle* worker is blocked in ``recv`` on it, sees the end of the stream and exits with 0.  A *busy* worker is inside the
operation and does not read the socket: it dies when the operation returns (it then writes the answer to a closed socket, which
fails, exit 70) or when the kernel enforces the soft ``RLIMIT_CPU`` it set on itself at the start of the request (CPU used so far
+ the operation timeout + 2 s, whole seconds), which is ``SIGXCPU``; nothing else stops it.  ``PR_SET_PDEATHSIG`` is not used.
"""

from __future__ import annotations

import json
import os
import queue
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

import pytest
from parent_death_processes import SCRIPT, children_of, parent_of
from process_support import cpu_limits, reaped

pytestmark = pytest.mark.skipif(
    not (sys.platform.startswith("linux") and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")),
    reason="process mode needs Linux with pidfd",
)

#: Seconds the test waits for anything that must happen on its own (an event, an exit): far above what was measured, far below
#: the 30 s a case may take.
PATIENCE = 12.0


def wait_for(predicate, timeout: float, what: str) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"not reached in {timeout:g} s: {what}")
        time.sleep(0.005)


class Scenario:
    """A reaper, its synthetic parent and the workers of the parent, all started by this test and cleaned up by it."""

    def __init__(self, tmp_path, **config) -> None:
        self.config = {
            "workers": 2, "timeout": 60.0, "command": None, "action": "wait", "uds": None, "deadline": 100.0, **config,
        }  # fmt: skip
        self.events: list[dict] = []
        self.pidfds: dict[int, int] = {}
        self._queue: queue.Queue = queue.Queue()
        self._stderr = tmp_path / "stderr.txt"
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(entry for entry in sys.path if entry)}
        with open(self._stderr, "wb") as stderr:
            self.proc = subprocess.Popen(
                [sys.executable, SCRIPT, "reaper", json.dumps(self.config)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                env=env,
                start_new_session=True,
            )
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def __enter__(self) -> Scenario:
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                self._queue.put(json.loads(line))
            except ValueError:
                self._queue.put({"event": "garbage", "line": line.decode(errors="replace")})
        self._queue.put({"event": "eof"})

    def explain(self, message: str) -> str:
        try:
            errors = self._stderr.read_text(errors="replace")[-3000:]
        except OSError:
            errors = ""
        return f"{message}; events: {self.events}; stderr: {errors}"

    def event(self, name: str, timeout: float = PATIENCE) -> dict:
        """The first event called ``name`` (already seen, or still to come)."""
        deadline = time.monotonic() + timeout
        while True:
            for event in self.events:
                if event["event"] == name:
                    return event
            if self.events and self.events[-1]["event"] == "eof":
                raise AssertionError(self.explain(f"the reaper ended without {name!r}"))
            try:
                self.events.append(self._queue.get(timeout=max(deadline - time.monotonic(), 0.001)))
            except queue.Empty:
                raise AssertionError(self.explain(f"no {name!r} event in {timeout:g} s")) from None

    @property
    def parent_pid(self) -> int:
        return self.event("starting")["pid"]

    def watch(self, pids: list[int]) -> None:
        """Open a pidfd on each worker (they are alive and children of the parent when this is called)."""
        for pid in pids:
            assert parent_of(pid) == self.parent_pid, f"{pid} is not a child of the parent"
            self.pidfds[pid] = os.pidfd_open(pid)

    def has_exited(self, pid: int) -> bool:
        poller = select.poll()
        poller.register(self.pidfds[pid], select.POLLIN)
        return bool(poller.poll(0))

    def exits(self, pids: list[int], timeout: float) -> dict[int, float]:
        """``time.monotonic()`` at which each of ``pids`` was seen to exit; the ones that did not within ``timeout`` are absent."""
        poller = select.poll()
        by_fd = {self.pidfds[pid]: pid for pid in pids}
        for fd in by_fd:
            poller.register(fd, select.POLLIN)
        found: dict[int, float] = {}
        deadline = time.monotonic() + timeout
        while len(found) < len(pids):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            for fd, _ in poller.poll(max(1, int(remaining * 1000))):
                found[by_fd[fd]] = time.monotonic()
                poller.unregister(fd)
        return found

    def signal_parent(self, number: int) -> float:
        """Send ``number`` to the synthetic parent (through a pidfd on it); ``time.monotonic()`` just before."""
        pidfd = os.pidfd_open(self.parent_pid)
        try:
            began = time.monotonic()
            signal.pidfd_send_signal(pidfd, number)
        finally:
            os.close(pidfd)
        return began

    def reaped(self) -> dict[int, dict]:
        """How each child of the reaper ended, once the reaper said ``done``."""
        self.event("done", PATIENCE + 8)
        return {event["pid"]: event for event in self.events if event["event"] == "reaped"}

    def close(self) -> None:
        """The reaper kills what is left when its stdin closes; the last resort kills the workers through the test's own pidfds."""
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        for fd in self.pidfds.values():
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except OSError:  # gone already
                pass
            os.close(fd)
        self.pidfds.clear()
        self._reader.join(timeout=5)
        if self.proc.stdout is not None:
            self.proc.stdout.close()


def no_trace_of(pids) -> bool:
    """Neither a live process nor a zombie nor anything for ``waitpid`` to reap."""
    return all(reaped(pid) for pid in pids)


# --- (a) idle workers --------------------------------------------------------------------------------------


@pytest.mark.parametrize("number", [signal.SIGKILL, signal.SIGTERM], ids=["sigkill", "sigterm-default"])
def test_idle_workers_exit_by_themselves_when_the_parent_dies_and_nothing_is_left(tmp_path, report, number) -> None:
    """The parent dies with no handler (``SIGKILL``; ``SIGTERM`` with the default action, which ends a Python process with no
    clean-up at all): the end of the stream is the only thing the workers get."""
    with Scenario(tmp_path, workers=3) as scenario:
        ready = scenario.event("ready")
        parent, workers = ready["pid"], ready["workers"]
        assert len(set(workers)) == 3
        scenario.watch(workers)
        time.sleep(0.5)  # idle workers do not leave on their own
        assert not any(scenario.has_exited(pid) for pid in workers)
        killed = scenario.signal_parent(number)
        exits = scenario.exits(workers, PATIENCE)
        outcome = scenario.reaped()
    assert set(exits) == set(workers), f"a worker outlived its parent: {sorted(set(workers) - set(exits))}"
    delays = {pid: exits[pid] - killed for pid in workers}
    assert max(delays.values()) < 5.0
    # the reaper had them as children (reassigned to it) and reaped them: exit 0 is the end of the stream
    assert set(outcome) == {parent, *workers}
    assert outcome[parent]["exit"] == -number
    assert {pid: outcome[pid]["exit"] for pid in workers} == {pid: 0 for pid in workers}
    assert no_trace_of([parent, *workers])
    assert scenario.proc.returncode == 0
    report(
        f"parent death, idle: parent killed with {signal.Signals(number).name}; its 3 idle workers exited by themselves "
        f"{', '.join(f'{delay * 1000:.0f}' for delay in sorted(delays.values()))} ms later (exit 0 each: the end of the "
        f"stream), were reassigned to the reaper and reaped by it; no process or zombie left"
    )


def test_parent_killed_while_the_workers_start_leaves_none_alive(tmp_path, report) -> None:
    """Killed at the first child it has: the worker reads its ``CONFIG`` (already in the socket), imports, warms up and its
    ``READY`` fails on the closed socket (exit 70), or it sees the end of the stream before the ``CONFIG`` (exit 1)."""
    with Scenario(tmp_path, workers=2) as scenario:
        parent = scenario.parent_pid
        seen: set[int] = set()
        wait_for(lambda: seen.update(children_of(parent)) or seen, 10.0, "the parent has no child")
        killed = scenario.signal_parent(signal.SIGKILL)
        outcome = scenario.reaped()
        finished = scenario.event("done")["t"] - killed
    orphans = {pid: event for pid, event in outcome.items() if pid != parent}
    assert outcome[parent]["exit"] == -signal.SIGKILL
    assert seen <= set(orphans), "a child of the dead parent was not reassigned and reaped"
    assert {event["exit"] for event in orphans.values()} <= {0, 1, 70}
    assert finished < PATIENCE
    assert no_trace_of(outcome)
    assert scenario.proc.returncode == 0
    report(
        f"parent death, during start: parent killed with {len(seen)} of 2 workers started; {len(orphans)} orphans, all gone "
        f"{finished * 1000:.0f} ms later with exit codes {sorted(event['exit'] for event in orphans.values())}"
    )


# --- (b) an operation in flight ---------------------------------------------------------------------------


@pytest.mark.parametrize("timeout, bound", [(1, 15.0), (4, 25.0)], ids=["timeout-1s", "timeout-4s"])
def test_a_cpu_bound_worker_outlives_its_dead_parent_until_its_own_cpu_limit(tmp_path, report, timeout, bound) -> None:
    """``spin:forever`` is pure Python that never returns, like the compiler on a hostile input.  The idle worker of the pair
    leaves at once; the busy one does not read the socket, so only the CPU limit it set on itself ends it: ``SIGXCPU`` when the CPU
    it used reaches ``ceil(CPU used before) + ceil(timeout) + 2`` s."""
    with Scenario(tmp_path, workers=2, timeout=timeout, command="spin:forever") as scenario:
        ready = scenario.event("ready")
        parent, workers = ready["pid"], ready["workers"]
        (burner,) = scenario.event("busy")["pids"]
        (idle,) = [pid for pid in workers if pid != burner]
        scenario.watch(workers)
        wait_for(lambda: cpu_limits(burner)[0].isdigit(), 5.0, "the worker has not set its CPU limit")
        soft, hard = cpu_limits(burner)
        time.sleep(0.5)
        killed = scenario.signal_parent(signal.SIGKILL)
        wait_for(lambda: parent_of(burner) == scenario.proc.pid, 3.0, "the busy worker was not reassigned to the reaper")
        exits = scenario.exits(workers, bound)
        outcome = scenario.reaped()
    assert set(exits) == set(workers), f"a worker outlived its parent for more than {bound:g} s: {sorted(set(workers) - set(exits))}"
    idle_delay, burner_delay = exits[idle] - killed, exits[burner] - killed
    assert idle_delay < 5.0 and outcome[idle]["exit"] == 0
    # the busy worker did not leave at the end of the stream: it was killed by the kernel at its CPU limit
    assert outcome[burner]["exit"] == -signal.SIGXCPU
    assert timeout + 2 < int(soft) <= timeout + 2 + 5, "CPU used so far + timeout + 2 s, and a fresh worker used less than 5 s"
    assert int(soft) - 1 <= outcome[burner]["cpu"] <= int(soft) + 1, "the CPU it used is the limit it set"
    assert 1.5 <= burner_delay <= bound
    assert set(outcome) == {parent, *workers}
    assert no_trace_of([parent, *workers])
    assert scenario.proc.returncode == 0
    report(
        f"parent death, CPU-bound operation in flight, operation timeout {timeout} s: soft RLIMIT_CPU {soft} s (hard {hard}); "
        f"parent killed with SIGKILL while the worker was inside the operation; the idle worker left after "
        f"{idle_delay * 1000:.0f} ms (exit 0), the busy one was reassigned to the reaper and died of SIGXCPU {burner_delay:.2f} s "
        f"after the parent, having used {outcome[burner]['cpu']:.2f} s of CPU; reaped, nothing left"
    )


@pytest.mark.parametrize(
    "command, timeout, duration",
    [("spin:2", 4, 2.0), ("sleep:5", 1, 5.0)],
    ids=["cpu-job-of-2s", "job-without-cpu-of-5s"],
)
def test_a_busy_worker_dies_when_its_operation_returns_not_when_the_stream_ends(
    tmp_path, report, command, timeout, duration
) -> None:
    """The operation is not interrupted by the end of the stream: it runs to its end (here 2 s of CPU, below the CPU limit; or 5 s
    asleep, which uses no CPU and so is not bounded by the limit or by the timeout of 1 s at all).  The worker then writes the
    answer to the closed socket, which fails, and exits with 70."""
    with Scenario(tmp_path, workers=1, timeout=timeout, command=command) as scenario:
        ready = scenario.event("ready")
        parent, (worker,) = ready["pid"], ready["workers"]
        began = scenario.event("busy")["t"]
        scenario.watch([worker])
        wait_for(lambda: cpu_limits(worker)[0].isdigit(), 5.0, "the worker has not set its CPU limit")
        soft, _ = cpu_limits(worker)
        time.sleep(0.5)
        killed = scenario.signal_parent(signal.SIGKILL)
        bound = duration + PATIENCE
        exits = scenario.exits([worker], bound)
        outcome = scenario.reaped()
    assert worker in exits, f"the worker outlived its parent for more than {bound:g} s"
    lived = exits[worker] - began
    # the job cannot end before its duration; the stream ended 0.5 s or more after it began, and the worker did not leave then
    assert duration - 0.2 <= lived <= bound
    assert outcome[worker]["exit"] == 70
    assert outcome[worker]["cpu"] < int(soft), "it did not reach its CPU limit"
    assert set(outcome) == {parent, worker}
    assert no_trace_of([parent, worker])
    report(
        f"parent death, operation `{command}` in flight, operation timeout {timeout} s (soft RLIMIT_CPU {soft} s): parent killed "
        f"{killed - began:.2f} s into the operation; the worker died {lived:.2f} s after the operation began "
        f"({exits[worker] - killed:.2f} s after the parent), exit 70 (the answer could not be written), CPU used "
        f"{outcome[worker]['cpu']:.2f} s; reaped, nothing left"
    )


# --- (c) a clean end of the parent ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "trigger", ["exits", "sigterm", "uvicorn"], ids=["parent-exits", "parent-handles-sigterm", "uvicorn-sigterm"]
)
def test_a_parent_that_leaves_cleanly_stops_and_reaps_its_workers_itself(tmp_path, report, trigger) -> None:
    """Normal interpreter exit (by itself, or a handler for ``SIGTERM`` that calls ``sys.exit``), and the real application under
    ``uvicorn`` that gets ``SIGTERM`` (its lifespan closes the gate): the pool closes the idle worker's socket, signals the busy one
    and reaps both before the parent is gone, so no orphan reaches the reaper."""
    action = {"exits": "exit", "sigterm": "term-handler", "uvicorn": "uvicorn"}[trigger]
    directory = tempfile.mkdtemp(prefix="bpd")  # a short path for the Unix socket of uvicorn
    try:
        with Scenario(
            tmp_path, workers=2, command="spin:forever", action=action, uds=os.path.join(directory, "s")
        ) as scenario:
            ready = scenario.event("ready")
            parent, workers = ready["pid"], ready["workers"]
            (burner,) = scenario.event("busy")["pids"]
            scenario.watch(workers)
            if trigger == "exits":
                began = scenario.event("exiting")["t"]
            else:
                wait_for(lambda: cpu_limits(burner)[0].isdigit(), 5.0, "the worker has not set its CPU limit")
                began = scenario.signal_parent(signal.SIGTERM)
            exits = scenario.exits(workers, PATIENCE)
            outcome = scenario.reaped()
            finished = outcome[parent]["t"] - began
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    assert set(exits) == set(workers)
    # uvicorn, once it has shut down, raises the signal again with the default action, so it may end as `SIGTERM`
    assert outcome[parent]["exit"] in ((0, -signal.SIGTERM) if trigger == "uvicorn" else (0,))
    assert set(outcome) == {parent}, "a worker was still alive when the parent left (reassigned to the reaper)"
    assert finished < 10.0
    assert no_trace_of([parent, *workers])
    assert scenario.proc.returncode == 0
    report(
        f"parent clean exit ({trigger}): idle and busy (spin:forever) worker both stopped and reaped by the parent itself, "
        f"parent exit {outcome[parent]['exit']} {finished:.2f} s after the trigger, no orphan reached the reaper"
    )
