"""Pytest hooks that put the five OMG BPMN 2.0.2 XSDs in place before a session that runs the suites of the toolchain.

The repository does not version the files, and ``bim_core`` does not download anything when it is used (that would
change ``compilerDigest``), so the session that exercises it does: ``pytest_sessionstart`` runs the verified download
(``xsd_inventory.ensure``) when a file is missing or is not the declared bytes, and does nothing when the five are there.
Without network the session stops with the exact command to run.

A conftest enables it with::

    from xsd_session import pytest_report_header, pytest_sessionstart  # noqa: F401

A session whose arguments are all outside the toolchain (the gateway tests, say) does not need the files and is left
alone; ``BIM_XSD_SESSION=skip`` turns the hooks off for a run that does not need them.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import xsd_inventory  # noqa: E402

SKIP_ENV = "BIM_XSD_SESSION"
#: What this process did for each root: ``present`` or ``downloaded`` (the hooks of several conftests run once).
_STATE: dict[Path, str] = {}
_REPORTED: set[Path] = set()


def inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def session_needs_xsd(args: list[str], invocation_dir: Path, root: Path = ROOT) -> bool:
    """Whether a session started with ``args`` from ``invocation_dir`` runs anything of the toolchain at ``root``."""
    if not args:
        return inside(invocation_dir.resolve(), root.resolve()) or inside(root.resolve(), invocation_dir.resolve())
    for argument in args:
        path = Path(argument.split("::", 1)[0])
        path = (path if path.is_absolute() else invocation_dir / path).resolve()
        if inside(path, root.resolve()):
            return True
    return False


def ensure_for_session(root: Path = ROOT) -> str:
    """``present`` or ``downloaded``, once per process and root; ``xsd_inventory.FetchError`` if the files cannot be had."""
    if root not in _STATE:
        _STATE[root] = "downloaded" if xsd_inventory.ensure(root) else "present"
    return _STATE[root]


def pytest_sessionstart(session: Any) -> None:
    config = session.config
    if os.environ.get(SKIP_ENV) == "skip":
        return
    # ``config.args`` are the paths the session collects (the positional arguments, or ``testpaths``, or the directory).
    if not session_needs_xsd([str(item) for item in config.args], Path(config.invocation_params.dir)):
        return
    try:
        ensure_for_session()
    except xsd_inventory.FetchError as exc:
        raise pytest.UsageError(f"the OMG BPMN 2.0.2 XSDs are required by this session:\n{exc}") from exc


def pytest_report_header(config: Any) -> list[str] | None:
    state = _STATE.get(ROOT)
    if state is None or ROOT in _REPORTED:
        return None
    _REPORTED.add(ROOT)
    return [f"omg bpmn xsd: {'downloaded now and ' if state == 'downloaded' else ''}verified (SHA-256, 5 files)"]
