# BWS-SCP: Cloud Manufacturing Business Workflow Service Composition

## 1. Provenance and Academic Attribution
- **Benchmark Name:** BWS-SCP (Business Workflow Service Composition Problem in Cloud Manufacturing)
- **Source Repository:** https://github.com/FMahroo/BWS-SCP
- **Primary Paper:** Fatemeh Mahroo, Nima Moradi, Navid Aftabi, Mahmoud Houshmand, Omid Fatahi Valilai. "A Novel Integer Linear Model for Reliability-Centric Service Composition in Cloud Manufacturing", *Computers & Industrial Engineering*, 211:111603, 2026.
- **DOI:** [10.1016/j.cie.2025.111603](https://doi.org/10.1016/j.cie.2025.111603)
- **License:** MIT License

### BibTeX Citation
```bibtex
@article{mahroo2026bws,
  author    = {Mahroo, Fatemeh and Moradi, Nima and Aftabi, Navid and Houshmand, Mahmoud and Valilai, Omid Fatahi},
  title     = {A Novel Integer Linear Model for Reliability-Centric Service Composition in Cloud Manufacturing},
  journal   = {Computers & Industrial Engineering},
  volume    = {211},
  pages     = {111603},
  year      = {2026},
  doi       = {10.1016/j.cie.2025.111603}
}
```

## 2. Dataset Description & Decision Problem
BWS-SCP models cloud manufacturing supply chains where manufacturing tasks (e.g. CNC machining, 3D printing, laser cutting, automated inspection) must be dynamically bound to candidate manufacturing cloud servers (workers/enterprises).

Features of the formulation (`milp.py` in the repository is the reference model):
- **Server Placement & Capacities:** Servers have finite workload capacities (`CAPACITY_SECTION`) while tasks demand processing units (`DEMAND_SECTION`); the load assigned to a server may not exceed its capacity.
- **Objective:** the MILP minimises `W1 * sum(T) + W2 * sum(C) - W3 * sum(log r)`, i.e. total time, total cost and the logarithm of the composite reliability (the classical logarithmic linearisation of the product), each weighted by the reciprocal of its attained range (`T_max - T_min`, etc.).
- **Time-dependent cost scenarios** (`ALPHA`/`BETA` sections, 14 files): `C = sum alpha_j T_ij x_ij + sum_j beta_j n_j^2` with `n_j` tasks on server `j`.

## 3. Directory & File Structure (Uncompressed)
```text
datasets/sources/bws_scp/
├── README.md                           # Documentation and paper citations
└── BWS-SCP-main/                       # Uncompressed repository root
    ├── LICENSE                         # MIT License
    ├── SA_code.py                      # Original Simulated Annealing algorithm
    ├── batch_solve.py                  # Batch execution script
    ├── bisection.py                    # Bisection search solver
    └── data/                           # 90 problem instance files (.scp format)
        ├── small/                      # 20 small instances (5-14 tasks)
        ├── medium/                     # 20 medium instances (15-95 tasks)
        ├── large/                      # 30 large instances (100-240 tasks, up to 240 servers)
        ├── scenario/                   # 14 alpha/beta time-dependent-cost scenarios (20 tasks)
        └── validation/                 # 6 analytical validation cases
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/06_bws_scp/` (90 instances)
- **Dialect:** `qos-binding/v1` plus the `qos-binding-placement/v1` overlay: one pool per server (`units` capacity from `CAPACITY_SECTION`), one demand per (task, server) candidate (`units` from `DEMAND_SECTION`) and a selected-candidate capacity rule, which is the MILP's server capacity constraint.
- **Objective:** three criteria normalised by the attained extremes, as in the MILP: `execution_time` (sum), `cost` (sum) and `log_reliability` (sum of `ln r`, maximised). The composite reliability is also kept as the multiplicative feature `reliability` for reporting. For the 14 alpha/beta scenarios the quadratic server-load term is linearised as a per-assignment charge `beta_j` (annotation `cost_model = alpha_time_plus_beta_linearised`); those instances are composition problems in their own right but their optima are not those of the source MINLP. The other 76 instances are exact.
- **Transformation Script:** `datasets/scripts/transform_bws_scp.py`
