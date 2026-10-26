# Handoff: m09-compose-only (wake 17)

## State
- Integrated: round-3 fixes (6b39770d: password undo reads the pattern on stdin, argv-secret static test, stale .prev removed before ALTER ROLE, mv loop || exit 1, sudo sed -i, tasks.md aligned, partial-rotation note) and 58c23f0a (site.env owned by the operator user, mode 0600). Head 8dadfa73 plus this checkpoint commit; the pushed head is 529cc33c. Dispositions: review/round3.md.
- Round-3 panel on 529cc33c: reviewer approve, test-reviewer no blocker/major, security-auditor one major (R3-SEC-001, now fixed).
- Full gateway suite last passed on the round-1 head; CI test on the final head will rerun it.

## Follow-ups for PR
F7, F8, F9 nginx resolver, non-superuser DB role, trusted proxy/Redis auth, SPACE_URL validator, base image digests, docker compose config never run, local SPACE vs INTENT.md:180, R2-SEC-006/007, R2-TST-005, R3-SEC-003 (tag vs ordered tag), R3-SEC-004.

## Next three steps
1. Push, then narrow security re-check (R3-SEC-001 lines, argv scan) and test review of the new tests; escalate if a major remains.
2. Tell the coordinator the head is final (changelog regeneration); wait for CI.
3. set_review_package, lead_ready.
