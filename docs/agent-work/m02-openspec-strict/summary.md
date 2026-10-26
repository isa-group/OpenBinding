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
- In all six changes, details moved into scenarios; Evidence/notes moved after the last scenario in m05, m41,
  validate-public-origin-format, and, where they fit the limit, in m21, m24 and m24-2 (a sibling task may also move
  Evidence lines in m24 and m24-2).
- Detailed rules moved into a first scenario of the same requirement (for validate-public-origin-format: "The public
  origin shape is exact", "The CORS entry shape is exact", "The masked value and the reported error are exact").
- Requirement names, ids, revisions, `Needs:` lines and trace tags were not changed.
- In m24-retire-screens, a duplicate `GIVEN` in the scenario "The history entry is replaced" became `AND`.

## State

- Nothing was archived. The living specs were not touched.
- The `m02-openspec-strict` change folder was removed: its 18 MODIFIED engine-* requirements were redundant, because
  the living specs `openspec/specs/engine-minizinc`, `engine-protocol`, `engine-registry` and `engines-java` already
  pass strict validation (CLI 1.15.0; baseline.md: archive simulation of the 18 modified requirements validated 16/16).
- `baseline.md` and `baseline-all.md` are the measurement before the fixes.

## Proof of exit 0

- CI job `openspec` on PR 56, head 822ea70c (merge ref with develop), ran `openspec validate --strict --all` with
  CLI 1.14.3 and printed `Totals: 26 passed, 0 failed (26 items)`.
- The step is report-only (`continue-on-error: true` in `.github/workflows/ci.yml:189-191`); making it blocking is a
  followup outside this change.

## Followups

- ROADMAP wording "16 specs fail" is stale: the living specs pass.
- Each of the six changes still needs its own archive step, done by its owner.
- OFT trace in CI reads only `openspec/specs`, so `Needs:` lines in unarchived changes are not traced.
- The MODIFIED requirements of m05 (~1120 chars) and m41 (~1789 chars) are long and must be shortened before their
  archive tasks.
- The m21 secondary-tab usage rule could be its own requirement.
- Some Evidence paths in m24-2 use brace shorthand.
- Make the CI `openspec` step blocking (remove `continue-on-error`).
