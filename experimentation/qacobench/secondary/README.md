# QACOBench secondary analyses

Post-hoc analyses of the reference campaign (`.artifacts/qacobench/results.jsonl`, 46,350 runs),
the QFBS generation manifest and the HSC packages, organised by research question (RQ1 hardness,
RQ2 applicability, RQ3 outcomes and agreement, RQ4 quality). Nothing here re-executes a solver.

```sh
# from the OpenBinding checkout (or set QACOBENCH_ROOT); outputs go to .artifacts/qacobench/secondary/
python experimentation/qacobench/secondary/run_all.py
```

| Step | Script | Output (in `.artifacts/qacobench/secondary/`) |
|---|---|---|
| 1 | `01_extract.py` | `runs.pkl`, `diagnostics.pkl`, `qfbs_manifest.pkl` (flattened records: objective components, trace milestones, termination reason, repeat index) |
| 2 | `02_analyze.py` | RQ1: `factor_analysis.csv`, `factor_effects.csv`, `cell_table.csv`; RQ2: `capability_matrix.csv`, `capability_diagnostics.csv`, `timing_budget.csv`; RQ3: `labels_by_group*.csv`, `reconciliation*.csv`, `contradictions.csv`, `paired_*.csv`; RQ4: `optimality_gap.csv`, `optimality_gap_instances.csv`, `optimality_gap_qfbs_instances.csv`, `vs_cp_incumbent.csv`, `virtual_best.csv`, `repeat_variability.csv` (with `--repeats`); also `instances_wide.csv`, `qfbs_wide.csv`, `mzn_runtime_by_status.csv`, `qfbs_time_to_feasible.csv`, `bound_tasks_by_suite.csv`, `qfbs_characterization.csv`, `hsc_llm_reconciliation.csv` |
| 3 | `03_hsc_quality.py` | `hsc_instances.csv` (all 10,000 HSC instances: shape, candidate pools, reference composition with its Eq. 1 + 2 objective recomputed on the released data, per-engine score, penalty and gap to the reference), `hsc_quality_summary.json`, `hsc_quality_by_constraints.csv`, `hsc_quality_by_space.csv` |
| 4 | `04_figures.py` | `figures/fig_rq1_hardness`, `fig_rq3_reconciliation`, `fig_rq4_gap`, `fig_rq4_gap_recovered`, `fig_rq4_hsc`, `fig_time_to_binding` (PDF + SVG) |
| 5 | `05_latex_tables.py` | `latex/table_rq1_factors.tex`, `table_rq1_compact.tex` (the paper's Table 3: extreme levels per factor), `table_rq2_capabilities.tex`, `table_rq3_labels.tex`, `table_rq4_gap.tex`, `table_rq4_incumbent.tex`, `table_rq4_hsc.tex`, `table_timing_budget.tex` |
| 8 | `08_corpus_characterization.py` | `corpus_packages.csv`, `corpus_characterization.csv`, `latex/table_corpus_characterization.tex` |
| 9 | `09_paper_numbers.py` | `latex/paper_numbers.tex`: one `\newcommand` per campaign-derived number quoted in the paper (counts, percentages, medians), read from `../evaluation/*.csv` and the outputs of steps 2 and 3; the manuscript `\input`s it as `qacobench-numbers.tex` so that no result is typed by hand |

Environment overrides: `QACOBENCH_ROOT`, `QACOBENCH_RESULTS`, `QACOBENCH_DATASETS`, `QACOBENCH_SECONDARY_OUT`.

Definitions used throughout:

* *score* / *quality*: the gateway's authoritative weighted-sum of normalised losses (`objectives.score` in each run record). It is the same function for the three engines and is what `minizinc-csp` minimises, so scores are comparable within an instance.
* *gap*: `score(heuristic) - score(MiniZinc OPTIMAL)` on instances where MiniZinc proved optimality.
* *known feasible*: at least one engine returned a gateway-validated binding.
* *gap to the reference (HSC)*: heuristic score minus the objective (Eq. 1 + Eq. 2 of the source paper) of the authors' reference composition recomputed on the released data; HSC constraints are soft, so every instance is feasible and quality is the only question.
