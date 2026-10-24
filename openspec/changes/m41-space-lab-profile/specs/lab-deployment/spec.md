## MODIFIED Requirements

### Requirement: No local SPACE
THE deployment files SHALL define SPACE services only in the optional `compose.lab-pricing.json`, which SHALL define exactly `space-mongo`, `space-redis` and `space-api` (plus `pricing-bootstrap` once the bootstrap exists); no manifest SHALL define a SPHERE service, and every other manifest, including `docker-compose.yml`, the other lab profiles, `compose.pgtest.json` and `deploy/**`, SHALL contain no SPACE service, network, volume or destructive key; SPACE and SPHERE SHALL otherwise be reached only as remote services configured by environment.

`req~lab-deployment-no-local-space~2`

Evidence: `openbinding-gateway/tests/test_no_local_space.py::test_other_manifests_have_no_local_space`; `openbinding-gateway/tests/test_no_local_space.py::test_no_manifest_defines_sphere`; `openbinding-gateway/tests/test_no_local_space.py::test_pricing_profile_defines_exactly_the_space_services`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_local_space_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_extra_space_service_breaks_the_exact_set`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_destructive_key_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_sphere_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_space_api_image_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_space_api_image_accepts_marker_and_digest`; `openbinding-gateway/tests/test_no_local_space.py::test_no_space_services_or_profile`

In `compose.lab-pricing.json` the `space-api` image SHALL be the marker `gap.invalid/space-api:1.7.1` or `<repo>:1.7.1@sha256:<64 hex>`, and its volumes SHALL be named `lab-pricing-*`.

#### Scenario: Adding a SPACE container
- **GIVEN** a change that adds a `space` service to `docker-compose.yml`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: SPACE outside the pricing profile
- **GIVEN** a change that adds a `space-api` service, a `space` network, a `space-*` volume or the destructive key to `compose.lab.json`, `compose.pgtest.json` or a file under `deploy/`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: Unlisted service in the pricing profile
- **GIVEN** `compose.lab-pricing.json` plus a `space-web` service
- **WHEN** the unit suite runs
- **THEN** it fails, because the SPACE services are no longer exactly the permitted set

#### Scenario: A SPHERE service
- **GIVEN** a service named or imaged `sphere` in any manifest, the pricing profile included
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: Image of space-api
- **GIVEN** the `space-api` image is the GAP marker or `<repo>:1.7.1@sha256:<64 hex>`
- **WHEN** the unit suite runs
- **THEN** the image rule passes
- **AND** it fails for a tag-only reference, another version or a short digest

## ADDED Requirements

### Requirement: Optional pricing profile in its own file
THE lab SHALL define the SPACE `pricing` profile only in `compose.lab-pricing.json`, named `openbinding-lab-pricing`, separate from `compose.lab.json` and its derived profiles, which SHALL stay free of SPACE services; the file SHALL declare no `profiles` key and exactly the services `space-mongo`, `space-redis` and `space-api` (plus the one-shot `pricing-bootstrap` once slice S4 exists).

`req~lab-deployment-pricing-profile-optional~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_optional_profile_file`; `lab/tests/test_lab_pricing_profile.py::test_compose_lab_keeps_no_space_service`; `lab/tests/test_lab_pricing_profile.py::test_control_sample_conforms`; `lab/tests/test_lab_compose.py::test_no_space_services`

The four services are the final state (slice S4). Slice S2 delivers the first three; the rule expects the three-service set until S4 adds `pricing-bootstrap`.

#### Scenario: Base lab unchanged
- **GIVEN** `compose.lab.json` and `compose.lab-pricing.json`
- **WHEN** the static checks run
- **THEN** `compose.lab.json` has no SPACE service and its memory sum is still the expected 4032 MiB

#### Scenario: Profile services
- **GIVEN** `compose.lab-pricing.json`
- **WHEN** its service names are read
- **THEN** they are `space-mongo`, `space-redis` and `space-api` (three until S4 adds `pricing-bootstrap`)

#### Scenario: A service started only on demand
- **GIVEN** a copy of the manifest with a `profiles` key, another project name or an extra service
- **WHEN** the optional-file rule is applied
- **THEN** it fails

### Requirement: Pinned images of the pricing profile
THE services of the pricing profile SHALL use images pinned by digest and listed as verified, with their date, in `docs/qa/PRICING_PROFILE.md`: `space-mongo` and `space-redis` by the `mongo:7.0.16` and `redis:7.4.2` digests of that list, and `space-api` either by the explicit marker `gap.invalid/space-api:1.7.1` while its image is unresolved and the runbook has an open GAP entry naming it, or by a `<repo>:1.7.1@sha256:<64 hex>` reference listed as verified; IF a reference is tag-only, a digest is not in the list, or the marker is used by another service or without the GAP entry, THEN the static check SHALL fail.

`req~lab-deployment-pricing-profile-pinned-images~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_pinned_images_match_the_runbook`; `lab/tests/test_lab_pricing_profile.py::test_runbook_documents_the_gap_and_the_bring_up`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_unpinned_images`

Verified on 2026-10-24 against Docker Hub: `mongo:7.0.16` `sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `redis:7.4.2` `sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`. No digest is guessed for `space-api`; its image is an open owner request.

#### Scenario: Mongo and redis by digest
- **GIVEN** `compose.lab-pricing.json` and the verified list of the runbook
- **WHEN** the static checks run
- **THEN** `space-mongo` is `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `space-redis` is `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`
- **AND** both digests are in the runbook's verified list

#### Scenario: GAP marker accepted only for space-api
- **GIVEN** `space-api` with the image `gap.invalid/space-api:1.7.1`, and the same marker on another service in a copy of the manifest
- **WHEN** the image rule is applied to each
- **THEN** it passes for `space-api` while the runbook GAP entry is open and fails for the other service

#### Scenario: Marker without a GAP entry
- **GIVEN** `space-api` with the marker and a runbook without a GAP entry naming `space-api`
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Tag-only or unlisted reference for space-api
- **GIVEN** `space-api` with a tag-only image such as `example.invalid/space-api:1.7.1`, and again with `@sha256:` followed by a digest absent from the runbook's verified list
- **WHEN** the image rule is applied
- **THEN** it fails for both

#### Scenario: Verified space-api reference
- **GIVEN** the owner has supplied the `space-api` image or build and the runbook lists its digest as verified
- **WHEN** `space-api` carries that reference
- **THEN** the image rule passes and the GAP marker is no longer accepted

### Requirement: Memory budget of the pricing profile
THE pricing profile SHALL set a whole-unit `mem_limit` on every service, keep their sum equal to the sum documented in the runbook and within the profile ceiling of 1152 MiB, and keep the MongoDB cache, the Redis `maxmemory` and the Node heap each below the limit of its container, so that the develop lab, one PR preview and the profile stay within the 9216 MiB lab cap.

`req~lab-deployment-pricing-profile-memory-budget~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_memory_budget_matches_the_runbook`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_mongo_limit_over_budget`

The final sum is 1088 MiB: 512 (`space-mongo`) + 96 (`space-redis`) + 384 (`space-api`) + 96 (`pricing-bootstrap`). The S2 manifest has three services and a sum of 992 MiB; slice S4 adds the bootstrap and the 96 MiB. The ceiling stays 1152 MiB.

#### Scenario: Budget arithmetic
- **GIVEN** the memory limits of the profile and the 4032 MiB of one lab stack
- **WHEN** the static checks sum them
- **THEN** the profile sum is 992 MiB (1088 MiB after S4), at most 1152 MiB
- **AND** 4032 + 4032 + 1088 is at most 9216 MiB

#### Scenario: A service without a limit
- **GIVEN** a profile service whose `mem_limit` is removed
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: A limit over budget
- **GIVEN** `space-mongo` with `mem_limit` `640m`, or a runbook sum that differs from the manifest sum
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Pricing profile isolated from the host
THE pricing profile SHALL publish no host port and expose none, use no `networks` or `network_mode` key (the project default network applies), mount no socket or host path (only its two named volumes `lab-pricing-mongo` and `lab-pricing-redis`, declared with labels only), set no privilege or destructive key, and run every service as a numeric non-root user.

`req~lab-deployment-pricing-profile-isolated~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_isolated_services`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_non_isolated_or_non_optional_profile`

#### Scenario: A published port added
- **GIVEN** `compose.lab-pricing.json` plus a published port for `space-api`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Bind mount, root user or privilege
- **GIVEN** a profile service with a bind mount, user `0:0` or `privileged: true`
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Secret references of the pricing profile
THE pricing profile SHALL reference its secrets only as the four bare variables `${DEMO_SPACE_JWT_SECRET}`, `${DEMO_SPACE_JWT_SALT}`, `${DEMO_SPACE_ADMIN_PASSWORD}` and `${DEMO_SPACE_MONGO_PASSWORD}`, without defaults, never as literals or as passwords embedded in a URI, and the runbook SHALL document each of the four.

`req~lab-deployment-pricing-profile-secret-references~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_secret_references_are_bare_and_documented`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_defaulted_or_literal_secrets`

#### Scenario: Literal or defaulted secret
- **GIVEN** a profile service environment with a literal `ADMIN_PASSWORD`, or `JWT_SECRET` set to `${DEMO_SPACE_JWT_SECRET:-dev}`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Password in a URI or wrong reference
- **GIVEN** a `MONGO_URI` with a literal password, or `JWT_SECRET` set to another variable
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Undocumented variable
- **GIVEN** a runbook that does not name one of the four variables
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Start order of the pricing profile
THE pricing profile SHALL give every service a healthcheck, and `space-api` SHALL depend on `space-mongo` and `space-redis` with the condition `service_healthy` only.

`req~lab-deployment-pricing-profile-start-order~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_start_order_waits_for_healthy_databases`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_started_only_dependency`

#### Scenario: Started-only dependency
- **GIVEN** `space-api` depending on `space-mongo` with the condition `service_started`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Service without healthcheck
- **GIVEN** a profile service with no healthcheck test
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Remote SPHERE only
THE `space-api` service of the pricing profile SHALL be configured with `SPHERE_SYNC_ENABLED=true`, `SPHERE_PUBLIC_URL=https://sphere.score.us.es`, `SPHERE_API_URL=https://sphere.score.us.es/api/v1` and `SPHERE_ALLOW_LOCAL_HTTP=false`, and the manifest SHALL contain no other external HTTP address than `sphere.score.us.es`.

`req~lab-deployment-pricing-profile-remote-sphere~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_remote_sphere_is_the_only_sphere`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_local_sphere`; live: GAP `lab/tests/test_lab_pricing_profile_live.py::test_the_lab_reaches_sphere_over_https`

#### Scenario: SPHERE address
- **GIVEN** `space-api` configured with the four SPHERE variables above
- **WHEN** the static checks read its environment
- **THEN** they pass and no other external URL is configured

#### Scenario: A local SPHERE
- **GIVEN** `SPHERE_API_URL=http://sphere:8080/api/v1` or a webhook URL on another host
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Bootstrap of the SPACE service from the SPHERE link
WHEN the pricing profile starts, THE `pricing-bootstrap` one-shot SHALL create the SPACE organization and a MANAGEMENT key, create the `openbinding` service from the SPHERE permanent link `https://sphere.score.us.es/p/6ab0a323697330667ccce891` with `source: sphere` and `policy: all_last`, run a first synchronization, create contracts for the synthetic users of the seed, and be safe to re-run; the tool SHALL read SPACE's own key store, not a lab secret store, and the MANAGEMENT key SHALL stay inside SPACE until M4.5 delivers it.

`req~lab-deployment-pricing-profile-bootstrap~1`

Evidence: GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_it_creates_organization_key_service_and_contracts`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_service_comes_from_the_sphere_link_with_all_last`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_a_second_run_changes_nothing`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_tool_reads_the_space_key_store`; live (S5): GAP `lab/tests/test_lab_pricing_profile_live.py::test_space_shows_the_openbinding_service_ready_on_the_latest_version`

This requirement is the final state. Its tests (slice S3) and the tool (slice S4) are blocked on the owner request `crp-openbinding-m41-space-image-and-16-1`; live evidence is slice S5.

#### Scenario: First run
- **GIVEN** a started profile with an empty SPACE
- **WHEN** the bootstrap runs
- **THEN** an organization, a MANAGEMENT key, the `openbinding` service from the permanent link with `all_last`, and one contract per synthetic user exist

#### Scenario: Second run
- **GIVEN** a profile already bootstrapped
- **WHEN** the bootstrap runs again
- **THEN** no organization, key, service or contract is duplicated

#### Scenario: Where the key lives
- **GIVEN** a bootstrap run
- **WHEN** the tool needs the MANAGEMENT key
- **THEN** it reads SPACE's own key store and writes no key to a lab secret store or to a file of the stack

### Requirement: Bootstrap boundary with SPACE and SPHERE
THE bootstrap tool SHALL write nothing to SPHERE and hold no SPHERE key, and SHALL call SPACE's HTTP API directly only if the owner has recorded an exception to constitution 16.1 for `tools/space_lab_bootstrap.py`; WHILE no such exception is recorded, THE repository SHALL contain no module that calls SPACE's HTTP API directly.

`req~lab-deployment-pricing-profile-bootstrap-boundary~1`

Evidence: GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_tool_holds_no_sphere_key_and_never_writes_to_sphere`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_tool_is_the_only_direct_space_http_caller`

Risk R8: the exception is the second question of the open owner request `crp-openbinding-m41-space-image-and-16-1`. Tests (slice S3) and tool (slice S4) wait for the answer.

#### Scenario: SPHERE key
- **GIVEN** the bootstrap tool and its service environment
- **WHEN** the static checks run
- **THEN** no `SPHERE_API_KEY` value is set and no request to SPHERE other than reading the public permanent link is made

#### Scenario: Other module calling SPACE directly
- **GIVEN** a module other than `tools/space_lab_bootstrap.py` that calls SPACE's HTTP API directly
- **WHEN** the unit suite runs
- **THEN** it fails
