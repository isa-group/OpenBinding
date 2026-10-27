# Tasks: m4-remote-space

Pytest runs from `openbinding-gateway`. In each slice the tests are written first and fail on the current tree (red
before), then the implementation makes them pass. File ownership is disjoint; `lab/tests/test_space_lab_bootstrap.py`
belongs to T3 only, so T3 removes its `lab/space` Dockerfile rules and T2 deletes `lab/space` after it.

Order: T1, then T3, then T2; T4 is independent; T5 last.

## T1. Spec (specifier)
- [x] 1.1 `openspec/changes/m4-remote-space/` (proposal, design, tasks, delta of `lab-deployment`).
- [x] 1.2 `docs/agent-work/m4-remote-space/roadmap-m4.md` (proposed ROADMAP and ADR wording, for the owner).
- Check: `openspec validate m4-remote-space --strict` (G1).

## T3. Bootstrap tool (`req~lab-space-remote-bootstrap~1`, `req~lab-space-remote-bootstrap-secrets~1`)
- [ ] 3.1 Tests: `lab/tests/test_space_lab_bootstrap.py` against the in-memory fake SPACE: configuration (`SPACE_API_KEY`
  required, https only, default `https://space.score.us.es`), service create when missing, synchronization, contracts,
  second run, aborts, no admin/organization/api-key requests, the three-item report, secrets, redirect, proxy, no SPHERE
  key. The `lab/space` Dockerfile rules go; the `lab/tools` Dockerfile rules stay, tagged
  `[utest->req~lab-deployment-remote-bootstrap-profile~1]`. `lab/tests/test_no_direct_space_http.py`: tags of the
  lab/tools scenario become `[utest->req~lab-space-remote-bootstrap-secrets~1]` beside `req~lab-space-no-direct-http~1`.
  Every tag of `lab-space-bootstrap-*` and `lab-space-image-pinned-commit` is removed.
- [ ] 3.2 Implementation: `lab/tools/space_lab_bootstrap.py` (`Config` with `api_key`, no admin user or password;
  `x-api-key` on every request; no authentication, organization or api-key step); module docstring updated.
- Check: `uv run --locked --extra test pytest ../lab/tests/test_space_lab_bootstrap.py ../lab/tests/test_no_direct_space_http.py`
  (red after 3.1, green after 3.2).

## T2. Profile (`req~lab-deployment-remote-bootstrap-profile~1`, `req~lab-deployment-no-local-space~4`)
- [ ] 2.1 Tests: `lab/tests/test_lab_pricing_profile.py` (one service, exact keys and environment, 96 MiB and the
  runbook sum, the single secret reference, https `SPACE_URL`, no SPHERE or proxy variable, `lab/space` absent, the
  runbook content, base lab 4032 MiB; controls for every scenario); `openbinding-gateway/tests/test_no_local_space.py`
  (the pricing profile is no longer exempt; `PRICING_SPACE_SERVICES`, `BUILT_SPACE_API` and the `space-api` image rule
  go; tags `[utest->req~lab-deployment-no-local-space~4]`).
- [ ] 2.2 Implementation: `compose.lab-pricing.json` reduced to `pricing-bootstrap` (design.md §2); delete
  `lab/space/Dockerfile` and `lab/space/.dockerignore`; `docs/qa/PRICING_PROFILE.md` rewritten for the remote SPACE
  (purpose, `DEMO_SPACE_MANAGEMENT_KEY` from the supervisor's secret file, `Memory sum: 96 MiB`, the tool image and its
  UNVERIFIED base digest, the bootstrap behaviour, the live checks of design.md §6; the verified mongo and redis list,
  the SPACE build, the four retired variables and the advisories of mongo, redis and node go).
- Check: `uv run --locked --extra test pytest ../lab/tests/test_lab_pricing_profile.py tests/test_no_local_space.py ../lab/tests/test_lab_compose.py`
  (red after 2.1, green after 2.2), then `uv run --locked --extra test pytest ../lab/tests`.

## T4. Production runbook (`req~lab-deployment-runbook-remote-space~1`)
- [ ] 4.1 Tests: `openbinding-gateway/tests/test_compose_production.py`: the test of the Local SPACE section is replaced
  by tests of the `## Remote SPACE` section, the absence of the old heading and anchor, `What stays blocked` without a
  SPACE item, and `SPACE_URL=https://space.score.us.es` in the `site.env` example.
- [ ] 4.2 Implementation: `docs/runbooks/production.md`: "Local SPACE (owner decision local-space)" becomes "Remote
  SPACE" (production uses `https://space.score.us.es` through `SPACE_URL` and `space_api_key`; no local SPACE); the
  "Production SPACE" item of "What stays blocked" goes; the opening paragraph and the `site.env` example follow.
- Check: `uv run --locked --extra test pytest tests/test_compose_production.py tests/test_no_local_space.py`.

## T5. Documentation (doc-steward)
- [ ] 5.1 `docs/ARCHITECTURE.md` (§9: remote SPACE in every environment, no local profile), `docs/ACCOUNTS_AND_PLANS.md`,
  `docs/DEMO.md` (the pricing profile, `DEMO_SPACE_MANAGEMENT_KEY`, no local SPACE), `openspec/project.md`,
  `.env.example` (no local SPACE variables; `SPACE_URL=https://space.score.us.es`), `docs/pricing/README.md`.
- Check: `uv run --locked --extra test pytest ../lab/tests tests/test_no_local_space.py tests/test_compose_production.py`
  and `openspec validate --all --strict`; a search of these files for `space-api`, `space-mongo`, `space-redis`,
  `DEMO_SPACE_ADMIN_PASSWORD` and `lab/space` finds only historical references.

## Not in this change
- `ROADMAP.md`, `INTENT.md`, `constitution.md`, `docs/adr/**`: owner edits from `docs/agent-work/m4-remote-space/roadmap-m4.md`.
- Archive plan of the superseded changes (design.md §7 O3); M4.5 wiring of the lab gateways; factory follow-up F1.
