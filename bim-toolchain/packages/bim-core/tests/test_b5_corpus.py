"""Migrated from openbinding-gateway/tests/test_b5_corpus.py (language side).

Open ranges work in several corpus packages and malformed ranges are rejected.  The whole-corpus
compilation check of the original (``tools/check_bim_corpus.py``) is covered by
``test_baseline_equivalence.py``; the scalar-Engine refusal checks need the platform's Engine manifests and
stay in OpenBinding (see docs/EXTRACTION_LOG.md).
"""

from __future__ import annotations

import json

import pytest

from bim_core import CompileError, compile_instance, load_package
from core_support import require_corpus_path

DEMOS = ["01_simple_seq", "02_parallel", "05_multi_obj"]
OPEN_RANGES = {
    "upper-open": lambda original: {"min": original, "max": None},
    "lower-open": lambda original: {"min": None, "max": original},
    "both-open": lambda original: {"min": None, "max": None},
}


def with_range(name: str, make):
    package = load_package(require_corpus_path(f"examples/demo/{name}"))
    catalog = json.loads(package.files["candidates.json"])
    first = next(iter(catalog["spec"]["candidates"].values()))
    alias = next(iter(first["features"]))
    first["features"][alias] = make(first["features"][alias])
    package.files["candidates.json"] = json.dumps(catalog).encode()
    return package, first["features"][alias]


@pytest.mark.parametrize("kind", sorted(OPEN_RANGES))
@pytest.mark.parametrize("name", DEMOS)
def test_corpus_packages_with_an_open_range_compile_and_keep_it_in_the_ir(name, kind):
    package, expected = with_range(name, OPEN_RANGES[kind])
    problem = compile_instance(package)
    catalog = next(iter(problem.document["spec"]["candidates"].values()))
    first = next(iter(catalog["candidates"].values()))

    assert expected in first["features"].values()
    assert None in expected.values()


@pytest.mark.parametrize(
    "bad",
    [{"min": 1}, {"min": "inf", "max": None}, {"min": None, "max": None, "extra": 1}, None],
    ids=["max-missing", "string-inf", "extra-key", "null-scalar"],
)
@pytest.mark.parametrize("name", DEMOS)
def test_corpus_packages_with_a_malformed_range_are_rejected(name, bad):
    package, _ = with_range(name, lambda original: bad)
    with pytest.raises(CompileError) as captured:
        compile_instance(package)

    assert any(item.code == "schema" for item in captured.value.diagnostics)
