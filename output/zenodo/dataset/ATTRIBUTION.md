# QACOBench dataset attribution

QACOBench harmonizes research artifacts into BIM and adds the generated QFBS
suite. Source identity and transformation/generation metadata are retained
inside the packages. The software artifact contains the original inputs,
transformation scripts and source-specific bibliographic documentation.

| Suite | Source and attribution |
|---|---|
| `01_icws` | OpenBinding literature scenarios, with scenario provenance retained in the instance packages. Source repository: https://github.com/isa-group/OpenBinding |
| `02_quantum` | Adrián Romero-Flores, Alfonso E. Márquez-Chamorro, José Antonio Parejo and Antonio Ruiz-Cortés, *Quantum Resource Selection as a QoS-Aware Composition Problem* (2026). Supplementary artifact: https://doi.org/10.5281/zenodo.21442195 |
| `03_hsc_llm` | Xiao Wang, Dunlei Rong, Hanchuan Xu, Xiangdong He and Zhongjie Wang, *HSC: An Artificial Intelligence Service Composition Dataset from Hugging Face* (ICSOC 2024). Source repository (CC BY 4.0): https://github.com/wangxiaohit/HSC ; paper: https://doi.org/10.1007/978-981-96-0808-9_17 |
| `04_rprsr15` | RPRSR15 research benchmark: https://www.uco.es/grupos/kdis/sbse/RPRSR15/ . Candidate measurements derive from QWS: https://www.uoguelph.ca/~qmahmoud/qws/ |
| `05_iots` | IoTS source dataset: https://doi.org/10.5281/zenodo.10440967 |
| `06_bws_scp` | BWS-SCP source repository: https://github.com/FMahroo/BWS-SCP . The upstream MIT license is included at `datasets/licenses/BWS-SCP-LICENSE`. |
| `07_qfbs` | Generated with QACOForge by Francisco Javier Cavero, José Antonio Parejo and Antonio Ruiz-Cortés. Generation requests, seeds and metadata are in `07_qfbs/manifest.jsonl`; code and design settings are in the software artifact. |

CC BY 4.0 applies to the original QACOBench contributions. Source material
retains its original rights and terms; inclusion does not replace upstream
licenses or grant new rights over third-party material.
