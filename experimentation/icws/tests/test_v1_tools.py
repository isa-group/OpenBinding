from __future__ import annotations

from pathlib import Path

from openbinding_gateway.v1 import compile_instance
from openbinding_gateway.v1.package import load_package

from experimentation.icws.generator import scale_package
from experimentation.icws.run_experiments import (
    InstanceMeta,
    engine_mode,
    expected_behavior_for_engine,
    load_instances,
    parse_validation_violations,
)

ROOT = Path(__file__).resolve().parents[3]


def test_scaler_consumes_and_emits_grouped_bim_packages(tmp_path: Path) -> None:
    source = ROOT / "examples/literature/benatallah"
    output = tmp_path / "scaled"
    original_count = len(load_package(source).json("candidates.json")["spec"]["candidates"])

    scale_package(source, output, copies=3)

    package = load_package(output)
    root = package.instance()
    assert root["apiVersion"] == "bim/v1"
    assert root["spec"]["profile"] == "qos-binding/v1"
    assert isinstance(root["spec"]["resources"], dict)
    catalog = package.json("candidates.json")
    assert catalog["apiVersion"] == "qos-binding/v1"
    assert len(catalog["spec"]["candidates"]) == original_count * 3
    compile_instance(package)


def test_runner_reads_all_grouped_icws_packages() -> None:
    instances = load_instances(ROOT / "experimentation/icws/instances")

    assert len(instances) == 48
    assert {instance.objective_type for instance in instances} == {"PARETO", "WEIGHTED"}


def test_problem_json_diagnostics_are_reported() -> None:
    valid, codes, message = parse_validation_violations(
        {"diagnostics": [{"code": "engine_mode_incompatible"}]}
    )

    assert valid is True
    assert codes == ["engine_mode_incompatible"]
    assert message == ""


def test_modes_and_expectations_follow_engine_manifests(tmp_path: Path) -> None:
    weighted_hard = InstanceMeta(tmp_path, "WEIGHTED", True, False, "mono_hard")
    weighted_soft = InstanceMeta(tmp_path, "WEIGHTED", False, True, "mono_soft")
    pareto = InstanceMeta(tmp_path, "PARETO", True, False, "many")

    assert engine_mode("evolutionary-heuristics", pareto) == "pareto-genetic"
    assert engine_mode("evolutionary-heuristics", weighted_hard) == "elitist-genetic"
    assert engine_mode("many-heuristic", pareto) == "pareto-sampling"
    assert expected_behavior_for_engine("many-heuristic", weighted_hard) == "VALIDATION_ERROR"
    assert expected_behavior_for_engine("minizinc-csp", weighted_soft) == "VALIDATION_ERROR"
    assert expected_behavior_for_engine("minizinc-csp", weighted_hard) == "ANY_COMPLETED"
    assert expected_behavior_for_engine("random-search", pareto) == "ANY_COMPLETED"
