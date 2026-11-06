"""The Studio's neutral rule must agree with the container's, for the whole corpus.

This is the single guard that keeps the explicit neutral values of the Studio compiler
from drifting away from the container's feature normalization. It matters because the
drift is silent: a wrong neutral produces a package that compiles, validates and digests,
and whose binding evaluations are all slightly wrong.

The rule lives in two places by necessity. The container infers a neutral when a source
omits it; the Studio writes one explicitly, so that a candidate for a property that does
not apply to it carries a value at all -- the deterministic profile performs no
imputation. Writing it explicitly is only safe while the two agree, and the only honest
way to know that is to compare them over every feature of every package in the corpus.

The comparison needs the compiler, and the compiler needs the five OMG BPMN XSDs, which
this repository deliberately does not version. The test therefore skips outside the
container image, where they are present; it runs unconditionally in CI.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition.neutral import Unbounded, infer_neutral

#: The example the authoring guide tells an author to start from, used only to find out
#: whether this environment can compile at all.
PROBE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"


def _corpus_tool():
    """The discovery and non-entry rules CI uses, loaded from the tool CI runs.

    Reusing the tool rather than restating its rules matters for one case in particular:
    the toolchain's example package deliberately carries a binding beside it that is not
    an entry of it, and the tool strips exactly that before compiling.
    """
    path = REPO_ROOT / "tools" / "check_bim_corpus.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location("_check_bim_corpus", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_check_bim_corpus"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_check_bim_corpus", None)
    return module


TOOL = _corpus_tool()
PACKAGES = list(TOOL.package_directories(REPO_ROOT)) if TOOL else []


def _compile(directory: Path):
    """Compile one corpus package exactly as the corpus check does."""
    from bim_core import InstancePackage, compile_instance, load_package

    package = load_package(directory)
    ignored = TOOL.NON_ENTRY_FILES.get(directory.relative_to(REPO_ROOT), frozenset())
    if ignored:
        package = InstancePackage(
            {name: data for name, data in package.files.items() if name not in ignored}
        )
    return compile_instance(package)


def _application_source(directory: Path) -> dict | None:
    """The source Application document of a package, read straight from disk.

    The point of this test is to compare the *source* aggregation and domain against the
    *compiled* neutral, so the source has to be read rather than taken from the IR.
    """
    instance = json.loads((directory / "instance.json").read_text(encoding="utf-8"))
    resources = instance.get("spec", {}).get("resources", {}).get("application") or {}
    for resource in resources.values():
        if not isinstance(resource, str) or not resource.endswith(".json"):
            continue
        document = json.loads((directory / resource).read_text(encoding="utf-8"))
        if document.get("kind") == "Application":
            return document
    return None


@pytest.fixture(scope="module")
def compiler():
    try:
        import bim_core  # noqa: F401
    except ImportError:  # pragma: no cover - the container always has it
        pytest.skip("bim_core is not importable in this environment")
    if PROBE.is_dir():
        try:
            _compile(PROBE)
        except FileNotFoundError as exc:
            pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    return _compile


def test_the_corpus_was_discovered() -> None:
    """A silent empty corpus would make every assertion below vacuously true."""
    assert TOOL is not None, "tools/check_bim_corpus.py is not mounted in this environment"
    assert PACKAGES, "no corpus packages were discovered"


@pytest.mark.parametrize("directory", PACKAGES, ids=lambda d: d.name)
def test_inferred_neutral_equals_the_compiled_one(directory: Path, compiler) -> None:
    source = _application_source(directory)
    if source is None:
        pytest.skip("package declares no Application resource")
    declared_features = source.get("spec", {}).get("features") or {}
    if not declared_features:
        pytest.skip("package declares no features")

    features = compiler(directory).document["spec"]["application"]["features"]

    for feature_id, declared in declared_features.items():
        if not isinstance(declared, dict):
            continue
        assert feature_id in features, f"{feature_id} is missing from the compiled features"
        expected = features[feature_id]["neutral"]
        if declared.get("neutral") is not None:
            # A declared neutral is copied through; this test is about the inference.
            assert float(declared["neutral"]) == pytest.approx(expected)
            continue
        try:
            actual = infer_neutral(declared.get("aggregation"), declared.get("domain"))
        except Unbounded as exc:  # pragma: no cover - no corpus package is unbounded
            pytest.fail(
                f"{directory.name}/{feature_id}: the Studio refuses a neutral the compiler "
                f"inferred as {expected} ({exc})"
            )
        assert actual == pytest.approx(expected), (
            f"{directory.name}/{feature_id}: the Studio infers {actual}, the compiler {expected}"
        )
