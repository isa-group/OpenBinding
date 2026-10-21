"""Session-wide hooks: the digest of the failures of a run (``tools/failure_digest.py``) and the marker of the tests
that read the OpenBinding corpus (``tools/corpus_tier.py``: ``-m 'not openbinding_corpus'`` runs everything else)."""

from __future__ import annotations

import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from corpus_tier import pytest_collection_modifyitems, pytest_configure  # noqa: E402,F401
from failure_digest import (  # noqa: E402,F401
    pytest_collectreport,
    pytest_runtest_logreport,
    pytest_sessionfinish,
    pytest_unconfigure,
)
