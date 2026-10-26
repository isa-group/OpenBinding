# Baseline of `openspec validate --strict --all`

Measured on 2026-10-26 through the registered checks 0 and 1 (a script summarises the JSON, so nothing is cut).

## CLI version

- Local `openspec`: **1.15.0**.
- The earlier run with `@fission-ai/openspec@1.14.3` produced the same totals, failing changes and messages as the
  local binary. Which version npx resolved was never printed, so that equality is not proof about 1.14.3.

## Result of `--strict --all`

- Exit code: **1**.
- Totals: 27 items, 21 passed, 6 failed.
  - specs: 16 items, **16 passed, 0 failed**.
  - changes: 11 items, 5 passed, **6 failed**.
- Every issue is level WARNING: "Requirement text is very long (>500 characters). Move examples and edge cases into
  scenarios, or split it into separate requirements that each state one behavior." Strict mode turns these warnings
  into failures. Total: 40 issues.

## Failing changes (complete list)

Body length = text between the requirement header and the first `#### Scenario`, blank lines removed. All flagged
requirements are ADDED. No failing change collides with the living spec on an ADDED name (check 1: "in living
spec: False" for each).

| Change | Capability | Issues | Longest body | Merged state (tasks.md ticks) |
|---|---|---|---|---|
| m05-pr-previews | lab-deployment | 9 | 733 | Not complete: 6 ticked, 12 open (tests 1.1, 1.2, 1.7, files 2.1, 2.2, docs 4.2, 4.3, archive). Handoff: spec round 2 fixed; implementation not shown as merged. |
| m21-rendering-catalogue | frontend-rendering | 6 | 1407 | Nearly complete: 18 ticked, 2 open (5.1 review sign-off, 5.2 archive). Handoff says all slices built, PR 38 open; whether it is merged is not shown by the repo files. |
| m24-retire-screens | frontend-workspace | 7 | 982 | Not complete: 10 ticked, 11 open. Slice 1 built and reviewed (handoff); slices 2 to 5 and archive open. |
| m24-retire-screens-2 | frontend-workspace | 6 | 1287 | Not started on build: 16 open (tests 2.1 to 2.6, code 2.7 to 2.12, sign-off, archive after S5). |
| m41-space-lab-profile | lab-deployment | 9 | 2027 | Not complete: 6 ticked, 6 open (2b.1, 3.1, 4.1, 4.2, 5.1, archive). |
| validate-public-origin-format | gateway-api | 3 | 1625 | Implementation ticked (3 of 4); only 4.1 archive open, so it is waiting for archive. |

Only validate-public-origin-format is clearly waiting for archive. m21-rendering-catalogue is waiting for sign-off
and archive. The others still have implementation tasks open.

### Flagged requirements

m05-pr-previews (lab-deployment): Preview on demand per PR head 680; Preview port range on loopback 644; One project
and private volumes per preview 663; Tracked Compose file and synthetic data only 711; Refresh on a new head 733;
Preview expiry after 7 idle days 613; Destroy only through the maintenance operation 709; Cap on running previews 627;
Refusal when preview ports are exhausted 501. Also MODIFIED "Single loopback port in the lab" 1120 (exists in the
living spec; not flagged by the validator, which only reports ADDED here, but over 450).

m21-rendering-catalogue (frontend-rendering): Read-only source view 882; Collapsed, searchable log panel 875; Grouped
diagnostics list 1272; Verdict badge 827; Metric cards 760; Raw-rendering hygiene with a shrinking allow-list 1407.

m24-retire-screens (frontend-workspace): Retired screens are not routed 681; Old addresses redirect through one table
857; Decision-space addresses redirect to the study or the job history 765; No link leads to a retired address 814;
Offenders leave the allow-list with their screens 768; Allow-list ceiling equals its entries 504; Gateway untouched by
screen retirements 982. Not flagged but over 450: Main navigation without retired screens 454; Command palette
without retired screens 470.

m24-retire-screens-2 (frontend-workspace): Report editor addresses redirect to the publications 1057; No link leads to
a report editor address 1287; Project tabs and palette lead to the publications, not the reports 754; Report page
offender leaves the allow-list 627; Publications and verifier stay without report links 952; No entry point into the
report editor 818. Not flagged, 477: Report editor screens are not routed.

m41-space-lab-profile (lab-deployment): Optional pricing profile in its own file 1450; Pinned images of the pricing
profile 2027; Memory budget of the pricing profile 922; Pricing profile isolated from the host 1005; Secret
references of the pricing profile 1019; Start order of the pricing profile 696; Remote SPHERE only 1314; Bootstrap of
the SPACE service from the SPHERE link 1354; Bootstrap boundary with SPACE and SPHERE 1169. Also MODIFIED "No local
SPACE" 1789 (exists in the living spec).

validate-public-origin-format (gateway-api): Public origin format 1625; CORS origin entry format 1468; Origin error
names the value with userinfo masked 1310.

Note: the validator counts the whole requirement text, so bodies of 477 to 504 in the table above are near the 500
limit; the check-1 lengths exclude the header line and may differ slightly from the validator's count.

### Other unarchived changes (passing)

m03-gate-tooling has four ADDED bodies of 470 to 487 (pass, close to the limit). m41-space-bootstrap,
m02-openspec-strict, ci-develop-triggers and ci-develop-nightly also pass.

## Ownership

The repository states no named owner for any of the six changes. What it shows:

- m05-pr-previews, m21-rendering-catalogue, m24-retire-screens, m24-retire-screens-2, m41-space-lab-profile each have
  `docs/agent-work/<change>/handoff.md` and `plan.md` written by the lead of that change (handoffs cite reviewer and
  specifier task ids, not people). The lead of each change is its owner for fixes.
- validate-public-origin-format has no agent-work directory; owner not stated (its tasks.md ends at the archive step).
- Archiving is a separate explicit archive task for each (tasks.md says so for m05, m21, m24 and m41).

## Living requirements above 500 characters

None. Maximum body in the living specs is **488** characters: auth-roles-entitlements "Entitlements from the plan
service" and instances-snapshots "Packages only as ZIP archives". Next: engines-java "Pareto modes return a canonical
archive" 479, engine-registry "Idempotent immutable registration" 468, job-execution "Failed jobs show catalog
sentences only" 467. Maximum per spec: auth-roles 488, collaboration-artifacts 457, engine-minizinc 453,
engine-protocol 447, engine-registry 468, engines-java 479, frontend-catalog-pricing 433, frontend-workspace 448,
gateway-api 433, generator 452, instances-snapshots 488, job-execution 467, lab-deployment 458,
qacobench-experimentation 445, resolver-verifier 455, studies-analysis 416.

## Reading: why ROADMAP says 16 specs fail

- The 16 living specs pass strict validation today (16/16).
- What fails `--all` is 6 active changes whose ADDED requirements exceed 500 characters. The ROADMAP figure "16"
  matches the number of living specs and does not describe them today.
- `openspec validate --strict --all` reaches exit 0 only after those requirements are shortened or split in the six
  changes (not by touching the living specs). Archiving a change as written would copy the long requirements into the
  living specs and break the 16/16 result, so each must be fixed before its archive. Archive would not collide on
  ADDED names; the two MODIFIED requirements (m05 and m41) do exist in the living spec.
- Living specs are close to the limit (several above 450), so edits there should stay short.
- Not established: the age of the ROADMAP figure and the CI result with 1.14.3.
