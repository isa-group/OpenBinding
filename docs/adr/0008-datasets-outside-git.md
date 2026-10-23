Status: DRAFT for owner review (2026-10-21)

# ADR-0008: Datasets, raw results and bulky artefacts live outside Git

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner (QACOBench 1.1.1 README; factory brief §3)

## Context and problem

The QACOBench corpus (15,450 BIM packages) and its 46,350 raw records are gigabytes; the ICSOC original dataset has
~1,400 files; QA screenshots and the design prototype are tens of MB. Git history is permanent and public.

## Decision

- QACOBench software and BIM dataset are Zenodo deposits (reserved DOIs 10.5281/zenodo.23336988 and 10.5281/zenodo.23337038), built by `tools/package_zenodo.sh` and verified by checksums.
- The original ICSOC dataset lives on the branch `data/icsoc-original-dataset`.
- Git keeps source inputs' READMEs, transformation scripts, generators, tests, compact versioned reference results
  (`experimentation/qacobench/reference/<version>/`) and analysis scripts. QA screenshots and design prototypes are not in the repository.

## Consequences

- Default test suites never require the datasets.
- Applied by the integration (912648c): `experimentation/icsoc/original_dataset/` (1,401 files, ~980 MiB) moved to the
  branch `data/icsoc-original-dataset` (b5c5589; CI materializes it when published, tests skip without it);
  `docs/frontend-qa/` and `docs/design-handoff/` removed and ignored (dea9591; the QA gallery writes to `QA_GALLERY_DIR`).
  History was not rewritten.
- The source inputs under `datasets/sources/` (~560 files) stay versioned, as the QACOBench 1.1.1 README states; they also
  travel in the Zenodo software deposit.


## Evidence

`experimentation/qacobench/README.md` ("Publication"), `output/zenodo/README.md`, `tools/package_zenodo.sh`, `experimentation/icsoc/README.md`, `.gitignore`; owner decision 2026-10-21.
