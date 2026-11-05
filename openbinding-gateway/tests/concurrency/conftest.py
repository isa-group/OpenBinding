import pytest

from ._two_sessions import two_sessions
from ._watchdog import timeout_seconds, watchdog

__all__ = ["two_sessions"]


@pytest.fixture(autouse=True)
def _test_watchdog():
    """Fail any test of this directory (fixtures included) that outlives its limit, with a dump.

    Limit: ``OPENBINDING_PG_TEST_TIMEOUT`` seconds, 60 by default.
    """
    with watchdog(timeout_seconds()):
        yield
