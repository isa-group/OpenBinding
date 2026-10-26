# M0.2 summary: OpenSpec strict validation

## Purpose

M0.2 makes `openspec validate --strict` pass for the living specs and for every change, so gate G1 can rely on it.

## Finding

- The 16 living specs in `openspec/specs/` already pass `--strict`. The longest requirement body is 488 characters,
  under the 500 limit.
- `openspec validate --strict --all` failed only because of six unarchived changes whose ADDED requirements exceeded
  500 characters (the validator counts everything between the requirement header and the first `#### Scenario`,
  including the `req~` line, the `Needs:` and `Evidence:` lines and notes):
  - m05-pr-previews
  - m21-rendering-catalogue
  - m24-retire-screens
  - m24-retire-screens-2
  - m41-space-lab-profile
  - validate-public-origin-format

## How they were fixed

- The `THE ... SHALL ...` sentence was shortened to one behaviour.
- Evidence lines and notes moved after the last scenario of each requirement.
- Detailed rules moved into a first scenario of the same requirement (for validate-public-origin-format: "The public
  origin shape is exact", "The CORS entry shape is exact", "The masked value and the reported error are exact").
- Requirement names, ids, revisions, `Needs:` lines and trace tags were not changed.
- In m24-retire-screens, a duplicate `GIVEN` in the scenario "The history entry is replaced" became `AND`.

## State

- Nothing was archived. The living specs were not touched.
- The `m02-openspec-strict` change folder was removed: its engine-* MODIFIED deltas were redundant.
- `baseline.md` and `baseline-all.md` are the measurement before the fixes.

## Followups

- ROADMAP wording "16 specs fail" is stale: the living specs pass.
- Each of the six changes still needs its own archive step, done by its owner.
