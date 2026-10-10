"""B5: the complete checked-in BIM corpus still compiles and open ranges work in several of its packages."""

from __future__ import annotations

import importlib.util
import json

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.compiler import CompileError, compile_instance
from openbinding_gateway.v1.package import load_package

DEMOS = ["01_simple_seq", "02_parallel", "05_multi_obj"]
OPEN_RANGES = {
    "upper-open": lambda original: {"min": original, "max": None},
    "lower-open": lambda original: {"min": None, "max": original},
    "both-open": lambda original: {"min": None, "max": None},
}


def load_corpus_tool():
    path = REPO_ROOT / "tools" / "check_bim_corpus.py"
    spec = importlib.util.spec_from_file_location("check_bim_corpus_b5", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_complete_corpus_still_compiles_with_the_same_package_count():
    tool = load_corpus_tool()
    directories = tool.package_directories()

    assert len(directories) == 82
    failures = []
    for directory in directories:
        name, package_digest, error = tool.compile_one(directory)
        if error or not package_digest:
            failures.append((name, error))
    assert failures == []


def test_an_instance_json_under_frontend_is_not_counted_as_a_corpus_package():
    tool = load_corpus_tool()
    fixture = REPO_ROOT / "frontend" / "src" / "test" / "fixtures" / "bim-package"
    assert (fixture / "instance.json").is_file()

    assert fixture not in tool.package_directories()
    assert not any(REPO_ROOT / "frontend" in directory.parents for directory in tool.package_directories())


def test_package_directories_skips_excluded_roots(tmp_path):
    tool = load_corpus_tool()
    for relative in ["kept/pkg", "frontend/fixture", "frontend/node_modules/dep"]:
        (tmp_path / relative).mkdir(parents=True)
        (tmp_path / relative / "instance.json").write_text("{}", encoding="utf-8")

    found = tool.package_directories(tmp_path, {tmp_path / "frontend"})

    assert found == [tmp_path / "kept" / "pkg"]


def with_range(name: str, make):
    package = load_package(REPO_ROOT / "examples/demo" / name)
    catalog = json.loads(package.files["candidates.json"])
    first = next(iter(catalog["spec"]["candidates"].values()))
    alias = next(iter(first["features"]))
    first["features"][alias] = make(first["features"][alias])
    package.files["candidates.json"] = json.dumps(catalog).encode()
    return package, first["features"][alias]


def scalar_engine_modes():
    manifests = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(routes._MANIFEST_DIR.glob("*.json"))]
    return [mode for manifest in manifests for mode in manifest["spec"]["modes"]]


@pytest.mark.parametrize("kind", sorted(OPEN_RANGES))
@pytest.mark.parametrize("name", DEMOS)
def test_corpus_packages_with_an_open_range_compile_and_scalar_engines_refuse_them(name, kind):
    package, expected = with_range(name, OPEN_RANGES[kind])
    problem = compile_instance(package)
    catalog = next(iter(problem.document["spec"]["candidates"].values()))
    first = next(iter(catalog["candidates"].values()))

    assert expected in first["features"].values()
    assert None in expected.values()
    assert routes._ir_features(problem)["featureValues"] >= {"interval"}
    modes = scalar_engine_modes()
    assert modes
    for mode in modes:
        refusals = [
            item
            for item in routes._mode_compatibility(problem, mode)
            if item.get("category") == "featureValues"
        ]
        assert [item["code"] for item in refusals] == ["unsupported_capability_value"]


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
