"""The guiding case as Composition2Yaml, both versions, and the diff between them.

Phase F1 step 7. Version 1 is the phase gate made concrete: written as a composition and
compiled, it has to reproduce the IR digest of ``examples/demo/13_fms``, the package
already in the corpus. Version 2 has no package to reproduce -- it exists in no form in the
corpus, deliberately -- so it is proved by compiling and by what the diff says about it.

Both are fixtures and neither is a package. A ``.c2y.yaml`` inside a package directory is
refused as ``undeclared_resource`` on every compile, and adding a package to the tree would
move the counts asserted in fourteen places across three CI jobs. That constraint is what
shaped the whole phase, and ``test_goldens_unchanged.py`` already pins the half of it that
would bite first.

The last test is the one the whole phase was sequenced for: the diff between the two
versions says what actually changed between the two papers, and not that every identifier
is new.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition.diff import diff
from openbinding_gateway.composition.emit import emit
from openbinding_gateway.composition.text import parse, serialise

FIXTURES = Path(__file__).resolve().parent / "fixtures"
VERSION_1 = FIXTURES / "fleet-management-v1.c2y.yaml"
VERSION_2 = FIXTURES / "fleet-management-v2.c2y.yaml"
#: The package version 1 is written against.
TARGET = REPO_ROOT / "examples" / "demo" / "13_fms"


def _parse(path: Path):
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    return parse(path.read_text(encoding="utf-8"))


def _ir(files: dict[str, bytes]) -> str:
    try:
        from bim_core import compile_instance, ir_digest  # noqa: PLC0415
        from bim_core.package import InstancePackage  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    try:
        compiled = compile_instance(InstancePackage(files))
    except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    return ir_digest(compiled.document)


def test_version_one_reproduces_the_package_in_the_corpus() -> None:
    """The phase gate, on the one package the whole case is about."""
    if not (TARGET / "instance.json").is_file():
        pytest.skip(f"{TARGET} is not mounted in this environment")
    target = _ir({entry.name: entry.read_bytes() for entry in TARGET.iterdir() if entry.is_file()})
    assert _ir(emit(_parse(VERSION_1))) == target


def test_version_one_keeps_the_task_ids_verbatim() -> None:
    """Including the gap. Renumbering would move the digest of the reference package."""
    composition = _parse(VERSION_1)
    assert sorted(composition.tasks) == ["T1", "T2", "T3", "T5", "T6", "node_classic_routing"]
    assert "T4" not in composition.tasks
    source = VERSION_1.read_text(encoding="utf-8")
    assert "There is no T4" in source, (
        "the reason the gap exists has to travel with the ids, because this file is where "
        "the reader who would 'fix' it is looking"
    )


def test_version_one_states_no_task_name() -> None:
    """A task's name reaches the IR, measured, so the service names stay comments here."""
    composition = _parse(VERSION_1)
    named = {name for name, task in composition.tasks.items() if task.title is not None}
    # The one name the package itself carries, on the local task, is kept; the five
    # service names recovered from the ancestor commit are comments.
    assert named == {"node_classic_routing"}
    assert "Cloud Deployment" in VERSION_1.read_text(encoding="utf-8")


def test_version_two_compiles() -> None:
    """No golden of its own: that it compiles at all is the first thing to know."""
    assert _ir(emit(_parse(VERSION_2))).startswith("sha256-")


def test_version_two_models_the_paper_s_architecture() -> None:
    """Nine services, two of which are deliberately not tasks."""
    composition = _parse(VERSION_2)
    assert sorted(composition.tasks) == ["C", "D", "F", "L", "O", "Q", "T"]
    # R is the composition itself and M is the loop around the plan; neither is a task.
    assert "R" not in composition.tasks
    assert "M" not in composition.tasks
    # The studio block still names them, and is emitted nowhere.
    assert composition.studio["layers"]["optimization"] == ["R", "C", "Q"]
    assert composition.studio["layers"]["execution"] == ["M"]
    assert "studio" not in str(emit(composition)["application.json"])


def test_version_two_consults_compliance_twice_with_one_task() -> None:
    """One task placed twice binds both positions to the same candidate."""
    from openbinding_gateway.composition.diff import _invocations

    composition = _parse(VERSION_2)
    where = _invocations(composition.workflow)
    assert len(where["L"]) == 2, "the compliance service is consulted in phases 1 and 4"
    assert len(composition.candidates) == 6, "one task, so one market for it"


def test_both_fixtures_round_trip_through_the_text() -> None:
    for path in (VERSION_1, VERSION_2):
        composition = _parse(path)
        assert parse(serialise(composition)) == composition


def test_neither_fixture_sits_inside_a_package() -> None:
    """A composition source inside a package is refused on every compile of it."""
    assert FIXTURES.parent.name == "composition"
    assert not (FIXTURES / "instance.json").exists()


def test_the_diff_between_the_versions_says_what_changed() -> None:
    """What the phase was sequenced for: a report about the architecture, not the names.

    Every identifier really is new between these two versions -- they are different
    architectures from different papers -- so added and removed are the truth here. The
    point is that the verdict is earned: the same diff says ``renamed`` and ``moved`` when
    that is what happened, which is what the compare screen could not do.
    """
    changes = diff(_parse(VERSION_1), _parse(VERSION_2))
    by_section: dict[str, list] = {}
    for change in changes:
        by_section.setdefault(change.section, []).append(change)

    structure = next(c for c in by_section["workflow"] if c.subject == "structure")
    assert "parallel" in structure.now and "parallel" not in structure.was, (
        "version 2 gathers the world state at once; version 1 has no parallel block"
    )

    kinds = {c.kind for c in by_section["tasks"]}
    assert kinds <= {"added", "removed"}, "the two architectures share no task"
    assert any(c.subject == "C" and c.kind == "added" for c in by_section["tasks"])

    # The identity section carries the rename of the composition itself and its version.
    assert any(c.subject == "composition" and c.kind == "renamed" for c in by_section["identity"])

    # Version 2 adds a pricing reference, which no diff over the compiled package could
    # report: a pricing is Studio-side and has no destination in a package.
    assert any(c.subject == "pricing" for c in by_section["identity"])
