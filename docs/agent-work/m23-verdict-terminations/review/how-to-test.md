# How to test: m23-verdict-terminations (slice V1)

No screen renders `VerdictBadge` yet, so there is nothing to click. Check it with the unit tests and the props below.

## Unit tests

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm exec vitest run VerdictBadge src/test
pnpm exec eslint .
pnpm exec tsc -b
```

Expected: all pass. The new cases in `src/components/rendering/VerdictBadge.test.tsx` carry
`[utest->req~frontend-rendering-verdict-terminations~1]`.

## What to see

| Props | Badge | Hidden text read by assistive technology |
|---|---|---|
| `verdict="INFEASIBLE"` | red (`badge-error`) | `INFEASIBLE, no combination meets the rules` |
| `verdict="UNKNOWN"` | neutral (`badge-default`) | `UNKNOWN, no conclusion` |
| `verdict="UNSAT"` | red (`badge-error`) | `UNSAT, no combination satisfies the rules` (unchanged) |
| `verdict="infeasible"`, `"Unknown"`, `"toString"` | neutral | none; the value is shown as is |

`reasons={['...']}` on `INFEASIBLE` renders a list named `Reasons` after the badge, inside an outer `<div>`.

## Before the change

On the base code, `INFEASIBLE` and `UNKNOWN` render a neutral badge with no hidden description, so four of the new
cases fail by assertion.
