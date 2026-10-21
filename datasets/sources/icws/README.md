# OpenBinding scenarios (suite `01_icws`)

## 1. Provenance and Academic Attribution
- **Benchmark Name:** OpenBinding scenarios: six literature workflows modelled in OpenBinding and evaluated in the OpenBinding paper (IEEE ICWS 2026); the suite directory keeps the `icws` short name of that venue.
- **Primary Paper:** F. J. Cavero, J. A. Parejo, A. Ruiz-Cortes. "OpenBinding: An Extensible, Plug-and-Play API Gateway for Cross-Engine QACO Solving", *2026 IEEE International Conference on Web Services (ICWS)*, 2026. DOI: [10.1109/ICWS72778.2026.00110](https://doi.org/10.1109/ICWS72778.2026.00110).
- **Workflow origins:** each scenario is named after the publication that introduced the workflow (e.g. the SELF-SERV travel solution of Benatallah et al., the warehouse example of Bultan et al., Pautasso's RESTful e-commerce checkout); the OpenBinding paper documents the sources.
- **License:** Open Academic Benchmark License

### BibTeX Citation
```bibtex
@inproceedings{cavero2026openbinding,
  author    = {Cavero, Francisco Javier and Parejo, Jos{'e} Antonio and Ruiz-Cort{'e}s, Antonio},
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
