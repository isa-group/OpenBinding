# Lessons

Known traps that cost earlier tasks a round; read them before you start.

1. Retired BIM markers in agent-work files: tools/check_bim_guard.py scans the whole repository, including docs/agent-work/** handoffs and test files. Never write a retired route or file literal; describe it in words or split the string, and run the bim-guard check before ending (m27-names-not-digests handoff).
2. Changelog after the last push: any commit after the chore(changelog) commit makes frontend/src/content/changelog.generated.json stale and turns the frontend CI job red. Regenerate it as the last commit, or tell the coordinator after every later push (see the optimistic-concurrency, m0-infra-close and m27 handoffs).
3. More than two review rounds: REVIEW.md allows two fix rounds. Ask for a CRP instead of a third round, even a docs-only one (m0-infra-close handoff).
4. Shared test files outside scope: a component's *.test.tsx may belong to another slice, and writes outside the file scope are refused. Check the scope before editing and name the file under needs.
5. Resumed attempts: after a model API error, run every registered check again from #0 before writing a done result block.
