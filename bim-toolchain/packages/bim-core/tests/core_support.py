"""Shared helpers: where the OpenBinding corpus lives and how to load the baseline tool.

They used to live in ``conftest.py`` and the tests imported them with ``from conftest import ...``.  That only works while
``conftest`` names one module; the service and client suites have conftests too and run in the same pytest
session, so the helpers have a name of their own.  ``conftest.py`` keeps the fixtures.
"""

from __future__ import annotations

import os
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


MANIFEST_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "manifests"


def engine_manifest_fixtures() -> dict[str, dict]:
    """The Engine manifests (copies of ``schemas/bim/v1/manifests`` of OpenBinding) used as test inputs."""
    import json

    if not MANIFEST_FIXTURES.is_dir():
        pytest.skip(f"{MANIFEST_FIXTURES} is missing: run the manifests bootstrap check first")
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(MANIFEST_FIXTURES.glob("*.json"))
    }


def check_or_create_golden(baseline_tool, path: Path, document) -> None:
    """Compare ``document`` with the golden at ``path``; create the golden if there is none yet.

    The goldens without an OpenBinding original (``golden/bim_core``, ``golden/vectors_extra.json``) are
    regression pins of the output of this very toolchain, so a missing one is written, never replaced, and
    the test fails once to say so: the new file must be reviewed and committed.  Delete a golden to
    regenerate it.  Whether the content is *right* is established by the tests that compare it with an
    independent source (the OpenBinding goldens, hand-written expectations).
    """
    data = baseline_tool.dump(document)
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        pytest.fail(f"golden {path.relative_to(TOOLCHAIN_ROOT)} did not exist and was created: review and commit it")
    import json

    # ``toolchain`` fields change with every edit of the code on purpose and are never compared.
    found = baseline_tool.comparable(json.loads(data))
    expected = baseline_tool.comparable(json.loads(path.read_text(encoding="utf-8")))
    assert found == expected, f"{path.name} differs from {path.relative_to(TOOLCHAIN_ROOT)}"
