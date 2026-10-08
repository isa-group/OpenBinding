# HSC: Hugging Face AI Service Composition Dataset

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
