# Tasks: m41-space-lab-profile

Each slice is ≤ 300 non-test diff lines and writes its tests first. Check commands run from the repository root; every
pytest check is one argv `["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", …]`
with paths relative to `openbinding-gateway/` (so the lab tests are `../lab/tests/…`). S1 and S2 are built; S3 to S5 are not.

Order: S1+S2 in one PR (about 300 lines), then S3 and S4 (both BLOCKED on the owner request
`crp-openbinding-m41-space-image-and-16-1`: question 2 about constitution 16.1 and ADR-0015 §2, whose answer is
recorded as an ADR amendment before S4, and question 3, to be added by the coordinator, about where the MANAGEMENT key
lives), then S5. The `space-api` image is also open (question 1, which includes the unverified candidate
`ghcr.io/scorelabus/space-api:1.7.1`): until answered, the marker `gap.invalid/space-api:1.7.1` stands and no digest is
guessed.

Tracing: `lab/` is not in the G6 OFT trace paths of `.agentic/project.yaml`, so tags in `lab/tests/` are not traced
until those paths are added.

Known deviation: `lab/tests/test_lab_pricing_profile.py` has 581 lines and 23 test functions (several parametrized), over the ~300-line PR guideline. The rule
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
  Measured: the registered check ran 290 tests, all passing.

## S3. Tests first, bootstrap — BLOCKED on the CRP (questions 2 and 3)
- [ ] 3.1 `openbinding-gateway/tests/test_space_lab_bootstrap.py`: tests for `pricing-profile-bootstrap` and
  `pricing-profile-bootstrap-boundary` (organization and key, service from the permanent link with `all_last`,
  idempotence, contracts for the synthetic users, no SPHERE key, no write to SPHERE; the key-placement test follows the
  owner's answer to question 3). Not started until the owner says whether 16.1 and ADR-0015 §2 admit the exception.

## S4. Bootstrap tool and service — BLOCKED on the CRP (questions 2 and 3)
- [ ] 4.1 `tools/space_lab_bootstrap.py` and its use of the official client where it covers the operation.
- [ ] 4.2 `compose.lab-pricing.json`: the one-shot `pricing-bootstrap` service (96 MiB); the sum becomes 1088 MiB, the
  service set four; `test_lab_pricing_profile.py`, the runbook and `docs/DEMO.md` follow.
- [ ] 4.3 The real `space-api` reference replaces the marker once question 1 is answered, listed as verified in the
  runbook with its source and date; the `space-api` user, healthcheck and port are checked against it. A build option
  needs a revision 2 of `pinned-images` first; a digest needs none.

## Follow-ups outside this change
- Factory F1/F2: `lab_compose` accepts `file=compose.lab-pricing.json`; the lab admission check and the preview planner
  count this project's memory; a preflight refuses an unset or empty `DEMO_SPACE_*` value.
- M4.2/M4.5: how `SPACE_URL` reaches the gateway (fold the services into the main lab manifest, or another route with a
  recorded exception to the no-`networks` rule); a memory decision for SPACE in previews (2 x (4032 + 1088) > 9216); the
  seed guard that refuses service `openbinding` (`docs/DEMO.md`, about line 195).
- Before the archive task: add `lab/tests` to the oft-trace paths in `.agentic/project.yaml` (R2-REV-004), so the tags in
  the lab tests are traced.
- S4 takes a revision 2 of `start-order` so that the one-shot `pricing-bootstrap` has no healthcheck (lab convention
  ONE_SHOT; R2-REV-001).
- Coordinator: update ARCHITECTURE §9.4 once the MANAGEMENT key placement is decided.
- Owner: confirm the lab-only risk of redis 7.4.2 and mongo 7.0.16 (runbook, Known advisories); bump to current patch
  releases by verified digest.

## S5. Live evidence (after S4)
- [ ] 5.1 `labctl`/`lab_compose` brings the profile up in the lab; SPACE shows the `openbinding` service `ready` on the
  latest public version; the lab reaches `sphere.score.us.es` over HTTPS; the memory is measured. Every `GAP` in the delta
  spec is replaced by a test path before the archive.

## A. Archive (after S5, explicit archive task)
- [ ] `["openspec", "archive", "m41-space-lab-profile", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

G1 for this change: `["openspec", "validate", "m41-space-lab-profile", "--strict"]`. It cannot run in the lab (owner
exemption); the format was checked by reading against `openspec/changes/m05-pr-previews/`.
