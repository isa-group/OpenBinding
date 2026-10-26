# Round 1 findings, PR #60 (change m09-compose-only, head ebdd63a8)

Disposition of each finding that the fix task named. Findings of round 1 that the task did not name are not listed
here and are not covered by this table. Nothing is disputed. `docker compose config` and the runbook commands were not
run (no Docker in the worker): Compose behaviour is checked by the static tests and by reading.

| Id | Disposition | Why |
|---|---|---|
| R1-REV-001 | fixed | `nginx` and the workers depend on `gateway` with `restart: true`; the runbook runs `$DC restart nginx` after every gateway recreate; tests for both |
| R1-REV-002 | fixed | pre-release dump uses `pipefail`, `umask 077` and `pg_restore --list` and refuses to deploy on failure; the rollback checks the dump and restores into `openbinding_rollback` before touching the live database |
| R1-REV-003 | fixed | rollback is `git checkout <previous tag>` of the whole tree; the pre-flight refuses a dirty `git status --porcelain` |
| R1-REV-004 | fixed | the postgres health check uses `-h 127.0.0.1`; the restore drill uses `up -d --wait postgres` |
| R1-REV-005 | fixed | the spec delta lists the guard test's real exclusions with the reason for each |
| R1-REV-006 | fixed | new requirement `production-network~1` with scenarios; the tests that enforced it are retagged |
| R1-REV-007 | fixed, follow-up | `[impl->...]` comments in `docker-entrypoint.sh` and `compose.yaml`; extending the OFT trace paths is the owner's follow-up F8 |
| R1-REV-008 | fixed | same as R1-TST-001 |
| R1-REV-010 | fixed | 'rootful Docker Engine' is a host prerequisite; the spec exclusions of R1-REV-005 |
| R1-REV-012 | fixed | `init: true` on `pg-backup` and `frontend-assets`, with a static test |
| R1-REV-013 | fixed | spec: `only` exits with the migration's status; 'if NAME is also non-empty' |
| R1-TST-001 | fixed | a success test for each of the seven variables (secret never printed, stderr empty), `DATABASE_URL_FILE` in auto mode, and a test that the command sees the environment it received |
| R1-TST-003 | fixed | `cd /backups` before the loop, `-name 'openbinding-*.dump'` and `-maxdepth 1` on the retention find, each with a mutation |
| R1-TST-004 | fixed | the `entrypoint` fixture asserts the script exists instead of skipping |
| R1-TST-005 | fixed | the trailing newline test prints `FILE_SECRET|` with `printf "%s|"` |
| R1-TST-006 | fixed | empty `OPENBINDING_MIGRATE` with and without `DATABASE_URL`; empty `NAME` with `NAME_FILE` set (the file wins, in the spec) |
| R1-TST-007 | fixed in part | the skip as root stays and is explained; a source test keeps the `[ ! -r` check and `cat --` from being removed; the unreadable-file behaviour is not exercised as root |
| R1-TST-008 | fixed | values with shell metacharacters, `-n`, `-e` and spaces are read back verbatim; the fake `alembic` uses `printf '%s\n'` |
| R1-TST-009 | fixed | the failure tests assert `<NAME>_FILE` in stderr; the no-database auto test runs a command and checks it ran with its exit status |
| R1-TST-011 | fixed | mutations for a password in a URL and a 40-character token under non-secret names, each with its own message |
| R1-TST-012 | fixed | `EXPECTED_IMAGE_VARIABLE` with swap mutations; a digest of one repeated character is rejected for non-marker images |
| R1-TST-013 | fixed | stale mutation paths and missing structures fail with a message; runbook service names are matched in the services table |
| R1-TST-014 | follow-up | disclosure stays: `docker compose config` is not run by the factory; CI (owner token) or a person with Docker runs the render command |
| R1-SEC-001 | fixed | same as R1-REV-002 |
| R1-SEC-002 | fixed | keys and passwords that a person provides are read with `IFS= read -rs v` and piped to `put_secret`; history is switched off; a test rejects a literal `printf '%s' '<...>'` |
| R1-SEC-003 | follow-up | `user` and `cap_drop` cannot be verified without Docker; recorded as F7 in tasks.md and in the runbook 'What stays blocked' |
| R1-SEC-005 | fixed | the secret rule uses the real default `APP_ENV=dev` (checked against `core/settings.py`); a service that sets `APP_ENV` must set `prod`; the gateway must set it |
| R1-SEC-006 | fixed | the PostgreSQL password reaches `ALTER ROLE` on standard input inside the container, never as an argument |
| R1-SEC-008 | fixed | TLS directory 0750 root, `privkey.pem` 0600 root, listed by the pre-flight |
| R1-SEC-009 | fixed | the pre-flight checks `config --images` (digest on every line, no `gap.invalid`) and refuses an `*_IMAGE` in `site.env` |
| R1-SEC-010 | fixed | the runbook states `SPACE_URL` must be https, and the pre-flight refuses anything else |
| R1-SEC-011 | fixed | `put_secret` refuses an empty value, writes a temp file then `mv`, keeps `<name>.prev` until verified; the Fernet rotation fails unless old and new are non-empty and unsets them |
| R1-SEC-012 | fixed | snapshot archives and the pre-release dump are created with `umask 077`; off-host copies are encrypted in transit and at rest |
| R1-SEC-013 | fixed | the restore drill prints the host name and aborts unless `DRILL_HOST=yes` |
| R1-SEC-014 | fixed | after the first login the `bootstrap_admin_password` file is emptied and the gateway recreated |
| R1-SEC-015 | fixed | the entrypoint reads the file with `cat --`; the runbook states the uids apply to a rootful Docker Engine without userns-remap or rootless mode |

A clean-context review of these fixes found, and the fixes then corrected: the `.prev` clean-up glob running in the
user's shell instead of a root shell; the rollback swap steps not being gated on the restore (now `rollback_swap`,
called only after `rollback_restore` succeeded, which returns to the running release on failure); a PostgreSQL
password rotation that could not be undone with the old files; and a test that matched `pg_restore --list` in prose.
