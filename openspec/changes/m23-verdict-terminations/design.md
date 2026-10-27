# Design: m23-verdict-terminations

Status: slice V1 of M2.3 (`docs/agent-work/m23-run-result/handoff.md`), parallel with H1, B1, Q1, O1, T1 and E1. Fixed
inputs: the `VerdictBadge` contract of `m21-rendering-catalogue` (design.md §2, `req~frontend-rendering-verdict-badge~1`),
merged and not archived; the API termination enum `OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN`
(`openbinding-gateway/src/openbinding_gateway/main.py:987-991`, `frontend/src/api/client.ts:38`); the vocabulary of
`outcomeOf` (`frontend/src/pages/Jobs/jobsModel.ts:47-55`).

## 1. Contract

```ts
// VerdictBadge.tsx
interface VerdictBadgeProps {
  verdict: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'UNSAT' | 'TIMEOUT' | 'INCOMPATIBLE' | (string & {});
  reasons?: string[];
  size?: 'sm' | 'md';        // unchanged
}
export function VerdictBadge(props: VerdictBadgeProps);   // unchanged signature
```

| Verdict | `Badge` variant | Plain-language description | Source |
|---|---|---|---|
| `OPTIMAL` | `success` | proven best combination | m21, unchanged |
| `FEASIBLE` | `info` | a valid combination, not proven best | m21, unchanged |
| `INFEASIBLE` | `error` | no combination meets the rules | **new** |
| `UNKNOWN` | `default` | no conclusion | **new** |
| `UNSAT` | `error` | no combination satisfies the rules | m21, unchanged |
| `TIMEOUT` | `warning` | stopped at the time budget | m21, unchanged |
| `INCOMPATIBLE` | `default` | the engine cannot solve this problem | m21, unchanged |
| any other | `default` | none; the value itself is the text | m21, unchanged |

The markup is unchanged from m21 design.md §2. The outer element is a `<div class="rendering-verdict">`. Inside it, an
inline wrapper `<span>` holds the `Badge` and, for a known verdict, an `.sr-only` `<span>` with the text
`, {description}`. There is no `aria-describedby`. Non-empty `reasons` render as `<ul aria-label="Reasons">` after the
wrapper. Lookup is exact and case-sensitive, through `Object.hasOwn` on the table, so `infeasible`, `Unknown` and
inherited keys such as `toString` stay unknown values.

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| `INFEASIBLE` variant | `error`. It says the same thing as `UNSAT` (no combination meets the rules), and the badge shows the same meaning in the same colour | `warning`, the tone of the Jobs outcome label (`jobsModel.ts:51`). That label uses `success`/`warning`/`plain` only and has no error tone. The badge vocabulary keeps `warning` for a run cut short (`TIMEOUT`). J1 replaces the Jobs label with the badge |
| `UNKNOWN` variant | `default` (neutral). The gateway's termination does not say why there is no conclusion | `warning`, as for `TIMEOUT`. That suggests a time budget, which the termination does not report |
| Descriptions | `no combination meets the rules` and `no conclusion`, lowercase like the m21 descriptions, taken from `outcomeOf` (`jobsModel.ts:51-52`) without its `Infeasible:` prefix, which repeats the verdict word | `no combination satisfies the rules` (the `UNSAT` text): it would make two verdicts sound identical when read aloud |
| `UNSAT`, `TIMEOUT`, `INCOMPATIBLE` | kept unchanged | removed: no API termination uses them, but `req~frontend-rendering-verdict-badge~1` pins them and no page uses the badge yet. That is J1's call, or a later change |
| Prop type | the two literals join the union. `(string & {})` keeps every string valid | no type change: it works, but editors would not suggest the two values |

## 3. Requirement and earlier text

| Requirement | Tests |
|---|---|
| `frontend-rendering-verdict-terminations` | `frontend/src/components/rendering/VerdictBadge.test.tsx` |

New test cases carry `[utest->req~frontend-rendering-verdict-terminations~1]`. The `KNOWN` table of `VerdictBadge.tsx`
carries `[impl->req~frontend-rendering-verdict-terminations~1]` next to the existing `[impl->…verdict-badge~1]` tag.

This change does not bump `req~frontend-rendering-verdict-badge~1`. That requirement defines the known verdicts by
reference to m21 design.md §2, which lists five. Read together with this change, "known verdict" means the seven of
§1, and "any other value" means any value outside those seven. The m21 tests for the five verdicts, `WEIRD`, size,
reasons and the CSS stay as they are and keep passing. At the archive (m21 first, then this change, intake R-f), the
archive task may fold this requirement into `verdict-badge` as `~2`. Until then both ids stand.

## 4. Risks

- `INFEASIBLE` appears in red as a badge and in a warning tone as the Jobs outcome label until J1 replaces the label.
  The two never show on the same screen today, because no page renders `VerdictBadge`.
- Stale text outside this change after it merges: `docs/qa/RENDERING_CATALOGUE.md:110` ("today including the API's
  `INFEASIBLE` and `UNKNOWN`, until M2.3 maps them") and m21 design.md §7 / tasks.md follow-ups. The catalogue page
  goes with J1, which documents the six components (handoff). The m21 text is reconciled at its archive.
- Accessibility is checked by text and classes, not by a screen reader (m21 design.md §7).

## 5. Rollback

Reverting the PR removes the two table entries, the two type literals and their tests. `INFEASIBLE` and `UNKNOWN` then
render as neutral badges again. No data, API or other component is touched.
