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

`03_hsc_llm` preserves sequential levels and parallel activities, uses one task per source activity, and retains the source per-activity reference binding. Its aggregation rules follow the source benchmark; engines that cannot execute those rules are reported as incompatible.

`07_qfbs` contains 5,200 instances generated directly through the HTTP endpoint:

- 2,600 feasibility-guaranteed instances: 26 configurations × 100 seeds.
- 2,600 non-guaranteed instances: the same 26 configurations × 100 seeds, using threshold bands without a satisfiability label.

`experimentation/qacobench/design_matrix.json` fixes every configuration and the base seed. The manifest records each request, response digest, actual counts and observed workflow structure. The campaign requires 15,450 instances before submitting jobs. There is no separate corpus-wide audit or second generation pass.
