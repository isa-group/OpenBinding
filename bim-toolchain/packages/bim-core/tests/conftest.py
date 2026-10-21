"""Fixtures of the bim-core tests.  The helpers they use are in ``core_support.py``."""

from __future__ import annotations

import importlib
import sys

import pytest
from core_support import TOOLS_DIR

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

# The digest of the failures of a run, printed last (the pytest configuration of this package stops the search for
# conftest files at its own directory, so the one at the root of bim-toolchain is not loaded here).
from corpus_tier import pytest_collection_modifyitems, pytest_configure  # noqa: E402,F401
from failure_digest import (  # noqa: E402,F401
    pytest_collectreport,
    pytest_runtest_logreport,
    pytest_sessionfinish,
    pytest_unconfigure,
)


@pytest.fixture(scope="session")
def baseline_tool():
    """``tools/baseline_core.py`` imported as a regular module (workers must be able to import it)."""
    if not (TOOLS_DIR / "baseline_core.py").is_file():
        pytest.skip("tools/baseline_core.py is not present")
    sys.path.insert(0, str(TOOLS_DIR))
    try:
        yield importlib.import_module("baseline_core")
    finally:
        sys.path.remove(str(TOOLS_DIR))
