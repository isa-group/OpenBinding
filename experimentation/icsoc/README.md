# PI4SecFaaS2Fog experimentation: FaaS placement as QACO

Experimental pipeline for the paper *A Pricing Intelligence Approach for Self-Adaptive Binding of
Secure FaaS-Based Compositions in the Cloud-Edge Continuum*. It reformulates the SecFaaS2Fog
placement problem as QoS-aware service composition (QACO), encodes it as priced **BIM\*** instances,
and solves it through the OpenBinding gateway with three engines.

## Pipeline

```
original_dataset/          bimstar generator            OpenBinding stack           campaign.py            notebooks/03
(3 apps, 20 seeds,   ──►   priced BIM* corpus     ──►   gateway + 3 engines   ──►   runs.csv/traces.csv ──► figures &
 35 sizes each)            (105 instances, 1 seed)      (docker compose)            (resumable)            statistics
```

- **Generator** (`bimstar/`): deterministic transformation (generator seed 12345, dataset seed
  146588263). Per candidate: monthly USD cost from on-demand **iPricings** (`pricings/`), security
  score, resource demands; per instance: provider/region-aware latency model, transition
  constraints, capacity constraints, security thresholds and canonical min–max normalization
  bounds shared by every engine.
  - **Security thresholds** come from a per-variable information-flow analysis
    (`security.output_propagation: variable`): trigger labels ride on the named dataflow
    variables, so tasks touching only low/medium data get thresholds below `top` and the
    security term of the objective genuinely discriminates (the classic saturating join is
    available as `saturate`).
  - **Pricing budgets** are anchored to a **certified feasible witness** — a cheapest-first
    backtracking assignment over the AC-3-filtered pools that satisfies every transition bound
    and pool capacity. Per-task budget = max(p75 of eligible costs, witness cost); global
    budget = witness cost + `global_budget_slack` × (fold of local budgets − witness cost),
    so every instance is satisfiable by construction with a configurable difficulty.
- **Reference evaluator** (`openbinding_gateway.validation.engine_plugins.bimstar`): the single
  source of truth for the placement semantics (end-to-end latency = expected makespan over XOR
  scenarios, capacity, transitions, canonical objective). Every solution returned by any engine is
  re-evaluated with it.
- **Engines**: `minizinc-csp` (exact, Gecode), `random-search` (**baseline** of the study),
  `evolutionary-heuristics` (NSGA-II, MONO mode with Deb's feasibility rules; uniform crossover +
  random-reset mutation — the standard variation for categorical candidate indices — population 20,
  selected in a preliminary 3-way pilot on the hard application, see `pilot_ga.py` and
  `out/results/pilot_ga.csv`).

## Experimental design

| Variable | Domain |
|---|---|
| Algorithms | exact (Gecode), random search (baseline), NSGA-II (pop 20, uniform crossover + random-reset mutation) |
| Objective | `J = 0.33·loss(latency) + 0.34·loss(cost) + 0.33·loss(security)` (canonical, lower is better) |
| Instances | 3 applications × 35 infrastructure sizes (50–220 nodes) × dataset seed 146588263 = 105 |
| Repetitions | exact ×1; stochastic ×10 (solver seeds 1–10) ⇒ 2 205 runs |
| Stopping criterion | shared wall-clock budget **T = 300 s** for every algorithm |
| Heuristic floor | ≥ 1 000 evaluations always granted (standard literature budget) |

**Anytime protocol**: every solver returns the best solution it was considering when the budget
expires — the exact engine returns its last (possibly unproven) incumbent; the heuristics return
their best sample even when infeasible, flagged by the reference evaluator. Best-so-far traces
record `(eval_index, elapsed_ms)` per improvement, so any cutoff τ ≤ T is recoverable offline.

**Exact-failure fallback**: when the exact engine returns no solution for an instance
(UNSATISFIABLE / UNKNOWN), the evaluation uses the heuristics at the standard 1 000-evaluation
cutoff as the per-instance reference.

## Layout

```
experimentation/icsoc/
├── original_dataset/          # SecFaaS2Fog input (applications + infrastructures)
├── bimstar/                   # generator package (+ unit tests in bimstar/tests/)
├── campaign.py                # resumable campaign runner (CLI + importable)
├── analysis.py                # evaluation helpers (references, profiles, stats, figures)
├── notebooks/
│   ├── 01_dataset_preprocessing.ipynb   # dataset → corpus, pricing & latency verification
│   ├── 02_campaign_execution.ipynb      # stack, pilot, launch commands, monitoring
│   └── 03_results_evaluation.ipynb      # full evaluation + paper figures
└── out/
    ├── bimstar-priced/        # generated corpus + provenance reports (CSV)
    └── results/               # runs.csv, traces.csv, corpus_summary.csv, figures/
```

## How to run

```bash
# 0) Environment (once)
uv pip install -e ./openbinding-gateway pandas matplotlib scipy httpx --python .venv/bin/python

# 1) Stack
docker compose --profile dev up -d --build gateway-dev engine-minizinc \
  engine-random-search engine-evolutionary-heuristics engine-many-heuristic

# 2) Corpus (deterministic; also available from notebook 01)
.venv/bin/python -m experimentation.icsoc.bimstar.cli generate \
  --dataset experimentation/icsoc/original_dataset --pricing-dir pricings \
  --config experimentation/icsoc/bimstar/configs/default.yml \
  --seed 12345 --out experimentation/icsoc/out/bimstar-priced --dataset-seeds 146588263

# 3) Campaign — three parallel lanes (three terminals), resumable
.venv/bin/python experimentation/icsoc/campaign.py --engines minizinc-csp
.venv/bin/python experimentation/icsoc/campaign.py --engines random-search
.venv/bin/python experimentation/icsoc/campaign.py --engines evolutionary-heuristics

# 4) Monitor
.venv/bin/python experimentation/icsoc/campaign.py --status

# 5) Evaluate
jupyter lab experimentation/icsoc/notebooks/03_results_evaluation.ipynb
```

Sharding for a cluster: add `--applications arOrch` (etc.) per shard and merge the CSVs afterwards.
A shorter horizon: `--time-budget-ms 60000` (the ≥1 000-evaluation floor is preserved).

## Fair comparison of objective values

Engines may compute objectives internally in different ways, so the study never compares
solver-reported numbers directly:

1. **One referee** — every returned binding is re-evaluated by the gateway reference evaluator;
   only that canonical J reaches `runs.csv` and the evaluation.
2. **Same landscape, proven** — normalization bounds are part of the instance (a declared
   contract), all engines use the same weighted-mean-of-losses convention, and each run carries an
   integrity audit (`oracle_match`): the engine's internal objective (`engine_objective_value`)
   must equal the canonical J for feasible solutions.
3. **Scale-free aggregation** — J is normalized per instance, so raw values are only comparable
   within an instance; cross-instance conclusions use gaps to the per-instance reference,
   % improvement vs the random-search baseline, Dolan–Moré performance profiles, and mean ranks
   with a Friedman test plus per-instance Mann–Whitney/Â₁₂.
4. **Feasibility first** — infeasible solutions are never compared by J (they are reported through
   success rates and violation magnitudes; NSGA-II infeasible bests carry Deb's offset by design).

## Reproducibility

- Corpus: generator seed 12345 + dataset seed 146588263 fully determine the 105 instances.
- Runs: solver seeds are explicit (1–10); run ids are deterministic (`instance|engine#seed`).
- Objectives: every reported value is recomputed by the gateway reference evaluator
  (`oracle_match` flags any divergence; expected count 0).
- Tests: `pytest experimentation/icsoc/bimstar/tests openbinding-gateway/tests`.
