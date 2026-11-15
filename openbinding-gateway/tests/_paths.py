"""Where the gateway project and its tests are, for tests that look at the gateway's own files.

Anything in the repository outside the gateway (``examples``, ``frontend``, ``engines``, ``schemas``, the
compose files) is found through ``_repo.REPO_ROOT``, which honours ``OPENBINDING_REPO_ROOT``. The gateway
project itself (``pyproject.toml``, ``src``, ``tools``, ``alembic``) always sits right above ``tests``, in a
checkout and in the gateway container alike, so it is located from here and does not need the rest of the
repository to be present. ``tests/test_no_file_relative_repo_paths.py`` keeps every other test from counting
directories up from its own file.
"""

from __future__ import annotations

from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
GATEWAY_ROOT = TESTS_DIR.parent
TOOLS_DIR = GATEWAY_ROOT / "tools"


def gateway_tool(name: str):
    """A module of the gateway's ``tools/`` (which is not a package), imported by file name."""
    import importlib.util
    import sys

    qualified = f"gateway_tool_{name}"
    if qualified in sys.modules:
        return sys.modules[qualified]
    spec = importlib.util.spec_from_file_location(qualified, TOOLS_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[qualified] = module
    spec.loader.exec_module(module)
    return module
