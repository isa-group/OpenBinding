# 0052. The study front, the export and study presets on the server

- Status: accepted
- Date: 2026-11-16 (F2b, decisions D14, D16 and D18 of the F2 implementation plan)

## Context

A study's Results tab decided in the browser which cells were Pareto-optimal (a client dominance check) and wrote
its CSV export itself; both are semantics the gateway already has (`nondominated`) or owns (the cells). Run presets
existed for runs ([ADR 0046](0046-compositions-module.md)) but a study could only name exact engines, and the plan
asks for compositions produced from a study's trade-off set.

## Decision

- **One front per problem version and objective set, in the gateway.** `getStudyAnalytics` answers
  `pareto: [{revision_id, problem, revision, objectives, points}]`: from the feasible solutions of completed cells,
  one front per problem revision and set of objective names, with the existing `nondominated` (minimisation). Each
  point names its cell, its run (`job_id`), the engine, its objective values and `solution_index` (the run solution
  it is, which each cell now records as `solutionIndex`). Fronts are ordered by problem slug, revision and objective
  names, points by their values. `paretoStatus` is gone.
- **No client dominance.** The Results tab draws the gateway's fronts (`pages/Studies/ParetoFront.tsx`: one table per
  front, points numbered `P<n>` per problem, a focused point, search and an engine filter), and the trade-off chart
  marks the gateway's points; the client dominance check and its tests are deleted.
- **One composition per point** (D16). "Derive compositions" turns each selected point into a new composition whose
  1.0.0 is that point's solution: `POST …/compositions/{c}/derive {run, point, version: "1.0.0", seal: true}`, one
  after another, each with its own result and an exact summary ("2 of 3 points hold a composition", then each
  failure). Retrying skips what the batch made; an address that is taken is taken over only when its composition is
  empty or its 1.0.0 already holds this run and point, since derive is idempotent. There is no batch endpoint, and
  which points hold a composition is known for the page's session only (no "compositions derived from run X"
  filter). Two derived points are compared through the gateway's document diff (`POST /v1/compositions/diff`).
- **The export is the server's.** `GET …/studies/{study}/runs/{run}/export?format=csv|json` (`exportStudyRun`,
  VIEWER, `studies:read`) streams every cell of a run as `<study>-run-<n>.<csv|json>`: JSON with the study, the run,
  the frozen definition and the cells; CSV with one row per cell in a fixed column order (`problem` and `revision`
  included), then the `objective.<name>` and `metric.<name>` columns sorted. The page fetches it with the session
  and saves it under the server's name; the client CSV is deleted.
- **Presets join studies by expansion at `runStudy`** (D18). A study engine is exact or `{preset: <slug or id>}`.
  Writing a study expands each preset once to refuse what no run could run (`preset_not_found`, `preset_federated`,
  `preset_incomplete`, `invalid_engine`, `duplicate_study_engines`) and stores it as given; each `runStudy` expands it
  again with the run-preset functions and freezes the exact engine revision, mode, optimization, options and the
  preset as `{id, slug}`. `options` are part of an engine's identity. A cell's run gets the preset's options under the
  cell's parameter set and records the preset. Editing a preset changes the next study run, never one that exists.
  Presets of federated engines cannot join a study until study cells can run registered engines.
- **Presets in the forms.** The run launcher picks a preset (`?preset=`) or saves the chosen settings as one; the
  study builder adds engines "from a run preset", with the presets it cannot take listed disabled and why; the
  organization's Settings gain a Run presets section.

## Consequences

- The front, the export and a frozen study engine are the same for the web, the API and an API key.
- The study page computes no dominance, sum or ranking (D14), and the export cannot drift from the stored cells.
- A preset edited after a study run is not reflected in that run's frozen definition; rerunning the study takes it.

Where: `studies.py` (`pareto_fronts`), `study_jobs.py` (`study_engines`), `routes/studies.py` (`exportStudyRun`,
analytics), `models/platform.py`
(`AnalyticsView`, `ParetoFront`, `StudyRunExport`), `frontend/src/pages/Studies/`, `frontend/src/features/derive/`,
`frontend/src/entities/preset/`, `frontend/src/pages/Organization/PresetsSection.tsx`,
`frontend/e2e/f2b-study-front.spec.ts`, `frontend/e2e/live/11-study-front.spec.ts`.
