# Review round 1 — m45-lab-pricing-wiring

Round 1 of the panel on the head after T3. Reviewer: one major (R1-REV-001) and minors or nits. Test-reviewer
(R1-TST-001..005) and security-auditor (R1-SEC-001..004): minor and nit findings only, verdict approve. "Fixed" means
changed in this round; "follow-up" means recorded here and not done.

| Id | Source | Disposition |
|---|---|---|
| R1-REV-001 (major) | reviewer | Fixed: the dropped note is back as two UNVERIFIED items in `docs/qa/PRICING_PROFILE.md` (Facts to confirm on the first build) and as open point R2 in `design.md` §3 |
| R1-REV-002 | reviewer | Fixed: the Evidence lines of the delta spec list the existing tests of the new scenarios |
| R1-REV-003 | reviewer | Fixed: `bootstrap-environment~1` pins the seven service keys of `pricing-bootstrap`; `rule_bootstrap_surface` enforces them; controls for a healthcheck, a volumes entry and a command |
| R1-REV-004 | reviewer | Follow-up: `tasks.md` nits not changed in this round |
| R1-TST-001 | test-reviewer | Fixed: controls for an extra declared volume, a missing declared volume and a named mount with a wrong target (`test_control_refuses_volume_and_user_variants`) |
| R1-TST-002 | test-reviewer | Fixed: controls for a service with no `user` key and for user `0:1000` (same test) |
| R1-TST-003 | test-reviewer | Fixed: `rule_isolated` refuses the destructive-key name anywhere in the manifest (literal assembled from two parts); control in the same test |
| R1-TST-004 | test-reviewer | Follow-up: pin the values of `ADMIN_USER` and `SERVER_PORT` |
| R1-TST-005 | test-reviewer | Follow-up: vacuous skips |
| R1-SEC-001..004 | security-auditor | Follow-up, none changed in this round: hashed pip requirements for the tool image; factory preflight that refuses unset or empty `DEMO_SPACE_*` values (design.md §3); node base image bump (design.md §3, R6) |

Checks of this round: ruff on the lab test file, targeted pytest (`../lab/tests`, `tests/test_no_local_space.py`) and
`openspec validate m45-lab-pricing-wiring --strict` passed. The full gateway suite (without `tests/test_process_probe.py`)
passed on the second run: 4000 passed, 97 skipped; the first run was aborted by the tool after 1800 s without output.
