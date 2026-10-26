# Design: ci-speed

## Context

`.github/workflows/ci.yml` runs nine jobs in parallel with no `needs` on every pull request, push to `develop` and
manual dispatch (`ci.yml:3-8`). Only push runs cancel each other (`ci.yml:10-13`). `engines`, `test` and `frontend`
have no `timeout-minutes`. The workflow may use only five actions (`req~gate-tooling-pinned-steps~1`). Lab tests pin
the workflow shape (`lab/tests/test_ci_triggers.py`, `lab/tests/test_ci_gate_tooling.py`,
`openbinding-gateway/tests/test_ci_starts_a_job_consumer.py`), so each workflow slice changes them in the same PR.
Details with file:line: `docs/agent-work/ci-speed/intake.md` sections 1 and 2.

## Decisions

### D1 Change detection is a repository script in a `changes` job (CRP-2a)
`tools/ci_changes.py --base <sha> --head <sha> --event <name>` diffs `pull_request.base.sha`..`HEAD` on a full
checkout (`fetch-depth: 0`), prints `area=true|false` and appends the lines to `$GITHUB_OUTPUT`. Heavy jobs carry
`if: needs.changes.outputs.<area> == 'true'`. A job skipped by `if` reports Success to branch protection, so no
check is left Pending (lookup L2 of the intake).

Fail-safe rules: on `push` and `workflow_dispatch` every area is `true`, so `develop` and the nightly keep full
coverage; a changed path in no known area, a change to `.github/workflows/ci.yml` or `tools/ci_*.py`, a failing git
command or a diff that lists no path (base equals head) sets every area `true`. The intake proposed that a git error fails the job; the owner's S0 brief chose all
areas `true` instead, which keeps coverage and still lets `ci-required` judge the result.

Starting areas (S2 proves them with tests over intake section 1.3):
- `e2e`: `frontend/**` except `frontend/src/content/changelog.generated.json` (every PR changes it,
  `CONTRIBUTING.md:36-38`) and `frontend/**/*.md`.
- `bim`: `bim-toolchain/**`, `examples/**`, `schemas/**`, `datasets/**`, `experimentation/**`, engine fixtures under
  `engines/**`, `tools/*bim*`, `openbinding-gateway/pyproject.toml`, `openbinding-gateway/uv.lock`,
  `openbinding-gateway/tests/golden/**` (the bim-core tests read `golden/bim_baseline`).
- `engines`: `engines/**`, `schemas/bim/**`, `tools/check_bim_guard.py` (the guard itself runs in `bim-corpus`, which
  is always on because it scans the whole repository; its path in this list is harmless).
- `gateway`: everything except `docs/agent-work/**`, `openspec/**`, root `*.md` that no test reads,
  `acceptance/ui/**`, `frontend/e2e/**`. The gateway tests read `frontend/`, `docs/`, `.github/`, compose files,
  `tools/`, `space/`, `experimentation/`, `pricings/`, `examples/`, `schemas/` and `bim-toolchain/`, so this area can
  only be false for docs-only or spec-only pull requests.
- Always on (each step under 1.5 min): `bim-corpus`, `lab`, `openspec`, `trace`, `frontend`.

### D2 One aggregate required check (CRP-1a)
`ci-required` needs every other job, runs with `if: always()` and passes `NEEDS: ${{ toJSON(needs) }}` to
`tools/ci_required.py`. With `if: always()` the job must fail explicitly on `failure` and `cancelled` (lookup L2).
It also fails when `changes` did not succeed, when a job gated by an area is `skipped` although its area output was
not exactly `false`, and when a job that no area gates (always-on or unknown) is `skipped` at all. The job-to-area
map of `tools/ci_required.py` is tested against the `if:` expressions of `ci.yml`. Matrix
and renamed jobs then never change the set of required checks. The owner sets branch protection to `ci-required`
only.

### D3 Sharding
- Playwright mocked project: job `frontend-e2e`, matrix `shard: [1, 2, 3]`, `fail-fast: false`,
  `--shard=i/3`. With `fullyParallel: true` Playwright splits per test (lookup L3). The UI acceptance runner stays
  the last step of `frontend` (`req~gate-tooling-ui-runner~1`).
- Gateway unit tests (CRP-5a): job `gateway-unit`, matrix `shard: [1, 2]`, run natively with
  `uv sync --locked --project openbinding-gateway --extra test`, file lists from `tools/ci_shard.py` (`test_*.py` and
  `*_test.py`, pytest's default patterns), balanced greedily by file size in bytes; `--weights` accepts a JSON file of
  measured durations when one exists and lists every file (S1 was dropped, so none is committed). A test proves the two lists partition the
  collected files. `test` keeps "Build and start
  services", ICSOC, OpenAPI snapshot and integration, which need the containers. No dependency or lockfile change.
- bim-toolchain (CRP-8a): matrix over `bim-core`, `bim-service`, `bim-client`; the two `--deselect` options stay on
  `bim-service`; the goldens (`req~gate-tooling-bim-toolchain-goldens~1`) run in exactly one package job. The job id
  stays `bim-toolchain`, so the goldens requirement keeps its text.

### D4 Concurrency (CRP-3a)
`group: ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.ref || github.event.pull_request.number || github.run_id }}`,
`cancel-in-progress: ${{ github.event_name != 'workflow_dispatch' }}`. Pull request runs share a group per pull
request and the newest wins; push runs keep their group per ref; manual runs keep a group per run id and are never
cancelled. The requirement keeps its heading so that the MODIFIED delta matches the living spec; its text and
revision change.

### D5 Timeouts
`changes` 5, `engines` 30, `test` 45, `frontend` 45; existing values (`bim-corpus` 45, `bim-toolchain` 45, `lab` 30,
`openspec` 10, `trace` 10) stay; the new jobs (`ci-required`, `frontend-e2e`, `gateway-unit`) get a value of at most
45 chosen by their slice from the S1 baseline.

### D6 Drafts (CRP-9a)
No workflow change: the factory pushes a draft only once the lab gate is green. The `pull_request` block stays exactly
`{branches: [main, develop]}`.

## Ruled out

| Option | Reason |
|---|---|
| `on.pull_request.paths` / `paths-ignore` filters | A workflow skipped by `paths` leaves required checks Pending and blocks the merge (lookup L2). |
| Third-party actions (`dorny/paths-filter`, `actions/cache`, `docker/*`, `pnpm/action-setup`) | Refused by `req~gate-tooling-pinned-steps~1` and `lab/tests/test_ci_gate_tooling.py:40-46,245-248`; each adds supply-chain risk (R10). |
| Self-hosted runners | The repository is public; GitHub-hosted standard runners (4 vCPU / 16 GB) are free and unlimited for public repositories (lookup L1). |
| Playwright browser cache | The Playwright docs advise against caching browsers; the OS dependencies cannot be cached anyway (lookup L3). |
| Docker layer cache, `type=gha` (CRP-7a) | Needs the runtime token exposed by a new third-party action such as `crazy-max/ghaction-github-runtime` (lookup L4); Compose `type=gha` is not documented. It would save about 2.2 min only. |
| pytest-xdist first (CRP-5b) | Needs a `pyproject.toml`/`uv.lock` change; locking needs PyPI, listed under `forbidden_remote_calls` (`.agentic/project.yaml:176`); the bim-service B8 tests measure timing. |

## Risks

- An area rule too narrow skips a needed job on a pull request. Mitigation: fail-safe rules, full runs on every push
  to `develop` and nightly, a test that every `REPO_ROOT / "<dir>"` read by `openbinding-gateway/tests` lies in the
  `gateway` area.
- Sharding drops tests. Mitigation: partition requirements and checks (S4, S5a).
- More jobs raise runner-minutes when every area is touched (estimate ≈ 58 against 52); skipping and cancelling
  superseded runs lower the total per merged PR (intake section 5).
- Every workflow slice needs a token with Workflows write (CRP-4).

## Migration

S3 adds `changes`, `ci-required` and the timeouts first; the owner then switches branch protection to `ci-required`
(CRP-1a). Later slices may rename or split jobs without touching branch protection.

## Open questions

None for this spec; CRP-4 (token) and CRP-6 (factory defaults) gate later slices, not the requirements.
