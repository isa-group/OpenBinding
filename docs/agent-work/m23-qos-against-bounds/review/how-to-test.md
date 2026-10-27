# How to test: m23-qos-against-bounds

The component `QoSAgainstBounds` and its model `qosBoundsOf` are not wired into any page yet, so there is nothing to
open in a browser. The evidence is the unit tests.

From the repository root:

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm exec vitest run QoSAgainstBounds qosBoundsModel src/test
pnpm exec eslint .
pnpm exec tsc -b
```

What the tests cover (`frontend/src/components/rendering/`):

- `qosBoundsModel.test.ts`: comparisons of one quality with a number become bounds (a number on the left flips the
  operator); other rules become text; a mixed `and` is never split; the status comes only from the gateway's violations
  (matched by resource and id); no violations list means `not checked`; violations for rules the compiled problem does
  not hold become rules; unexpected input is left out.
- `QoSAgainstBounds.test.tsx`: the `Bounds` table cell by cell, margin words (`below`, `above`, `at the limit`), missing
  values, the `Other rules` list, status words with badge variants and penalty, the empty and one-part cases, number
  format, text-only rendering, no hex colour in the stylesheet and no import from `pages/`.

`src/test` includes the rendering hygiene test; it passes with the allow-list unchanged.

Screenshots at 1440×900 and 390×844 come with the preview of slice J1, which wires the component.
