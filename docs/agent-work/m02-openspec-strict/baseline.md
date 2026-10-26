# M0.2 baseline: `openspec validate --strict`

Measured through the registered checks (check 0: current living specs; check 1: archive of this change on a scratch
copy, then strict validation).

## CLI

`openspec --version`: 1.15.0.

## Check 0: living specs as they are now

`openspec validate --strict --specs --json` reports 16 items, 16 passed, 0 failed, no issues, for all 16 specs:
auth-roles-entitlements, collaboration-artifacts, engine-minizinc, engine-protocol, engine-registry, engines-java,
frontend-catalog-pricing, frontend-workspace, gateway-api, generator, instances-snapshots, job-execution,
lab-deployment, qacobench-experimentation, resolver-verifier, studies-analysis.

So the CLI printed no failing requirement, no message and no measured length: the baseline of failing requirements is
empty at the time of this run (the other M0.2 slices may already have shortened their specs, or the rule is not
reached by `--specs --json`). The exact limit and what is counted could not be read from the CLI output. The working
rule remains the one in `design.md` (statement, id line and Evidence line at most 500 characters, from the earlier
slices and `openspec/changes/m03-gate-tooling/tasks.md`), with a 400-450 target.

## Check 1: archive simulation

`openspec archive m02-openspec-strict --yes` on a scratch copy applied 18 modified requirements (engine-minizinc 6,
engine-protocol 5, engine-registry 4, engines-java 3), no add, remove or rename, and the strict validation then
passed: 16 passed, 0 failed. No error for the four capabilities of this change.

## engine-protocol-ir-only

`IR-only solve endpoint` (`req~engine-protocol-ir-only~1`) is not in the delta: its block in the living spec is about
480 characters (hand count), under the limit, and check 0 does not list it as failing.

## Other unarchived changes

Check 0 validates only specs (`--specs`), so it shows nothing about the other changes under `openspec/changes/`
(m03-gate-tooling, m05-pr-previews, m21-*, m24-*, m41-*, ci-develop-*, validate-public-origin-format). None was
edited. Their validation needs `openspec validate --strict --all`, which no registered check runs.
