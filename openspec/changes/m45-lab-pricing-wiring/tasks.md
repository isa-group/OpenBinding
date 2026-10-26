# Tasks: m45-lab-pricing-wiring

Slices in order; T2 is written before T3 and fails on the current manifest. Pytest runs from `openbinding-gateway`
(`uv run --locked --extra test pytest ../lab/tests/test_lab_pricing_profile.py tests/test_no_local_space.py`).

## T1. Spec (specifier)
- [x] 1.1 `openspec/changes/m45-lab-pricing-wiring/` (proposal, design, tasks, delta of `lab-deployment`).
- Check: `openspec validate m45-lab-pricing-wiring --strict` (G1).

## T2. Tests first (test-designer)
- [ ] 2.1 `lab/tests/test_lab_pricing_profile.py`: four services; `LIMITS` gains `pricing-bootstrap: 96`, sum 1088,
  `MAX_MIB` stays 1152; `rule_isolated` allows `build` (exactly `context`, `dockerfile`) and `restart` (`"no"`,
  `pricing-bootstrap` only); `rule_images` drops the GAP marker and checks the two build pairs; the admin-password
  reference counts two; start order exempts the one-shot and pins its `depends_on`; `SAMPLE` mirrors the new manifest.
  Tests: `test_optional_profile_file`, `test_compose_lab_keeps_no_space_service`, `test_pinned_images_match_the_runbook`,
  `test_built_images_follow_the_allow_list` (new), `test_runbook_has_no_gap_and_documents_the_wiring` (replaces
  `test_runbook_documents_the_gap_and_the_bring_up`), `test_isolated_services`, `test_memory_budget_matches_the_runbook`,
  `test_secret_references_are_bare_and_documented`, `test_start_order_waits_for_healthy_databases`,
  `test_bootstrap_surface_is_pinned` (new), and controls for every scenario of the delta; tags `[utest->req~…~2]`
  (`~1` for `bootstrap-environment`; the `remote-sphere` tags stay `~1`).
- [ ] 2.2 `openbinding-gateway/tests/test_no_local_space.py`: `_space_api_image_problems` accepts
  `openbinding-lab/space-api:1.7.1` and the `1.7.1` digest, refuses the marker;
  `test_pricing_profile_defines_exactly_the_space_services` with `pricing-bootstrap` present;
  `test_negative_control_space_api_image_accepts_built_image_and_digest` replaces `..._accepts_marker_and_digest`;
  every `no-local-space` tag becomes `[utest->req~lab-deployment-no-local-space~3]`.
- Check: the pytest command above fails on the current manifest and runbook (red before T3).

## T3. Compose and runbook (implementer)
- [ ] 3.1 `compose.lab-pricing.json`: `space-api` image and build; the `pricing-bootstrap` service (design.md §2).
- [ ] 3.2 `docs/qa/PRICING_PROFILE.md`: remove `## GAP` and "Compose wiring still needed"; `Memory sum: 1088 MiB`;
  name both built images with their contexts; keep the three base digests UNVERIFIED and outside the verified list;
  `DEMO_SPACE_ADMIN_PASSWORD` used by both services.
- Check: the pytest command above passes; `lab/tests` passes as a whole.

## Follow-ups (not in this change)
- Open points D1–D4, `:?required` and preflight, S4, `docs/DEMO.md`, F1, F2, R1, R6 (design.md §3).
