"""Shared helpers: where the OpenBinding corpus lives and how to load the baseline tool."""

from __future__ import annotations

import importlib
import os
import sys
import warnings
from pathlib import Path

import pytest

TOOLCHAIN_ROOT = Path(__file__).resolve().parents[3]
TOOLS_DIR = TOOLCHAIN_ROOT / "tools"
GOLDEN_DIR = TOOLCHAIN_ROOT / "golden" / "bim_baseline"
CORPUS_MARKER = Path("examples") / "demo" / "01_simple_seq" / "instance.json"


def corpus_root() -> Path:
    """``BIM_CORPUS_ROOT`` or the directory that contains ``bim-toolchain/``."""
    configured = os.environ.get("BIM_CORPUS_ROOT")
    return Path(configured) if configured else TOOLCHAIN_ROOT.parent


def require_corpus_path(relative: str) -> Path:
    """The corpus directory ``relative``, or skip the test with a warning when it is absent."""
    path = corpus_root() / relative
    if not (corpus_root() / CORPUS_MARKER).is_file() or not path.is_dir():
        message = f"BIM corpus not available at {corpus_root()} (set BIM_CORPUS_ROOT): skipping {relative}"
        warnings.warn(message, stacklevel=2)
        pytest.skip(message)
    return path


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
