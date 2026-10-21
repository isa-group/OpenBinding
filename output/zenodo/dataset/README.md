# QACOBench BIM dataset

Version 1.1.1. Companion to *QACOBench: A Reusable Benchmark Suite for QoS-Aware Service Composition* (BenchSOC@ICSOC 2026).

Authors: Francisco Javier Cavero, José Antonio Parejo and Antonio Ruiz-Cortés.
SCORE Lab, I3US Institute, Universidad de Sevilla.

The dataset contains 15,450 BIM v1 instances in seven suites.

| Directory | Instances | Source/type |
|---|---:|---|
| `01_icws` | 48 | OpenBinding literature scenarios |
| `02_quantum` | 46 | Quantum resource selection |
| `03_hsc_llm` | 10,000 | HSC: Hugging Face AI-service workflows |
| `04_rprsr15` | 60 | RPRSR15 service-composition instances |
| `05_iots` | 6 | IoT service composition |
| `06_bws_scp` | 90 | Cloud-manufacturing service composition |
| `07_qfbs` | 5,200 | QACOForge Benchmarking Suite (QFBS) |
| **Total** | **15,450** | |

`03_hsc_llm`, `04_rprsr15` and `06_bws_scp` use source-faithful encodings (soft
squared-violation penalties for HSC; source branch probabilities, loops,
probability-scaled availability/successability and attained normalisation ranges
for RPRSR15; the MILP objective with log-reliability and server capacities as a
placement overlay for BWS-SCP). Each of their packages records the fidelity facts
(`source_objective`, `objective_weights`, `attained_extremes`, aggregation and value
conventions, reference solutions) in `benchmark-metadata.json`.

Every package of the six recovered suites carries `benchmark-metadata.json`
(`qacobench/v2`): suite and instance identity, admission class, the provenance
of the source benchmark, the transformer's fidelity annotations, the SHA-256 of
each resource and the package digest recorded by the campaign.

Each instance is rooted at `instance.json`. Its package contains the referenced
application, candidate, constraint, optimization and any additional BIM resources.
Existing instance metadata and the QFBS generation manifest are preserved.
QFBS has 2,600 feasibility-guaranteed and 2,600 non-guaranteed instances;
non-guaranteed instances do not have a satisfiability label by construction.

## Use

For standalone use, extract the archive and access the packages under `datasets/`.
For reproduction with OpenBinding, first extract the companion software archive
and then extract this archive into the same directory. The paths match the
software's existing experiment configuration.

Code, original source inputs, transformation and generation settings, solver
execution records and analyses are provided by the separate software artifact.

## License and attribution

CC BY 4.0 applies to the original contributions. Reused third-party material retains its original rights and license terms; see the included attribution and license notices.
See `datasets/LICENSE`, `datasets/ATTRIBUTION.md` and `datasets/licenses/`.
