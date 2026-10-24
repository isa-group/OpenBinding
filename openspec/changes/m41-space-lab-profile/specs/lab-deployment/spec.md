## MODIFIED Requirements

### Requirement: No local SPACE
THE deployment files SHALL contain no SPACE service, network or volume, except the `space-*` services and volumes and the `pricing-bootstrap` service of the optional `compose.lab-pricing.json`; SPHERE SHALL never be deployed locally, and SPACE and SPHERE SHALL otherwise be reached only as remote services configured by environment.

`req~lab-deployment-no-local-space~2`

Evidence: `openbinding-gateway/tests/test_no_local_space.py::test_no_space_services_or_profile`; GAP `openbinding-gateway/tests/test_no_local_space.py::test_space_is_declared_only_in_the_pricing_profile`; GAP `openbinding-gateway/tests/test_no_local_space.py::test_the_pricing_profile_declares_only_its_own_services_and_volumes`; `lab/tests/test_lab_compose.py::test_no_space_services`

#### Scenario: Adding a SPACE container
- **GIVEN** a change that adds a `space` service to `docker-compose.yml`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: SPACE outside the pricing profile
- **GIVEN** a change that adds a `space-api` service to `compose.lab.json`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: Unlisted service in the pricing profile
- **GIVEN** `compose.lab-pricing.json` plus a `space-web` service
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: Image of space-api
- **GIVEN** the `space-api` image is the GAP marker or a reference listed as verified in `docs/qa/PRICING_PROFILE.md`
- **WHEN** the unit suite runs
- **THEN** the image rule passes
- **AND** it fails for a tag-only reference or a digest the runbook does not list (see `pricing-profile-pinned-images`)

## ADDED Requirements

### Requirement: Optional pricing profile in its own file
THE lab SHALL define the SPACE `pricing` profile only in `compose.lab-pricing.json`, separate from `compose.lab.json` and its derived profiles, which SHALL stay free of SPACE services; the file SHALL declare exactly four services, `space-mongo`, `space-redis`, `space-api` and the one-shot `pricing-bootstrap`.

`req~lab-deployment-pricing-profile-optional-file~1`

Evidence: GAP `lab/tests/test_lab_pricing_profile.py::test_the_profile_is_a_separate_file_with_its_own_services`; GAP `lab/tests/test_lab_pricing_profile.py::test_the_base_lab_files_do_not_mention_the_profile`; `lab/tests/test_lab_compose.py::test_no_space_services`

The four services are the final state (slice S4). Slice S2 delivers the first three; the test expects the three-service set until S4 adds `pricing-bootstrap`.

#### Scenario: Base lab unchanged
- **GIVEN** `compose.lab.json` and `compose.lab-pricing.json`
- **WHEN** the static checks run
- **THEN** `compose.lab.json` has no `space-*` service and its memory sum is still 4032 MiB

#### Scenario: Profile services
- **GIVEN** `compose.lab-pricing.json`
- **WHEN** its service names are read
- **THEN** they are `space-mongo`, `space-redis` and `space-api` (three until S4 adds `pricing-bootstrap`)

### Requirement: Pinned images of the pricing profile
THE services of the pricing profile SHALL use images pinned by digest and listed as verified, with their date, in `docs/qa/PRICING_PROFILE.md`: `space-mongo` and `space-redis` by the `mongo:7.0.16` and `redis:7.4.2` digests of that list, and `space-api` either by the explicit marker `gap.invalid/space-api:1.7.1` while its image is unresolved, or by a reference pinned by digest or build commit listed as verified; IF a reference is tag-only, a digest is not in the list, or the marker is used by another service, THEN the static check SHALL fail.

`req~lab-deployment-pricing-profile-pinned-images~1`

Evidence: GAP `lab/tests/test_lab_pricing_profile.py::test_mongo_and_redis_are_pinned_by_a_verified_digest`; GAP `lab/tests/test_lab_pricing_profile.py::test_space_api_is_the_gap_marker_or_a_verified_reference`; GAP `lab/tests/test_lab_pricing_profile.py::test_the_gap_marker_is_refused_for_other_services`; GAP `lab/tests/test_lab_pricing_profile.py::test_tag_only_or_unlisted_space_api_reference_is_refused`; GAP `lab/tests/test_lab_pricing_profile.py::test_the_runbook_lists_the_verified_images_with_a_date`

Verified on 2026-10-24 against Docker Hub: `mongo:7.0.16` `sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `redis:7.4.2` `sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`. No digest is guessed for `space-api`; its image is an open owner request.

#### Scenario: Mongo and redis by digest
- **GIVEN** `compose.lab-pricing.json` and the verified list of the runbook
- **WHEN** the static checks run
- **THEN** `space-mongo` is `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `space-redis` is `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`
- **AND** both digests are in the runbook's verified list

#### Scenario: GAP marker accepted only for space-api
- **GIVEN** `space-api` with the image `gap.invalid/space-api:1.7.1`, and the same marker on `space-redis` in a copy of the manifest
- **WHEN** the image rule is applied to each
- **THEN** it passes for `space-api` and fails for `space-redis`

#### Scenario: Tag-only or unlisted reference for space-api
- **GIVEN** `space-api` with a tag-only image such as `example.invalid/space-api:1.7.1`, and again with `@sha256:` followed by a digest absent from the runbook's verified list
- **WHEN** the image rule is applied
- **THEN** it fails for both

#### Scenario: Verified space-api reference
- **GIVEN** the owner has supplied the `space-api` image or build and the runbook lists its digest (or the commit SHA of tag v1.7.1 it is built from) as verified
- **WHEN** `space-api` carries that reference
- **THEN** the image rule passes and the GAP marker is no longer accepted

### Requirement: Memory budget of the pricing profile
THE pricing profile SHALL set a memory limit on every service and keep their sum equal to the documented sum and within the profile ceiling of 1152 MiB, so that the develop lab, one PR preview and the profile stay within the 9216 MiB lab cap.

`req~lab-deployment-pricing-profile-memory-budget~1`

Evidence: GAP `lab/tests/test_lab_pricing_profile.py::test_every_profile_service_has_a_mem_limit`; GAP `lab/tests/test_lab_pricing_profile.py::test_profile_memory_sum_is_the_documented_one_and_within_the_ceiling`; GAP `lab/tests/test_lab_pricing_profile.py::test_lab_preview_and_profile_fit_the_lab_cap`

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

### Requirement: Pricing profile reachable only inside its network
THE pricing profile SHALL publish no host port and expose none, and SHALL reach outside its Compose network only `sphere.score.us.es` over HTTPS.

`req~lab-deployment-pricing-profile-internal-only~1`

Evidence: GAP `lab/tests/test_lab_pricing_profile.py::test_the_profile_publishes_and_exposes_no_port`; GAP `lab/tests/test_lab_pricing_profile.py::test_sphere_public_url_is_the_only_external_address`; live: GAP `lab/tests/test_lab_pricing_profile_live.py::test_the_lab_reaches_sphere_over_https`

#### Scenario: A published port added
- **GIVEN** `compose.lab-pricing.json` plus `27017:27017` published for `space-mongo`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: SPHERE address
- **GIVEN** `space-api` configured with `SPHERE_PUBLIC_URL=https://sphere.score.us.es` and `SPHERE_SYNC_ENABLED=true`
- **WHEN** the static checks read its environment
- **THEN** no other external URL is configured

### Requirement: Secrets and privileges of the pricing profile
THE pricing profile SHALL reference secrets only through variables without defaults, never as literals, and its services SHALL run without extra privileges, host bind mounts or custom networks.

`req~lab-deployment-pricing-profile-secrets-and-privileges~1`

Evidence: GAP `lab/tests/test_lab_pricing_profile.py::test_profile_holds_no_literal_secret`; GAP `lab/tests/test_lab_pricing_profile.py::test_profile_services_ask_for_no_privileges_binds_or_networks`

#### Scenario: Literal key
- **GIVEN** a profile service environment with a literal value for a key or password
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Privileged service
- **GIVEN** `privileged: true` or `cap_add` on a profile service
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Bootstrap of the SPACE service from the SPHERE link
WHEN the pricing profile starts, THE `pricing-bootstrap` one-shot SHALL create the SPACE organization and a MANAGEMENT key kept in the stack's secret store, create the `openbinding` service from the SPHERE permanent link `https://sphere.score.us.es/p/6ab0a323697330667ccce891` with `source: sphere` and `policy: all_last`, run a first synchronization, create contracts for the synthetic users of the seed, and be safe to re-run.

`req~lab-deployment-pricing-profile-bootstrap~1`

Evidence: GAP `lab/tests/test_space_lab_bootstrap.py::test_it_creates_organization_key_service_and_contracts`; GAP `lab/tests/test_space_lab_bootstrap.py::test_the_service_comes_from_the_sphere_link_with_all_last`; GAP `lab/tests/test_space_lab_bootstrap.py::test_a_second_run_changes_nothing`; live (S5): GAP `lab/tests/test_lab_pricing_profile_live.py::test_space_shows_the_openbinding_service_ready_on_the_latest_version`

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

Evidence: GAP `lab/tests/test_space_lab_bootstrap.py::test_the_tool_holds_no_sphere_key_and_never_writes_to_sphere`; GAP `lab/tests/test_space_lab_bootstrap.py::test_the_tool_is_the_only_direct_space_http_caller`

Risk R8: the exception is the second question of the open owner request `crp-openbinding-m41-space-image-and-16-1`. Tests (slice S3) and tool (slice S4) wait for the answer.

#### Scenario: SPHERE key
- **GIVEN** the bootstrap tool and its service environment
- **WHEN** the static checks run
- **THEN** no `SPHERE_API_KEY` value is set and no request to SPHERE other than reading the public permanent link is made

#### Scenario: Other module calling SPACE directly
- **GIVEN** a module other than `tools/space_lab_bootstrap.py` that calls SPACE's HTTP API directly
- **WHEN** the unit suite runs
- **THEN** it fails
