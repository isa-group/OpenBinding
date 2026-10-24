# M0.2 — requirement length (specs D, lab-deployment)

Rule: body of each `### Requirement:` (EARS sentence + id line + Evidence line) at most 500 characters, target 450.
No openspec binary was available: lengths are hand counts (error about ±15 characters), not tool output.

Revision rule (constitution 1.3): rewording does not bump the revision; narrowing a requirement bumps it and the
split-off behaviour gets a new id at `~1`. Ids are never reused.

## Living spec (`openspec/specs/lab-deployment/spec.md`)

| Requirement | Before | After | Id before | Id after |
|---|---|---|---|---|
| Single loopback port | ~360 | ~360 | single-loopback-port~1 | same |
| Memory budget | ~463 | ~452 (reworded) | memory-budget~1 | same |
| Secret references | ~537 | ~324 (JWT clause moved out) | secret-references~1 | secret-references~2 |
| (new) JWT secret only for session signers | — | ~363 (second test added to Evidence) | — | jwt-secret-scope~1 |
| Unprivileged containers | ~530 | ~377 (pinning moved out) | unprivileged-containers~1 | unprivileged-containers~2 |
| (new) Pinned images and uv | — | ~215 | — | pinned-images~1 |
| No local SPACE | ~347 | ~347 | no-local-space~1 | same |
| Migrations at start | ~388 | ~388 | migrate-on-start~1 | same |
| Kubernetes manifests render | ~250 | ~250 | kustomize-render~1 | same |

Every Evidence entry is kept: the JWT test moved with its clause, the `uv`-pinning test with the pinning clause. Each
new requirement has a scenario; existing scenarios are unchanged. No code or test carries a tag for the changed ids
(they are not cited outside the spec).

## Preview requirements of M0.5 — NOT in the living spec

The ten `preview-*` / `single-loopback-port~2` requirements are not in `openspec/specs/lab-deployment/spec.md`: they
live as a delta in `openspec/changes/m05-pr-previews/specs/lab-deployment/spec.md` (the change is not archived). That
file is outside this task's scope, so it was not edited. The sentences are under 380 characters, but the Evidence
lines (many `GAP` entries with long test names) make each body far over the limit (hand estimates):

| Requirement | Body estimate |
|---|---|
| single-loopback-port~2 | ~1200 |
| preview-on-demand~1 | ~1000 |
| preview-port-range~1 | ~1150 |
| preview-isolation~1 | ~950 |
| preview-synthetic-only~1 | ~950 |
| preview-refresh~1 | ~930 |
| preview-idle-expiry~1 | ~960 |
| preview-destroy-maintenance~1 | ~1200 |
| preview-running-cap~1 | ~1080 |
| preview-ports-exhausted~1 | ~600 |

Suggested fix for a task that may edit the change: cite `lab/tests/test_previews.py` once at file level (plus the F2
acceptance line where there is one) and keep the per-test names in `tasks.md`, or split the requirements; check that
every clause stays covered by a named test or file.

Counts at 9d9151f; openspec validate --strict --all: NOT EXECUTED (exencion del propietario 24-10-2026).
