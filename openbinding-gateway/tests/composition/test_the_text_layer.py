"""The text layer's own property, and the one that matters once it has it.

Phase F1 step 3. Step 2 won the IR-digest gate with no text in sight, which is why this
file can hold the syntax to a property of its own:

    parse(serialise(m)) == m

over every model the gate produces. When this fails it is the syntax, never the
translation -- that is the whole reason the phase was sequenced this way.

The second test closes the loop the Studio actually needs: a composition written as text
compiles to the package it came from, digest for digest. Without it the first test would
prove only that the two halves of the syntax agree with each other, which they could do
while both drifting away from the translation.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from _repo import REPO_ROOT

GATE = 82


@pytest.fixture(scope="module")
def gate() -> list[str]:
    path = REPO_ROOT / "tools" / "check_composition_roundtrip.py"
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    try:
        import bim_core  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    spec = importlib.util.spec_from_file_location("_gate_for_text", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_gate_for_text"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_gate_for_text", None)
    members, _unrecorded = module.gate(REPO_ROOT)
    assert len(members) == GATE
    return members


def _files(package: str) -> dict[str, bytes]:
    directory = Path(REPO_ROOT / package)
    return {entry.name: entry.read_bytes() for entry in directory.iterdir() if entry.is_file()}


def _compile(files: dict[str, bytes]) -> dict:
    """The compiler, injected rather than imported: the BPMN package is read through it."""
    from bim_core import compile_instance  # noqa: PLC0415
    from bim_core.package import InstancePackage  # noqa: PLC0415

    return compile_instance(InstancePackage(files)).document


def test_the_text_round_trips_every_gate_model(gate: list[str]) -> None:
    """``parse(serialise(m)) == m``, model for model."""
    from openbinding_gateway.composition.read import import_bim
    from openbinding_gateway.composition.text import parse, serialise

    failed = []
    for package in gate:
        model = import_bim(_files(package), compile=_compile)
        back = parse(serialise(model))
        if back != model:
            differing = sorted(
                name for name in model.__dataclass_fields__
                if getattr(model, name) != getattr(back, name)
            )
            failed.append(f"{package}: {differing}")
    assert not failed, "\n".join(failed)


def test_a_composition_written_as_text_reproduces_its_package(gate: list[str]) -> None:
    """The loop the Studio needs: text in, the same compiled problem out.

    ``ir_digest(compile(emit(parse(serialise(import_bim(d)))))) == ir_digest(compile(d))``.
    """
    from bim_core import compile_instance, ir_digest
    from bim_core.package import InstancePackage

    from openbinding_gateway.composition.emit import emit
    from openbinding_gateway.composition.read import import_bim
    from openbinding_gateway.composition.text import parse, serialise

    failed = []
    for package in gate:
        original = _files(package)
        try:
            before = ir_digest(compile_instance(InstancePackage(original)).document)
            through_text = parse(serialise(import_bim(original, compile=_compile)))
            after = ir_digest(compile_instance(InstancePackage(emit(through_text))).document)
        except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
            pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
        except Exception as error:  # noqa: BLE001 - a failure is a result here
            failed.append(f"{package}: {type(error).__name__}: {error}")
            continue
        if before != after:
            failed.append(f"{package}: {before[:24]} -> {after[:24]}")
    assert not failed, "\n".join(failed)


def test_the_text_states_the_policy_and_omits_the_defaults() -> None:
    """What the surface writes, and what it leaves to the parser.

    A template is authoring sugar with no trace in the model, so the writer always states
    the aggregation rather than guessing which template an author started from -- which is
    why a round trip through the Visual editor normalizes the text, a cost section 12
    records rather than hides.
    """
    from openbinding_gateway.composition.model import (
        Aggregation,
        Composition,
        Domain,
        Goal,
        Normalize,
        OpenTask,
        Property,
        Sequence,
        TaskNode,
    )
    from openbinding_gateway.composition.text import parse, serialise

    model = Composition(
        composition="c",
        version="1.0.0",
        properties={
            "cost": Property(
                unit="USD/month",
                direction="minimize",
                aggregation=Aggregation("sum", "sum", "weightedSum", "scale", "sum"),
                domain=Domain("real", 0.0, 100.0),
            ),
        },
        tasks={"t": OpenTask(requires="service/t")},
        workflow=Sequence((TaskNode("t"),)),
        goals=(Goal("cost", normalize=Normalize(0.0, 100.0)),),
    )
    text = serialise(model)
    # The defaults the model already carries are not written out.
    assert "scope:" not in text
    assert "applies_to:" not in text
    assert "kind:" not in text
    assert "clamp:" not in text
    # The policy always is, in full, so a partial block can never be mistaken for one.
    assert "aggregate:" in text
    assert text.count("selection:") == 1
    assert "template:" not in text
    assert parse(text) == model
