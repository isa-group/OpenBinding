"""The phase F1 gate, run: every package the language claims to express survives emission.

For each package of section 11.2's gate,
``ir_digest(compile(emit(import_bim(d)))) == ir_digest(compile(d))``.

This runs the same tool CI runs, ``tools/check_composition_roundtrip.py``, rather than
restating its logic: a gate asserted twice in two places is a gate that can disagree with
itself. The tool defines the gate by the rule that makes it -- the live normalized golden's
packages, minus those declaring a Placement resource -- so adding a package to the tree
shows up here as a membership change rather than as a number nobody can recompute.

It compares IR digests, so it says nothing about bytes: a package's own annotations do not
survive the trip and are not meant to. ``test_emit_reproduces_a_package.py`` stays at one
hand-written composition on purpose, so that when this test fails it is clear whether the
emitter or the importer is at fault.
"""

from __future__ import annotations

import importlib.util
import sys

import pytest

from _repo import REPO_ROOT

#: Section 11.2's gate size. The tool fails on its own if the gate stops holding this many,
#: which is the tripwire for a package added to or removed from the tree.
GATE = 75
#: The one package the walk finds and the golden does not hold: the compiler's own fixture.
NOT_A_TARGET = "bim-toolchain/packages/bim-core/tests/fixtures/example-package"


@pytest.fixture(scope="module")
def tool():
    path = REPO_ROOT / "tools" / "check_composition_roundtrip.py"
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    try:
        import bim_core  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    spec = importlib.util.spec_from_file_location("_roundtrip_gate", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_roundtrip_gate"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_roundtrip_gate", None)
    return module


def test_the_gate_is_the_golden_minus_placement(tool) -> None:
    members, excluded, unrecorded = tool.gate(REPO_ROOT)
    assert len(members) == GATE
    assert len(excluded) == 7
    assert unrecorded == [NOT_A_TARGET]
    assert not set(members) & set(excluded)


def test_every_gate_package_reproduces_its_ir_digest(tool) -> None:
    members, _excluded, _unrecorded = tool.gate(REPO_ROOT)
    failed = []
    for package in members:
        result = tool.roundtrip(REPO_ROOT, package)
        if not result["ok"]:
            failed.append((package, result.get("error") or f"{result['before']} -> {result['after']}"))
    assert not failed, "\n".join(f"{package}: {reason}" for package, reason in failed)
