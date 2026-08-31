# BIM v1 engine benchmark

This benchmark contains modular BIM v1 Instance packages derived from the
literature scenarios. Each package is a readable directory rooted at
`instance.json`; the runner exports it as a deterministic `.bim.zip`, creates a
snapshot, and submits jobs through the OpenBinding `/v1` API.

`run_experiments.py` selects the current immutable Engine modes and checks each
mode's advertised compatibility before interpreting an outcome:

| Engine | Mode | Relevant optimization support |
| --- | --- | --- |
| `minizinc-csp` | `exact-weighted` | weighted deterministic subset |
| `random-search` | `seeded` | all BIM v1 optimization modes |
| `many-heuristic` | `pareto-sampling` | Pareto only |
| `evolutionary-heuristics` | `elitist-genetic` or `pareto-genetic` | selected by optimization mode |

The generated report is evidence only for the exact source, dialect/adapter,
IR, Engine, mode, options, and limits recorded in its BIM v1 provenance. Reports
from a different contract are not converted or treated as comparable results;
regenerate them with the current runner instead. The `reports/` directory is
therefore an output directory, not a checked-in baseline.

Run the benchmark against a current local stack:

```bash
.venv/bin/python experimentation/icws/run_experiments.py
```

Use `--engines` to restrict the advertised engines and `--max-cases` for a
smoke run. A validation rejection is an expected result when a mode truthfully
declares that it cannot execute a package's optimization, expression, workflow,
or placement constructs. Completed jobs use only `OPTIMAL`, `FEASIBLE`,
`INFEASIBLE`, or `UNKNOWN`, and the gateway authoritatively reevaluates every
returned binding.
