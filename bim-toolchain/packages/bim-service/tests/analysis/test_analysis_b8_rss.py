"""B8 (measurement): resident memory of the service process before, during and after concurrent evaluations of the
largest allowed body.

What is measured, and what is not:

* ``process``: ``VmRSS`` and ``VmHWM`` from ``/proc/self/status`` *of a fresh child process* (``rss_support.py``) that holds
  the service and an in-process client, so the 32 MiB request (one ``bytes`` object shared by all the requests) is counted
  in it as well.  It is not a deployed container.
* ``cgroup``: ``memory.max`` / ``memory.current`` / ``memory.peak`` of the cgroup of the test run, when the files exist.
  They are reported apart because they count the whole cgroup (this runner, page cache, siblings), not the child.
* The operation (``operations.evaluate``) is replaced by a stand-in that returns at once: the numbers are those of the
  service layer (reading the body, ``json.loads``, validation, rendering), not of the evaluator.

Nothing is estimated: every number printed in the "measurements" section was read from the kernel during the run.  The
only assertions are loose upper bounds that catch an unbounded copy.  The runs are skipped one by one when the memory that
is visible (``MemAvailable`` or the cgroup limit) cannot hold them, and the report says which ran.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from rss_support import (
    cgroup_bytes,
    cgroup_directory,
    cgroup_value,
    meminfo_available,
    mib,
    room,
)

from bim_service.settings import BODY_MEMORY_FACTOR, BimServiceSettings

SUPPORT = Path(__file__).with_name("rss_support.py")
LIMIT = BimServiceSettings().max_body_bytes
CONCURRENT = (1, 2, 4)


def measure(count: int) -> dict:
    """The child's own figures, plus the highest ``memory.current`` of the cgroup that this (separate) process read while
    the child ran."""
    environment = {"PYTHONPATH": ":".join(sys.path), "PATH": "/usr/bin:/bin"}
    child = subprocess.Popen(
        [sys.executable, str(SUPPORT), str(count)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    highest = cgroup_bytes("memory.current") or 0
    deadline = time.monotonic() + 900
    while child.poll() is None:
        assert time.monotonic() < deadline, "the child did not finish"
        highest = max(highest, cgroup_bytes("memory.current") or 0)
        time.sleep(0.02)
    stdout, stderr = child.communicate()
    assert child.returncode == 0, stderr[-2000:]
    row = json.loads(stdout.strip().splitlines()[-1])
    row["cgroup_highest_sampled"] = highest or None
    return row


@pytest.mark.skipif(not Path("/proc/self/status").exists(), reason="no /proc/self/status (not Linux)")
def test_resident_memory_of_concurrent_evaluations_of_the_largest_body(report) -> None:
    free, which = room()
    report("== B8 resident memory, /evaluate at the largest allowed body (operation stubbed; fresh process per row) ==")
    report(
        f"cgroup (not the process): {cgroup_directory() or 'no cgroup v2 memory files'}; memory.max {cgroup_value('memory.max')}, "
        f"memory.current {mib(cgroup_bytes('memory.current'))}, memory.peak {mib(cgroup_bytes('memory.peak'))}; "
        f"host MemAvailable {mib(meminfo_available())}; free by the tightest limit {mib(free)} ({which})"
    )
    ran = []
    for count in CONCURRENT:
        # The documented estimate (BODY_MEMORY_FACTOR x body per request) plus the request itself; a guard, not a result.
        needed = LIMIT * (BODY_MEMORY_FACTOR * count + 2)
        free, which = room()
        if free is not None and needed > free:
            report(f"N={count}: not run, needs {mib(needed)} by the guard and {mib(free)} is free ({which})")
            continue
        row = measure(count)
        ran.append(count)
        if len(ran) == 1:
            report(
                f"process: pid {row['pid']}, name {row['name']!r}, python {row['python']} ({row['implementation']}), "
                f"{row['system']}, cpus {row['cpus']}; body {row['body_bytes']} bytes ({mib(row['body_bytes'])}), "
                f"of small objects"
            )
        above = row["rss_peak"] - row["rss_idle"]
        report(
            f"N={count} (pid {row['pid']}): VmRSS interpreter {mib(row['rss_interpreter'])}, idle {mib(row['rss_idle'])}, "
            f"with the request {mib(row['rss_before'])}; peak VmHWM {mib(row['rss_peak'])} "
            f"({'reset before the run' if row['peak_reset'] else 'NOT reset: lifetime peak'}); "
            f"end {mib(row['rss_end'])}, after gc {mib(row['rss_gc'])}, after malloc_trim {mib(row['rss_trim'])}; "
            f"{row['seconds']:.1f} s"
        )
        report(
            f"N={count}: peak above idle {mib(above)} = {above / LIMIT:.1f} x body, {above / LIMIT / count:.1f} x body per "
            f"request (the 32 MiB request held by the client is in it); cgroup memory.current "
            f"{mib(row['cgroup_before'])} before, highest sampled every 20 ms while it ran {mib(row['cgroup_highest_sampled'])}, "
            f"{mib(row['cgroup_end'])} at the end (cgroup figures)"
        )
        assert row["statuses"] == [200] * count
        # Loose upper bound, per request: twice the 8 x estimate of the memory budget, far below an unbounded copy.
        assert above < 2 * BODY_MEMORY_FACTOR * LIMIT * count, (count, above)
    if not ran:
        pytest.skip(f"not enough memory for one request at the body limit: {mib(free)} free ({which})")
