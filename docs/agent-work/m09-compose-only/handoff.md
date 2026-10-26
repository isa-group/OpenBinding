# Handoff: m09-compose-only
- Status: waiting-review (intake written; CRP-1 to CRP-4 to raise) · Updated: 2026-10-26
- Branch / head: task/148c311616ef4980 / base 99697d7e · PR: none

## Goal
ROADMAP M0.9 (`ROADMAP.md:45`, ADR-0021): no Kubernetes left; a `deploy/compose/production` definition with
digest-pinned images, secret files, health checks, backups and limits, plus a runbook; `docker compose config` in CI
for development, lab and production.

## State (with evidence)
- Intake written: `docs/agent-work/m09-compose-only/intake.md` (facts F1-F22, the §4 interface contract, slices
  S0-S5, checks, gates, CRPs).
- Already done before this change: `deploy/kubernetes/` is gone (glob `deploy/**` empty). CI has no Kubernetes step
  (`.github/workflows/ci.yml`; its only Compose check is at :301-302). The changelog titles point to PR #27
  (`frontend/src/content/changelog.generated.json:30,34`); git history was not read.
- Leftovers:
  - `.agentic/project.yaml:82` (gate `kustomize`, fails on the missing path; R11);
  - `openspec/specs/lab-deployment/spec.md:10-11,111-121,134` (R11);
  - `AGENTS.md:36`;
  - `docs/adr/0021-docker-compose-only.md:54` (R11).
- Gaps found:
  - production is built and never pinned, with no restart, limits or logging (`docker-compose.yml:36-551`);
  - secrets are environment values with a default DB password (`docker-compose.yml:13,50-51`);
  - the gateway has no file-secret support (`core/settings.py:122-134`);
  - migrations run inside the gateway entrypoint (`docker-entrypoint.sh:12-15`), and workers bypass it
    (`docker-compose.yml:224`);
  - no image-publishing workflow exists.
- No code, spec or check was written or run.

## Decisions
- D1: six slices: S0 spec, S1 leftovers and guard test, S2 entrypoint, S3 production files and test, S4 runbook,
  S5 CI job. Reason: disjoint owned files, each ≤ ~300 diff lines; S0-S3 run in parallel.
- D2: secrets as files through `<NAME>_FILE` in `openbinding-gateway/docker-entrypoint.sh`, not in `Settings`.
  Reason: `src/**` belongs to other leads, and workers can opt into the entrypoint. The defaults keep today's
  behaviour.
- D3: a one-shot `migrate` service (`OPENBINDING_MIGRATE=only`); gateway and workers use `skip`. Reason: ADR-0021:34.
- D4: no feature flag. Reason: nothing deploys the production file without the owner's order, and the entrypoint
  changes are opt-in.
- D5: images of this repository use `gap.invalid/…@sha256:0…` markers in `images.env` until CRP-4. Reason: no
  registry or publish workflow exists, and digests must never be guessed (the pattern of `test_no_local_space.py:19-21`).
- D6: the risk levels follow the globs: S2, S3 and S5 are high (R10 or secret handling), S0 and S1 low, S4 high by
  glob but documentation only.

## Ruled out
- Pydantic `secrets_dir` in `core/settings.py`: outside the scope (`src/**` reserved). Possible later.
- Running the production file in the lab: the lab validator forbids `secrets`, `deploy` and `extends`
  (`lab/tests/test_lab_compose.py:28-32`).
- Moving `compose.lab*.json` into `deploy/compose/`: that is M9.4 (`ROADMAP.md:187`).

## Open questions and risks
- CRP-1 (owner): SPACE in production. INTENT:180 says none; ARCHITECTURE:494 says local until M4.6. Recommended:
  remote only.
- CRP-2 (owner): what "overlay" means. Recommended: a standalone `compose.yaml`, like the lab files.
- CRP-3 (owner): R11 edits (`project.yaml:81-82`, ADR-0021:54, the spec archive) and **a token with Workflows: write
  for S5**.
- CRP-4 (owner): the image registry and a tag-triggered publish workflow (`packages: write`, Workflows: write).
- Q1 (coordinator): grant `openspec/changes/m09-compose-only/**` despite the `openspec/**` reservation. Q2:
  `README.md` and `AGENTS.md` ownership. Q3 (owner): host size, Compose version, backup target, TLS.
- Risk: an entrypoint regression breaks every gateway start (lab and QACOBench too). Mitigation: unchanged `auto`
  default, subprocess tests with a fake `alembic`, a lab smoke after merge.
- Risk: Compose features (`--profile "*"`, repeated `--env-file`) have unconfirmed versions (F22). Mitigation: the
  check runs locally first, and the fallbacks are written in the intake.

## Next three steps
1. Coordinator: raise CRP-1 to CRP-4 from intake §7, answer Q1-Q2, and register the proposed checks of intake §5.
2. Start S0 (specifier), S1, S2 and S3 (implementers) in parallel with the owned files and checks of intake §5.
   S2 and S3 follow the §4 contract.
3. After S3 merges: finish S4 on that base. After the CRP-3 token exists: S5, then the owner applies the
   `project.yaml` edits.

## Evidence
- Tasks: this intake (planner; no checks registered or run) · Heads: 99697d7e · CI: none run for this intake.
- Lookups (medium confidence): compose-go `loader/validate.go` (no stat of secret files);
  docs.docker.com/compose/how-tos/profiles (`--profile "*"`); docker/compose v2.24.4 (`!reset`); docker/compose
  PR #10284 (repeated `--env-file`).
