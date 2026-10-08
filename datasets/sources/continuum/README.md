# PROMISE: Continuum Pricing & Resource Allocation Dataset

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
