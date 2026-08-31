from __future__ import annotations

from experimentation.icsoc.campaign import (
    ENGINE_MODES,
    LoadedInstance,
    RunSpec,
    _run_row,
    campaign_specs,
)


def _instance() -> LoadedInstance:
    return LoadedInstance(
        package=None,  # type: ignore[arg-type]
        root={},
        resources={
            "Application": [{"spec": {"tasks": {"a": "service/a", "b": "service/b"}}}],
            "CandidateCatalog": [{"spec": {"candidates": {"x": {}, "y": {}, "z": {}}}}],
        },
    )


def test_campaign_selects_only_modes_compatible_with_weighted_placement() -> None:
    specs = campaign_specs(1234)

    assert {spec.engine for spec in specs} == {
        "minizinc-csp",
        "random-search",
        "evolutionary-heuristics",
    }
    assert {ENGINE_MODES[spec.engine] for spec in specs} == {
        "exact-weighted",
        "seeded",
        "elitist-genetic",
    }
    assert all(spec.options["time_budget_ms"] == 1234 for spec in specs)


def test_run_row_uses_authoritative_evaluation_and_v1_provenance() -> None:
    data = {
        "status": "completed",
        "result": {
            "termination": "FEASIBLE",
            "solutions": [{
                "decision": {"kind": "binding", "binding": {}},
                "metrics": {"cost": 4.5, "latency": 8.0, "security": 0.9},
                "objectives": {"mode": "weighted", "score": 0.25},
                "penalties": [0.5, 1.25],
                "violations": [
                    {"enforcement": "soft", "constraint": {"resource": "c", "id": "s"}},
                    {"enforcement": "hard", "constraint": {"resource": "c", "id": "h"}},
                ],
            }],
            "provenance": {
                "mode": "seeded",
                "algorithm": "seeded-random-search",
                "instanceDigest": "sha256-instance",
                "packageDigest": "sha256-package",
                "irDigest": "sha256-ir",
                "engineDigest": "sha256-engine",
                "profileDigest": "sha256-profile",
                "protocolDigest": "sha256-protocol",
                "compilerDigest": "sha256-compiler",
                "evaluatorDigest": "sha256-evaluator",
                "engineReported": {
                    "algorithm": "untrusted-name",
                    "elapsed_ms": 17,
                    "evaluations": 99,
                    "objective": -999,
                },
            },
        },
    }
    row = _run_row(
        "run",
        {"application": "app", "infra_size": 1, "dataset_seed": "seed", "instance_id": "i"},
        RunSpec("random-search", 7, {"iterations": 99, "seed": 7}),
        _instance(),
        data,
        0.1234,
    )

    assert row["termination"] == "FEASIBLE"
    assert row["mode"] == "seeded"
    assert row["algorithm"] == "seeded-random-search"
    assert row["objective_value"] == 0.25
    assert row["penalty"] == 1.75
    assert row["hard_violations"] == 1
    assert row["soft_violations"] == 1
    assert row["engine_execution_time_ms"] == 17
    assert row["engine_evaluations"] == 99
    assert row["ir_digest"] == "sha256-ir"
