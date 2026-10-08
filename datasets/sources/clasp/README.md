# CLASP: Cloud-Edge FaaS Placement Benchmark

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
