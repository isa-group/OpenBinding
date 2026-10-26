# Review round 2: m91-modules-skeleton

## reviewer: changes-requested (0 blocker, 1 major, 1 minor, 1 nit)

| Id | Severity | Finding | Disposition |
|---|---|---|---|
| R2-REV-001 | major | G6 traces `openbinding-gateway/src` and tests only, so `module-contracts` had no impl tag | fixed: tag added to the `modules/__init__.py` docstring; the ini keeps its tag |
| R2-REV-002 | minor | bare `import ...modules.repository` from a sibling module not covered | fixed: fixture added in `test_modules_cross_import.py` |
| R2-REV-003 | nit | ARCHITECTURE §4.2 Enforcement line over 120 chars | fixed: wrapped |

## test-reviewer: approve (0 blocker, 0 major, 1 minor, 2 nit)

| Id | Severity | Finding | Disposition |
|---|---|---|---|
| R2-TST-010 | minor | resolver fixture lacks a file inside `app` | fixed: `app/inner.py` added, stays out of the offenders |
| R2-TST-011 | nit | style | no change |
| R2-TST-012 | nit | real-tree sanity message unclear | fixed: says the gateway package has no Python files to check |

Accepted: R1-TST-003 skip kept; the blocking CI step S2 must run the teeth test with `--group lint`.

## Open owner items

- S2 CI step: run `tests/test_modules_skeleton.py` with `--group lint` so the teeth test runs instead of skipping.
- G6 trace paths could include the `openbinding-gateway` root config files (`importlinter-modules.ini`).
- ADR-0017 acceptance.
- G9 entry.
- Constitution Article 6 line.
