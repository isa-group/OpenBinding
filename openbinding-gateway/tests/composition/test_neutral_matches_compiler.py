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


def _corpus_packages() -> list[Path]:
    """The corpus as CI discovers it, by loading the same tool CI runs."""
    tool = REPO_ROOT / "tools" / "check_bim_corpus.py"
    if not tool.is_file():
        return []
    spec = importlib.util.spec_from_file_location("_check_bim_corpus", tool)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_check_bim_corpus"] = module
    try:
        spec.loader.exec_module(module)
        return list(module.package_directories(REPO_ROOT))
    finally:
        sys.modules.pop("_check_bim_corpus", None)


def _application_source(directory: Path) -> dict | None:
    """The source Application document of a package, read straight from disk.

    The point of this test is to compare the *source* aggregation and domain against the
    *compiled* neutral, so the source has to be read rather than taken from the IR.
    """
    instance = json.loads((directory / "instance.json").read_text(encoding="utf-8"))
    for resource in (instance.get("spec", {}).get("resources", {}).get("application") or {}).values():
        if not isinstance(resource, str) or not resource.endswith(".json"):
            continue
        document = json.loads((directory / resource).read_text(encoding="utf-8"))
        if document.get("kind") == "Application":
            return document
    return None


PACKAGES = _corpus_packages()


@pytest.fixture(scope="module")
def compiler():
    try:
        from bim_core import compile_instance, load_package
    except ImportError:  # pragma: no cover - the container always has it
        pytest.skip("bim_core is not importable in this environment")
    try:
        compile_instance(load_package(PACKAGES[0]))
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    return compile_instance, load_package


def test_the_corpus_was_discovered() -> None:
    """A silent empty corpus would make every assertion below vacuously true."""
    assert PACKAGES, "no corpus packages were discovered"


@pytest.mark.parametrize("directory", PACKAGES, ids=lambda d: d.name)
def test_inferred_neutral_equals_the_compiled_one(directory: Path, compiler) -> None:
    compile_instance, load_package = compiler
    source = _application_source(directory)
    if source is None:
        pytest.skip("package declares no Application resource")

    compiled = compile_instance(load_package(directory))
    features = compiled.document["spec"]["application"]["features"]

    for feature_id, declared in (source.get("spec", {}).get("features") or {}).items():
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
