# HSC: Hugging Face AI Service Composition Dataset

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
