Change m05-pr-previews (M0.5), approved scope by the coordinator (option A): repository files of design.md §9-§10.

PR order (each ≤300 diff lines, tests first, develop unchanged by default, develop lab port 18100):
 0. PR-spec (this branch now): OpenSpec change m05-pr-previews (proposal, design, tasks, delta spec lab-deployment) + docs/previews/README.md (plan). G1 could not run: no openspec binary in the lab (CRP crp-openbinding-openspec-g1-waiver open); say so in the PR.
 1. S1b+S3: lab/tests/test_previews.py (red first, planner called by subprocess) + lab/previews/previews.py (stdlib planner).
 2. S4 (if it does not depend on S2): docs/DEMO.md section, runbook, TESTING.md, E2E_PLAN.md, lab/tests/test_preview_isolation.py (skipped without a lab).
 3. S1a+S2 last: compose parameterisation DEMO_LAB_PORT in compose.lab.json and 4 profiles + static rule tests. Not merged until the coordinator's lab_compose validator accepts DEMO_LAB_PORT; tell the coordinator when S2 is ready to merge.
Documented limit in docs/previews: one PR preview beside develop (4032 MiB per stack, cap 9216 MiB).
Out of repo (coordinator handles): lab_compose validator, labctl preview/destroy.
