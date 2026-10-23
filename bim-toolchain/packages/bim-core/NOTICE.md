# Notice

## License of the code: CC-BY-4.0

The BIM toolchain (`bim-core`, `bim-service`, `bim-client`) is licensed under the
Creative Commons Attribution 4.0 International license (SPDX: `CC-BY-4.0`), the
same license as OpenBinding, the repository this code was extracted from. The
license text is in `LICENSE`; the license deed is
<https://creativecommons.org/licenses/by/4.0/> and the legal code is
<https://creativecommons.org/licenses/by/4.0/legalcode>.

Holder: javiercavlop (titular del repositorio OpenBinding). The legal name of the
holder is not recorded in the repository and none has been inferred.

Attribution: when you share or adapt this material, credit the holder, link the
license and indicate whether changes were made.

Scope: the license covers the material written for this repository (sources,
tests, tools, documentation, contracts and goldens). It does **not** cover the
OMG BPMN schemas below, the third-party dependencies, or the material credited in
`THIRD_PARTY_NOTICES.md`. `licenses.json` records the scope and the SPDX identifier
once per repository; `docs/LICENSING.md` explains it.

A technical note, recorded as a risk and not as a change of decision: CC BY 4.0 is
not designed for software (it says nothing about patents and does not define source
code or distribution of binaries). The holder chose it on purpose, for consistency
with OpenBinding; see `docs/LICENSING.md`.

## OMG BPMN 2.0.2 schemas: rights not demonstrated

The XML Schemas published by the Object Management Group for BPMN 2.0.2 (`BPMN20.xsd`,
`Semantic.xsd`, `BPMNDI.xsd`, `DC.xsd`, `DI.xsd`) go in
`packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/`, next to the
`README.md` that came with them. They are **not** covered by the license above. Read
byte by byte, none of the five files contains a copyright or license notice
(`docs/OMG_XSD_RIGHTS.md`), and the terms under which OMG allows them to be
redistributed have not been demonstrated. For that reason the repository does not
version them: every build downloads them from omg.org over https and verifies their
SHA-256, and writes nothing unless all five match. The wheels, sdists, SDK and images
built from this repository do carry them, byte for byte as downloaded; keeping them
in the artifacts is a decision of the owner.

## Datasets

No dataset is redistributed here. The goldens in `golden/` contain only digests and
numeric summaries derived from evaluations. The corpus of BIM packages used to
regenerate them stays in OpenBinding and is located through `BIM_CORPUS_ROOT`.
