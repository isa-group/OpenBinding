# Baseline of `openspec validate --strict --all`

Measured on 2026-10-26 through the registered checks 0, 1 and 2.

## Limit of this record

The check output is returned as its last ~17,000 characters. The head of the JSON (the CLI version line, the first
items and the first issues of the first failing changes) was cut in checks 0 and 2, and the log files are outside
the worker's readable scope. Facts below come from the visible part and from the summary block, which is complete.
Items marked "not visible" must be re-read from a run whose output is written to a file.

## CLI version

- Check 0 (local `openspec`): version line not visible (cut). The task states 1.15.0.
- Check 2 (`npx @fission-ai/openspec@1.14.3`): it ran and produced a JSON report, so it did not fail offline. The
  version line is not visible, so it is not proven that npx resolved 1.14.3 and not the local binary.

## Result of `--strict --all`

- Exit code: **1** (printed `exit=1`).
- Totals: 27 items, 21 passed, 6 failed.
  - specs: 16 items, **16 passed, 0 failed**.
  - changes: 11 items, 5 passed, **6 failed**.
- Every issue seen is level WARNING with the message "Requirement text is very long (>500 characters). Move
  examples and edge cases into scenarios, or split it into separate requirements that each state one behavior."
  Strict mode turns these warnings into failures.

## Failing items (all changes, none a living spec)

Visible in full:

| Change | Spec file | Requirements flagged (ADDED) |
|---|---|---|
| m24-retire-screens-2 | frontend-workspace | Report editor addresses redirect to the publications; No link leads to a report editor address; Project tabs and palette lead to the publications, not the reports; Report page offender leaves the allow-list; Publications and verifier stay without report links; No entry point into the report editor |
| m41-space-lab-profile | lab-deployment | Optional pricing profile in its own file; Pinned images of the pricing profile; Memory budget of the pricing profile; Pricing profile isolated from the host; Secret references of the pricing profile; Start order of the pricing profile; Remote SPHERE only; Bootstrap of the SPACE service from the SPHERE link; Bootstrap boundary with SPACE and SPHERE |
| validate-public-origin-format | gateway-api | Public origin format; CORS origin entry format; Origin error names the value with userinfo masked |

Partly visible (head of the item cut; its id is not visible, most likely the sibling `m24-retire-screens-1`):

- frontend-workspace: "Allow-list ceiling equals its entries"; "Gateway untouched by screen retirements" (more issues
  of that item may be cut).

Not visible: the other 2 failing changes (6 failed minus the 4 above). Passing and visible: m41-space-bootstrap,
qacobench-experimentation, resolver-verifier, studies-analysis (specs and one change).

## Living requirements above 500 characters

None. Check 1 (body = text between the `### Requirement:` line and the first `#### Scenario`, blank lines
removed) gives a maximum of **488** characters, in two specs:

- auth-roles-entitlements: "Entitlements from the plan service" (488)
- instances-snapshots: "Packages only as ZIP archives" (488)

Next highest: engines-java "Pareto modes return a canonical archive" (479), engine-registry "Idempotent immutable
registration" (468), job-execution "Failed jobs show catalog sentences only" (467). Maximum per spec: auth-roles 488,
collaboration-artifacts 457, engine-minizinc 453, engine-protocol 447, engine-registry 468, engines-java 479,
frontend-catalog-pricing 433, frontend-workspace 448, gateway-api 433, generator 452, instances-snapshots 488,
job-execution 467, lab-deployment 458, qacobench-experimentation 445, resolver-verifier 455, studies-analysis 416.
Requirement counts: 10, 8, 10, 9, 9, 7, 8, 7, 8, 7, 7, 10, 9, 8, 5, 6 (same order as the specs above, alphabetical).

## 1.15.0 versus 1.14.3

For the visible part and the summary, check 0 and check 2 are identical: same totals (27/21/6), same failing
changes, same messages, exit 1. No difference found, with the caveat that the version of the check 2 run is not
proven (see above).

## Reading: why ROADMAP says 16 specs fail

- The 16 living specs do pass strict validation today (16/16), with bodies at most 488 characters, under the 500
  limit of the warning.
- What fails `--all` is 6 active changes whose delta (ADDED) requirements exceed 500 characters. The ROADMAP figure
  "16" matches the number of living specs, so it most likely came from an earlier state in which the specs had long
  requirements (since shortened), or from conflating "`--all` fails" with "all 16 specs fail". It no longer describes
  the specs.
- So `openspec validate --strict --all` reaches exit 0 only after the long requirements in the failing changes are
  shortened or split (or the changes are archived after being fixed), not by touching the living specs. The
  living specs are close to the limit (several above 450), so future edits should be kept short.
- Not established: the age of the ROADMAP figure and the CI result with 1.14.3 (CI was not run).
