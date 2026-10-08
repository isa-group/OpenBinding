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
- **Primary Conference:** *International Conference on Service-Oriented Computing (ICSOC 2024 / 2025)*
- **Authors:** Xiao Wang, Dunlei Rong, Hanchuan Xu, Xiangdong He, Zhongjie Wang
- **Institution:** Harbin Institute of Technology, China
- **DOI:** [10.1007/978-981-96-0808-9_17](https://doi.org/10.1007/978-981-96-0808-9_17)
- **Source Repository:** https://github.com/HSC-Dataset/HSC
- **License:** Open Research Benchmark License

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
HSC bridges the gap between classic web service composition and modern artificial intelligence pipelines. The dataset mines real-world AI pipeline models from the Hugging Face hub across multiple modalities (computer vision, natural language processing, speech synthesis, translation, and multimodal reasoning).

Each instance defines:
- A multi-stage AI workflow DAG with candidate model alternatives for each processing step.
- Real-world measured QoS metrics: Latency (inference time), Memory Footprint, Throughput, and Model Accuracy.
- Global constraints on total pipeline latency and resource consumption.

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
- **Admitted Suite:** `datasets/03_hsc_llm/` (10,000 instances)
- **Dialect:** Pure core `qos-binding/v1`
- **Transformation Script:** `datasets/scripts/transform_hsc.py`
"""

# 3. QUANTUM
READMES["quantum"] = """# Quantum Resource Selection Benchmark

## Provenance

- **Source:** Adrián Romero-Flores, Alfonso E. Márquez-Chamorro and Antonio Ruiz-Cortés, *Quantum Resource Selection as a QoS-Aware Composition Problem* (2026).
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
"""

# 5. IOTS
READMES["iots"] = """# IoTS: Internet of Things Service Composition Dataset

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
"""

# 6. BWS-SCP
READMES["bws_scp"] = """# BWS-SCP: Cloud Manufacturing Business Workflow Service Composition

## 1. Provenance and Academic Attribution
- **Benchmark Name:** BWS-SCP (Business Workflow Service Composition Problem in Cloud Manufacturing)
- **Source Repository:** https://github.com/FMahroo/BWS-SCP
- **Primary Paper:** Fatemeh Mahroo, Mohammad Reza Vasili, Ali Asghar Rahmani Hosseinabadi, Seyed Mohammad Razavi. "Reliability-centric cloud manufacturing business workflow service composition problem", *Computers & Industrial Engineering*, 203:111603, 2025/2026.
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
    └── data/                           # 90 problem instance files (.scp format)
        ├── small/                      # Small scale test cases
        ├── medium/                     # Medium scale test cases
        ├── large/                      # Large scale test cases (up to 160 tasks, 160 servers)
        └── validation/                 # Analytical validation cases
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/06_bws_scp/` (90 instances)
- **Dialect:** Pure core `qos-binding/v1` with server qualification constraints
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
READMES["icws"] = """# ICWS: Foundational QoS Web Service Composition Benchmark

## 1. Provenance and Academic Attribution
- **Benchmark Name:** ICWS 2007 / Zeng 2004 Foundational QoS Composition Scenarios
- **Primary Papers:**
  - L. Zeng, B. Benatallah, A. H. H. Ngu, M. Dumas, J. Kalagnanam, H. Chang. "QoS-Aware Middleware for Web Services Composition", *IEEE Transactions on Software Engineering*, 30(5):311-327, 2004. DOI: [10.1109/TSE.2004.11](https://doi.org/10.1109/TSE.2004.11).
  - M. Alrifai, T. Risse, P. Dolog. "A hybrid approach for efficient Web service selection with end-to-end QoS constraints", *Proceedings of the 18th International Conference on World Wide Web (WWW 2009)*, pp. 71-80, 2009. DOI: [10.1145/1526709.1526723](https://doi.org/10.1145/1526709.1526723).
- **License:** Open Academic Benchmark License

### BibTeX Citations
```bibtex
@article{zeng2004middleware,
  author    = {Zeng, Liangzhao and Benatallah, Boualem and Ngu, Anne H. H. and Dumas, Marlon and Kalagnanam, Jayant and Chang, Henry},
  title     = {QoS-Aware Middleware for Web Services Composition},
  journal   = {IEEE Transactions on Software Engineering},
  volume    = {30},
  number    = {5},
  pages     = {311--327},
  year      = {2004},
  doi       = {10.1109/TSE.2004.11}
}
```

## 2. Dataset Description & Decision Problem
The foundational benchmark collection represents 6 canonical literature service composition workflows:
1. `benatallah2002-selfserv-travel-solution-cts-itas`: Travel itinerary planning and flight/hotel booking.
2. `bultan2003-warehouse-example`: E-commerce warehouse order dispatching and inventory management.
3. `cremaschi2018-textbook-access`: University library and student digital resource subscription access.
4. `netedu2020-transport-agency`: Logistics transport agency route allocation.
5. `pautasso2009-restful-ecommerce`: RESTful web checkout and payment fulfillment pipeline.
6. `zhang2014-entertainment-planner-running-example`: Urban event and leisure planner workflow.

Each workflow is evaluated across 8 objective/constraint variants:
`mono_one_hard`, `mono_one_soft`, `mono_utility_hard`, `mono_utility_soft`, `multi_hard`, `multi_soft`, `many_hard`, `many_soft`.

## 3. Directory & File Structure
```text
datasets/sources/icws/
├── README.md                           # Documentation and paper citations
└── (Referenced from experimentation/icws/instances/)
```

## 4. Representation in QACOBench
- **Admitted Suite:** `datasets/01_icws/` (48 instances)
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
