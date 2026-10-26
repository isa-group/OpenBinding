# Change: m03-gate-tooling

## Why

ROADMAP M0.3: "OpenSpec CLI (G1) and OpenFastTrace (G6) run in CI and in the gate runner; `acceptance/api` (pytest)
and `acceptance/ui` (Playwright) runners exist; import-linter and ESLint boundaries run in report-only mode (G9); a
`bim-toolchain` CI job runs its tests and goldens on every change under `bim-toolchain/` until the extraction to
`isa-group/bim-toolchain`".

Constitution GAP lines this change starts to close: 1 ("OpenSpec CLI not yet installed in CI"), 2 ("`acceptance/`
does not exist yet"), 3 (G6 has no tool to run), 6.5–6.6 ("import-linter contracts … and an ESLint boundaries rule").
The GAP lines stay until the gates block (design.md §9).

## What Changes

- CI job `openspec`: Node 22, `@fission-ai/openspec@1.14.3`, `openspec validate --strict --all`, report-only.
- CI job `trace`: Temurin 21, OpenFastTrace 4.11.0 downloaded into `$RUNNER_TEMP/oft` and checked by SHA-256, then
  `trace -o plain` over the G6 paths of `.agentic/project.yaml`, report-only. Download and checksum steps fail hard.
- import-linter (gateway, dependency group `lint`) and `eslint-plugin-boundaries` 7.3.0 (frontend devDependency, rule
  at `warn`), both report-only (G9). The three contracts state the layer rule of ADR-0012 and constitution 6.1; they
  do not mirror `tests/test_architecture_layers.py` exactly: they check whole import chains, mirror neither
  `ALLOWED_LEGACY` nor the composition root `main`, and the `integrations` contract is a deny-list subset of the
  test's allow-list. The first CI run is `Contracts: 1 kept, 2 broken` (see design.md §4); the gate stays report-only
  until the legacy refactors of ROADMAP M9.2.
- Workflow hardening: top-level `permissions: contents: read`, `persist-credentials: false` and `timeout-minutes: 10`
  on jobs `openspec` and `trace`, a HTTPS-only retrying download of the OpenFastTrace jar (GPL-3.0, CI-only, never
  committed or distributed), and `if: ${{ !cancelled() }}` on the API acceptance and import-linter steps of `lab`.
- CI job `bim-toolchain`: the bim-toolchain package tests and goldens on every pull request, in the gateway's locked
  environment.
- Acceptance runners without tests: `acceptance/api` (pytest, `lab` job) and `acceptance/ui` (Playwright, `frontend`
  job); both exit 0 while there are no tests. `TESTING.md` and `acceptance/README.md` describe them.
- `.agentic/project.yaml`: comment lines under the G1 and G6 entries only; `todo: true` stays.

## Impact

- Capability: new `gate-tooling`, 17 ADDED requirements. No HTTP API, OpenAPI, database or BIM contract change.
- Files: `.github/workflows/ci.yml`, `.agentic/project.yaml` (R11, owner approval), `openbinding-gateway/.importlinter`,
  `openbinding-gateway/pyproject.toml`, `openbinding-gateway/uv.lock`, `frontend/package.json`,
  `frontend/pnpm-lock.yaml`, `frontend/eslint.config.js`, `frontend/playwright.acceptance.config.ts`,
  `frontend/src/test/e2eSpecs.test.ts`, `acceptance/**` (runners only), `TESTING.md`, and the evidence file
  `lab/tests/test_ci_gate_tooling.py`.
- Images: the frontend `dev` and `build` stages and the e2e image (`frontend/Dockerfile.e2e`) gain
  `eslint-plugin-boundaries` through their existing `pnpm install --frozen-lockfile`; neither Dockerfile changes, and the
  served `prod`/`lab` stages copy only `dist`. OpenSpec, OpenFastTrace and import-linter are CI-only and in no image.
  The PR of S2 states the e2e image change.
- Risk: high by path (R10 `.github/**`, lockfiles, `package.json`; R7 `pyproject.toml`/`uv.lock`; R11
  `.agentic/**`), low in behaviour: every new gate step is report-only, and the only new failing steps are a pinned
  download, its checksum and the bim-toolchain tests.
- Order: S1 → S2 → S3 → S4, serialized because each slice edits `ci.yml` and the shared evidence file (tasks.md).

## Out of scope

- Making G1, G6 or G9 blocking, and removing `todo: true` or the constitution GAP lines (after a run into `develop`
  exits 0 and the factory runner F1 has the tools).
- Acceptance tests themselves (test-designer, G4).
- The items listed in design.md §9: `--expected 83` vs 82, uv 0.8.14 vs 0.8.22, Actions pinned by tag, OpenSpec
  transitive dependencies, G6 paths without `lab/`, the weaker `bim-toolchain` job, G4 and the Playwright acceptance
  config, the empty-runner exemptions.
- Fixing the architecture debt the import-linter contracts report (first run: `Contracts: 1 kept, 2 broken`, including
  `telemetry -> main`), and raising the ESLint severity to `error` (ROADMAP M9.3, baseline about 316 warnings).
- The extraction of `bim-toolchain/` to `isa-group/bim-toolchain`.
