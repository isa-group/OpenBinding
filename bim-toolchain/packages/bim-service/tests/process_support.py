"""Helpers shared by the tests of ``BIM_SERVICE_EXECUTOR=process`` (the name is unique across the packages' test folders)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time

from bim_service import workers
from bim_service.runtime import Gate

COMPILE = "/bim/v1/compile"
XML_ROOT = "/bim/v1/resources/xml/root"


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


def slot_pids(app) -> list[int]:
    """The pids of the children the pool owns right now."""
    return [slot.pid for slot in app.state.gate.pool.slots if slot.pid]


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


def fd_kinds() -> list[str]:
    """What this process holds open, one entry per descriptor with the numbers (inodes) taken out, sorted.

    Two snapshots are equal when the process holds the same kinds of descriptors the same number of times: a leak of
    a socket or a pidfd per child shows as a difference, the churn of numbers does not.
    """
    kinds = []
    for entry in os.listdir("/proc/self/fd"):
        try:
            kinds.append(re.sub(r"\d+", "#", os.readlink(f"/proc/self/fd/{entry}")))
        except OSError:
            continue
    return sorted(kinds)


def assert_nothing_held(gate: Gate, slots: int) -> None:
    assert gate._charged == 0 and gate._chargers == 0
    assert gate._tenants == {}
    assert gate.bodies.held == 0
    assert all(gate._slots.acquire(blocking=False) for _ in range(slots)), "a slot leaked"
    for _ in range(slots):
        gate._slots.release()


def tell_workers_a_smaller_budget(monkeypatch, seconds: float) -> None:
    """Send the workers an ``operation_timeout_seconds`` smaller than the parent's in the ``CONFIG`` frame.

    A worker has one thread and cannot use more CPU than wall time, so with the same budget on both sides the wall clock of the
    parent always fires before the CPU limit of the worker.  The frame, the worker and its limit are the real ones.
    """
    original = workers.WorkerPool._config
    monkeypatch.setattr(
        workers.WorkerPool, "_config", lambda self: {**original(self), "operation_timeout_seconds": seconds}
    )


def spy_on_checkin(pool: workers.WorkerPool, monkeypatch) -> list[tuple[int, str]]:
    """The ``(index, state)`` of every slot at the moment it goes back to the free list."""
    seen: list[tuple[int, str]] = []
    original = pool._checkin

    def checkin(slot):
        seen.append((slot.index, slot.state))
        return original(slot)

    monkeypatch.setattr(pool, "_checkin", checkin)
    return seen


def xml_root_request(index: int) -> bytes:
    """A real, cheap operation whose answer says which request it answers: the root element is ``r<index>``."""
    document = f'<?xml version="1.0"?><r{index} xmlns="urn:r"/>'.encode()
    return json.dumps({"contentBase64": base64.b64encode(document).decode()}).encode()


def answered(index: int, response) -> bool:
    return response.status_code == 200 and response.json() == {"namespace": "urn:r", "localName": f"r{index}"}


def cpu_limits(pid: int) -> tuple[str, str]:
    """``(soft, hard)`` ``RLIMIT_CPU`` of a process as ``/proc/<pid>/limits`` prints them (seconds or ``unlimited``)."""
    with open(f"/proc/{pid}/limits", encoding="ascii") as handle:
        for line in handle:
            if line.startswith("Max cpu time"):
                soft, hard = line.split()[3:5]
                return soft, hard
    raise AssertionError("no CPU limit line in /proc/<pid>/limits")
