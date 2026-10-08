# ICWS: Foundational QoS Web Service Composition Benchmark

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
