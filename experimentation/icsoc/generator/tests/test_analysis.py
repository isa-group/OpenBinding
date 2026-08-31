from __future__ import annotations

import pandas as pd

from experimentation.icsoc import analysis


def _runs() -> pd.DataFrame:
    rows = []
    for instance, random_score, genetic_score in (("i1", 0.4, 0.2), ("i2", 0.6, 0.3)):
        for engine, mode, algorithm, score in (
            ("random-search", "seeded", "seeded-random-search", random_score),
            ("evolutionary-heuristics", "elitist-genetic", "elitist-genetic-search", genetic_score),
        ):
            for seed in range(1, 4):
                rows.append({
                    "run_id": f"{instance}|{engine}#{seed}",
                    "instance_id": instance,
                    "engine": engine,
                    "mode": mode,
                    "algorithm": algorithm,
                    "status": "ok",
                    "termination": "FEASIBLE",
                    "feasible": True,
                    "objective_value": score,
                    "penalty": 0,
                    "hard_violations": 0,
                    "soft_violations": 0,
                    "engine_execution_time_ms": 1,
                    "engine_evaluations": 10,
                    "wall_time_s": 0.01,
                    "instance_digest": f"instance-{instance}",
                    "ir_digest": f"ir-{instance}",
                    "engine_digest": f"engine-{engine}",
                    "profile_digest": "profile",
                    "protocol_digest": "protocol",
                    "compiler_digest": "compiler",
                    "evaluator_digest": "evaluator",
                })
    return pd.DataFrame(rows)


def test_current_result_contract_supports_reproducible_analysis(tmp_path) -> None:
    source = _runs()
    source.to_csv(tmp_path / "runs.csv", index=False)

    runs = analysis.load_results(tmp_path)
    assert len(analysis.feasible_runs(runs)) == len(source)
    assert len(analysis.provenance_summary(runs)) == 2
    assert set(analysis.termination_rates(runs).termination) == {"FEASIBLE"}

    improvements = analysis.improvement_over_baseline(runs)
    assert set(improvements.engine) == {"evolutionary-heuristics"}
    assert set(improvements.improvement_vs_baseline.round(8)) == {0.5}

    ranks, paired = analysis.mean_ranks(runs)
    assert ranks["evolutionary-heuristics"] < ranks["random-search"]
    assert paired["n_instances"] == 2
