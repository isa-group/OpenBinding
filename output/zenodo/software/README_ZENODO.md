# QACOBench software artifact

Version 1.1.1. Companion to *QACOBench: A Reusable Benchmark Suite for QoS-Aware Service Composition* (BenchSOC@ICSOC 2026).

Authors: Francisco Javier Cavero, José Antonio Parejo and Antonio Ruiz-Cortés.
SCORE Lab, I3US Institute, Universidad de Sevilla.

This archive contains the OpenBinding repository (gateway, solver engines, QACOForge
generator, BIM schemas, original benchmark source inputs, transformation scripts, Docker
configuration, QFBS design settings, documentation and experiment notebooks) and the
recorded QACOBench campaign outputs. The final seven-suite BIM corpus is provided
in the separate `qacobench-bim-dataset-1.1.1.tar.xz` archive.

## Use

1. Extract `qacobench-software-1.1.1.tar.xz` into an empty directory.
2. Extract `qacobench-bim-dataset-1.1.1.tar.xz` into that same directory.
   Its seven suites will appear under `datasets/`.
3. See `README.md` for OpenBinding and `experimentation/qacobench/README.md`
   for the experiment workflow. Docker and Docker Compose are required to
   execute the isolated experiment.

The exact engine (`engines/minizinc-csp`) pins MiniZinc 2.8.7 / Gecode 6.3.0; the
engine revisions, solver options and budgets used by the shipped campaign are
recorded in `.artifacts/qacobench/run_manifest.json`.

The recorded results are at `.artifacts/qacobench/results.jsonl`; evaluation
tables, figures and executed notebooks are in the corresponding subdirectories.
They can be inspected without rerunning the campaign. For running the existing
analysis commands, follow the experiment README after extracting both archives.

To reconstruct the recovered suites instead of using the dataset archive,
see `datasets/README.md` and the scripts in `datasets/scripts/`.

## License and attribution

CC BY 4.0 applies to the original contributions. Reused third-party material retains its original rights and license terms; see the included attribution and license notices.
See `LICENSE`, `THIRD_PARTY_NOTICES.md` and `datasets/sources/*/README.md`.
