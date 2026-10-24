# Tasks: m41-space-bootstrap

Slices in build order; the tests of S-B are written before S-C and S-D. Check commands run from the repository root;
pytest checks are one argv `["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest",
"-q", …]` with the lab tests as `../lab/tests/…`. S-A, S-B and S-D are done; S-C is in progress.

## S-A. Spec and ADR
- [x] A.1 `openspec/changes/m41-space-bootstrap/` (proposal, design, tasks, delta spec of `lab-deployment` with five
  ADDED requirements).
- [x] A.2 `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md` (status Proposed).
- Acceptance: every requirement block under 500 characters, five blocks (registered check); ADR names `lab/tools`.
  G1 is not run (owner exemption until PR 37 merges, design.md §9).

## S-B. Tests first (done)
- [x] B.1 `lab/tests/test_space_lab_bootstrap.py`: the tests named in the Evidence lines of
  `lab-space-image-pinned-commit`, `lab-space-bootstrap-creates`, `lab-space-bootstrap-idempotent` and
  `lab-space-bootstrap-sphere-readonly`, tagged `[utest->req~…~1]`; a simulated SPACE transport and an injected sleep,
  no network.
- [x] B.2 `lab/tests/test_no_direct_space_http.py`: the five tests of `lab-space-no-direct-http`, with
  `openbinding-gateway/tools/_remote_common.py` and `openbinding-gateway/src/openbinding_gateway/sphere_client.py` as
  the only pinned deviations (design.md §6).

## S-C. Tool (in progress)
- [ ] C.1 `lab/tools/space_lab_bootstrap.py` and its requirements file (exact pins): the sequence of design.md §4,
  `space-python-client` for contracts, httpx for the rest (ADR 0022).
- Acceptance: S-B passes.

## S-D. Images and runbook (done)
- [x] D.1 `lab/space/Dockerfile` and `lab/tools/Dockerfile` (design.md §2 and §3).
- [x] D.2 `docs/qa/PRICING_PROFILE.md`: the build from the pinned commit, the three base digests as unverified until
  the lab builds them, and the bootstrap procedure.
- Acceptance: S-B passes; `lab/tests` passes as a whole.

## Follow-ups
- Coordinator: compose wiring of `pricing-bootstrap` and of the `space-api` build (design.md §7), with the revisions of
  the pricing-profile requirements and tests listed there (`build`, the fourth service, `secret-references`,
  `remote-sphere`, `start-order`, `no-local-space`).
- Coordinator, at archive of `m41-space-lab-profile`: replace the stubs `req~lab-deployment-pricing-profile-bootstrap~1`
  and `req~lab-deployment-pricing-profile-bootstrap-boundary~1` by the five requirements of this change.
- Add `lab/tests` to the oft-trace paths of `.agentic/project.yaml`, so the tags in the lab tests are traced.
- Owner question 3: where the `MANAGEMENT` key lives (inside SPACE until M4.5 is assumed; design.md §5).
- Move `SpaceRemote`/`SphereRemote` of `openbinding-gateway/tools/_remote_common.py` under `lab/tools` or retire them,
  then drop the pinned deviation; `SphereRemote` also carries `SPHERE_API_KEY` and a private upload (constitution 16.2).
- Remove `openbinding-gateway/src/openbinding_gateway/sphere_client.py` (ADR-0015 §7; it holds a SPHERE key), then drop
  its pinned deviation.
- Bump redis and mongo to the latest 7.4.x and 7.0.x patch by verified digest (runbook, Known advisories).
- Lab: build both images and verify the three base digests (design.md §2); S5 live evidence.
