"""A per-test time limit that turns a hang into a failure with a dump of what is waiting.

The PostgreSQL tests wait on row locks and events; when one waits for something that
never happens the harness would otherwise sit until its outer timeout and lose the
output. ``watchdog`` arms ``SIGALRM`` on the main thread. When it fires, the handler
raises ``WatchdogTimeout`` from wherever the main thread is: inside the event loop's
``select`` for an async test, which makes the loop's run call raise and pytest report
the test as failed; inside plain Python for a synchronous one. The message carries the
stack of every thread (``faulthandler``) and of every asyncio task of the running loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import faulthandler
import io
import os
import signal
import tempfile
import threading
import warnings
from collections.abc import Iterator, Mapping

TIMEOUT_VARIABLE = "OPENBINDING_PG_TEST_TIMEOUT"
DEFAULT_TIMEOUT = 60.0
#: After the first expiry the timer repeats at this interval, so a hang in fixture
#: teardown (after the test already failed) is reported too instead of blocking.
REPEAT_SECONDS = 15.0


class WatchdogTimeout(Exception):
    """A test (with its fixtures) ran longer than its limit."""


def timeout_seconds(environ: Mapping[str, str] | None = None) -> float:
    """The limit in seconds: ``OPENBINDING_PG_TEST_TIMEOUT`` or 60. A bad value is an error."""
    environ = os.environ if environ is None else environ
    raw = environ.get(TIMEOUT_VARIABLE)
    if raw is None or not raw.strip():
        return DEFAULT_TIMEOUT
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{TIMEOUT_VARIABLE}={raw!r} is not a number of seconds") from None
    if not value > 0 or value == float("inf"):
        raise ValueError(f"{TIMEOUT_VARIABLE}={raw!r} must be a positive, finite number of seconds")
    return value


def dump_state() -> str:
    """Stacks of all threads and of all asyncio tasks of the loop running on this thread."""
    with tempfile.TemporaryFile("w+") as threads:
        faulthandler.dump_traceback(file=threads, all_threads=True)
        threads.seek(0)
        thread_dump = threads.read().rstrip()
    lines = ["Threads:", thread_dump, "", "asyncio tasks:"]
    loop = asyncio._get_running_loop()
    if loop is None:
        lines.append("  (no event loop is running on this thread)")
    else:
        tasks = sorted(asyncio.all_tasks(loop), key=lambda task: task.get_name())
        if not tasks:
            lines.append("  (none)")
        for task in tasks:
            buffer = io.StringIO()
            task.print_stack(file=buffer)
            lines.append(f"  {task!r}")
            lines.append("    " + buffer.getvalue().rstrip().replace("\n", "\n    "))
    return "\n".join(lines)


@contextlib.contextmanager
def watchdog(seconds: float) -> Iterator[None]:
    """Raise ``WatchdogTimeout`` (with a dump) if the block is still running after ``seconds``."""
    if not hasattr(signal, "setitimer") or threading.current_thread() is not threading.main_thread():
        warnings.warn("the test watchdog needs SIGALRM on the main thread; running without it", stacklevel=2)
        yield
        return

    def expired(signum, frame):
        raise WatchdogTimeout(
            f"test exceeded {seconds:g} s ({TIMEOUT_VARIABLE} changes the limit)\n{dump_state()}"
        )

    previous_handler = signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds, REPEAT_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)
