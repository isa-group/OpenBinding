Goal: M2.7 part 1 (names, not digests): shared/lib/identity.ts, components/CitationPanel, components/VerifyResult, test/digestHygiene.test.ts (PENDING_CLEANUP 40, EXEMPT_FILES 39), spec aligned. Pages/** untouched (second change after M2.6).

State: all tasks integrated, head after spec task 9b419063 is 482cafb3 (plus this checkpoint commit). Round 1 panel (reviewer 5731e94, test-reviewer b151d99, ui-qa e4be8ed) findings fixed by tasks df68a4c1, 4a18966c, 7c0904a0, spec 9b419063. Coordinator approved changelog.generated.json in scope: after the final checkpoint commit, run `python3 tools/generate_changelog.py` and commit only that file; regenerate after any later checkpoint commit. CI at d5f9de61 was red only on 'Check generated changelog'.

Decisions: split into two changes (coordinator note); .gitignore exception for frontend/src/shared/lib; no ceiling assertion on pending list (follow-up F.2 in tasks.md); owner reading of constitution 15.5 for two different digests is open (design question 5).

Ruled out: moving labels to utils/ or shared/labels; touching pages/**.

Next: 1) changelog regeneration task, 2) push + CI, 3) panel round 2 (reviewer + test-reviewer), set_review_package, pr_ready, lead_ready.

Risks: pending list includes pages/Resolve/Resolve.tsx (M2.6 edits it, merge order). Components not mounted on any page.
