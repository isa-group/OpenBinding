# Notice

## License of the code: pending

The license of the BIM toolchain code has **not been decided**. The holder of the
rights has yet to choose it. Until then no license is granted by this notice and
none is declared in the package metadata; nothing in this directory should be
read as a statement that the code is open source or proprietary.

`LICENSE` (Creative Commons Attribution 4.0 International) and
`THIRD_PARTY_NOTICES.md` are copied unchanged from OpenBinding, the repository
this code was extracted from. They are kept so that no existing notice is lost;
the CC BY 4.0 text is the license of OpenBinding's content at the time of the
copy and is not a decision about this code's future license.

## OMG BPMN 2.0.2 schemas

`packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/` contains the
normative XML Schemas of OMG BPMN 2.0.2 (`BPMN20.xsd`, `Semantic.xsd`,
`BPMNDI.xsd`, `DC.xsd`, `DI.xsd`) together with the `README.md` that came with
them. The copyright and license notices inside those files belong to the Object
Management Group and are preserved byte for byte; do not edit or strip them.

## Datasets

No dataset is redistributed here. The baseline goldens in `golden/bim_baseline/`
contain only digests and numeric summaries derived from evaluations. The corpus of
BIM packages used to regenerate them stays in OpenBinding and is located through
`BIM_CORPUS_ROOT`.
