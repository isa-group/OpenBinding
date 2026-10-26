## MODIFIED Requirements

### Requirement: No local SPACE
`req~lab-deployment-no-local-space~3`
THE deployment files SHALL hold local SPACE only in `compose.lab-pricing.json`, with exactly the SPACE services `space-mongo`, `space-redis` and `space-api` (whose image is `openbinding-lab/space-api:1.7.1` or `<repo>:1.7.1@sha256:<64 hex>`) beside the non-SPACE `pricing-bootstrap`, define SPHERE in no manifest and SPACE services, networks, volumes or the destructive key in no other, and reach SPACE and SPHERE otherwise only as remote services.

Needs: impl, utest

#### Scenario: Adding a SPACE container
- **GIVEN** a change that adds a `space` service to `docker-compose.yml`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: SPACE outside the pricing profile
- **GIVEN** a change that adds a `space-api` service, a `space` network, a `space-*` volume or the destructive key to `compose.lab.json`, `compose.pgtest.json` or a file under `deploy/`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: The four services of the pricing profile
- **GIVEN** `compose.lab-pricing.json` with `space-mongo`, `space-redis`, `space-api` and `pricing-bootstrap`
- **WHEN** the unit suite runs
- **THEN** the SPACE services found are exactly `space-mongo`, `space-redis` and `space-api`
- **AND** the test passes

#### Scenario: Unlisted service in the pricing profile
- **GIVEN** `compose.lab-pricing.json` plus a `space-web` service, or with `pricing-bootstrap` renamed `space-bootstrap`
- **WHEN** the unit suite runs
- **THEN** it fails, because the SPACE services are no longer exactly the permitted set

#### Scenario: A SPHERE service
- **GIVEN** a service named or imaged `sphere` in any manifest, the pricing profile included
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: Image of space-api
- **GIVEN** the `space-api` image `openbinding-lab/space-api:1.7.1`, and again `registry.example/space-api:1.7.1@sha256:` followed by 64 hex digits
- **WHEN** the image rule is applied
- **THEN** it passes for both
- **AND** it fails for `registry.example/space-api:1.7.1` (tag only), `openbinding-lab/space-api:1.8.0`, a 63-digit digest and the retired marker `gap.invalid/space-api:1.7.1`

Evidence: `openbinding-gateway/tests/test_no_local_space.py::test_other_manifests_have_no_local_space`; `openbinding-gateway/tests/test_no_local_space.py::test_no_manifest_defines_sphere`; `openbinding-gateway/tests/test_no_local_space.py::test_pricing_profile_defines_exactly_the_space_services`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_local_space_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_extra_space_service_breaks_the_exact_set`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_bootstrap_is_not_a_space_service_unless_renamed`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_destructive_key_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_sphere_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_space_api_image_is_detected`; `openbinding-gateway/tests/test_no_local_space.py::test_negative_control_space_api_image_accepts_built_image_and_digest`; `openbinding-gateway/tests/test_no_local_space.py::test_no_space_services_or_profile`

Every other manifest means `docker-compose.yml`, `compose.lab.json` and the other `compose.lab*.json` profiles, `compose.pgtest.json` and `deploy/**`. Remote services are configured by environment. The volumes of the pricing profile are named `lab-pricing-*` (checked by `test_pricing_profile_defines_exactly_the_space_services`; their exact set is `req~lab-deployment-pricing-profile-isolated~2`). `pricing-bootstrap` is not a SPACE service: its name has no `space` element and its image does not name `space-api`. The marker `gap.invalid/space-api:1.7.1` of revision 2 is no longer accepted.

### Requirement: Optional pricing profile in its own file
`req~lab-deployment-pricing-profile-optional~2`
THE lab SHALL define the SPACE `pricing` profile only in `compose.lab-pricing.json`, as a standalone project named `openbinding-lab-pricing` with exactly the four services `space-mongo`, `space-redis`, `space-api` and `pricing-bootstrap` and no `profiles` key, separate from `compose.lab.json` and its derived profiles, which stay free of SPACE services.

Needs: impl, utest

#### Scenario: Base lab unchanged
- **GIVEN** `compose.lab.json` and `compose.lab-pricing.json`
- **WHEN** the static checks run
- **THEN** `compose.lab.json` has no SPACE service and its memory sum is still the expected 4032 MiB

#### Scenario: Profile services
- **GIVEN** `compose.lab-pricing.json`
- **WHEN** its service names are read
- **THEN** they are `space-mongo`, `space-redis`, `space-api` and `pricing-bootstrap`, in any order
- **AND** the file declares no `profiles` key

#### Scenario: The three services of revision 1
- **GIVEN** a copy of the manifest without `pricing-bootstrap`
- **WHEN** the optional-file rule is applied
- **THEN** it fails

#### Scenario: A service started only on demand
- **GIVEN** a copy of the manifest with a `profiles` key, another project name or an extra service
- **WHEN** the optional-file rule is applied
- **THEN** it fails

Evidence: `lab/tests/test_lab_pricing_profile.py::test_optional_profile_file`; `lab/tests/test_lab_pricing_profile.py::test_compose_lab_keeps_no_space_service`; `lab/tests/test_lab_pricing_profile.py::test_control_sample_conforms`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_non_optional_profile`; `lab/tests/test_lab_pricing_profile.py::test_control_ignores_the_service_order`; `lab/tests/test_lab_compose.py::test_no_space_services`

The profile is brought up on its own, not as an overlay of the lab project. How the lab gateways reach it is not decided by this change (design.md §3, open points).

### Requirement: Pinned images of the pricing profile
`req~lab-deployment-pricing-profile-pinned-images~2`
THE pricing profile SHALL pin every image of a service without `build` by a digest that `docs/qa/PRICING_PROFILE.md` lists as verified with its date, and SHALL allow `build` only on `space-api`, with image `openbinding-lab/space-api:1.7.1` and build `{context: lab/space, dockerfile: Dockerfile}`, and on `pricing-bootstrap`, with image `openbinding-lab/pricing-bootstrap:1` and build `{context: lab/tools, dockerfile: Dockerfile}`, each pair exact.

Needs: impl, utest

#### Scenario: Mongo and redis by digest
- **GIVEN** `compose.lab-pricing.json` and the verified list of the runbook
- **WHEN** the static checks run
- **THEN** `space-mongo` is `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `space-redis` is `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`
- **AND** both digests are in the runbook's verified list

#### Scenario: The two built images
- **GIVEN** `space-api` with image `openbinding-lab/space-api:1.7.1` and build `{context: lab/space, dockerfile: Dockerfile}`, and `pricing-bootstrap` with image `openbinding-lab/pricing-bootstrap:1` and build `{context: lab/tools, dockerfile: Dockerfile}`
- **WHEN** the image rule is applied
- **THEN** it passes, although neither image is in the verified list

#### Scenario: Wrong build context
- **GIVEN** `space-api` built from context `lab/tools` or `.`, or `pricing-bootstrap` built from context `lab/space`
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Wrong local image name
- **GIVEN** `space-api` built from `lab/space` with image `openbinding-lab/space-api:latest` or without an `image` key, or `pricing-bootstrap` built from `lab/tools` with image `openbinding-lab/pricing-bootstrap:2`
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Build on another service
- **GIVEN** `space-mongo` with build `{context: lab/space, dockerfile: Dockerfile}` and image `openbinding-lab/space-api:1.7.1`
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Digest-less image on another service
- **GIVEN** `space-redis` with the tag-only image `redis:7.4.2`, or with `openbinding-lab/space-redis:1` and no `build`
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: space-api by verified digest
- **GIVEN** `space-api` without `build`, with a `<repo>:1.7.1@sha256:<64 hex>` reference that the runbook lists as verified
- **WHEN** the image rule is applied
- **THEN** it passes

#### Scenario: Tag-only or unlisted reference for space-api
- **GIVEN** `space-api` without `build`, with a tag-only image such as `example.invalid/space-api:1.7.1`, and again with `@sha256:` followed by a digest absent from the runbook's verified list
- **WHEN** the image rule is applied
- **THEN** it fails for both

#### Scenario: Unverified version
- **GIVEN** `space-api` without `build`, with a `<repo>:<other version>@sha256:<64 hex>` reference listed as verified
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Retired GAP marker
- **GIVEN** `space-api` with the image `gap.invalid/space-api:1.7.1`, with or without a `## GAP` section in the runbook
- **WHEN** the image rule is applied
- **THEN** it fails

#### Scenario: Runbook after the wiring
- **GIVEN** `docs/qa/PRICING_PROFILE.md`
- **WHEN** the static checks read it
- **THEN** it has no `## GAP` section and its verified list holds exactly the mongo and redis references above
- **AND** it names `openbinding-lab/space-api:1.7.1` with `lab/space` and `openbinding-lab/pricing-bootstrap:1` with `lab/tools`, and the three base-image digests, each marked UNVERIFIED, outside the verified list

#### Scenario: Parser controls on malformed runbook text
- **GIVEN** verified lines without a date, with a 63-digit digest, or outside the `## Verified image references` section
- **WHEN** the runbook parser reads them
- **THEN** it returns no verified reference

Evidence: `lab/tests/test_lab_pricing_profile.py::test_pinned_images_match_the_runbook`; `lab/tests/test_lab_pricing_profile.py::test_built_images_follow_the_allow_list`; `lab/tests/test_lab_pricing_profile.py::test_runbook_has_no_gap_and_documents_the_wiring`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_unpinned_images`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_wrong_builds`; `lab/tests/test_lab_pricing_profile.py::test_control_accepts_built_images_outside_the_verified_list`; `lab/tests/test_lab_pricing_profile.py::test_control_runbook_rule_refuses_a_gap_and_a_wrong_wiring`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_an_unverified_space_api_version`; `lab/tests/test_lab_pricing_profile.py::test_control_runbook_parsers_refuse_malformed_text`

The verified list holds only `mongo:7.0.16` `sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `redis:7.4.2` `sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`, verified on 2026-10-24 against Docker Hub. Built images have no registry digest and are never on that list. `lab/space/Dockerfile` builds SPACE from the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` of tag `v1.7.1` (owner answer to `crp-openbinding-m41-space-image-and-16-1`, 24-10-2026; `req~lab-space-image-pinned-commit~1` of change `m41-space-bootstrap`). The three base-image digests of `lab/space/Dockerfile` and `lab/tools/Dockerfile` stay UNVERIFIED in the runbook until the first lab build.

### Requirement: Memory budget of the pricing profile
`req~lab-deployment-pricing-profile-memory-budget~2`
THE pricing profile SHALL set a whole-unit `mem_limit` of 512 MiB on `space-mongo`, 96 MiB on `space-redis`, 384 MiB on `space-api` and 96 MiB on `pricing-bootstrap`, whose sum of 1088 MiB equals the runbook's documented sum and stays within the 1152 MiB ceiling, with the MongoDB cache, the Redis `maxmemory` and the Node heap each below its container limit, so that 4032 + 4032 + 1088 MiB stays within the 9216 MiB lab cap.

Needs: impl, utest

#### Scenario: Budget arithmetic
- **GIVEN** the memory limits of the profile and the 4032 MiB of one lab stack
- **WHEN** the static checks sum them
- **THEN** the profile sum is 1088 MiB, at most 1152 MiB, and equals the runbook's `Memory sum`
- **AND** 4032 + 4032 + 1088 = 9152 is at most 9216 MiB

#### Scenario: A service without a limit
- **GIVEN** a profile service, `pricing-bootstrap` included, whose `mem_limit` is removed
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: A limit over budget
- **GIVEN** `space-mongo` with `mem_limit` `640m`, or `pricing-bootstrap` with `128m`, or a runbook that still documents 992 MiB
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Cache or heap changed
- **GIVEN** a copy of the manifest with a changed MongoDB cache, Redis `maxmemory` or Node heap value
- **WHEN** the static checks run
- **THEN** they fail

Evidence: `lab/tests/test_lab_pricing_profile.py::test_memory_budget_matches_the_runbook`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_cache_and_heap_changes` (also covers a limit over budget or removed, and a runbook sum that differs)

The runbook line reads `Memory sum: 1088 MiB`. The ceiling of 1152 MiB is unchanged from revision 1.

### Requirement: Pricing profile isolated from the host
`req~lab-deployment-pricing-profile-isolated~2`
THE pricing profile SHALL publish and expose no port, mount no socket or host path, set no privilege or destructive key, run every service as a numeric non-root `uid:gid`, and use only the service keys `image`, `user`, `command`, `environment`, `volumes`, `mem_limit`, `healthcheck`, `depends_on`, `build` with exactly the keys `context` and `dockerfile`, and `restart` with the value `"no"` on `pricing-bootstrap` only.

Needs: impl, utest

#### Scenario: A published port added
- **GIVEN** `compose.lab-pricing.json` plus a published port for `space-api` or `pricing-bootstrap`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Bind mount, root user or privilege
- **GIVEN** a profile service with a bind mount, user `0:0` or `privileged: true`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Key outside the allow-list
- **GIVEN** a profile service with `security_opt`, `cap_drop`, `read_only`, `userns_mode`, `networks` or `network_mode` (the project default network applies)
- **WHEN** the static checks run
- **THEN** they fail, because a service uses only the keys of the allow-list

#### Scenario: Extra build keys
- **GIVEN** `space-api` with build `{context: lab/space, dockerfile: Dockerfile, args: {X: "1"}}`, or with `target`, or with `build` given as the string `lab/space`
- **WHEN** the static checks run
- **THEN** they fail, because `build` is a mapping of exactly `context` and `dockerfile`

#### Scenario: Restart on another service
- **GIVEN** `space-api` with `restart: "no"` or `restart: unless-stopped`, or `pricing-bootstrap` with `restart: on-failure`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Group id, volume driver or top-level network
- **GIVEN** a profile service with user `1000:0` or `1000` (no gid), a volume declared with `driver_opts`, or a top-level `networks` section
- **WHEN** the static checks run
- **THEN** they fail, because the gid must be numeric and non-zero, the only volumes are the named `lab-pricing-mongo` and `lab-pricing-redis` declared with labels only, and no top-level `networks` is declared

Evidence: `lab/tests/test_lab_pricing_profile.py::test_isolated_services`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_non_isolated_profile`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_keys_outside_the_allow_list`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_bind_networks_socket_and_bad_gid`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_extra_build_keys`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_restart_on_another_service_or_value`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_volume_and_user_variants`

The manifest carries no `cap_drop`, `read_only` or `security_opt`: the lab supervisor drops every capability for all lab projects, and `compose.lab.json` does not state it either. Which services may carry `build`, and with which values, is `req~lab-deployment-pricing-profile-pinned-images~2`.

### Requirement: Secret references of the pricing profile
`req~lab-deployment-pricing-profile-secret-references~2`
THE pricing profile SHALL reference its secrets only as the four bare variables `${DEMO_SPACE_JWT_SECRET}`, `${DEMO_SPACE_JWT_SALT}`, `${DEMO_SPACE_ADMIN_PASSWORD}` and `${DEMO_SPACE_MONGO_PASSWORD}`, without defaults and never as literal values, with `${DEMO_SPACE_ADMIN_PASSWORD}` exactly twice, as `ADMIN_PASSWORD` of `space-api` and `SPACE_ADMIN_PASSWORD` of `pricing-bootstrap`, and with the runbook documenting all four.

Needs: impl, utest

#### Scenario: Literal or defaulted secret
- **GIVEN** a profile service environment with a literal `ADMIN_PASSWORD` or `SPACE_ADMIN_PASSWORD`, or `JWT_SECRET` set to `${DEMO_SPACE_JWT_SECRET:-dev}`
- **WHEN** the static checks run
- **THEN** they fail, also for any value matching the `SECRET_SHAPES` scan

#### Scenario: Password in a URI or wrong reference
- **GIVEN** a `MONGO_URI` with a literal password, or `JWT_SECRET` set to another variable, or `SPACE_ADMIN_PASSWORD` set to `${DEMO_SPACE_JWT_SECRET}`, or a variable written unbraced as `$DEMO_SPACE_JWT_SECRET`
- **WHEN** the static checks run
- **THEN** they fail, because no `$` other than the four exact references is allowed anywhere in the manifest and each variable is pinned to its own reference

#### Scenario: Reference embedded in the Mongo URI
- **GIVEN** a `MONGO_URI` that embeds the bare `${DEMO_SPACE_MONGO_PASSWORD}` reference on purpose
- **WHEN** the static checks run
- **THEN** they pass

#### Scenario: The admin password in both places
- **GIVEN** `${DEMO_SPACE_ADMIN_PASSWORD}` as `ADMIN_PASSWORD` of `space-api` and as `SPACE_ADMIN_PASSWORD` of `pricing-bootstrap`
- **WHEN** the static checks run
- **THEN** they pass

#### Scenario: Second admin-password reference elsewhere
- **GIVEN** a third `${DEMO_SPACE_ADMIN_PASSWORD}`, for example as `ADMIN_USER` of `space-api` or in a URL of `pricing-bootstrap`, or the reference missing from `pricing-bootstrap`
- **WHEN** the static checks run
- **THEN** they fail, because the reference must appear exactly twice, in the two places above

#### Scenario: Undocumented variable
- **GIVEN** a runbook that does not name one of the four variables
- **WHEN** the static checks run
- **THEN** they fail

Evidence: `lab/tests/test_lab_pricing_profile.py::test_secret_references_are_bare_and_documented`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_defaulted_or_literal_secrets`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_unbraced_or_swapped_secret_references` (also covers `MONGO_URI` pinned to its full literal); `lab/tests/test_lab_pricing_profile.py::test_control_pins_the_admin_password_to_its_two_places`

`${DEMO_SPACE_JWT_SECRET}` and `${DEMO_SPACE_JWT_SALT}` appear once (`space-api`), `${DEMO_SPACE_MONGO_PASSWORD}` twice (`space-mongo` and the `MONGO_URI` of `space-api`), as in revision 1.

### Requirement: Start order of the pricing profile
`req~lab-deployment-pricing-profile-start-order~2`
THE pricing profile SHALL give each long-running service (`space-mongo`, `space-redis`, `space-api`) an enabled healthcheck, make `space-api` depend on `space-mongo` and `space-redis`, and make the one-shot `pricing-bootstrap`, which is exempt from the healthcheck rule, depend on `space-api` alone, each dependency with the condition `service_healthy` only.

Needs: impl, utest

#### Scenario: Started-only dependency
- **GIVEN** `space-api` depending on `space-mongo` with the condition `service_started`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Service without healthcheck
- **GIVEN** a long-running profile service (`space-mongo`, `space-redis` or `space-api`) with no healthcheck test, or with a test of `NONE` or a `disable` key (neither counts as a healthcheck)
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: One-shot bootstrap
- **GIVEN** `pricing-bootstrap` without a healthcheck and with `depends_on: {space-api: {condition: service_healthy}}`
- **WHEN** the static checks run
- **THEN** they pass, because the one-shot is exempt from the healthcheck rule, as in the lab rules

#### Scenario: Bootstrap started too early
- **GIVEN** `pricing-bootstrap` without `depends_on`, or depending on `space-api` with `service_started` or `service_completed_successfully`, or also depending on `space-mongo`
- **WHEN** the static checks run
- **THEN** they fail

Evidence: `lab/tests/test_lab_pricing_profile.py::test_start_order_waits_for_healthy_databases`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_started_only_dependency`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_service_without_a_healthcheck`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_bootstrap_started_too_early`; `lab/tests/test_lab_pricing_profile.py::test_control_exempts_the_one_shot_from_the_healthcheck_rule`

## ADDED Requirements

### Requirement: Pinned environment of the bootstrap service
`req~lab-deployment-pricing-profile-bootstrap-environment~1`
THE `pricing-bootstrap` service of the pricing profile SHALL have exactly the environment `SPACE_URL=http://space-api:3000`, `SPACE_ADMIN_USER=lab-space-admin` and `SPACE_ADMIN_PASSWORD=${DEMO_SPACE_ADMIN_PASSWORD}`, and no other key, and its service keys SHALL be exactly `image`, `build`, `user`, `restart`, `environment`, `mem_limit` and `depends_on`.

Needs: impl, utest

#### Scenario: The pinned environment
- **GIVEN** `compose.lab-pricing.json`
- **WHEN** the environment of `pricing-bootstrap` is read
- **THEN** it is exactly `SPACE_URL=http://space-api:3000`, `SPACE_ADMIN_USER=lab-space-admin` and `SPACE_ADMIN_PASSWORD=${DEMO_SPACE_ADMIN_PASSWORD}`

#### Scenario: Bootstrap with an extra key or a proxy variable
- **GIVEN** `pricing-bootstrap` with an extra `HTTPS_PROXY=http://proxy.example:3128`, `https_proxy`, `SPHERE_API_KEY` or `SPACE_BOOTSTRAP_PLAN` key
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Bootstrap with a changed value or a missing key
- **GIVEN** `pricing-bootstrap` with `SPACE_URL=https://space.score.us.es`, `SPACE_ADMIN_USER=admin`, or without `SPACE_ADMIN_USER`
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Bootstrap with a healthcheck, a volume or a command
- **GIVEN** `pricing-bootstrap` with an added `healthcheck`, a `volumes` entry (for example the `lab-pricing-mongo` mount) or a `command`
- **WHEN** the static checks run
- **THEN** they fail, because its service keys are exactly the seven above

Evidence: `lab/tests/test_lab_pricing_profile.py::test_bootstrap_surface_is_pinned`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_changed_bootstrap_surface`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_a_missing_bootstrap_service`; `lab/tests/test_lab_pricing_profile.py::test_control_refuses_extra_bootstrap_keys`

No other key excludes the proxy variables `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` (any case), `SPHERE_API_KEY` and `SPACE_BOOTSTRAP_PLAN` (the tool default `FREE` applies; per-user plans are an open point of design.md §3). The bootstrap tool itself is specified by change `m41-space-bootstrap`.
