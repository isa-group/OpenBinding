# Change: m23-verdict-terminations

## Why

ROADMAP M2.3 (owner request own-58fe9d3b57f44525a17f2ff5bde0667f, release R1): "render the run result with the M2.1
catalogue", and the run page of ARCHITECTURE §5.3 starts with the verdict. The gateway's evaluated termination is
`OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN` (`openbinding-gateway/src/openbinding_gateway/main.py:987-991`, frontend
type `Termination` in `frontend/src/api/client.ts:38`). `VerdictBadge` knows `OPTIMAL`, `FEASIBLE`, `UNSAT`, `TIMEOUT`
and `INCOMPATIBLE` (`frontend/src/components/rendering/VerdictBadge.tsx:10-16`), so two of the four terminations the
API returns render today as a neutral badge with no description. The M2.1 change deferred this mapping to M2.3
(`openspec/changes/m21-rendering-catalogue/design.md` §7, tasks.md follow-ups). This change is slice V1 of
`docs/agent-work/m23-run-result/handoff.md`. The run-result composition of slice J1 passes the termination straight to
`VerdictBadge`, so V1 comes first.

## What Changes

- `VerdictBadge` knows `INFEASIBLE`: an `error` badge read as `INFEASIBLE, no combination meets the rules`.
- `VerdictBadge` knows `UNKNOWN`: a `default` badge read as `UNKNOWN, no conclusion`.
- So every termination the API returns has a plain-language description for assistive technology. The verdict word
  stays the visible badge text (constitution 11.1, colour never alone).
- Nothing else changes. The five earlier verdicts keep their variants and descriptions. Any other value, including a
  different case such as `infeasible`, stays a neutral badge with no description. No screen uses the badge yet (J1
  wires it).

## Impact

- Capability `frontend-rendering`: one ADDED requirement, `req~frontend-rendering-verdict-terminations~1`. It is ADDED
  rather than a MODIFIED `req~frontend-rendering-verdict-badge~2` because the capability exists only in the unarchived
  change `m21-rendering-catalogue`, and a MODIFIED delta needs a living spec (intake R-f, design.md §3).
- Code: `frontend/src/components/rendering/VerdictBadge.tsx` (two table entries and the prop type) and
  `VerdictBadge.test.tsx` (new cases). `VerdictBadge.css` is owned by the slice but is not expected to change. That is
  about 5 non-test lines.
- No API, OpenAPI, gateway, dependency or allow-list change. `MAX_ALLOWED_OFFENDERS` is untouched.
- Risks (design.md §4): the `error` variant for `INFEASIBLE` differs from the `warning` tone of the Jobs page's outcome
  label (`frontend/src/pages/Jobs/jobsModel.ts:51`). Two documents outside this change go stale when it merges and
  are followups: `docs/qa/RENDERING_CATALOGUE.md:110` and the m21 design note.
- G1: no check is registered for this task, so `openspec validate m23-verdict-terminations --strict` is NOT EXECUTED
  here. The layout copies `m24-retire-sponsorship` and `m21-rendering-catalogue`.

## Out of scope

- Mapping job states (queued, failed, cancelled) or engine refusals onto verdicts, and choosing which value a page passes
  to the badge (J1, W1).
- Retiring `UNSAT`, `TIMEOUT` or `INCOMPATIBLE`, which no API termination uses today.
- The wording of `outcomeOf` in `jobsModel.ts` (J1), `docs/qa/RENDERING_CATALOGUE.md` (written serially by H1, J1, W1),
  `openspec/specs/**` and archiving.
