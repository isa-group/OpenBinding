# How to test: BindingTable (slice B1 of M2.3)

No screen uses `BindingTable` yet (slices J1 and W1 wire it), so the evidence is the unit tests.

From the repository root:

```
cd frontend
pnpm install --frozen-lockfile
pnpm exec vitest run BindingTable bindingTableModel src/test
pnpm exec eslint .
pnpm exec tsc -b
```

What the tests show:

- `bindingTableModel.test.ts`: rows from a solution's `decision.binding` and the compiled problem (problem task order,
  binding order without a problem, unknown task, candidate not eligible, malformed bindings, the value that
  `readBindingProblem` returns) and the feature columns with their units.
- `BindingTable.test.tsx`: the named scroll region and table, column headers with units, row headers with names and
  ids, the Provider column only when a provider is known, number and range formats, `no value` for missing values,
  the empty message, a custom label, engine strings rendered as text, tokens-only CSS and no `pages/` import.

Expected: all tests pass, no lint errors, no type errors.
