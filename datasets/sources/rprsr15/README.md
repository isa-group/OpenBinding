# RPRSR15: Many-Objective Service Composition Benchmark

## 1. Provenance and Academic Attribution
- **Dataset Name:** RPRSR15 (Ramirez, Parejo, Romero, Simons, Ruiz-Cortes 2015/2017)
- **Source Web:** https://www.uco.es/grupos/kdis/sbse/RPRSR15/
- **Primary Paper:** A. Ramirez, J. A. Parejo, J. R. Romero, S. Segura, A. Ruiz-Cortes. "Evolutionary composition of QoS-aware web services: a many-objective perspective", *Expert Systems with Applications*, 72:357-370, 2017.
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
RPRSR15 provides 60 published problem instances for Quality-Aware Service Composition evaluating mono-objective, multi-objective and many-objective optimization techniques. Workflows feature sequential composition (`SEC[...]`), conditional exclusive branching with execution probabilities (`BRANCH(p1;p2;...)[...]`) and, in 26 of the 60 files, loops with an iteration count (`LOOP(k)[...]`). Every file declares its own QoS model (attribute ranges, aggregation functions per structure and objective weights, which are all zero: the benchmark is many-objective).

Candidate pools are populated with real-world web service measurements from the QWS dataset across 9 QoS dimensions, with the aggregation functions declared in the files (sequence / parallel flow / branch / loop):
1. `throughput` (maximize; MIN / MIN / MIN / SUMPOW)
2. `availability` (maximize; PRODUCT / PRODUCT / POW / SUMPOW)
3. `latency` (minimize, stored negated; SUM / MINAVG / SUMPOW / SUMPOW)
4. `documentation` (maximize; AVG / AVG / AVG / AVG)
5. `successability` (maximize; PRODUCT / PRODUCT / POW / SUMPOW)
6. `bestpractices` (maximize; AVG / AVG / AVG / SUMPOW)
7. `reliability` (maximize; MIN / MIN / MIN / SUMPOW)
8. `responsetime` (minimize, stored negated; SUM / MIN / SUMPOW / SUMPOW)
9. `compliance` (maximize; AVG / AVG / AVG / SUMPOW)

`SUMPOW` on a branch is the probability-weighted sum, `POW` the probability-weighted product. None of the files declares constraints.

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
- **Dialect:** Pure core `qos-binding/v1` with `RoutingOverlay` for the declared branch probabilities and exact `repeat` nodes for loops
- **Transformation Script:** `datasets/scripts/transform_rprsr15.py`. It reads the per-file QoS model: `SUM`/`PRODUCT`/`MIN` map to the BIM operators, `SUMPOW`/`POW` to probability-weighted sum/product, loops scale additive attributes and raise multiplicative ones to the iteration count (MIN and AVG attributes are invariant under repetition). `AVG` is lowered exactly by folding the `1/|children|` factor of every enclosing sequence into the candidate values (`avg_prescale` annotation) and aggregating with sums. Availability and successability percentages are rescaled to `[0, 1]` so that products are probabilities; latency and response time use the absolute values of the negated source attributes. The optimisation keeps the nine attributes with equal weights, each normalised by its attained extremes (exact, since every aggregation is monotone in each service's value); the `attained_extremes` annotation records them.
