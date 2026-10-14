from __future__ import annotations

import importlib.util
import json

import pytest

from _repo import REPO_ROOT
from bim_core import compile_instance, load_package
from openbinding_gateway.integrations import packages


TOOL = REPO_ROOT / "tools" / "check_bim_conciseness.py"
if not TOOL.is_file():
    TOOL = REPO_ROOT / "repository-tools" / "check_bim_conciseness.py"

#: The evidence that the previous toolchain (IR lists in document order) left, by identifier.
PREVIOUS_EVIDENCE = REPO_ROOT / "bim-toolchain" / "golden" / "ir_previous" / "evidence.json"


def _load_tool():
    spec = importlib.util.spec_from_file_location("check_bim_conciseness", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # In Compose the repository tool directory is mounted beside the gateway's
    # own tools directory, while its benchmark packages still live under the
    # configured repository root.
    module.BENCHMARKS = TOOL.with_name("bim_conciseness_benchmarks.json")
    return module


def _cases(tool) -> dict:
    return json.loads(tool.BENCHMARKS.read_text(encoding="utf-8"))["cases"]


def test_representative_bim_packages_are_at_least_fifty_percent_more_concise() -> None:
    report = _load_tool().run_benchmarks()

    assert report["ok"], {name: result["errors"] for name, result in report["cases"].items() if result["errors"]}
    assert set(report["cases"]) == {"sequence", "xor", "placement", "soft-multiobjective"}
    for result in report["cases"].values():
        assert result["reduction"] >= 0.5
        assert not result["errors"]


def test_the_authoring_sizes_do_not_depend_on_the_order_of_the_ir() -> None:
    """The metric counts the semantic control fields the author writes (`expectedControls`, against the audited
    `baseline`), not the IR: the sizes are the same and the reduction is the same as before the IR was ordered."""
    tool = _load_tool()
    sizes = {
        name: (sum(case["baseline"].values()), case["expectedControls"]) for name, case in _cases(tool).items()
    }

    assert sizes == {
        "sequence": (12, 4),
        "xor": (13, 6),
        "placement": (62, 29),
        "soft-multiobjective": (69, 34),
    }
    report = tool.run_benchmarks()
    for name, (baseline, current) in sizes.items():
        assert report["cases"][name]["current"] == current
        assert report["cases"][name]["reduction"] == pytest.approx((baseline - current) / baseline)


def test_the_projection_digest_does_not_depend_on_how_the_package_is_serialized() -> None:
    """The tool digests the projection with `json.dumps(sort_keys, separators)`, which is not the canonical JSON
    (RFC 8785) of `bim_core`: it writes `30.0` where the canonical form writes `30`, so a pin follows the number
    model of the IR (an integral JSON number such as `6.0` is read as the integer `6` since `bim-core` 0.2.0).
    What a pin must not follow is the package's serialization: the directory, the raw ZIP the platform builds and
    the canonical ZIP (`to_zip()`, where `6.0` is already written `6`) give the same IR, hence the same pin."""
    tool = _load_tool()
    for name, case in _cases(tool).items():
        directory = REPO_ROOT / case["package"]
        reference = load_package(directory)
        digests = {
            "directory": tool._projection_digest(compile_instance(reference).document),
            "raw-zip": tool._projection_digest(compile_instance(load_package(packages.zip_directory(directory))).document),
            "canonical-zip": tool._projection_digest(compile_instance(load_package(reference.to_zip())).document),
        }

        assert len(set(digests.values())) == 1, (name, digests)


def test_the_projection_has_the_members_of_the_previous_ir() -> None:
    """The pins of `placement` and `soft-multiobjective` changed because the sets of their IR are listed in order of
    identifier, not because a member changed: with every list's order forgotten, the projection is the previous one."""
    tool = _load_tool()
    baseline_path = REPO_ROOT / "bim-toolchain" / "tools" / "baseline_core.py"
    if not (baseline_path.is_file() and PREVIOUS_EVIDENCE.is_file()):
        pytest.skip("bim-toolchain is not mounted in this environment")
    spec = importlib.util.spec_from_file_location("baseline_core_conciseness", baseline_path)
    assert spec is not None and spec.loader is not None
    baseline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baseline)
    evidence = json.loads(PREVIOUS_EVIDENCE.read_text(encoding="utf-8"))["packages"]

    for name, case in _cases(tool).items():
        problem = compile_instance(load_package(REPO_ROOT / case["package"]))
        found = baseline.package_evidence(problem, case["package"])

        assert found == evidence[case["package"]], name
