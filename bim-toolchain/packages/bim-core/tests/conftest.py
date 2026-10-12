"""Fixtures of the bim-core tests.  The helpers they use are in ``core_support.py``."""

from __future__ import annotations

import importlib
import sys

import pytest
from core_support import TOOLS_DIR


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
