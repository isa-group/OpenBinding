# BIM v1 placement experiment

This directory contains the reproducible experiment for *QoS-aware Placement
of FaaS Compositions in the Cloud-Edge Continuum*. It gives CLASP-FaaS—the
Cost- and Latency-Aware Secure Placement of FaaS Compositions—a deterministic
placement-aware formulation of QACO′, generates each case as a modular BIM v1
Instance, and runs compatible modes through the OpenBinding platform.
`OpenBinding4Placement` is the experiment name, not a language or API version.

## Pipeline

```text
original_dataset/       BIM v1 generator        OpenBinding /v1       campaign.py
(applications and  ──>  readable Instance  ──>  compile + dispatch ──> generated results
infrastructures)        package directories     + reevaluation        and provenance
```

The deterministic generator combines the source dataset with the local
iPricing models in `pricings/`. It emits typed capabilities, finite scalar QoS
metrics, candidate-to-pool assignments, capacity rules, explicit transition
bounds, directed or explicitly symmetric network latency, and a weighted
latency/cost/security objective. It also emits the routing and repeat
multipliers used by the deterministic workflow semantics. The generated corpus
contains three applications, 35 infrastructure sizes, and one pinned dataset
seed: 105 BIM v1 Instances in total.

Every Instance is a directory rooted at `instance.json`. The campaign builds a
deterministic `.bim.zip`, creates or reuses an immutable snapshot, and submits a
job to `/v1`. Every returned binding is reevaluated by the gateway's
authoritative BIM v1 evaluator before its metrics and objective are recorded.

## Engine compatibility

The bundled mode matrix is:

| Engine | Mode | Placement | Optimization | This corpus |
| --- | --- | --- | --- | --- |
| `minizinc-csp` | `exact-weighted` | `all` | `weighted` | compatible; exact reference |
| `random-search` | `seeded` | `all` | `all` | compatible |
| `evolutionary-heuristics` | `elitist-genetic` | `all` | `satisfy`, `weighted`, `lexicographic` | compatible |
| `many-heuristic` | `pareto-sampling` | `all` | `pareto` only | incompatible with the weighted objective |

The campaign executes `minizinc-csp/exact-weighted`, `random-search/seeded`,
and `evolutionary-heuristics/elitist-genetic`. Compatibility is derived from the
published Engine manifests and checked again against each compiled
`BindingProblem`; an incompatible mode is never used as a fallback.
All three selected modes pair their closed `placement: all` capability with
`irExtensions: only(qos-binding-placement/v1)`; none claims support for an
unknown future IR extension.

MiniZinc supplies an exact `OPTIMAL`/`INFEASIBLE` reference when it finishes.
The other two lanes are heuristic and report only `FEASIBLE` or `UNKNOWN`.
Comparisons use the same finite wall-clock budget, explicit seeds, and the
authoritative reevaluated weighted loss. Raw values are compared only within
the same Instance; cross-instance summaries use normalized gaps or ranks.

## Layout

```text
experimentation/icsoc/
├── original_dataset/          # source applications and infrastructures
├── generator/                 # BIM v1 generator and unit tests
├── campaign.py                # resumable /v1 campaign runner
├── regression/                # tiny pinned historical baseline (not the corpus)
├── analysis.py                # result analysis helpers
├── notebooks/
│   ├── 01_dataset_preprocessing.ipynb
│   ├── 02_campaign_execution.ipynb
│   └── 03_results_evaluation.ipynb
└── out/
    ├── bim-v1/                 # generated BIM v1 corpus and generation reports
    └── results/                # generated locally by a new BIM v1 campaign
```

The reduced regression pins one historical case and its exact result so changes
can be classified as coincident, similar, statistically sensible, or a
regression. “Similar” lies inside the historical min/max at 1,000 evaluations;
“sensible” lies outside that range but below the Tukey-style outer fence
`Q3 + 3 × IQR`, reconstructed from the last incumbent of each of ten published
seeds. The baseline records Q1, Q3, the quantile method, and the current seeded
observations, all of which are asserted in CI. Generate a fresh full corpus and
run the current campaign before evaluating or publishing new figures.

## Run the experiment

```bash
# 0) Environment
uv pip install -e ./openbinding-gateway pandas matplotlib scipy httpx --python .venv/bin/python

# 1) Placement-compatible stack
docker compose --profile dev up -d --build gateway-dev \
  engine-minizinc engine-random-search engine-evolutionary-heuristics

# 2) Deterministic corpus
.venv/bin/python -m experimentation.icsoc.generator.cli generate \
  --dataset experimentation/icsoc/original_dataset \
  --pricing-dir pricings \
  --config experimentation/icsoc/generator/configs/default.yml \
  --seed 12345 \
  --out experimentation/icsoc/out/bim-v1 \
  --dataset-seeds 146588263

# 3) Resumable campaign (one exact and two heuristic lanes)
.venv/bin/python experimentation/icsoc/campaign.py

# Optional independent lanes
.venv/bin/python experimentation/icsoc/campaign.py --engines minizinc-csp
.venv/bin/python experimentation/icsoc/campaign.py --engines random-search
.venv/bin/python experimentation/icsoc/campaign.py --engines evolutionary-heuristics

# 4) Status and evaluation
.venv/bin/python experimentation/icsoc/campaign.py --status
jupyter lab experimentation/icsoc/notebooks/03_results_evaluation.ipynb
```

Use `--applications arOrch` (or another application id) to shard the campaign.
A shorter wall-clock horizon can be selected with `--time-budget-ms`; use the
  same value for all modes in a comparison.

## Reproducibility contract

- Generator seed `12345` and dataset seed `146588263` determine the 105 source
  directories.
- Export uses canonical JSON, UTF-8/LF, sorted POSIX paths, fixed timestamps,
  ZIP `STORE`, and SHA-256 digests.
- Every job records package, `fileDigests`, logical `resourceDigests`, selected
  Dialect and adapter revisions, IR, Engine/mode, effective options, limits,
  compiler, and evaluator in provenance.
- Solver seeds are explicit and run ids are deterministic, so an interrupted
  campaign can resume without changing completed runs.
- Only gateway-reevaluated metrics, objectives, penalties, and violations enter
  analysis outputs.

Run the generator tests and BIM v1 gateway tests before launching a campaign:

```bash
PYTHONPATH=.:openbinding-gateway/src pytest \
  experimentation/icsoc/generator/tests openbinding-gateway/tests

# With the Compose stack running, this also regenerates and solves the reduced
# historical case through all three compatible engines.
docker compose exec -T gateway-dev test \
  tests/integration/test_icsoc_regression.py -m integration
```
