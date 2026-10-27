# How to test: TradeOffChart (M2.3, slice T1)

The component is not placed on any page yet (J1 and W1 do that), so there is no screen to open in this change.

## Unit tests

From `frontend/`:

```
pnpm install --frozen-lockfile
pnpm exec vitest run TradeOffChart tradeOffModel src/test
pnpm exec eslint .
pnpm exec tsc -b
```

The tests cover the model (reading canonical solutions, common objectives, dominance by `loss`) and the component
(region, table, number format, summary, axis selects, swap rule, legend, one solution, empty cases, CSS rules).
Recharts is mocked, because jsdom gives it no size.

## Visual check (ui-qa)

Render `<TradeOffChart points={POINTS} objectives={['cost','latency','availability']} />` from a test harness or from
J1's run page, at 1440×900 and at 390×844, with the four points of design.md's fixture:

| Point | cost | latency | availability |
|---|---|---|---|
| Solution 1 | 12 | 440 | 0.99 |
| Solution 2 | 15 | 412 | 0.95 |
| Solution 3 | 18 | 450 | 0.97 |
| Solution 4 | 20 | 300 | 0.9 |

Expect:

- A table `Non-dominated solutions` with Solutions 1, 2 and 4 (Solution 3 is dominated by Solution 1), scrolling
  sideways inside its region at 390 px.
- A scatter chart of 280 px height at full width, with filled circles for the three non-dominated points and a cross for
  Solution 3, and the legend `not dominated` / `dominated`.
- The image name (screen reader): `4 solutions plotted by cost (horizontal) and latency (vertical); 3 not dominated:
  Solution 1 (12, 440); Solution 2 (15, 412); Solution 4 (20, 300)`.
- `Horizontal axis` and `Vertical axis` selects, operable by keyboard; choosing the criterion the other select shows
  swaps the two. The table does not change with the axes.
- With one point: the table and the note `A chart needs at least two solutions; this run has one.`; with fewer than
  two objectives or no point: nothing.
