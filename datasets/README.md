# QACOBench datasets

The release corpus has seven consecutive, stable suite IDs and 15,450 instances.

| Directory | Instances | Source/type |
|---|---:|---|
| `01_icws` | 48 | Literature QoS composition scenarios |
| `02_quantum` | 46 | Quantum service selection |
| `03_hsc_llm` | 10,000 | Hugging Face service workflows |
| `04_rprsr15` | 60 | RPRSR15 literature instances |
| `05_iots` | 6 | IoT service composition |
| `06_bws_scp` | 90 | Cloud-manufacturing worker/service matching |
| `07_qfbs` | 5,200 | HTTP-generated QFBS workload |

CLASP and PROMISE are retained only in the recovery catalogue as excluded material. They do not occupy active suite IDs.

## Reproduction

Each literature transformer reads only its corresponding directory under `datasets/sources`. Generated packages use BIM v1 and carry `benchmark-metadata.json` with a `suite_id` equal to their containing suite.

```bash
python datasets/scripts/transform_quantum.py --target datasets/02_quantum
python datasets/scripts/transform_hsc.py --target datasets/03_hsc_llm --jobs 16
python datasets/scripts/transform_rprsr15.py --target datasets/04_rprsr15
python datasets/scripts/transform_iots.py --target datasets/05_iots
python datasets/scripts/transform_bws_scp.py --target datasets/06_bws_scp
experimentation/qacobench/run.sh generate
```

(`experimentation/qacobench/run.sh transform` runs the three transformers whose encodings changed in the second release — HSC, RPRSR15 and BWS-SCP — inside the runner image, followed by `write_benchmark_metadata.py`.)

`datasets/scripts/write_benchmark_metadata.py` (re)writes `benchmark-metadata.json` in every package of the six recovered suites: suite and instance identity, admission class, the provenance of the source benchmark taken from `recovery_catalogue.json`, the transformer's fidelity annotations, the SHA-256 of each resource and the package digest the campaign records (same recipe as `experimentation/qacobench/_common.py`; the metadata file itself is excluded from that digest). `--check` verifies the files without writing them. QFBS packages are described by `07_qfbs/manifest.jsonl` instead.

Each transformer encodes the *source* objective and constraints, not a convenience approximation, and records in `benchmark-metadata.json` the fidelity facts a reader needs (`source_objective`, `objective_weights`, `attained_extremes`, aggregation and value conventions, reference solutions where the source provides them):

* `03_hsc_llm` preserves sequential levels and parallel activities, uses one task per source activity, and retains the source per-activity reference binding. Its objective is the source paper's Eq. (1) and its constraints are the soft, squared-violation penalties of Eq. (2), encoded as soft BIM constraints whose penalty expression is `K * (value - c)^2`; the transformer verifies that the BIM score of the reference binding equals the paper's objective. Its sequence aggregations are custom expressions (means and geometric means over levels); engines that cannot execute those rules are reported as incompatible.
* `04_rprsr15` keeps the per-file QoS model (sequence/parallel/branch/loop aggregation functions of the source, including the 26 files with loops), the branch probabilities and the loop counts; normalisation ranges are the extremes attained by witness bindings, not the clamped 0–100 ranges of the first release.
* `06_bws_scp` encodes the source MILP: the weighted sum of total time, total cost and the negated sum of log-reliabilities with weights `1/(attained max - min)`, and the server capacities as a placement overlay (`placement.json`: one pool per server, per-task demands, hard capacity rules). The first release's normalisation collapsed the objective to a constant; see the suite README.

`07_qfbs` contains 5,200 instances generated directly through the HTTP endpoint:

- 2,600 feasibility-guaranteed instances: 26 configurations × 100 seeds.
- 2,600 non-guaranteed instances: the same 26 configurations × 100 seeds, using threshold bands without a satisfiability label.

`experimentation/qacobench/design_matrix.json` fixes every configuration and the base seed. The manifest records each request, response digest, actual counts and observed workflow structure. The campaign requires 15,450 instances before submitting jobs. There is no separate corpus-wide audit or second generation pass.

## ICSOC placement dataset

The source dataset of the ICSOC placement experiment
(`experimentation/icsoc/original_dataset/`) is not stored on the main
development branches. It is published on the separate branch
`data/icsoc-original-dataset` of
[isa-group/OpenBinding](https://github.com/isa-group/OpenBinding); fetch it with
`git fetch origin data/icsoc-original-dataset` and materialize it with
`git archive FETCH_HEAD experimentation/icsoc/original_dataset | tar -x` (or
check it out separately with `git worktree add`).
See [`experimentation/icsoc/README.md`](../experimentation/icsoc/README.md#source-dataset).
The HSC sources under `datasets/sources/hsc/` remain part of this repository.
