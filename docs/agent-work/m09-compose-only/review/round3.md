# Round 3: dispositions (PR #60, head 529cc33c)

| Finding | Severity | Disposition | Evidence |
|---|---|---|---|
| R3-SEC-001 | major | Fixed | `undo_password_rotation` passes the pattern on standard input: `printf ':%s@' "$old" \| sudo grep -qF -f - "$dir/database_url.prev"`, inside the same `&&` chain with the refuse branch kept. New static scan `secret_argument_problems` over the fenced bash blocks (secret variables `old`, `new`, `password`, `v` in the arguments of a non-builtin command; builtins and assignments allowed), with a case table and a mutation that re-introduces the old line. The scan found one more hit: the snapshot loop used `$v` as a volume name (not a secret); the loop variable is now `vol`. The undo mutation tests were updated to the new line; the `sudo` shim passes standard input through. |
| R3-REV-001 | minor | Fixed | The forward rotation block removes `postgres_password.prev` and `database_url.prev` (`sudo sh -c 'rm -f --'`) after the empty-password guard and before `ALTER ROLE`; the text says so and that any `.prev` is from the current rotation. Test: order of guard, removal, `ALTER ROLE`, new files; the block runs with stale files (removed with a password, kept with an empty one); mutation without the removal. |
| R3-REV-002 | minor | Fixed | One sentence after the undo text: after a partial forward rotation (role changed, `database_url` not replaced) the undo refuses; rewrite `database_url` from `postgres_password`, or set the role back from `postgres_password.prev` and move only that file back. |
| R3-REV-003 | minor | Fixed | The `mv` loop ends each iteration with `\|\| exit 1`. Test: a fake `mv` that fails on `postgres_password.prev`; the undo returns non-zero and recreates nothing; mutation without `\|\| exit 1` returns 0. |
| R3-REV-004 | minor | Fixed | Step 7 uses `sudo sed -i`; one sentence says `site.env` belongs to root. The test runs the `sed` with the `sudo` shim and checks the sentence. |
| R3-REV-005 | minor | Fixed | `tasks.md` 1.1 lists the skipped directories as in the spec delta (`.git`, `node_modules`, `.venv`; for manifests also `openspec`, `docs`, `lab`, `.github`) and `*.yml` and `*.yaml` workflows. |
| R3-SEC-003 | not now | Follow-up | Listed in the PR follow-ups. |
| R3-SEC-004 | not now | Follow-up | Listed in the PR follow-ups. |

Docker is not available here: the runbook blocks run with shims for `sudo`, `$DC` and `mv`; `docker compose config` was not run.
