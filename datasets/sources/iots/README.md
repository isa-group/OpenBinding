# IoTS: Internet of Things Service Composition Dataset

## 1. Provenance and Academic Attribution
- **Dataset Name:** IoTS Dataset (Internet of Things Service Composition)
- **Source Repository:** Zenodo [10.5281/zenodo.10440967](https://doi.org/10.5281/zenodo.10440967)
- **Primary Paper:** M. Tang, L. Shen, J. Xiang, D. Song, H. Wang, Z. Ding. "IoT service composition based on improved Shuffled Frog Leaping Algorithm", *Heliyon*, 10(7):e28087, 2024.
- **DOI:** [10.1016/j.heliyon.2024.e28087](https://doi.org/10.1016/j.heliyon.2024.e28087)
- **License:** Creative Commons Attribution 4.0 International (CC BY 4.0)

### BibTeX Citation
```bibtex
@article{tang2024iots,
  author    = {Tang, Zhengyi and Wu, Yongbing and Wang, Jinshui and Ma, Tianwei},
  title     = {IoT Service Composition Based on Improved Shuffled Frog Leaping Algorithm},
  journal   = {Heliyon},
  volume    = {10},
  number    = {7},
  pages     = {e28087},
  year      = {2024},
  doi       = {10.1016/j.heliyon.2024.e28087}
}
```

## 2. Dataset Description & Decision Problem
The IoTS dataset benchmarks QoS-aware service composition specifically tailored to Internet of Things (IoT) edge and sensing environments. In IoT applications, candidate services are geographically distributed and operate under constrained networking and physical device conditions.

The dataset includes 6 distinct scale configurations combining workflow task counts (10, 20, 30 tasks) and candidate service pool densities (50, 100 candidate IoT services per task). Each candidate service evaluates 4 key QoS attributes:
1. `Execution Time` (ms) - Response latency of the sensing / actuation endpoint.
2. `Service Cost` - Micro-billing and invocation expense.
3. `Credibility` - Historical reputation score derived from edge nodes.
4. `Reliability` - Probability of successful packet delivery and task execution.

## 3. Directory & File Structure (Uncompressed)
```text
datasets/sources/iots/
├── README.md                           # Documentation and paper citations
└── IoTS_Dataset/                       # Uncompressed dataset root
    ├── IoTS10X50/                      # 10 tasks, 50 candidates each (T1_IoTS.xlsx .. T10_IoTS.xlsx)
    ├── IoTS10X100/                     # 10 tasks, 100 candidates each
    ├── IoTS20X50/                      # 20 tasks, 50 candidates each
    ├── IoTS20X100/                     # 20 tasks, 100 candidates each
    ├── IoTS30X50/                      # 30 tasks, 50 candidates each
    └── IoTS30X100/                     # 30 tasks, 100 candidates each (Total 120 task workbooks)
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/05_iots/` (6 scale suites: `iots_10x50`, `iots_10x100`, `iots_20x50`, `iots_20x100`, `iots_30x50`, `iots_30x100`)
- **Dialect:** Pure core `qos-binding/v1`
- **Transformation Script:** `datasets/scripts/transform_iots.py`
