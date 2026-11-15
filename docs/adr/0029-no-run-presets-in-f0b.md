# 0029. No run presets or execution configurations in F0b

- Status: accepted
- Date: 2026-11-14 (F0b, decision D8 of the F0b implementation plan)

## Context

The old `ExecutionConfiguration` artifact was created only by the seed and by package import; no route ever created
one. A run already stores its effective settings.

## Decision

F0b removes the ExecutionConfiguration picker and adds no `run_presets` table. `run_presets` arrives in F1 as a
standalone table of engine, mode, options and optimisation that runs use; it never enters a composition document.

## Consequences

- Launching a run picks the engine, mode and settings each time; the run records them.
- No migration carries configurations over: there is no production data.

Where: `frontend/src/pages/Jobs/JobLaunch.tsx`.
