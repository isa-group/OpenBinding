#!/usr/bin/env python3
"""Generate comprehensive README.md files for all benchmark sources in datasets/sources/."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "datasets" / "sources"

READMES = {}

# 1. CONTINUUM (PROMISE)
READMES["continuum"] = """# PROMISE: Continuum Pricing & Resource Allocation Dataset

## 1. Provenance and Academic Attribution
- **Benchmark Name:** PROMISE (Pricing-driven Resource Allocation for Service Infrastructure Deployment)
- **Target Conference:** *International Conference on Service-Oriented Computing (ICSOC 2026)*
- **Authors:** Francisco Javier Cavero, Jose Antonio Parejo, Antonio Ruiz-Cortes
- **Institution:** ISA Research Group, Universidad de Sevilla, Spain
- **Primary Domain:** Cloud-Edge Continuum, Provider Pricing Models, Infrastructure Resource Allocation
- **License:** Open Academic Research Benchmark License

### BibTeX Citation
```bibtex
@inproceedings{cavero2026promise,
  author    = {Cavero, Francisco Javier and Parejo, Jose Antonio and Ruiz-Cortes, Antonio},
  title     = {Pricing-driven Resource Allocation for Service Infrastructure Deployment},
  booktitle = {Service-Oriented Computing -- ICSOC 2026},
  series    = {Lecture Notes in Computer Science},
  year      = {2026}
}
```

## 2. Dataset Description & Decision Problem
PROMISE addresses multi-cloud and fog-to-cloud continuum configuration and deployment. It optimizes the placement and sizing of distributed service components onto cloud-edge host topologies while explicitly accounting for commercial cloud provider pricing schemes (compute instances, memory tiers, and inter-region data egress costs).

Key constraints and objectives:
- **Host Capacity Bounds:** Hard CPU core and RAM limits across heterogeneous edge and cloud servers.
- **Co-location and Anti-affinity:** Rules preventing conflicting services from sharing physical hosts.
- **Network Transit Limits:** Inter-service latency across WAN/edge-cloud boundaries must satisfy application SLA deadlines.
- **Multi-tiered Pricing:** Cost calculation modeling real-world cloud pricing curves.

## 3. Directory & File Structure
```text
datasets/sources/continuum/
├── README.md                           # Documentation and paper citations
├── problem_instance_pricing.yml        # Formal pricing schemas for continuum nodes
├── sample_problem_instance_pricing.yml # Minimal reproducible pricing configuration snippet
├── scenario_mapping.json               # Mapping index of 9,600 scenarios to topologies
├── topologies/                         # 9,600 topology UUID directories
│   ├── <uuid>/
│   │   ├── infrastructure.json         # Node definitions, capacities, latency matrices
│   │   └── application.json            # Microservice graph and communication flows
├── results.csv                         # Baseline solver solutions, costs, and runtimes
└── evaluation.ipynb                    # Analysis and trade-off visualization notebook
```

## 4. Representation in QACOBench
- **QACOBench status:** Excluded from the admitted seven-suite release; it has no active numeric suite ID.
"""

# 2. HSC (Hugging Face Service Composition)
READMES["hsc"] = """# HSC: Hugging Face AI Service Composition Dataset

## 1. Provenance and Academic Attribution
- **Dataset Name:** HSC (Hugging Face Service Composition Dataset)
- **Primary Paper:** Xiao Wang, Dunlei Rong, Hanchuan Xu, Xiangdong He, Zhongjie Wang. "HSC: An Artificial Intelligence Service Composition Dataset from Hugging Face", *Service-Oriented Computing -- ICSOC 2024*, LNCS 15405, pp. 225-239, Springer, 2025.
- **Institution:** Faculty of Computing, Harbin Institute of Technology, China
- **DOI:** [10.1007/978-981-96-0808-9_17](https://doi.org/10.1007/978-981-96-0808-9_17)
- **Source Repository:** https://github.com/wangxiaohit/HSC (the four JSON files below are the released dataset)
- **License:** CC BY 4.0 (stated in the repository README)

### BibTeX Citation
```bibtex
@inproceedings{wang2024hsc,
  author    = {Wang, Xiao and Rong, Dunlei and Xu, Hanchuan and He, Xiangdong and Wang, Zhongjie},
  title     = {HSC: An Artificial Intelligence Service Composition Dataset from Hugging Face},
  booktitle = {Service-Oriented Computing -- ICSOC 2024},
  series    = {Lecture Notes in Computer Science},
  volume    = {15405},
  pages     = {225--239},
  year      = {2025},
  doi       = {10.1007/978-981-96-0808-9_17}
}
```

## 2. Dataset Description & Decision Problem
HSC bridges the gap between classic web service composition and AI pipelines built from Hugging Face models. The released dataset contains 15,463 models (`normalized_model.json`, one function category per model) and 10,000 LLM-generated composition requirements with natural-language descriptions (`requirements.json`), each with a workflow of 1-10 sequential levels whose levels may run several activities in parallel (`workflow.json`, 1-21 activities), objective weights and constraint values, and the authors' best composition and objective value (`best_solution.json`).

Each model carries six min-max-normalised QoS attributes: `normalized_downloads`, `normalized_likes` (maximised), `normalized_response_times`, `normalized_waiting_times` (minimised), `reliabilities` and `successabilities` (maximised). Aggregation follows Table 3 of the paper: downloads/likes are summed over a parallel level and averaged over the sequence of levels; response/waiting times take the maximum over a parallel level and the average over levels; reliability/successability take the minimum over a parallel level and the geometric mean over levels. The objective (Eq. 1) is the weighted sum of the normalised values of the minimised attributes and of `1 - value` for the maximised ones; every constraint is soft and adds its squared violation to the objective (Eq. 2). The constraint values in `workflow.json` are already multiplied by the paper's scale coefficients `p_j`.

**Reference values.** `best_solution.json` contains the authors' compositions and objective values. Evaluating those compositions on the released `normalized_model.json` with Eq. 1-2 reproduces `best_value` exactly for only a small share of the requirements (about 4% in our audit); the released model file therefore does not seem to be the exact one used to compute the published values. QACOBench keeps them as `reference_binding` / `reference_value` annotations (provenance), not as certified optima.

## 3. Directory & File Structure
```text
datasets/sources/hsc/
├── README.md                           # Documentation and paper citations
├── workflow.json                       # Complex multi-step AI pipeline graph structures
├── requirements.json                   # Explicit QoS requirements and global constraints
├── normalized_model.json               # Hugging Face model registry with benchmarked metrics
└── best_solution.json                  # Reference ground-truth optimal compositions
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/03_hsc_llm/` (10,000 instances, batches of 1,000)
- **Dialect:** Pure core `qos-binding/v1` (sequence aggregations are BIM expressions: mean and geometric mean over the levels; constraints are soft with penalty `K * (g_j - c_j)^2`, which the compiler's `1/K` penalty weights turn into the paper's `sum_j (g_j - c_j)^2`)
- **Transformation Script:** `datasets/scripts/transform_hsc.py` (its verification step checks that the BIM score of the reference composition equals Eq. 1-2 evaluated on the source data)
"""

# 3. QUANTUM
READMES["quantum"] = """# Quantum Resource Selection Benchmark

## Provenance

- **Source:** Adrián Romero-Flores, Alfonso E. Márquez-Chamorro, José Antonio Parejo and Antonio Ruiz-Cortés, *Quantum Resource Selection as a QoS-Aware Composition Problem*, Service-Oriented Computing -- ICSOC 2026 (in press).
- **Archive:** [Zenodo 10.5281/zenodo.21442195](https://doi.org/10.5281/zenodo.21442195).
- **Source files:** `quantumbim.json`, reconstruction and knitting workflow JSON, plus the circuit scaling experiment under `datasets/sources/quantum/`.

## Representation in QACOBench

`datasets/02_quantum/` contains 46 BIM v1 packages: 39 circuit-scaling combinations (three families at 13 source qubit levels), four knitting profiles and three reconstruction profiles. `datasets/scripts/transform_quantum.py` converts the original files without inventing missing observations. The original source and transformed metadata remain available for auditing.
"""

# 4. RPRSR15
READMES["rprsr15"] = """# RPRSR15: Many-Objective Service Composition Benchmark

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
"""

# 5. IOTS
READMES["iots"] = """# IoTS: Internet of Things Service Composition Dataset

## 1. Provenance and Academic Attribution
- **Dataset Name:** IoTS Dataset (Internet of Things Service Composition)
- **Source Repository:** Zenodo [10.5281/zenodo.10440967](https://doi.org/10.5281/zenodo.10440967)
- **Primary Paper:** Z. Tang, Y. Wu, J. Wang, T. Ma. "IoT service composition based on improved Shuffled Frog Leaping Algorithm", *Heliyon*, 10(7):e28087, 2024.
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
"""

# 6. BWS-SCP
READMES["bws_scp"] = """# BWS-SCP: Cloud Manufacturing Business Workflow Service Composition

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
"""

# 7. CLASP (ICSOC Placement)
READMES["clasp"] = """# CLASP: Cloud-Edge FaaS Placement Benchmark

## 1. Provenance and Academic Attribution
- **Benchmark Name:** CLASP (Declarative Secure Placement of FaaS Orchestrations in the Cloud-Edge Continuum)
- **Primary Paper:** Alessandro Bocci, Stefano Forti, Gian-Luigi Ferrari, Antonio Brogi. "Declarative Secure Placement of FaaS Orchestrations in the Cloud-Edge Continuum", *Electronics*, 12(6):1332, 2023.
- **DOI:** [10.3390/electronics12061332](https://doi.org/10.3390/electronics12061332)
- **Target Conference:** *International Conference on Service-Oriented Computing (ICSOC 2026)*
- **Primary Domain:** FaaS Composition, Serverless Edge-to-Cloud Placement, Network Latency Optimization
- **License:** Open Academic Research Benchmark License

### BibTeX Citation
```bibtex
@article{bocci2023placement,
  author    = {Bocci, Alessandro and Forti, Stefano and Ferrari, Gian-Luigi and Brogi, Antonio},
  title     = {Declarative Secure Placement of FaaS Orchestrations in the Cloud-Edge Continuum},
  journal   = {Electronics},
  volume    = {12},
  number    = {6},
  pages     = {1332},
  year      = {2023},
  doi       = {10.3390/electronics12061332}
}
```

## 2. Dataset Description & Decision Problem
CLASP formulates the joint selection and physical placement of serverless (FaaS) workflows onto distributed cloud-edge topologies.

The problem features:
- **Application Orchestrations:** 3 distinct realistic workflows: `arOrch` (Augmented Reality pipeline), `mediaOrch` (Multi-party media transcoding), and `stockOrch` (Financial real-time ticker processing).
- **Physical Infrastructures:** 35 diverse continuum network topologies with heterogeneous node compute capacity (CPU cores, RAM) and network transit latencies.
- **Constraints:** Node capacity boundaries, data residency regulations, and edge-to-cloud hop latency budgets.

## 3. Directory & File Structure
```text
datasets/sources/clasp/
├── README.md                           # Documentation and paper citations
└── (Referenced from experimentation/icsoc/original_dataset/)
    ├── applications.json               # Graph structure and computational requirements
    └── infrastructures/                # 35 infrastructure continuum topologies
```

## 4. Representation in QACOBench
- **QACOBench status:** Excluded from the admitted seven-suite release; it has no active numeric suite ID.
"""

# 8. ICWS (Historical Standard)
READMES["icws"] = """# OpenBinding scenarios (suite `01_icws`)

## 1. Provenance and Academic Attribution
- **Benchmark Name:** OpenBinding scenarios: six literature workflows modelled in OpenBinding and evaluated in the OpenBinding paper (IEEE ICWS 2026); the suite directory keeps the `icws` short name of that venue.
- **Primary Paper:** F. J. Cavero, J. A. Parejo, A. Ruiz-Cortes. "OpenBinding: An Extensible, Plug-and-Play API Gateway for Cross-Engine QACO Solving", *2026 IEEE International Conference on Web Services (ICWS)*, 2026. DOI: [10.1109/ICWS72778.2026.00110](https://doi.org/10.1109/ICWS72778.2026.00110).
- **Workflow origins:** each scenario is named after the publication that introduced the workflow (e.g. the SELF-SERV travel solution of Benatallah et al., the warehouse example of Bultan et al., Pautasso's RESTful e-commerce checkout); the OpenBinding paper documents the sources.
- **License:** Open Academic Benchmark License

### BibTeX Citation
```bibtex
@inproceedings{cavero2026openbinding,
  author    = {Cavero, Francisco Javier and Parejo, Jos{\'e} Antonio and Ruiz-Cort{\'e}s, Antonio},
  title     = {OpenBinding: An Extensible, Plug-and-Play API Gateway for Cross-Engine QACO Solving},
  booktitle = {2026 IEEE International Conference on Web Services (ICWS)},
  year      = {2026},
  doi       = {10.1109/ICWS72778.2026.00110}
}
```

## 2. Dataset Description & Decision Problem
The suite contains 6 literature service composition workflows:
1. `benatallah2002-selfserv-travel-solution-cts-itas`: Travel itinerary planning and flight/hotel booking.
2. `bultan2003-warehouse-example`: E-commerce warehouse order dispatching and inventory management.
3. `cremaschi2018-textbook-access`: University library and student digital resource subscription access.
4. `netedu2020-transport-agency`: Logistics transport agency route allocation.
5. `pautasso2009-restful-ecommerce`: RESTful web checkout and payment fulfillment pipeline.
6. `zhang2014-entertainment-planner-running-example`: Urban event and leisure planner workflow.

Each workflow is evaluated across 8 objective/constraint variants:
`mono_one_hard`, `mono_one_soft`, `mono_utility_hard`, `mono_utility_soft`, `multi_hard`, `multi_soft`, `many_hard`, `many_soft`. The scenarios use five features (cost, execution time, availability, reliability, security) with additive, min and multiplicative aggregations, XOR and repeat blocks (some with expected iteration counts), hard and soft constraints (constant penalties) and provider co-location constraints.

## 3. Directory & File Structure
```text
datasets/sources/icws/
├── README.md                           # Documentation and paper citations
└── (Referenced from experimentation/icws/instances/)
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/01_icws/` (48 instances; the paper calls it "OpenBinding scenarios")
- **Dialect:** Pure core `qos-binding/v1`
- **Transformation Script:** `datasets/scripts/transform_icws.py`
"""

for dir_name, text in READMES.items():
    target_dir = SOURCES / dir_name
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / "README.md"
    target_file.write_text(text, encoding="utf-8")
    print(f"Wrote {target_file}")

print("All READMEs generated successfully.")
