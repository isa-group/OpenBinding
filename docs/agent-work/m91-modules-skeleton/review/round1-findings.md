# Review round 1: m91-modules-skeleton

## reviewer: changes-requested (0 blocker, 2 major, 4 minor, 2 nit)

| Id | Severity | Finding | Disposition |
|---|---|---|---|
| R1-REV-001 | major | detector misses `from X.application import sub` | fixed in tasks (detector and its tests) |
| R1-REV-002 | major | missing impl tags | fixed: package docstrings and ini carry the tags; `application-only` now `Needs: utest` |
| R1-REV-003 | minor | teeth test not described | fixed in docs (design.md §2, ARCHITECTURE §4.2) |
| R1-REV-004 | minor | skeleton requirement describes a temporary state | fixed: reworded; M4.2 follow-up noted in design.md §6 |
| R1-REV-005 | minor | `gateway-as-is.md` promised but out of scope | fixed: promise removed, recorded as followup |
| R1-REV-008 | minor | long line in ARCHITECTURE §4.3 step 1 | fixed: wrapped, edit recorded in tasks S4 |
| other 2 nits | nit | style | fixed in tasks where applicable |

## test-reviewer: changes-requested (0 blocker, 2 major, 6 minor, 1 nit)

| Id | Severity | Finding | Disposition |
|---|---|---|---|
| R1-TST-001 | major | resolver untested | fixed in tests |
| R1-TST-002 | major | tree glue untested | fixed in tests |
| R1-TST-003 | minor | teeth test skipped without `lint-imports` | accepted: skip kept; noted for the MRP |
| R1-TST-008 | minor | coverage of contract runs | accepted: covered by the qa checks; noted for the MRP |
| other 4 minor, 1 nit | minor/nit | test quality | fixed in tests |
