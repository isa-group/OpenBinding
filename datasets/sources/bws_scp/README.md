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
  author    = {Mahroo, Fatemeh and Moradi, Nima and Aftabi, Navid and Houshmand, Mahmoud and Fatahi Valilai, Omid},
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

Features of the formulation:
- **Server Placement & Capacities:** Servers have finite workload capacities (`CAPACITY_SECTION`) while tasks demand varying processing units (`DEMAND_SECTION`).
- **Dynamic Pricing Functions:** Candidate worker pricing combines fixed setup costs with variable hourly rates based on parameters alpha and beta.
- **Tri-Criteria QoS:** Execution Time (makespan), Cost, and Reliability.

## 3. Directory & File Structure (Uncompressed)
```text
datasets/sources/bws_scp/
├── README.md                           # Documentation and paper citations
└── BWS-SCP-main/                       # Uncompressed repository root
    ├── LICENSE                         # MIT License
    ├── SA_code.py                      # Original Simulated Annealing algorithm
    ├── batch_solve.py                  # Batch execution script
    ├── bisection.py                    # Bisection search solver
    └── data/                           # 90 .scp files: 70 main, 14 scenarios, 6 validation
        ├── small/                      # Small scale test cases
        ├── medium/                     # Medium scale test cases
        ├── large/                      # Large scale test cases (up to 160 tasks, 160 servers)
        └── validation/                 # Analytical validation cases
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/06_bws_scp/` (90 instances)
- **Dialect:** Pure core `qos-binding/v1` with server qualification constraints
- **Transformation Script:** `datasets/scripts/transform_bws_scp.py`
