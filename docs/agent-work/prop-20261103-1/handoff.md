# Handoff: prop-20261103-1
- Status: waiting-review (intake done, waiting on the coordinator and CRP-1..2) · Updated: 2026-11-03
- Branch / head: task/3ff31895e8934d39 / base b8067258 · PR: none

## Goal
Make the browser's two CSV exports safe to open in a spreadsheet: the cells CSV of a study run and the organization
audit CSV. One shared `csvCell` helper prefixes `'` to text that starts with a formula trigger and quotes on `"`, `,`,
CR and LF. INTENT O8 (Security).

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261103-1/intake.md`, with evidence F1-F17 checked against `b8067258`.
- No code, spec or acceptance written (planner scope). No check registered, so none was run, `bim-guard` included.

## Decisions
- One slice, S1 `csv-formula-neutralise`, about 40-60 non-test lines. Reason: one capability, and splitting would leave
  two escapers with different behaviour (the proposal's alternative 1).
- The helper goes in `frontend/src/shared/lib/csv.ts`. Reason: `ARCHITECTURE.md:208-209` puts formatters in
  `shared/lib`, and `.gitignore:18` already tracks the folder.
- Risk is low. Reason: `*.ts` and `docs/qa/**` match no risk glob, and R9 is `*.{tsx,css}` only (`REVIEW.md:22,25`).
  Q5 recommends adding a security-auditor pass anyway, because the kind is security.
- No feature flag. Reason: one slice, and the change is a pure output transform.
- The order is prefix first, then quote. Numbers and booleans are never prefixed. Reason: OWASP guidance (lookup,
  medium confidence), and the proposal's rule that negative numbers are left alone.

## Ruled out
- Button warning text (proposal alternative 2). It touches `*.tsx` (R9) and does not protect the file.
- Gateway-side validation of case and engine names. It is R3 (public schema). It is listed as a followup.

## Open questions and risks
- CRP-1: the trigger set. The proposal's six characters, or the OWASP list with LF and the full-width forms
  (recommended). Waiting on the owner.
- CRP-2: the visible `'` in notebook readers (`analyticsModel.ts:175` says "for a spreadsheet or a notebook").
  Recommended: accept it and document it. Waiting on the owner.
- Q3-Q6 for the coordinator: helper location, capability `frontend-workspace`, review panel, and the unverified
  engine-name exposure (F5).
- Risk: the main vector is the free-text case name (`platform.py:148-151`), not the engine name. The registration
  schema pins one `name` definition to `^[A-Za-z0-9]…` (`engine-registration.schema.json:87`), but `engine.name`
  (`:103`) has no pattern. The SECURITY_REVIEW row must say this correctly.
- Risk: the active change `m25-studies-engines` fixes the audit `detail` JSON cell (`frontend-rendering/spec.md:180-184`).
  JSON starts with `{`, so it is kept. S1 must not edit that change.
- Risk: lesson 2. Any commit after `chore(changelog)` makes the frontend CI red.

## Next three steps
1. Coordinator: open CRP-1 and CRP-2 with the options in intake §7. Create the OpenSpec change (capability
   `frontend-workspace`, `req~frontend-csv-export-neutralised~1`, scenarios in intake §4).
2. After G1/G2, contract S1 for an implementer: the owned files and checks 1-7 in intake §4.
3. pr-steward: regenerate the changelog as the last commit, then run the review panel (reviewer, plus a
   security-auditor if Q5 is accepted).

## Evidence
- Task: 3ff31895e8934d39 (this intake) · Head: b8067258 · CI: none (no code).
- Lookup: OWASP CSV Injection, https://community.owasp.org/attacks/CSV_Injection (medium confidence; read through a
  summarising fetch).
