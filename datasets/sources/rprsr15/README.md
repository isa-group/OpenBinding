# RPRSR15: Many-Objective Service Composition Benchmark

## 1. Provenance and Academic Attribution
- **Dataset Name:** RPRSR15 (Ramirez, Parejo, Romero, Simons, Ruiz-Cortes 2015/2017)
- **Source Web:** https://www.uco.es/grupos/kdis/sbse/RPRSR15/
- **Primary Paper:** J. Ramirez, J. R. Romero, C. Simons. "Evolutionary composition of QoS-aware web services: a many-objective perspective", *Expert Systems with Applications*, 72:357-370, 2017.
- **DOI:** [10.1016/j.eswa.2016.10.047](https://doi.org/10.1016/j.eswa.2016.10.047)
- **Instance Generator Paper:** J. A. Parejo, S. Segura, P. Fernandez, A. Ruiz-Cortes. "QoS-aware web services composition using GRASP with path relinking", *Expert Systems with Applications*, 41(9):4211-4223, 2014.
- **DOI:** [10.1016/j.eswa.2013.12.036](https://doi.org/10.1016/j.eswa.2013.12.036)
- **License:** Open Academic Benchmark License

### BibTeX Citations
```bibtex
@article{ramirez2017many,
  author    = {Ramirez, Aurora and Parejo, Jose Antonio and Romero, Jose Raul and Segura, Sergio and Ruiz-Cortes, Antonio},
  title     = {Evolutionary Composition of QoS-Aware Web Services: A Many-Objective Perspective},
  journal   = {Expert Systems with Applications},
  volume    = {72},
  pages     = {357--370},
  year      = {2017},
  doi       = {10.1016/j.eswa.2016.10.047}
}

@article{parejo2014grasp,
  author    = {Parejo, Jose Antonio and Segura, Sergio and Fernandez, Pablo and Ruiz-Cortes, Antonio},
  title     = {QoS-Aware Web Services Composition Using GRASP with Path Relinking},
  journal   = {Expert Systems with Applications},
  volume    = {41},
  number    = {9},
  pages     = {4211--4223},
  year      = {2014},
  doi       = {10.1016/j.eswa.2013.12.036}
}
```

## 2. Dataset Description & Decision Problem
RPRSR15 provides 60 published problem instances for Quality-Aware Service Composition evaluating both mono-objective, multi-objective, and many-objective optimization techniques. Workflows feature complex block structures including sequential composition (`SEC[...]`) and conditional exclusive branching (`BRANCH(p1, p2)[...]`) with execution probabilities.

Candidate pools are populated with real-world web service measurements from the QWS dataset across 9 distinct QoS dimensions:
1. `throughput` (maximize, min aggregation)
2. `availability` (maximize, product aggregation)
3. `latency` (minimize, sum aggregation)
4. `documentation` (maximize, min aggregation)
5. `successability` (maximize, product aggregation)
6. `bestpractices` (maximize, min aggregation)
7. `reliability` (maximize, product aggregation)
8. `responsetime` (minimize, sum aggregation)
9. `compliance` (maximize, min aggregation)

## 3. Directory & File Structure (Uncompressed)
```text
datasets/sources/rprsr15/
├── README.md                           # Documentation and paper citations
├── experiment1/                        # 15 instances varying workflow scale and candidate density
│   ├── instance-aws10-mark0-str0.txt
│   ├── instance-aws20-mark0-str0.txt
│   └── ...
└── experiment2/                        # 45 instances evaluating branch complexity and constraints
    ├── instance-aws10-mark0-str1.txt
    └── ...
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/04_rprsr15/` (60 instances)
- **Dialect:** Pure core `qos-binding/v1` with `RoutingOverlay` for branch execution probabilities
- **Transformation Script:** `datasets/scripts/transform_rprsr15.py`
