"""Helpers shared by the client tests (the name is unique across the packages' test folders)."""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path
from typing import Any, Callable

import pytest

TOOLCHAIN_ROOT = Path(__file__).resolve().parents[3]
TOOLS_DIR = TOOLCHAIN_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from bim_core import BimError  # noqa: E402

TOKEN = "client-test-token-" + "0123456789abcdef" * 2
BASE_URL = "http://bim.test"
CORPUS_MARKER = Path("examples") / "demo" / "01_simple_seq" / "instance.json"
GOLDEN_DIR = TOOLCHAIN_ROOT / "golden"
MANIFEST_DIR = TOOLCHAIN_ROOT / "packages" / "bim-core" / "tests" / "fixtures" / "manifests"


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


def outcome(call: Callable[[], Any]) -> tuple:
    """How a call ended, as a comparable value: its result, or everything observable about the error."""
    try:
        return ("ok", call())
    except BimError as exc:
        return (
            "error",
            type(exc).__name__,
            exc.code,
            str(exc),
            exc.as_dict(),
            getattr(exc, "http_status", None),
            getattr(exc, "span", None),
        )


def stable(value: Any) -> Any:
    """Round every float to 12 significant digits, as the baseline goldens are written."""
    if isinstance(value, float):
        return float(format(value, ".12g"))
    if isinstance(value, dict):
        return {key: stable(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [stable(child) for child in value]
    return value
