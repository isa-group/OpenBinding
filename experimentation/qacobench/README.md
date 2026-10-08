# QACOBench experiment artifact

QACOBench contains 10,250 instances from six research sources and 5,200 QFBS instances generated through `POST /v1/generator/instances`. QFBS design v2 has 26 configurations and 100 seeds in each of two groups: feasibility guaranteed and non-guaranteed. Each request produces one instance with the API defaults. The reference campaign submits all 15,450 instances to three solvers: 46,350 executions with a 5,000 ms solver budget.

## Docker workflow

From the repository root, with Docker Compose available and the six source suites in `datasets/`, run:

```sh
experimentation/qacobench/run.sh build
experimentation/qacobench/run.sh pilot
experimentation/qacobench/run.sh generate
experimentation/qacobench/run.sh manifest
experimentation/qacobench/run.sh campaign
# After campaign completion:
experimentation/qacobench/run.sh evaluate
experimentation/qacobench/run.sh figures
experimentation/qacobench/run.sh notebooks
```

`run.sh all` runs every stage, including evaluation. For a background campaign that stops before evaluation, run `experimentation/qacobench/launch_campaign_background.sh` after the pilot. It runs generation, captures the manifest, and starts the campaign. A successful full campaign writes `CAMPAIGN_DONE`. The pilot uses two HTTP-generated instances, one per group, and six solver executions.

Images include the code, schemas, scripts and four notebooks. Source transformers are included at `transformations/scripts/` inside the runner; their inputs and output directories are under `/workspace/datasets`. Host mounts contain inputs and outputs. Compose starts PostgreSQL, Redis, the gateway, worker and solvers; account configuration and solver registration are automatic. `run.sh jupyter` opens an optional token-protected server on `127.0.0.1:18888`.

## QFBS design

`design_matrix.json` is the generation source of truth. Its first 24 rows cover all pairs of levels across nine factors. Two reference rows use sequence and mixed structures with an activity budget of 24, five candidates, uniform feature values, default aggregation, three exact constraints and three objectives. Both reference rows use constraint-setting level 0. Each row has 100 trials in each group, sharing generation seeds across corresponding configurations.

The guaranteed group uses `guarantee_feasibility=true` and tension 0.3 or 0.8. The non-guaranteed group omits tension and samples `constraint_optimality_percent` in bands of 20–40% or 60–80%. These bands are positions in an aggregate feature range, not universal difficulty levels. Neither band establishes SAT or UNSAT. All instances are generated directly by HTTP.

The generator saves returned file bytes, requests, seeds, response digests, observed workflow constructs and actual task, candidate and constraint counts. It resumes from the generation manifest and rejects a manifest from another design. No second generation or corpus-wide compilation audit is required.

## Execution and analysis

The campaign resumes by instance identity, package digest, solver, budget and seed. Quota failures, communication failures and unclassified infrastructure errors stop execution. Capability rejections remain `INCOMPATIBLE`. Results from another design must not be placed in the new output directory.

Evaluation summarizes recorded responses without recompiling instances or reevaluating bindings. RQ1 characterizes workflow constructs in both QFBS groups. RQ2 compares accepted/submitted and binding-returned/accepted proportions for the seven suites and three solvers. Undefined conditional proportions are left unfilled. RQ3 separates QFBS outcomes by feasibility group. Figures use CSVs rebuilt from the generation metadata and run records. The four notebooks read the same outputs.

The run manifest records software and image identities, configuration hashes, seeds, budget and host information. Generation and aggregate calculations can be repeated from the fixed inputs. Wall-clock execution and outcomes close to a time limit can vary with host load.

## Nipogi

Run the watcher from a Mac with the `nipogi-dev` SSH alias:

```sh
experimentation/qacobench/watch_nipogi.sh
```

It displays stage, generated instances out of 5,200, and recorded executions out of 46,350 every 30 seconds. It stops at `CAMPAIGN_DONE` or a reported exit code. The background launcher does not start evaluation.

## Publication

The planned GitHub/Zenodo software artifact includes source inputs, code, Docker configuration, notebooks, raw results and analyses, without BIM instance directories. A separate Zenodo deposit will contain the 15,450 BIM instances. Neither deposit has been published yet.
