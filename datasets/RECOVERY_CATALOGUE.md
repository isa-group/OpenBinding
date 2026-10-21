# QACOBench recovery catalogue

## Admitted release suites

| ID | Dataset | Instances | Admission |
|---|---|---:|---|
| `01_icws` | OpenBinding scenarios (Cavero et al., ICWS 2026) | 48 | Complete QACO |
| `02_quantum` | Quantum service selection (Romero-Flores et al., 2026) | 46 | Related QACO |
| `03_hsc_llm` | HSC (Wang et al., ICSOC 2024) | 10,000 | Derived composition |
| `04_rprsr15` | RPRSR15 (Ramírez et al., ESWA 2017) | 60 | Complete QACO |
| `05_iots` | IoTS (Tang et al., Heliyon 2024) | 6 | Complete QACO |
| `06_bws_scp` | BWS-SCP (Mahroo et al., CIE 2026) | 90 | Placement-aware QACO |
| `07_qfbs` | QFBS HTTP workload | 5,200 | Synthetic benchmark |

The admitted corpus contains exactly 15,450 canonical BIM v1 instances. IDs are consecutive and have no reserved gaps. The structured provenance of every suite (`recovery_catalogue.json`, version `qacobench/v2`) is the single source for the per-package `benchmark-metadata.json` written by `scripts/write_benchmark_metadata.py` and for `sources/*/README.md`; the first release carried attributions that did not match the sources (see the revision notes in those READMEs).

## Classified but not admitted

- QWS and WS-DREAM: QoS observation catalogues without fixed workflow and binding instances.
- WSC and WSBen: semantic discovery/composition benchmarks whose primary task is workflow discovery rather than binding optimization over a fixed workflow.

Excluded sources retain their provenance records in `recovery_catalogue.json` but do not receive an active numeric suite ID.

## Admission invariants

An admitted package must define a fixed workflow, task-to-candidate eligibility, QoS features, constraints where applicable, and an optimization contract that compiles to BIM v1 without inventing missing scientific structure. Transformations preserve source workflow semantics and record deterministic provenance hashes.

QFBS contributes 2,600 feasibility-guaranteed and 2,600 non-guaranteed instances, each generated directly by the HTTP API. Both groups use the same 26 configurations and 100 seeds per configuration. The non-guaranteed group has no satisfiability label by construction. HSC-LLM keeps individual activities and within-level parallelism instead of collapsing a level into a single task.
