"""The two facts specification section 13 decides on, asserted against the container.

Section 13 settles that Composition2Yaml ships as a real, installed, JSON-only Dialect,
and that the notation marker it makes room for is written only when the composition has no
existing package to reproduce. Those are two decisions because they have two prices, and
both prices are one line of the container's IR digest function:

* it strips ``spec.dialects``, so naming the dialect costs nothing;
* it keeps ``spec.extensions``, so the marker moves the digest and cannot be written when
  the phase F1 gate is digest equality with an existing package (section 11.2).

The earlier draft bundled the two into "never enters ``spec.dialects`` and never moves a
digest", as if one implied the other. Nothing enforced the difference, and the shortcut it
justified -- a descriptor that is never installed -- turned out to have nowhere to be
recorded at all: the IR's ``spec`` is closed over a fixed set of members and its
``metadata`` admits only a name.

This test needs the compiler only to obtain one real IR document. It installs nothing: a
process-wide dialect install is visible to every other test in the session, and one of the
container's own tests asserts that every installed dialect's version tracks the compiler
bundle digest, which a host-installed dialect does not do.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

from _repo import REPO_ROOT

PROBE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"

#: The members the container's IR digest drops. ``metadata`` goes whole; the other three
#: are spec members. Section 13 and section 9 both reason from this list.
STRIPPED = ("metadata", "instance", "dialects", "sourceMap")


def _compiler():
    try:
        from bim_core import compiler  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    return compiler


@pytest.fixture(scope="module")
def ir() -> dict:
    """One compiled IR document, from the package the authoring guide starts with."""
    compiler = _compiler()
    if not (PROBE / "instance.json").is_file():
        pytest.skip(f"{PROBE} is not mounted in this environment")
    path = REPO_ROOT / "tools" / "check_bim_corpus.py"
    if not path.is_file():
        pytest.skip("tools/check_bim_corpus.py is not mounted in this environment")
    spec = importlib.util.spec_from_file_location("_corpus_for_dialect", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_corpus_for_dialect"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_corpus_for_dialect", None)
    try:
        from bim_core.package import InstancePackage  # noqa: PLC0415

        files = {
            entry.name: entry.read_bytes()
            for entry in Path(PROBE).iterdir()
            if entry.is_file()
        }
        compiled = compiler.compile_instance(InstancePackage(files))
    except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    document = getattr(compiled, "document", compiled)
    assert "application" in document["spec"]
    return deepcopy(document)


def test_the_ir_digest_drops_exactly_the_provenance_members(ir: dict) -> None:
    """The list section 13 reasons from, read off the function rather than the prose."""
    compiler = _compiler()
    source = Path(compiler.__file__).read_text(encoding="utf-8")
    body = source.split("def ir_digest(")[1].split("\ndef ")[0]
    for member in STRIPPED:
        assert f'"{member}"' in body, f"ir_digest no longer mentions {member}"
    assert '"extensions"' not in body, (
        "ir_digest now mentions extensions; section 13's marker rule rests on it NOT being "
        "stripped, so the rule has to be re-decided"
    )
    assert '"profile"' not in body, (
        "ir_digest now strips spec.profile; section 13 prices the schema discriminator on "
        "the profile being kept"
    )


def test_naming_the_dialect_costs_nothing(ir: dict) -> None:
    """A descriptor appended to spec.dialects leaves the IR digest where it was."""
    compiler = _compiler()
    before = compiler.ir_digest(ir)
    named = deepcopy(ir)
    named["spec"].setdefault("dialects", []).append({
        "namespace": "studio",
        "id": "composition2yaml/v1",
        "version": "1.0.0",
        "digest": "sha256-" + "0" * 64,
        "irFeatures": [{"dimension": "irExtensions", "value": "composition2yaml/v1"}],
        "adapter": {"id": "c2y", "version": "1.0.0", "digest": "sha256-" + "1" * 64},
    })
    assert compiler.ir_digest(named) == before


def test_the_notation_marker_moves_the_digest(ir: dict) -> None:
    """So a composition reproducing an existing package is compiled without it."""
    compiler = _compiler()
    before = compiler.ir_digest(ir)
    marked = deepcopy(ir)
    marked["spec"].setdefault("extensions", {})["composition2yaml/v1"] = {
        "inline": {"application:/spec": {"notation": "composition2yaml/v1"}},
    }
    assert compiler.ir_digest(marked) != before, (
        "the notation marker no longer moves the IR digest; if extensions became "
        "informative, section 13 can write the marker unconditionally and should say so"
    )
    assert compiler.ir_digest(marked) == compiler.ir_digest(deepcopy(marked)), "not a pure function"


def test_the_ir_has_nowhere_to_record_an_uninstalled_descriptor() -> None:
    """Why the virtual dialect was rejected: a BindingProblem has no slot for it.

    ``spec`` is closed and ``metadata`` admits only a name, so "recorded in provenance but
    never installed" could only ever have meant "recorded outside the IR" -- which is the
    loss it was offered as a remedy for.
    """
    compiler = _compiler()
    schemas = Path(compiler.__file__).parent / "resources" / "schemas" / "bim" / "v1"
    path = schemas / "binding-problem.schema.json"
    if not path.is_file():
        pytest.skip(f"{path} is not in this environment")
    schema = json.loads(path.read_text(encoding="utf-8"))
    spec = schema["properties"]["spec"]
    assert spec.get("additionalProperties") is False
    metadata = schema["properties"]["metadata"]
    assert metadata.get("additionalProperties") is False
    assert set(metadata["properties"]) == {"name"}, (
        "the IR's metadata now admits more than a name; the annotation route section 13 "
        "rejects may have become available and the section needs re-reading"
    )
