# 0028. Study runs freeze their definitions

- Status: accepted
- Date: 2026-11-14 (F0b, decision D7 of the F0b implementation plan)

## Context

Study definitions used to be sealed into the versioned-artifact store, which F0b removed. A study run must not change
when its study is edited, and cells launch lazily, so a toolchain release in the middle of a run could otherwise mix
IRs within one run.

## Decision

`studies.definition` is the editable current matrix, changed under `If-Match`. `study_runs.definition`, with its
`definition_digest`, is the frozen copy written when the run is created; it names each problem revision and the
compilation the run uses. `study_cells.compilation_id` is pinned at run creation (composite foreign key with the
revision). Both are protected by triggers. Re-running an old matrix means PATCHing the study's definition from
`getStudyRun`; there is no version picker, because there is no store.

## Consequences

- A revision the toolchain cannot compile refuses the whole run (`422 revision_not_recompilable`), because a cell needs
  its compilation.
- The interface shows the frozen definition with its digest behind a copy button, never as raw text.
- A server-side study export arrives in F2.

Where: `study_jobs.py`, `routes/studies.py`, `tests/test_study_frozen_definition.py`.
