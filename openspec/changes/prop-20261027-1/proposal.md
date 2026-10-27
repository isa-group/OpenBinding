# Change: prop-20261027-1

## Why

INTENT objective **O7, delivery flow** (`INTENT.md:168`), with the signal to watch "Spec drift: code without
`[impl->req~…]` tags, specs with `GAP` evidence" (`INTENT.md:219`). Proposal P-20261027-1, owner-approved; intake
`docs/agent-work/prop-20261027-1/intake.md` (facts F1-F14, checked at `5a47e475`).

The report-only G6 trace step in CI reads only `openspec/specs`, `openbinding-gateway/src`,
`openbinding-gateway/tests`, `engines`, `frontend/src` and `acceptance` (`.github/workflows/ci.yml:289`). The 283
coverage tags in 18 files under `lab/`, `tools/` and `.github/workflows/` (F3) are never traced, so a broken or stale
`utest` or `impl` tag there goes unnoticed. The living requirement `req~gate-tooling-trace-paths~1`
(`openspec/specs/gate-tooling/spec.md:57-72`) names the six paths "in that order", so widening the list is a
behaviour change that needs a new revision.

## What Changes

- The CI trace step also reads `lab`, `tools` and `.github/workflows`, appended after `acceptance`; the six existing
  paths keep their order.
- An absent path is still skipped and logged; the step stays report-only (`continue-on-error: true`).
- Broken or stale coverage tags in the lab tests, the CI tools and the workflow show up as trace defects on every PR.

Modified requirement (delta `specs/gate-tooling/spec.md`): `req~gate-tooling-trace-paths~1` becomes
`req~gate-tooling-trace-paths~2`.

## Impact

- Capability: `gate-tooling` only.
- Code: `.github/workflows/ci.yml` (the `for path in` list of the trace step only) and
  `lab/tests/test_ci_gate_tooling.py` (a CI-only path constant, the loop assertion and the tag moved to `~2`).
- API, schema, data: none. No new action, download, permission or job; the OpenFastTrace version and checksum stay.
- Risk: the first wider run reports more defects, not fewer: tags in `lab/`, `tools/` and `ci.yml` point at ids
  declared only in unarchived changes (intake F9). This is expected and does not block (report-only). See
  `design.md`.
- Review risk: S1 touches `.github/**` (R10, high by rule, `REVIEW.md:23,27`), so it keeps the full high panel
  unless the owner lowers it.

## Out of scope

- `.agentic/project.yaml`: the local G6 `oft-trace` argv keeps its six paths and `todo: true`;
  `req~gate-tooling-project-yaml-notes~1` is unchanged.
- Removing `continue-on-error` from the trace step, or making G6 blocking.
- Resolving the orphaned links of intake F9; the archive tasks of `ci-speed`, `m05-pr-previews`,
  `m41-space-bootstrap` and `m45-lab-pricing-wiring` own that work.
- Tracing `openspec/changes` or all of `.github`.
- Moving tags between directories.
