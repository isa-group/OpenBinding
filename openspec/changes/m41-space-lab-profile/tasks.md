# Tasks: m41-space-lab-profile

Each slice is ≤ 300 non-test diff lines and writes its tests first. Check commands run from `openbinding-gateway/`;
every pytest check is one argv `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", …]`. Nothing is built yet.

Order: S1+S2 in one PR (about 300 lines), then S3 and S4 (both BLOCKED on the owner request
`crp-openbinding-m41-space-image-and-16-1`, question 2 about constitution 16.1), then S5. The `space-api` image is also
open (question 1): until answered, the marker `gap.invalid/space-api:1.7.1` stands and no digest is guessed.

Tracing: `lab/` is not in the G6 OFT trace paths of `.agentic/project.yaml`, so tags in `lab/tests/` are not traced
until those paths are added.

## S1. Tests first, static profile rules (ships in the S2 PR, never merged alone)
- [ ] 1.1 `lab/tests/test_lab_pricing_profile.py` (new): the tests named in the delta spec's `Evidence:` lines for
  `pricing-profile-optional-file`, `-pinned-images`, `-memory-budget`, `-internal-only` and `-secrets-and-privileges`,
  tagged `[utest->req~lab-deployment-pricing-profile-…~1]`. The expected service set in this slice is three
  (`space-mongo`, `space-redis`, `space-api`) and the expected sum 992 MiB; S4 changes both to four and 1088.
- [ ] 1.2 Image rules: mongo and redis by `name:tag@sha256:<64 hex>` listed in the runbook's verified list; `space-api`
  the GAP marker or a verified reference; a scenario that the marker is refused for any other service and that a
  tag-only or unlisted-digest reference is refused for `space-api`.
- [ ] 1.3 `openbinding-gateway/tests/test_no_local_space.py`: narrowed as design.md §4 says;
  `[utest->req~lab-deployment-no-local-space~2]`.
- Acceptance: red on the base (G3) by assertion: the file `compose.lab-pricing.json` does not exist. Check (red_before):
  `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_lab_pricing_profile.py", "tests/test_no_local_space.py"]`.

## S2. Manifest, runbook and pointer (~150 lines + S1; same PR as S1)
- [ ] 2.1 `compose.lab-pricing.json`: three services `space-mongo`, `space-redis`, `space-api` and two `space-*` volumes;
  `mem_limit` 512 + 96 + 384 = 992 MiB; no published port; `space-api` image `gap.invalid/space-api:1.7.1`.
- [ ] 2.2 `docs/qa/PRICING_PROFILE.md`: the verified list (mongo and redis, verified 2026-10-24), the GAP entry for
  `space-api`, the memory arithmetic (992 now, 1088 after S4, ceiling 1152, 9152 within 9216) and how to run the overlay.
- [ ] 2.3 `docs/DEMO.md`: a pointer to the runbook, stating the profile is optional and not part of the 4032 MiB sum.
- Acceptance: S1 passes; `lab/tests` and `tests/test_container_hardening.py` still pass. Checks:
  `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests", "tests/test_no_local_space.py", "tests/test_container_hardening.py"]`.

## S3. Tests first, bootstrap — BLOCKED on the CRP (question 2)
- [ ] 3.1 `lab/tests/test_space_lab_bootstrap.py`: tests for `pricing-profile-bootstrap` and
  `pricing-profile-bootstrap-boundary` (organization and key, service from the permanent link with `all_last`,
  idempotence, contracts for the synthetic users, no SPHERE key, no write to SPHERE). Not started until the owner says
  whether 16.1 admits the exception.

## S4. Bootstrap tool and service — BLOCKED on the CRP (question 2)
- [ ] 4.1 `tools/space_lab_bootstrap.py` and its use of the official client where it covers the operation.
- [ ] 4.2 `compose.lab-pricing.json`: the one-shot `pricing-bootstrap` service (96 MiB); the sum becomes 1088 MiB, the
  service set four; `test_lab_pricing_profile.py`, the runbook and `docs/DEMO.md` follow.
- [ ] 4.3 The real `space-api` reference replaces the marker once question 1 is answered, listed as verified in the
  runbook with its source and date.

## S5. Live evidence (after S4)
- [ ] 5.1 `labctl`/`lab_compose` brings the profile up in the lab; SPACE shows the `openbinding` service `ready` on the
  latest public version; the lab reaches `sphere.score.us.es` over HTTPS; the memory is measured. Every `GAP` in the delta
  spec is replaced by a test path before the archive.

## A. Archive (after S5, explicit archive task)
- [ ] `["openspec", "archive", "m41-space-lab-profile", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

G1 for this change: `["openspec", "validate", "m41-space-lab-profile", "--strict"]`.
