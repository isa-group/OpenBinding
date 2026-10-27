# Handoff: m25-render-rest
- Status: waiting-review (plan) · Updated: 2026-10-27T00:00:00Z
- Branch / head: task/6da08ee7c9784073 on base 00f653ef · PR: none (planning only)

## Goal
Plan ROADMAP M2.5: studies, engines, audit, registration and generator rendered, with raw views moved to Source tabs,
so that offenders 8–10 and 12–15 leave the raw-rendering allow-list. The plan uses changes of one capability each,
with disjoint files and tests first.

## State (with evidence)
- Intake written: `docs/agent-work/m25-render-rest/intake.md`. It has eight slices: S0 ledger, S1 studies, S2
  engines, S3 audit, S4 registration, S5 generator, S6 snapshot, S7 close.
- Offender lines confirmed in `frontend/src/test/rawRenderingAllowList.ts` and in the sources: StudyCell.tsx:296,
  StudyDetail.tsx:276 (ROADMAP says 277), EngineParts.tsx:47, OrgAudit.tsx:88, EngineForm.tsx:179, LabAside.tsx:25
  and SnapshotDetail.tsx:94.
- `ViewSource` (EngineParts.tsx:42) has six consumers: EngRegistrationDetail (via ManifestPanel), LangExtensions,
  RegisterEngine, AdminAudit, AdminErrors and AdminEngineReview.
- The e2e coverage per slice was checked. s7a-studies:606,827 cover studies; s8a-engines:278,567,685 cover engines;
  s5a-cases:618–623 covers the snapshot; s4a-org:858 covers the audit. The gen-lab test lives in
  s5d-workbench.spec.ts:570–656.
- No M2.3 change exists (nothing under `openspec/changes/m23-*`).
- No checks registered for this task; nothing was run.

## Decisions
- S0 splits the allow-list into one file per offender, with a frozen ROADMAP table and the detector moved to a module
  that is not a test file. Reason: every retirement edits `MAX_ALLOWED_OFFENDERS` and the exact-list assertions in
  `rawRenderingHygiene.test.ts:361–408`, and a stale entry fails the test, so parallel slices (and M2.3 and M2.6)
  would always collide there.
- On a page that is the item's own page, the source goes in a real `Source` tab (TabBar/TabPanel + SourceView).
  Inside cards, panels, rows and wizard steps, a labelled disclosure holding SourceView is used instead. Reason:
  constitution 15.2 and 15.4. Needs confirming.
- No new component under `components/rendering/**`. Reason: M2.3 owns that folder; SourceView and MetricCards exist.
- No feature flag. Reason: each slice is complete on its own.
- Shared docs (RENDERING_CATALOGUE table, ROADMAP status) only in S7. Reason: disjoint files for S1–S6.

## Ruled out
- Retiring offenders in parallel against the single list file. Rejected because of certain conflicts on the ceiling
  and exact-list lines (see above).
- Having the engines slice (S2) and the registration slice (S4) share `manifestModel.ts` or `s8a-engines.spec.ts`.
  Instead, S4 owns `manifestModel.*` and S2 owns s8a.
- Letting S5 edit `s5d-workbench.spec.ts`. That spec belongs to M2.3's workbench work, so S5 keeps the `View source`
  and `File` selectors that the spec uses.

## Open questions and risks
- The inbox file named in the brief is missing from the worktree. Waiting on the coordinator to confirm that the body
  adds nothing beyond ROADMAP M2.5.
- Whether a disclosure counts as 15.2's "tab" inside cards, panels and steps. Waiting on the owner or coordinator.
  ARCHITECTURE §5.3 ("only in Source tabs") belongs to the coordinator.
- S0 vs the serial-ledger fallback. Coordinator decision.
- Risk: S0 contradicts the exact-value scenarios of the unarchived m21 and m24-* changes. Mitigation: the archive task
  reconciles them.
- Risk: S2 changes a helper with six consumers. Mitigation: keep its export and summary text; full unit suite; medium
  panel.
- Risk: S2 may need `s9a-admin.spec.ts`, which `m24-retire-sponsorship` also edits. Mitigation: S2 starts after that
  PR merges.

## Next three steps
1. Coordinator: answer the three open questions, then create change `m25-allow-list-ledger` (S0). Its checks are the
   argument arrays of intake.md "Checks per slice"; the test-designer's red_before runs first.
2. After S0 merges into develop, start S1–S6 in parallel, each with the owned globs listed in intake.md. Each has a
   test-designer task (red_before), then an implementer task, then a review panel by its risk.
3. When S1–S6 have merged (and after M2.3's catalogue edits, if any), run S7 `m25-render-close`. Then plan an archive
   task for the M2.5 changes, reconciling them with m21 and m24.

## Evidence
- Tasks: 6da08ee7c9784073 (this plan) · Heads: base 00f653ef · CI: none (no code change)
