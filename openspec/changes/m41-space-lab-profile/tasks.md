# Tasks: m41-space-lab-profile

Each slice is ≤ 300 non-test diff lines and writes its tests first. Check commands run from the repository root; every
pytest check is one argv `["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", …]`
with paths relative to `openbinding-gateway/` (so the lab tests are `../lab/tests/…`). S1 and S2 are built; S2b, S3, S4 and S5 are not.

Order: S1+S2 in one PR (about 300 lines), then S2b, S3 and S4 in a follow-on PR after this one merges, then S5. The
owner answered `crp-openbinding-m41-space-image-and-16-1` on 24-10-2026 (option build-pinned-exception); its
implementation is the follow-on PR, so the marker `gap.invalid/space-api:1.7.1` stays in this PR and no digest is
guessed. The MANAGEMENT key placement (proposed question 3) is still open.

Tracing: `lab/` is not in the G6 OFT trace paths of `.agentic/project.yaml`, so tags in `lab/tests/` are not traced
until those paths are added.

Known deviation: `lab/tests/test_lab_pricing_profile.py` has 585 non-blank lines and 27 test functions (several parametrized; extended in round 2), over the ~300-line PR guideline. The rule
functions (one per requirement) and the controls that mutate a conforming sample live in one file so that each rule sits
next to the proof that it refuses what it must; splitting them would separate a rule from its control.

## S1. Tests first, static profile rules (ships in the S2 PR, never merged alone)
- [x] 1.1 `lab/tests/test_lab_pricing_profile.py` (new): the tests named in the delta spec's `Evidence:` lines for
  `pricing-profile-optional`, `-pinned-images`, `-memory-budget`, `-isolated`, `-secret-references`, `-start-order` and
  `-remote-sphere`, tagged `[utest->req~lab-deployment-pricing-profile-…~1]`. The expected service set in this slice is
  three (`space-mongo`, `space-redis`, `space-api`) and the expected sum 992 MiB; S4 changes both to four and 1088.
- [x] 1.2 Image rules: mongo and redis by `name:tag@sha256:<64 hex>` listed in the runbook's verified list; `space-api`
  the GAP marker (with an open GAP entry) or a verified reference; controls that the marker is refused for any other
  service and that a tag-only or unlisted-digest reference is refused for `space-api`.
- [x] 1.3 `openbinding-gateway/tests/test_no_local_space.py`: narrowed as design.md §4 says;
  `[utest->req~lab-deployment-no-local-space~2]`.
- Acceptance: the tests were written before the manifest and the runbook, in separate tasks. No red run is recorded: a
  red_before check cannot see non-acceptance files. The evidence that each rule can fail is the set of controls that
  mutate the conforming SAMPLE and expect a refusal. S1 is not integrated alone; it ships in the S2 PR.

## S2. Manifest, runbook and pointer (~150 lines + S1; same PR as S1)
- [x] 2.1 `compose.lab-pricing.json`: three services `space-mongo`, `space-redis`, `space-api` and the volumes
  `lab-pricing-mongo` and `lab-pricing-redis`; `mem_limit` 512 + 96 + 384 = 992 MiB; no published port; `space-api`
  image `gap.invalid/space-api:1.7.1`; its user, healthcheck and port are UNVERIFIED for the GAP image (design.md §2).
- [x] 2.2 `docs/qa/PRICING_PROFILE.md`: the verified list (mongo and redis, verified 2026-10-24), the GAP entry for
  `space-api`, the memory arithmetic (992 now, 1088 after S4, ceiling 1152, 9152 within 9216) and how to bring the standalone project up (proposed `lab_compose up file=compose.lab-pricing.json`; support is factory
  follow-up F1), the known advisories and the unset-variable warning.
- [x] 2.3 `docs/DEMO.md`: a pointer to the runbook, stating the profile is optional and not part of the 4032 MiB sum.
- Acceptance: S1 passes; `lab/tests` and `tests/test_container_hardening.py` still pass. Check:
  `["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests", "tests/test_no_local_space.py", "tests/test_container_hardening.py"]`.
  Measured: the registered check ran 290 tests, all passing (round 1, over all of `lab/tests`). The latest registered
  check, over `../lab/tests/test_lab_pricing_profile.py` and `tests/test_no_local_space.py`, measured 63 tests.

## S2b. Build from the pinned commit — follow-on PR
- [ ] 2b.1 `compose.lab-pricing.json`: SPACE is built from `SCORELabUS/space` pinned to the commit
  `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` of tag `v1.7.1` (never the tag; source
  `https://api.github.com/repos/SCORELabUS/space/git/refs/tags/v1.7.1`), replacing the `gap.invalid` marker; mongo and
  redis stay by digest. Needs revision ~2 of `pinned-images` (build context pinned by commit SHA) and the manifest and
  test allow-list for `build`; the runbook GAP entry closes and the user, healthcheck and port are checked against the
  build.

## S3. Tests first, bootstrap — follow-on PR
- [ ] 3.1 `lab/tests/test_space_lab_bootstrap.py`: tests for `pricing-profile-bootstrap` and
  `pricing-profile-bootstrap-boundary` (organization and key, service from the permanent link with `all_last`,
  idempotence, contracts for the synthetic users, no SPHERE key, no write to SPHERE; the key-placement test follows the
  owner's answer to question 3), plus an architecture test that forbids direct HTTP to SPACE outside `lab/tools` and
  the plans module.

## S4. Bootstrap tool and service — follow-on PR
- [ ] 4.1 `lab/tools/space_lab_bootstrap.py`, using `space-python-client` wherever it covers the operation. The 16.1
  exception applies only to this lab bootstrap tool and is recorded in a short ADR,
  `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md` (owner's answer to the CRP, 24-10-2026, option
  build-pinned-exception).
- [ ] 4.2 `compose.lab-pricing.json`: the one-shot `pricing-bootstrap` service (96 MiB); the sum becomes 1088 MiB, the
  service set four; `test_lab_pricing_profile.py`, the runbook and `docs/DEMO.md` follow.

## Follow-ups outside this change
- Factory F1/F2: `lab_compose` accepts `file=compose.lab-pricing.json`; the lab admission check and the preview planner
  count this project's memory; a preflight refuses an unset or empty `DEMO_SPACE_*` value (missing today: with an empty
  value SPACE may start with weak settings or fail to start, UNVERIFIED because the image is unresolved).
- Follow-on PR (S2b, S3, S4): build from the pinned commit, the bootstrap tests and the tool under `lab/`, and the ADR
  0022 exception, as above.
- Test control pending in the profile test file: a control that pins the `command` of the three services, `MONGO_URI` and
  the mongo and redis healthchecks by equality (the spec states it; cite its test name in the remote-sphere Evidence
  once it lands).
- M4.2/M4.5: how `SPACE_URL` reaches the gateway (fold the services into the main lab manifest, or another route with a
  recorded exception to the no-`networks` rule); a memory decision for SPACE in previews (2 x (4032 + 1088) > 9216); the
  seed guard that refuses service `openbinding` (`docs/DEMO.md`, about line 195).
- Before the archive task: add `lab/tests` to the oft-trace paths in `.agentic/project.yaml` (R2-REV-004), so the tags in
  the lab tests are traced.
- S4 takes a revision 2 of `start-order` so that the one-shot `pricing-bootstrap` has no healthcheck (lab convention
  ONE_SHOT; R2-REV-001).
- Coordinator: update ARCHITECTURE §9.4 once the MANAGEMENT key placement is decided.
- Owner: confirm the lab-only risk of redis 7.4.2 and mongo 7.0.16 (runbook, Known advisories, a non-exhaustive list);
  the follow-up bumps both to the latest 7.4.x and 7.0.x patch by verified digest, to be decided by the owner.

## S5. Live evidence (after S4)
- [ ] 5.1 `labctl`/`lab_compose` brings the profile up in the lab; SPACE shows the `openbinding` service `ready` on the
  latest public version; the lab reaches `sphere.score.us.es` over HTTPS; the memory is measured. Every `GAP` in the delta
  spec is replaced by a test path before the archive.

## A. Archive (after S5, explicit archive task)
- [ ] `["openspec", "archive", "m41-space-lab-profile", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

G1 for this change: `["openspec", "validate", "m41-space-lab-profile", "--strict"]`. It cannot run in the lab (owner
exemption); the format was checked by reading against `openspec/changes/m05-pr-previews/`.
