Goal: record M0.8, M0.9, M2.7 as 'partly' in ROADMAP Status (S1 done, integrated 0195229c). Scope widened by coordinator to include frontend/src/content/changelog.generated.json (generated only).
State: changelog regeneration task 7e022259cf924d22 integrated at e2753e88 (diff: documentation track date 2026-11-02 -> 2026-10-27 and drops the 'Optimistic-concurrency plan and handoff' entry; the worker's summary said 'no change' but its commit has this diff and both checks passed). Earlier explorer saw --check fail at 0195229c, consistent.
Next: checkpoint commit, push chore/roadmap-m0-m2-status, open PR into develop, run reviewer (with changelog --check re-run on the pushed head), set_review_package (docs only, how to review), lead_ready.
Risks: any commit after the changelog commit that the generator counts makes the JSON stale again (docs/lessons.md item 2); verify with --check on the pushed head.
Ruled out: hand-editing the JSON.
