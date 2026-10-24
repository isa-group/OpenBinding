GOAL: PR previews per PR head in the NiPoGi lab (ROADMAP M0.5), repo side only.
STATE: spec task ec26ee0461d64be6 integrated into change branch (1b6d833): proposal, design, tasks, delta spec (1 MODIFIED + 9 ADDED reqs), docs/previews/README.md (plan). Clean review inside the task found 4 major + 7 minor, all fixed. G1 task 76e602a7ed7e43dc blocked: openspec binary missing in the QA runner (FileNotFoundError); not a spec defect. CRP crp-openbinding-openspec-g1-waiver open. Branch not yet pushed at the start of this run.
DECISIONS: slice order set by coordinator: S1b+S3, then S4, S1a+S2 last (S2 waits for the validator accepting DEMO_LAB_PORT, managed by coordinator). One PR preview beside develop is a documented limit. No AI mentions in anything published.
RULED OUT: touching lab_compose / labctl (outside the repo).
OPEN: auto-stop of idle running preview (owner question, not blocking). design.md is ~195 lines, change ~540 markdown lines (over the 300 target, spec only).
NEXT: (1) push and open the spec PR, say G1 not run; (2) panel reviewer + test-reviewer on pushed head, then lead_ready; (3) after merge, slices S1b+S3, S4, S1a+S2 in that order.
EVIDENCE: task ec26ee0461d64be6 commit d29a958, integrated 1b6d833; task 76e602a7ed7e43dc blocked on G1.
