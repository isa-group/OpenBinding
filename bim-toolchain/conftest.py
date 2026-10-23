"""Session-wide hooks: the digest of the failures of a run (``tools/failure_digest.py``), the marker of the tests
that read the OpenBinding corpus (``tools/corpus_tier.py``: ``-m 'not openbinding_corpus'`` runs everything else) and the
verified download of the OMG BPMN XSDs, which the repository does not version (``tools/xsd_session.py``)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOOLS_DIR = ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

# The sources of the packages come last: an installed bim_core wins, and a session that defines no PYTHONPATH (the tests
# of tools/ import bim_core, bim_service and bim_client) still finds them.
for _source in sorted((ROOT / "packages").glob("*/src")):
    if str(_source) not in sys.path:
        sys.path.append(str(_source))

from corpus_tier import pytest_collection_modifyitems, pytest_configure  # noqa: E402,F401
from failure_digest import (  # noqa: E402,F401
    pytest_collectreport,
    pytest_runtest_logreport,
    pytest_sessionfinish,
    pytest_unconfigure,
)
from xsd_session import pytest_report_header, pytest_sessionstart  # noqa: E402,F401
