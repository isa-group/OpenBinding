"""The per-test watchdog of ``conftest.py`` turns a hang into a failure with a dump.

These tests need no database. None of them hangs for real: each uses a limit of a fraction of a
second on a loop (or a sleep) that would otherwise wait for 30 s.
"""

from __future__ import annotations

import asyncio
import signal
import time

import pytest

from ._watchdog import DEFAULT_TIMEOUT, TIMEOUT_VARIABLE, WatchdogTimeout, timeout_seconds, watchdog


def test_a_sleeping_coroutine_fails_with_the_stack_of_threads_and_tasks():
    async def waits_for_a_lock_that_never_frees():
        await asyncio.sleep(30)

    started = time.monotonic()
    with pytest.raises(WatchdogTimeout) as caught:
        with watchdog(0.2):
            # Not the pytest-asyncio loop: the handler's exception leaves the loop it interrupts.
            asyncio.run(waits_for_a_lock_that_never_frees())

    assert time.monotonic() - started < 10
    message = str(caught.value)
    assert "exceeded 0.2 s" in message
    assert TIMEOUT_VARIABLE in message
    assert "Threads:" in message and "most recent call first" in message
    assert "asyncio tasks:" in message
    assert "waits_for_a_lock_that_never_frees" in message


def test_a_blocked_synchronous_test_fails_too():
    with pytest.raises(WatchdogTimeout) as caught:
        with watchdog(0.2):
            time.sleep(30)

    assert "no event loop is running" in str(caught.value)


def test_a_test_inside_the_limit_is_left_alone():
    with watchdog(5):
        time.sleep(0.01)


def test_the_watchdog_restores_the_timer_and_handler_it_found():
    before = signal.getsignal(signal.SIGALRM)
    remaining_before = signal.getitimer(signal.ITIMER_REAL)[0]

    with watchdog(5):
        assert 0 < signal.getitimer(signal.ITIMER_REAL)[0] <= 5
    assert signal.getsignal(signal.SIGALRM) is before
    # The enclosing (autouse) watchdog is still armed, with what was left of its time.
    assert 0 < signal.getitimer(signal.ITIMER_REAL)[0] <= remaining_before


def test_every_test_of_this_directory_runs_under_the_autouse_watchdog():
    remaining, _ = signal.getitimer(signal.ITIMER_REAL)
    assert 0 < remaining <= timeout_seconds()


def test_the_limit_is_60_s_unless_the_variable_says_otherwise():
    assert DEFAULT_TIMEOUT == 60
    assert timeout_seconds({}) == 60
    assert timeout_seconds({TIMEOUT_VARIABLE: ""}) == 60
    assert timeout_seconds({TIMEOUT_VARIABLE: "2.5"}) == 2.5
    assert timeout_seconds({TIMEOUT_VARIABLE: " 300 "}) == 300


@pytest.mark.parametrize("value", ["soon", "0", "-1", "inf", "nan"])
def test_a_bad_limit_is_an_error_not_a_disabled_watchdog(value):
    with pytest.raises(ValueError, match=TIMEOUT_VARIABLE):
        timeout_seconds({TIMEOUT_VARIABLE: value})
