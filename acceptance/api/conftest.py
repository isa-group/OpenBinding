"""Runner configuration for the API acceptance tests.

The runner must exit 0 while no acceptance test exists, and when ``-k`` selects
nothing. Pytest reports both as exit code 5 (no tests collected); it is mapped to 0
here and every other exit status is left unchanged.
"""

import pytest


def pytest_sessionfinish(session, exitstatus):
    if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:
        session.exitstatus = 0
