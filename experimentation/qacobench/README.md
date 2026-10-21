# QACOBench experiment artifact

QACOBench contains 10,250 instances from six research sources and 5,200 QFBS instances generated through `POST /v1/generator/instances`. QFBS design v2 has 26 configurations and 100 seeds in each of two groups: feasibility guaranteed and non-guaranteed. Each request produces one instance with the API defaults. The reference campaign submits all 15,450 instances to three solvers: 46,350 executions with a 5,000 ms solver budget.

## Docker workflow

From the repository root, with Docker Compose available and the source suites in `datasets/sources/`, run:

```sh
experimentation/qacobench/run.sh reset      # only after an engine manifest changed: drops the Compose volumes
experimentation/qacobench/run.sh build
experimentation/qacobench/run.sh pilot
experimentation/qacobench/run.sh transform  # regenerates 03_hsc_llm, 04_rprsr15 and 06_bws_scp from their sources
experimentation/qacobench/run.sh generate   # resumes 07_qfbs from its manifest
experimentation/qacobench/run.sh manifest
experimentation/qacobench/run.sh campaign --fresh
# After campaign completion:
experimentation/qacobench/run.sh evaluate
experimentation/qacobench/run.sh figures
experimentation/qacobench/run.sh analyze    # secondary analyses (gaps, reconciliation, timing, LaTeX tables)
experimentation/qacobench/run.sh notebooks
```

`run.sh all` runs every stage, including evaluation. For a background campaign that stops before evaluation, run `experimentation/qacobench/launch_campaign_background.sh` after the pilot. It runs generation, captures the manifest, and starts the campaign. A successful full campaign writes `CAMPAIGN_DONE`. The pilot uses two HTTP-generated instances, one per group, and six solver executions.

Images are tagged `qacobench/*:qfbs-v3` (`QACOBENCH_REVISION` overrides) and include the code, schemas, scripts and four notebooks. Source transformers are included at `transformations/scripts/` inside the runner; their inputs and output directories are under `/workspace/datasets`. Host mounts contain inputs and outputs. Compose starts PostgreSQL, Redis, the gateway, worker and solvers; account configuration and solver registration are automatic. `run.sh jupyter` opens an optional token-protected server on `127.0.0.1:18888`.

The gateway registry keeps every engine revision it has seen, keyed by (namespace, name, version). `campaign.py` compares the digest of each registered engine manifest with the checkout's `schemas/bim/v1/manifests/<engine>.json` and refuses to run against a stale registration; `run.sh reset` clears the volumes so that `run.sh build` registers the current manifests. The `minizinc-csp` image pins the official MiniZinc 2.8.7 bundle (Gecode 6.3.0); `run.sh manifest` records `minizinc --version` and the solver list in `.artifacts/qacobench/minizinc_versions.txt` and the manifest digests in `run_manifest.json`.

### Campaign options

`campaign.py` (invoked by `run.sh campaign`, which adds `--all --timeout-ms 5000`) accepts:

* `--fresh` — ignore an existing `results.jsonl`; without it the campaign resumes by (suite, instance, engine, budget, seed, package digest).
* `--redo-engine <name>` (repeatable) — drop the recorded runs of one engine (a backup of the results file is kept) and run it again, e.g. after an engine revision.
* `--repeats k` — run every heuristic engine `k` times per instance with seeds `base + 0 .. base + k-1` (record field `repeat`); the reference campaign uses 1.
* `--concurrency n` — packages in flight at once; `n > 1` shortens the campaign but adds CPU contention to the runtime measurements, so the reference campaign uses 1.
* `--engines`, `--suite`, `--package`, `--sample`, `--source-only` — subsets, as before.

Every record carries `termination_reason` (`proof`, `evaluation_budget`, `time_budget`, `incompatible`) and the effective `engine_options`. The heuristic engines run with their declared defaults inside the 5,000 ms budget: random-search 1,000 evaluations, evolutionary-heuristics population 100 and 10,000 evaluations; the budget is recorded in the run manifest (`engine_budgets`) and reported with the results, so that "time budget" and "evaluation budget" terminations are never conflated. Capability rejections are recorded as `INCOMPATIBLE` with the engine's 422 diagnostics (`diagnostics`), never as errors.

## QFBS design

`design_matrix.json` is the generation source of truth. Its first 24 rows cover all pairs of levels across nine factors. Two reference rows use sequence and mixed structures with an activity budget of 24, five candidates, uniform feature values, default aggregation, three exact constraints and three objectives. Both reference rows use constraint-setting level 0. Each row has 100 trials in each group, sharing generation seeds across corresponding configurations.

The guaranteed group uses `guarantee_feasibility=true` and tension 0.3 or 0.8. The non-guaranteed group omits tension and samples `constraint_optimality_percent` in bands of 20–40% or 60–80%. These bands are positions in an aggregate feature range, not universal difficulty levels. Neither band establishes SAT or UNSAT. All instances are generated directly by HTTP.

The generator saves returned file bytes, requests, seeds, response digests, observed workflow constructs and actual task, candidate and constraint counts. It resumes from the generation manifest and rejects a manifest from another design. No second generation or corpus-wide compilation audit is required.

## Execution and analysis

The campaign resumes by instance identity, package digest, solver, budget and seed. Quota failures, communication failures and unclassified infrastructure errors stop execution. Capability rejections remain `INCOMPATIBLE`. Results from another design must not be placed in the new output directory.

Evaluation summarizes recorded responses without recompiling instances or re-evaluating bindings (every binding was already validated by the gateway when it was recorded). The research questions and the artifacts that answer them:

* **RQ1 — What makes a QFBS instance hard?** Marginal outcome rates per design-factor level (nine factors of `design_matrix.json`): share of instances the exact solver settles within the budget (OPTIMAL or UNSAT), median proof time, unresolved instances and the share of certified optima the GA attains. `secondary/factor_analysis.csv`, `factor_effects.csv`, `cell_table.csv`, `figures/fig_rq1_hardness`, `latex/table_rq1_factors.tex`, `latex/table_rq1_compact.tex` (extreme levels per factor; the paper's table). (The construct heat map, `figures/qfbs_structure`, describes the corpus; it is no longer a research question.)
* **RQ2 — Which instances can each solver process, and how often does it return a binding within the budget?** Coverage = processable / submitted and conditional binding yield = binding returned / processable, per suite and solver (`evaluation/outcomes_by_suite_engine.csv`, `figures/rq2_binding_yield` and `figures/rq2_engine_coverage`), the rejection reasons recorded with every INCOMPATIBLE run (`evaluation/incompatibilities.csv`, `secondary/capability_matrix.csv`, `latex/table_rq2_capabilities.tex`) and the termination reasons (`evaluation/termination_reasons.csv`, `secondary/timing_budget.csv`).
* **RQ3 — How do solver outcomes differ between the two QFBS feasibility settings, and do the solvers' verdicts agree on each instance?** Outcomes per group (`evaluation/qfbs_outcomes.csv`) and the per-instance reconciliation of the exact labels with the heuristics' validated bindings (`secondary/reconciliation_summary.csv`, `contradictions.csv`, `figures/fig_rq3_reconciliation`, `latex/table_rq3_labels.tex`). A contradicted verdict is an UNSAT proof on an instance for which another engine returned a validated binding, or an OPTIMAL label whose score another engine strictly beats; `evaluate_results.py` refuses the campaign when either count is non-zero.
* **RQ4 — How close are heuristic bindings to certified optima?** Gap = heuristic score − MiniZinc optimum, comparable within an instance because the gateway scores every engine with the same normalised weighted sum; by QFBS subset and by recovered suite, plus heuristics against time-limited CP incumbents and the best-known score (`secondary/optimality_gap.csv`, `vs_cp_incumbent.csv`, `virtual_best.csv`, `figures/fig_rq4_gap*`, `latex/table_rq4_gap.tex`, `table_rq4_incumbent.tex`). HSC has no exact proofs: its heuristic scores are compared with the authors' reference compositions, whose objective (Eq. 1 + Eq. 2 of the source paper) is recomputed on the released data (`secondary/hsc_quality_summary.json`, `hsc_quality_by_constraints.csv`, `figures/fig_rq4_hsc`, `latex/table_rq4_hsc.tex`).

`run.sh evaluate` produces the primary tables, `run.sh figures` the primary figures and `run.sh analyze` the secondary analyses (`secondary/run_all.py`); the notebook `04_evaluation_and_visualization.ipynb` displays all of them. With `campaign.py --repeats k`, `secondary/repeat_variability.csv` reports the seed-to-seed variability of the heuristics. `secondary/latex/paper_numbers.tex` (step `09_paper_numbers.py`) defines one LaTeX macro per campaign-derived number quoted in the paper, so the manuscript is recompiled rather than retyped after a campaign.

The run manifest records software and image identities, configuration hashes, seeds, budget and host information. Generation and aggregate calculations can be repeated from the fixed inputs. Wall-clock execution and outcomes close to a time limit can vary with host load.

## Publication

### Reference results and local data

`reference/1.1.1/` contains the compact, versioned tables, figures, executed
notebooks and provenance of the accepted reference campaign. The 46,350 raw
records and the 15,450 BIM instance packages are distributed through the
companion Zenodo records, not through Git. Both archives extract into the
repository root; the raw results are under `.artifacts/qacobench/`.

To save local disk space, the BIM dataset can remain compressed as
`output/zenodo/qacobench-bim-dataset-1.1.1.tar.xz`. Verify its SHA-256 against
`reference/1.1.1/checksums.json` before extracting it. Allow at least 3 GiB of
free space, then extract it only when recomputing package-dependent analyses:

```sh
tar -xJf output/zenodo/qacobench-bim-dataset-1.1.1.tar.xz
python3 experimentation/qacobench/verify_dataset_digests.py
```

The generated suite directories, raw output store and archive bundles are
ignored by Git. Keep source inputs, transformations, tests and reproducible
analysis scripts versioned; do not force-add the ignored corpus or raw logs.

`tools/package_zenodo.sh [version]` builds the two Zenodo archives from the checkout: the software artifact (source inputs, code, Docker configuration, notebooks, raw results and analyses, without the BIM instance directories) and the dataset artifact (the seven instance directories with their notices). Metadata and descriptions for both records are in `output/zenodo/`.
