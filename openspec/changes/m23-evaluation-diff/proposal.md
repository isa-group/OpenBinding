# Change: m23-evaluation-diff

## Why

ROADMAP M2.3 (owner request own-58fe9d3b57f44525a17f2ff5bde0667f, release R1): render the run result with the M2.1
catalogue plus `BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`, `LogPanel`, and
`TradeOffChart` when there are several objectives. ARCHITECTURE §5.2 puts "engine-claimed versus evaluated values" on
the run page, and §5.3 defines `EvaluationDiff` as "engine-claimed versus gateway-evaluated values and downgrade
reasons", used in the run result. INTENT §1: the gateway "re-evaluates every answer itself, so results are comparable
across engines and verifiable by digest"; a reader of a run must see whether the engine's own claim and the gateway's
evaluation agree, and where they do not. Today the job page shows the engine's provenance as a raw source dump (offender
2 of the hygiene allow-list), and no shared component compares the two.

This is slice E1 of the M2.3 plan (`docs/agent-work/m23-run-result/handoff.md`), one of the six component slices that
run in parallel and that J1 then wires into the run result.

## What Changes

- A new shared rendering component `EvaluationDiff` and its pure derivation `evaluationDiffOf` under
  `frontend/src/components/rendering/`, with the prop contract of the M2.3 plan (design.md §3).
- When the engine's claim is given and agrees with the gateway's evaluation, one line says so; when it differs, the line
  counts the differing values and a table lists each one (termination, number of solutions, each feature and each score
  value per solution) with the engine's and the gateway's value.
- When no claim is given, as on every run with today's API, a line says that the values the engine claimed are not
  kept for this run, and gives the gateway's termination and number of solutions. Nothing is invented.
- The engine's own notes and the gateway's downgrade reasons, when given, are listed as text.
- Engine text is external input: it is shown as plain text only, isolated for text direction, shortened past 500
  characters, and the number of rows and notes shown is capped.
- No screen changes in this change: J1 mounts the component in the run result.

## Impact

- Capability `frontend-rendering`: one ADDED requirement, `req~frontend-rendering-evaluation-diff~1`. The capability
  exists only in the unarchived change `m21-rendering-catalogue`, so m21 is archived first (intake R-f).
- Repository: new files only, `frontend/src/components/rendering/EvaluationDiff.{tsx,css,test.tsx}`,
  `evaluationDiffModel.ts` and `evaluationDiffModel.test.ts`, plus this change's how-to-test guide under
  `docs/agent-work/m23-evaluation-diff/`. No existing screen, no `package.json`, no lockfile and no hygiene allow-list
  change; no new dependency.
- No HTTP API, OpenAPI or database change. Showing the real claimed values and the downgrade reasons needs data the API
  does not return (intake F14): that is CRP-M23-1, the owner's decision, and the slices C1 and J2 if option A is chosen.
  This change does not depend on it and does not block it.
- Risks (design.md §8): with today's API only the `no-claim` line and notes appear on real runs; solutions are paired by
  position; the tolerance is absolute (1e-9); engine text is shortened and direction-isolated but not otherwise
  cleaned. Risk class medium (R9, new UI) with external input; the review panel adds security-auditor.
- G1 (`openspec validate m23-evaluation-diff --strict`) is not registered for this task and was not run (intake F16:
  the CLI may be missing in the lab); the format follows `openspec/changes/m21-rendering-catalogue/`.

## Out of scope

- Wiring the component into the run result, mapping the job report to its props, and the catalogue entry in
  `docs/qa/RENDERING_CATALOGUE.md` (J1, which documents all six components).
- Any change to `GET /v1/jobs/{id}/report`, `docs/openapi.json` or the gateway (CRP-M23-1, C1), and passing the claim
  and downgrades from the API (J2).
- Computing downgrade reasons in the client, and deciding whether a claim was acceptable (the gateway's job).
- `VerdictBadge` terminations (V1), the other M2.3 components, and any hygiene allow-list entry.
- Editing `openspec/specs/**`, ARCHITECTURE §5.3 or earlier changes; archiving.
