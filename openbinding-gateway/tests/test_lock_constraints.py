"""The image installs what the lock records, and this is the rule that makes it so.

``tools/lock_constraints.py`` turns ``uv.lock`` into a pip constraints file for the
Dockerfile's single install command. Before it, the image resolved every range in
``pyproject.toml`` afresh against the index while CI installed with ``uv sync --locked``,
so the container drifted away from the versions CI tests: measured, ``space-python-client``
1.1.0 against a locked 1.0.0, FastAPI 0.162.0 against 0.141.1, SQLAlchemy 2.1.8 against
2.0.51.

The assertions below are about the rule, not about today's versions: a lock is bumped on
purpose and a test that pinned its contents would fail for the wrong reason. What must not
change silently is which entries get a pin -- an editable path has no registry version to
constrain, and a name the lock records twice behind environment markers has no single
version a constraints file could express.
"""

from __future__ import annotations

import collections
import importlib.util
import sys
import tomllib
from pathlib import Path

import pytest

GATEWAY = Path(__file__).resolve().parent.parent
SCRIPT = GATEWAY / "tools" / "lock_constraints.py"
LOCK = GATEWAY / "uv.lock"


def _module():
    if not SCRIPT.is_file():
        pytest.skip(f"{SCRIPT} is not mounted in this environment")
    spec = importlib.util.spec_from_file_location("_lock_constraints", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_lock_constraints"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_lock_constraints", None)
    return module


SAMPLE = {
    "package": [
        {"name": "fastapi", "version": "0.141.1", "source": {"registry": "https://pypi.org/simple"}},
        {"name": "alembic", "version": "1.18.5", "source": {"registry": "https://pypi.org/simple"}},
        # Installed from a path inside the image: no registry version to pin.
        {"name": "bim-core", "version": "0.2.0", "source": {"editable": "../bim-toolchain/packages/bim-core"}},
        {"name": "openbinding-gateway", "version": "0.1.0", "source": {"editable": "."}},
        # Two versions behind environment markers: a constraints file cannot say "either".
        {"name": "numpy", "version": "2.2.6", "source": {"registry": "https://pypi.org/simple"}},
        {"name": "numpy", "version": "2.4.6", "source": {"registry": "https://pypi.org/simple"}},
    ],
}


def test_a_registry_package_is_pinned_and_a_path_package_is_not() -> None:
    pins, ambiguous, editable = _module().constraints(SAMPLE)
    assert pins == ["alembic==1.18.5", "fastapi==0.141.1"], "pins must be sorted and registry-only"
    assert ambiguous == ["numpy"]
    assert sorted(editable) == ["bim-core", "openbinding-gateway"]


def test_the_pins_are_sorted_whatever_the_lock_order_is() -> None:
    """The constraints file is a build input, so it is a pure function of the lock."""
    module = _module()
    reversed_lock = {"package": list(reversed(SAMPLE["package"]))}
    assert module.constraints(reversed_lock)[0] == module.constraints(SAMPLE)[0]


def test_pinning_nothing_is_refused_rather_than_written(tmp_path: Path) -> None:
    """An empty constraints file would silently restore the drift this exists to stop."""
    module = _module()
    empty = tmp_path / "uv.lock"
    empty.write_text('version = 1\n\n[[package]]\nname = "bim-core"\nversion = "0.2.0"\n'
                     '[package.source]\neditable = "../bim-toolchain/packages/bim-core"\n',
                     encoding="utf-8")
    out = tmp_path / "constraints.txt"
    assert module.main([str(empty), "-o", str(out)]) == 1
    assert not out.exists()


def test_the_real_lock_pins_every_registry_package_it_can() -> None:
    """Structural, so a deliberate lock bump does not fail here."""
    if not LOCK.is_file():
        pytest.skip(f"{LOCK} is not mounted in this environment")
    module = _module()
    lock = tomllib.loads(LOCK.read_text(encoding="utf-8"))
    pins, ambiguous, editable = module.constraints(lock)

    packages = lock["package"]
    seen = collections.Counter(entry["name"] for entry in packages)
    expected = {
        entry["name"]
        for entry in packages
        if "registry" in (entry.get("source") or {}) and seen[entry["name"]] == 1
    }
    assert {pin.split("==")[0] for pin in pins} == expected
    assert pins, "the lock pinned nothing"

    # The gateway, bim-core and bim-client are the editable entries; they are installed
    # from paths copied into the image, which is why the Dockerfile keeps --no-sources.
    assert "openbinding-gateway" in editable
    assert not {name for name in ("bim-core", "bim-client")} - set(editable)
    for name in (*ambiguous, *editable):
        assert all(not pin.startswith(f"{name}==") for pin in pins)
