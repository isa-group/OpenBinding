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
- At `spec/baseline` these are still tracked and must be removed by an approved change (not by rewriting history):
  `experimentation/icsoc/original_dataset/` (1,401 files), `datasets/sources/**` (~560 files), `docs/frontend-qa/screenshots/`, `docs/design-handoff/prototype/` (296 files together with `docs/frontend-qa`).
  `frontend/e2e/qa-gallery.spec.ts` and `frontend/src/styles/globals.css` reference those docs paths.

> OPEN QUESTION: are the third-party inputs under `datasets/sources/` (icws, iots, bws_scp, rprsr15, quantum, hsc) "data"
> to remove, or small source inputs to keep (the QACOBench README says source inputs stay versioned)?

## Evidence

`git show origin/feat-isa:experimentation/qacobench/README.md` ("Publication"), `git show origin/feat-isa:output/zenodo/README.md`, `.gitignore`.
