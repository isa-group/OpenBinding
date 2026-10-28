Goal: M2.7 part 1 (names, not digests): shared/lib/identity.ts, components/CitationPanel, components/VerifyResult, test/digestHygiene.test.ts (PENDING_CLEANUP 40, EXEMPT_FILES 39), spec aligned. Pages/** untouched (second change after M2.6).

State: all tasks integrated. Round 2 panel at 0009ec0d: test-reviewer 5188b25d approve; reviewer 87a75860 changes-requested with one blocker (the BIM guard flagged the jobs API file path literal in the pinned exempt list of digestHygiene.test.ts), fixed by task 5edde466 (string split, A.3b ticked). Pushed 44061e8d; CI then failed bim-corpus because this handoff quoted the retired jobs API route marker; reworded here (never write that literal in agent-work files). Changelog generated file: task 09bf6261 found it current at 44061e8d; this new checkpoint commit may make it stale: regenerate with python3 tools/generate_changelog.py and commit only that file.

Decisions: split into two changes (coordinator note); .gitignore exception for frontend/src/shared/lib; no ceiling assertion on pending list (follow-up F.2 in tasks.md); owner reading of constitution 15.5 for two different digests is open (design question 5).

Ruled out: moving labels to utils/ or shared/labels; touching pages/**.

Next: 1) changelog regeneration task, 2) push + CI green, 3) final reviewer + test-reviewer on the pushed head, set_review_package, pr_ready, lead_ready.

Risks: pending list includes pages/Resolve/Resolve.tsx (M2.6 edits it, merge order). Components not mounted on any page.
