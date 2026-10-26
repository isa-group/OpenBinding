# M0.2 baseline: `openspec validate --strict --all`

## Not obtained

This worker has no shell: `openspec --version` and `openspec validate --strict --all --json` could not be run, so
there is no JSON output, no `/tmp` file and no per-requirement list from the tool. The only registered check is
`openspec validate m02-openspec-strict --strict`.

What that check showed:

- A delta block (`## MODIFIED Requirements`) with a 600-character statement validates without a length error: the
  length rule is not applied to delta specs. The rule is applied when the living specs are validated (after archive),
  so the delta check cannot confirm the lengths.
- `openspec validate m02-openspec-strict --strict` exits 0 for the four capabilities of this slice.

## Rule used

Not read from the CLI. Taken from the earlier slices (`docs/agent-work/m02-specs-a/report.md` and siblings, and
`openspec/changes/m03-gate-tooling/tasks.md`: "two requirement texts over 500 characters"): the body of a requirement
(statement, id line, Evidence line) at most 500 characters. Lengths in this slice are hand counts (about ±15).

## Unarchived changes

Not checked by the tool; none was edited.

## Requested follow-up

Run `openspec --version` and `openspec validate --strict --all --json` where the CLI exists, to confirm the failing
list and the limit.
