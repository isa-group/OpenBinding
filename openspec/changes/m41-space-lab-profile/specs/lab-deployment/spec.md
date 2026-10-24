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
THE lab SHALL define the SPACE `pricing` profile only in `compose.lab-pricing.json`, as a standalone project named `openbinding-lab-pricing` (brought up on its own, not as an overlay of the lab project), separate from `compose.lab.json` and its derived profiles, which SHALL stay free of SPACE services; the file SHALL declare no `profiles` key and exactly the services `space-mongo`, `space-redis` and `space-api` (plus the one-shot `pricing-bootstrap` once slice S4 exists).

`req~lab-deployment-pricing-profile-optional~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_optional_profile_file`; `lab/tests/test_lab_pricing_profile.py::test_compose_lab_keeps_no_space_service`; `lab/tests/test_lab_pricing_profile.py::test_control_sample_conforms`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_non_optional_profile`; `lab/tests/test_lab_pricing_profile.py::test_control_ignores_the_service_order`; `lab/tests/test_lab_compose.py::test_no_space_services`

The four services are the final state (slice S4). Slice S2 delivers the first three; the rule expects the three-service set until S4 adds `pricing-bootstrap`. The gateway is not wired to this SPACE in M4.1; M4.2/M4.5 fold the services into the main lab manifest or choose another route with a recorded exception to the no-`networks` rule. The command `lab_compose up file=compose.lab-pricing.json` is proposed (factory follow-up F1) and no test covers that exact string.

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
THE services of the pricing profile SHALL use images pinned by digest and listed as verified, with their date, in `docs/qa/PRICING_PROFILE.md`: `space-mongo` and `space-redis` by the `mongo:7.0.16` and `redis:7.4.2` digests of that list, and `space-api` either by the explicit marker `gap.invalid/space-api:1.7.1` while its image is unresolved and the runbook has an open GAP entry naming it, or by a `<repo>:1.7.1@sha256:<64 hex>` reference listed as verified; IF a reference is tag-only, a digest is not in the list, or the marker is used by another service, without the GAP entry, or once the verified list contains a `space-api` digest, THEN the static check SHALL fail.

`req~lab-deployment-pricing-profile-pinned-images~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_pinned_images_match_the_runbook`; `lab/tests/test_lab_pricing_profile.py::test_runbook_documents_the_gap_and_the_bring_up`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_unpinned_images`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_an_unverified_space_api_version`

Verified on 2026-10-24 against Docker Hub: `mongo:7.0.16` `sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `redis:7.4.2` `sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`. No space-api reference has been verified by this change; no digest is guessed for `space-api`. `ghcr.io/scorelabus/space-api:1.7.1` (ARCHITECTURE §9.4) is an unverified candidate submitted to the owner in question 1 of the open owner request. A build option would need a revision 2 of this requirement (build context pinned by commit SHA plus a check for it); the digest path needs none.

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

#### Scenario: Marker after a verified digest
- **GIVEN** a runbook whose verified list contains a `space-api` digest and a manifest that still carries the marker
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Unverified version
- **GIVEN** `space-api` with a `<repo>:<other version>@sha256:<64 hex>` reference
- **WHEN** the image rule is applied
- **THEN** it fails

### Requirement: Memory budget of the pricing profile
THE pricing profile SHALL set a whole-unit `mem_limit` on every service, keep their sum equal to the sum documented in the runbook and within the profile ceiling of 1152 MiB, and keep the MongoDB cache, the Redis `maxmemory` and the Node heap each below the limit of its container, so that the develop lab, one PR preview and the profile stay within the 9216 MiB lab cap.

`req~lab-deployment-pricing-profile-memory-budget~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_memory_budget_matches_the_runbook`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_cache_and_heap_changes` (also covers a limit over budget or removed, and a runbook sum that differs)

The final sum is 1088 MiB: 512 (`space-mongo`) + 96 (`space-redis`) + 384 (`space-api`) + 96 (`pricing-bootstrap`). The S2 manifest has three services and a sum of 992 MiB; slice S4 adds the bootstrap and the 96 MiB. The ceiling stays 1152 MiB.

#### Scenario: Budget arithmetic
- **GIVEN** the memory limits of the profile and the 4032 MiB of one lab stack
- **WHEN** the static checks sum them
- **THEN** the profile sum is 992 MiB (1088 MiB after S4), at most 1152 MiB
- **AND** 4032 + 4032 + 1088 is at most 9216 MiB
- **AND** 2 x 4032 + 1088 is at most 9216 MiB

#### Scenario: A service without a limit
- **GIVEN** a profile service whose `mem_limit` is removed
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: A limit over budget
- **GIVEN** `space-mongo` with `mem_limit` `640m`, or a runbook sum that differs from the manifest sum
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Cache or heap changed
- **GIVEN** a copy of the manifest with a changed MongoDB cache, Redis `maxmemory` or Node heap value
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Pricing profile isolated from the host
THE pricing profile SHALL publish no host port and expose none, use no `networks` or `network_mode` key (the project default network applies), mount no socket or host path (only its two named volumes `lab-pricing-mongo` and `lab-pricing-redis`, declared with labels only), set no privilege or destructive key, run every service as a numeric non-root user, and use only the service keys `image`, `user`, `command`, `environment`, `volumes`, `mem_limit`, `healthcheck` and `depends_on`.

`req~lab-deployment-pricing-profile-isolated~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_isolated_services`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_non_isolated_profile`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_keys_outside_the_allow_list`

#### Scenario: A published port added
- **GIVEN** `compose.lab-pricing.json` plus a published port for `space-api`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Bind mount, root user or privilege
- **GIVEN** a profile service with a bind mount, user `0:0` or `privileged: true`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Key outside the allow-list
- **GIVEN** a profile service with `security_opt`, `userns_mode` or `build`
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Secret references of the pricing profile
THE pricing profile SHALL reference its secrets only as the four bare variables `${DEMO_SPACE_JWT_SECRET}`, `${DEMO_SPACE_JWT_SALT}`, `${DEMO_SPACE_ADMIN_PASSWORD}` and `${DEMO_SPACE_MONGO_PASSWORD}`, without defaults, never as literal values, including a literal password embedded in a URI (`MONGO_URI` embeds the bare `${DEMO_SPACE_MONGO_PASSWORD}` reference on purpose), with no `$` other than those four exact references anywhere in the manifest (an unbraced `$VAR` is refused), each variable pinned to its own reference, and no value matching the `SECRET_SHAPES` scan; the runbook SHALL document each of the four.

`req~lab-deployment-pricing-profile-secret-references~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_secret_references_are_bare_and_documented`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_defaulted_or_literal_secrets`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_unbraced_or_swapped_secret_references`

#### Scenario: Literal or defaulted secret
- **GIVEN** a profile service environment with a literal `ADMIN_PASSWORD`, or `JWT_SECRET` set to `${DEMO_SPACE_JWT_SECRET:-dev}`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Password in a URI or wrong reference
- **GIVEN** a `MONGO_URI` with a literal password, or `JWT_SECRET` set to another variable, or a variable written unbraced as `$DEMO_SPACE_JWT_SECRET`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Reference embedded in the Mongo URI
- **GIVEN** a `MONGO_URI` that embeds the bare `${DEMO_SPACE_MONGO_PASSWORD}` reference
- **WHEN** the static checks run
- **THEN** they pass

#### Scenario: Undocumented variable
- **GIVEN** a runbook that does not name one of the four variables
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Start order of the pricing profile
THE pricing profile SHALL give every service a healthcheck, and `space-api` SHALL depend on `space-mongo` and `space-redis` with the condition `service_healthy` only.

`req~lab-deployment-pricing-profile-start-order~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_start_order_waits_for_healthy_databases`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_started_only_dependency`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_service_without_a_healthcheck`

#### Scenario: Started-only dependency
- **GIVEN** `space-api` depending on `space-mongo` with the condition `service_started`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Service without healthcheck
- **GIVEN** a profile service with no healthcheck test
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Remote SPHERE only
THE `space-api` service of the pricing profile SHALL be configured with `SPHERE_SYNC_ENABLED=true`, `SPHERE_PUBLIC_URL=https://sphere.score.us.es`, `SPHERE_API_URL=https://sphere.score.us.es/api/v1` and `SPHERE_ALLOW_LOCAL_HTTP=false`, and every URL of any scheme in the manifest SHALL have a host in {`space-mongo`, `space-redis`, `space-api`, `sphere.score.us.es`, `127.0.0.1`}.

`req~lab-deployment-pricing-profile-remote-sphere~1`

Evidence: `lab/tests/test_lab_pricing_profile.py::test_remote_sphere_is_the_only_sphere`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_local_sphere`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_foreign_host_in_any_url_scheme`; live: GAP `lab/tests/test_lab_pricing_profile_live.py::test_the_lab_reaches_sphere_over_https`

#### Scenario: SPHERE address
- **GIVEN** `space-api` configured with the four SPHERE variables above
- **WHEN** the static checks read its environment
- **THEN** they pass and no other external URL is configured

#### Scenario: A local SPHERE
- **GIVEN** `SPHERE_API_URL=http://sphere:8080/api/v1` or a webhook URL on another host
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: A foreign host in another scheme
- **GIVEN** a URL such as `mongodb://other-host:27017/` or `redis://other-host:6379` anywhere in the manifest
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Bootstrap of the SPACE service from the SPHERE link
WHEN the pricing profile starts, THE `pricing-bootstrap` one-shot SHALL create the SPACE organization and a MANAGEMENT key, create the `openbinding` service from the SPHERE permanent link `https://sphere.score.us.es/p/6ab0a323697330667ccce891` with `source: sphere` and `policy: all_last`, run a first synchronization, create contracts for the synthetic users of the seed, and be safe to re-run; the placement of the MANAGEMENT key (the stack's secret store per ARCHITECTURE §9.4, or kept inside SPACE until M4.5) is an open decision settled with the owner request before slice S4, and this requirement takes a revision once it is decided.

`req~lab-deployment-pricing-profile-bootstrap~1`

Evidence: GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_it_creates_organization_key_service_and_contracts`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_service_comes_from_the_sphere_link_with_all_last`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_a_second_run_changes_nothing`; live (S5): GAP `lab/tests/test_lab_pricing_profile_live.py::test_space_shows_the_openbinding_service_ready_on_the_latest_version`

This requirement is the final state. Its tests (slice S3) and the tool (slice S4) are blocked on the owner request `crp-openbinding-m41-space-image-and-16-1`; live evidence is slice S5.

#### Scenario: First run
- **GIVEN** a started profile with an empty SPACE
- **WHEN** the bootstrap runs
- **THEN** an organization, a MANAGEMENT key, the `openbinding` service from the permanent link with `all_last`, and one contract per synthetic user exist

#### Scenario: Second run
- **GIVEN** a profile already bootstrapped
- **WHEN** the bootstrap runs again
- **THEN** no organization, key, service or contract is duplicated

### Requirement: Bootstrap boundary with SPACE and SPHERE
THE bootstrap tool SHALL write nothing to SPHERE and hold no SPHERE key, and SHALL call SPACE's HTTP API directly only if the owner has recorded an exception to constitution 16.1 for `tools/space_lab_bootstrap.py`; WHILE no such exception is recorded, THE repository SHALL contain no module that calls SPACE's HTTP API directly.

`req~lab-deployment-pricing-profile-bootstrap-boundary~1`

Evidence: GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_tool_holds_no_sphere_key_and_never_writes_to_sphere`; GAP `openbinding-gateway/tests/test_space_lab_bootstrap.py::test_the_tool_is_the_only_direct_space_http_caller`

Risk R8: the exception is the second question of the open owner request `crp-openbinding-m41-space-image-and-16-1`. ADR-0015 §2 says the plans module is the only code that talks to SPACE, so the answer is also put to the owner and recorded as an ADR amendment before slice S4. Tests (slice S3) and tool (slice S4) wait for the answer.

#### Scenario: SPHERE key
- **GIVEN** the bootstrap tool and its service environment
- **WHEN** the static checks run
- **THEN** no `SPHERE_API_KEY` value is set and no request to SPHERE other than reading the public permanent link is made

#### Scenario: Other module calling SPACE directly
- **GIVEN** a module other than `tools/space_lab_bootstrap.py` that calls SPACE's HTTP API directly
- **WHEN** the unit suite runs
- **THEN** it fails
