# QACOBench 1.1.1 reference campaign

This directory contains compact outputs of the accepted 15,450-instance,
three-engine campaign (46,350 unique records). The exact engine is version
1.1.1; the random-search and evolutionary engines are version 1.0.0.

- `evaluation/`: coverage, outcomes, termination reasons and acceptance checks.
- `figures/` and `secondary/figures/`: generated research-question figures.
- `secondary/`: aggregate analyses, including the HSC reference comparison.
- `secondary/latex/`: tables and the 676 generated manuscript number macros.
- `notebooks/`: four executed result-reading notebooks.
- `run_manifest.json` and `experiment-context.json`: original run provenance.
- `checksums.json`: identities of the raw records and companion Zenodo archives.

The raw records, complete per-instance analyses and BIM corpus are not stored
in Git. They are distributed with the companion Zenodo artifacts. Locally,
raw outputs live in `.artifacts/qacobench/`; the dataset may remain compressed
in `output/zenodo/qacobench-bim-dataset-1.1.1.tar.xz`.

Acceptance checks report zero duplicate runs, infrastructure errors, contradicted
UNSAT labels or OPTIMAL labels beaten by another engine's validated binding.
The exact engine reports 4,401 OPTIMAL, 250 FEASIBLE, 799 UNSAT and 10,000
INCOMPATIBLE outcomes (HSC). Empirical reconciliation is not a formal proof
of every optimality claim. HSC comparisons use the published reference
composition, not a certified optimum.

Measurements used a shared Linux host, sequential packages and engines, and
a requested solver budget of 5,000 ms. Resource limits remained constant;
optional repetitions across heuristic seeds were not run. The source hashes
identify the measured snapshot, before subsequent release documentation and
presentation-only analysis updates. No solver runs were replaced or edited.
