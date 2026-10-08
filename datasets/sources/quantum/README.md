# Quantum Resource Selection Benchmark

## Provenance

- **Source:** Adrián Romero-Flores, Alfonso E. Márquez-Chamorro, José Antonio Parejo and Antonio Ruiz-Cortés, *Quantum Resource Selection as a QoS-Aware Composition Problem* (2026).
- **Archive:** [Zenodo concept DOI 10.5281/zenodo.21442195](https://doi.org/10.5281/zenodo.21442195), which points to the latest version of the supplementary artifact.
- **Source files:** `quantumbim.json`, reconstruction and knitting workflow JSON, plus the circuit scaling experiment under `datasets/sources/quantum/`.

## Representation in QACOBench

`datasets/02_quantum/` contains 46 BIM v1 packages: 39 circuit-scaling combinations (three families at 13 source qubit levels), four knitting profiles and three reconstruction profiles. `datasets/scripts/transform_quantum.py` converts the original files without inventing missing observations. The original source and transformed metadata remain available for auditing.
