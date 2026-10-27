# Tasks: m23-binding-table

Slice B1 of M2.3, one PR. Tests carry `[utest->req~frontend-rendering-binding-table~1]`, code `[impl->…]` (design.md
§4). Diff budget: about 160 non-test lines, at most 300 (constitution 14.1). All paths are under `frontend/src/`.

Checks the slice registers (handoff "Checks"): FI (`pnpm install --frozen-lockfile`) first; RED over both test files
and the stub (G3); V over `src/components/rendering/BindingTable.test.tsx`,
`src/components/rendering/bindingTableModel.test.ts` and `src/test`; LINT (`pnpm exec eslint .`); TSC
(`pnpm exec tsc -b`); `openspec validate m23-binding-table --strict` once the lab has the CLI (until then CI runs
`openspec validate --strict --all`).

## B1. BindingTable (tests first)

Tests first:
- [ ] 1.1 `components/rendering/bindingTableModel.test.ts`: the model scenarios of the requirement (rows with a
  problem, order, features and units, without a problem, unknown task, candidate not eligible, missing feature,
  malformed input, the compiled form read by `readBindingProblem`), with the fixtures of design.md §3.
- [ ] 1.2 `components/rendering/BindingTable.test.tsx`: the rendering scenarios (region and table, headers with units,
  row headers with names and ids, provider column only when known, value formats and ranges, missing values, empty
  rows, default and custom label, engine strings as text, no `<pre>`), the CSS read for no hex colour and both
  sources read for no `pages/` import.
- [ ] 1.3 Stub of `components/rendering/bindingTableModel.ts` and `BindingTable.tsx` (final exports and types of
  design.md §2; the functions return `[]` and the component renders `null`); RED shows assertion failures only.

Source:
- [ ] 1.4 `components/rendering/bindingTableModel.ts`: types, `bindingRowsOf`, `bindingFeaturesOf` (design.md §2).
- [ ] 1.5 `components/rendering/BindingTable.tsx`: the markup of design.md §2 on `components/ui/DataTable` and
  `formatFeature` of `utils/featureRange.ts`.
- [ ] 1.6 `components/rendering/BindingTable.css`: tokens only.
- [ ] 1.7 Confirm the diff touches no page, route, hygiene file, `RENDERING_CATALOGUE.md`, `ROADMAP.md`, `api/*.ts`,
  `package.json` or lockfile.
- [ ] 1.8 `docs/agent-work/m23-binding-table/review/how-to-test.md`: how to run the two test files and what they show.
- [ ] 1.9 Review sign-off (G11) and ui-qa at 1440×900 and 390×844 (handoff "Review panels"), on a gallery or test
  harness page since no screen uses the component yet.
- Acceptance: the two test files, `src/test`, eslint and tsc pass; every scenario of the requirement has a test.

## Archive (later)
- [ ] Archive after `m21-rendering-catalogue` (which creates the capability `frontend-rendering`), in the explicit
  archive task of the M2.3 changes: `["openspec", "archive", "m23-binding-table", "--yes"]`, then
  `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- J1 and W1 wire `BindingTable` into `RunResult` and document it in `docs/qa/RENDERING_CATALOGUE.md`.
- ARCHITECTURE §5.3 catalogue row says "with per-feature contributions"; the component shows each chosen candidate's
  own values (design.md §1). The coordinator aligns the wording.
- Carry the catalogue (`resource`) of each candidate in `readBindingProblem` so the lookup can match on catalogue and
  id (design.md §6).
