# Handoff: m09-compose-only (wake 10)

## State
- Change head after integrating 786a226e (round-1 fixes) and 51eaf817 (guard test uses REPO_ROOT, prunes dirs, tolerates OSError): 3298c107, plus this checkpoint commit. PR #60 (pushed head ebdd63a8 before this push).
- Round-1 fixes: nginx and workers depend_on gateway restart: true; postgres healthcheck on 127.0.0.1; init: true on pg-backup/frontend-assets; entrypoint cat --; runbook: pre-flight (config --images, clean git status), typed secrets via read -rs, verified pre-release dump (pipefail, pg_restore --list), rollback as rollback_restore (new database) then rollback_swap, undoable PostgreSQL password rotation, drill guard, TLS modes, rootful Docker prerequisite; spec: production-network~1, guard exclusions; tests: success-path no-print, metacharacters, backup mutations, image variable map, etc. docs/agent-work/m09-compose-only/review/round1.md lists dispositions.
- Verification task 42b4dcc9 runs the full gateway suite (deselect test_process_probe).
- CI on ebdd63a8 had 2 reds: test (my guard test, fixed) and frontend changelog (coordinator regenerates after the final push).

## Accepted follow-ups (list in PR)
F7 non-root users and cap_drop for JVM engines, nginx, frontend-assets (needs Docker to verify); F8 owner extends OFT trace paths; non-superuser DB role; trusted proxy address / Redis auth; SPACE_URL https validator in Settings; base image digests; docker compose config never run (needs Docker or the S5 CI job); local SPACE vs INTENT.md:180; spec states *.yml/*.yaml workflow glob.

## Next three steps
1. When 42b4dcc9 is green: push chore/compose-production-overlay, update PR body.
2. Round-2 panel on the pushed head; tell the coordinator the head is final (changelog).
3. set_review_package, lead_ready.
