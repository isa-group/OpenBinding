## MODIFIED Requirements

### Requirement: Single loopback port in the lab
THE lab profile SHALL publish exactly one host port, from the `web` service only, which no other service exposes, bound to `127.0.0.1` at `${DEMO_LAB_PORT:-18100}` (the variable in 18100–18199), and SHALL use that port in the gateway image tag and the local CORS origins, so the develop lab keeps 18100.

`req~lab-deployment-single-loopback-port~2`

Evidence: static tests: `lab/tests/test_lab_compose.py::test_single_published_port_on_loopback` (unset, 18101 and 18199); `lab/tests/test_lab_compose.py::test_no_expose_of_published_ports_on_other_services`; `lab/tests/test_lab_compose.py::test_port_rule_refuses_an_extra_published_port`; `lab/tests/test_lab_compose.py::test_published_port_outside_the_range_is_refused`; `lab/tests/test_lab_compose.py::test_gateway_image_tag_and_local_cors_follow_the_port`; `lab/tests/test_lab_compose.py::test_demo_doc_has_the_demo_lab_port_row`; `lab/tests/test_lab_process_profiles.py::test_only_the_gateway_holds_the_jwt_secret_and_one_port_is_published`; Compose layer: `lab/tests/test_lab_compose_config.py::test_compose_config_expands_port_image_and_cors`

#### Scenario: A debug port added to the gateway
- **GIVEN** a manifest equal to `compose.lab.json` plus `8000:8000` published for the gateway
- **WHEN** the port rule of the lab static checks is applied to it
- **THEN** the rule fails

#### Scenario: Develop lab without the variable
- **GIVEN** `compose.lab.json` and no `DEMO_LAB_PORT` in the environment
- **WHEN** the file is interpolated
- **THEN** `web` is published on `127.0.0.1:18100`
- **AND** gateway, worker and seed use the image `openbinding-lab-gateway:18100`

#### Scenario: Preview port set
- **GIVEN** `compose.lab.json` with `DEMO_LAB_PORT=18101`, and again with `DEMO_LAB_PORT=18199`
- **WHEN** the file is interpolated
- **THEN** `web` is published on `127.0.0.1:18101` (respectively `18199`) and on no other port
- **AND** the image is `openbinding-lab-gateway:18101` and the local CORS origins are `http://localhost:18101,http://127.0.0.1:18101` (respectively 18199)

#### Scenario: Port outside the range
- **GIVEN** `compose.lab.json` with `DEMO_LAB_PORT` set to `18099`, to `18200` or to `abc`
- **WHEN** the port rule is applied to the interpolated file
- **THEN** the rule fails for each of the three values

## ADDED Requirements

### Requirement: Preview on demand per PR head
THE preview manager SHALL start a PR preview only on an explicit request naming an open PR whose head branch is in this repository, built from the PR's current head SHA; IF the PR is closed, merged or from a fork, THEN it SHALL refuse with `preview_pr_not_eligible`, write no record and hold no port.

`req~lab-deployment-preview-on-demand~1`

#### Scenario: Request for an open PR
- **GIVEN** open PR 42 of `isa-group/OpenBinding` with head `3f2a…`, no record and port 18101 free
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has `refusal: null`, project `openbinding-pr-42`, port 18101 and the command `["lab_compose", "up", "--project", "openbinding-pr-42", "--build"]`
- **AND** the planned record has `head_sha` `3f2a…`

#### Scenario: Closed or merged PR
- **GIVEN** PR 42 in state `closed`, and again in state `merged`, with no record
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has `refusal: "preview_pr_not_eligible"`, `record: null`, `port: null` and no commands

#### Scenario: PR from a fork
- **GIVEN** open PR 57 whose `head_repo` is `someone/OpenBinding`
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan has `refusal: "preview_pr_not_eligible"`, `record: null`, `port: null` and no commands

#### Scenario: Without a record, only request or refresh starts a stack
- **GIVEN** a state with no record for PR 42, whose head moved to `9c1d…`
- **WHEN** the planner plans `open`, `expire`, `activity`, `stop` and `destroy-check` for it
- **THEN** no plan contains an `up` command and none returns a record for PR 42

#### Scenario: Push without a request (F2 acceptance)
- **GIVEN** open PR 42 without a preview
- **WHEN** a new commit is pushed to its branch
- **THEN** no project `openbinding-pr-42` exists afterwards

Evidence: `lab/tests/test_previews.py::test_request_for_an_open_pr_plans_one_stack_at_its_head`; `lab/tests/test_previews.py::test_closed_or_merged_pr_is_refused_as_not_eligible`; `lab/tests/test_previews.py::test_fork_pr_is_refused_as_not_eligible`; `lab/tests/test_previews.py::test_only_request_and_refresh_plan_an_up_without_a_record`

### Requirement: Preview port range on loopback
THE preview manager SHALL publish each PR preview on exactly one port of `127.0.0.1` in 18101–18199, the lowest that no other record holds and no other process listens on, keep it until destroy, also while stopped, unless `up` fails on a port collision, which releases it, and SHALL never allocate 18100 or bind another interface.

`req~lab-deployment-preview-port-range~1`

#### Scenario: First preview
- **GIVEN** no PR preview record, port 18101 free and the develop lab on 18100
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has port 18101 and `DEMO_LAB_PORT` `18101`

#### Scenario: Lowest free port with gaps
- **GIVEN** records holding 18101 and 18103, and 18102 free
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan has port 18102

#### Scenario: Port listened on by another process is skipped
- **GIVEN** no PR preview record and `--listening [18101]`
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has port 18102

#### Scenario: Stopped preview keeps its port
- **GIVEN** the `stopped` record of PR 42 on 18101
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan does not have port 18101

#### Scenario: Failed record without a port gets a port again
- **GIVEN** the `failed` record of PR 42 at the PR's head with `port: null` after a collision, the record of PR 57 on 18101, port 18102 free and no running stack
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has `refusal: null` and port 18102, and its record has `port` 18102

#### Scenario: Destroyed record frees its port
- **GIVEN** the `destroyed` record of PR 42, which held 18101, and no other record
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan has port 18101

#### Scenario: Last free port
- **GIVEN** 98 records holding 18101–18198 and port 18199 free
- **WHEN** the planner plans `request` for PR 200
- **THEN** the plan has port 18199

#### Scenario: Port 18100 is never allocated
- **GIVEN** an empty state and 99 successive `request` plans, each added to the state
- **WHEN** the allocated ports are collected, the list being asserted non-empty
- **THEN** they are exactly 18101–18199 and none is 18100

Evidence: `lab/tests/test_previews.py::test_first_preview_gets_18101`; `lab/tests/test_previews.py::test_lowest_free_port_fills_gaps`; `lab/tests/test_previews.py::test_98_held_ports_allocate_18199`; `lab/tests/test_lab_compose.py::test_single_published_port_on_loopback`

### Requirement: One project and private volumes per preview
THE preview manager SHALL run each PR preview as its own Compose project `openbinding-pr-<number>` whose network and named volumes no other project uses, with no host bind mount.

`req~lab-deployment-preview-isolation~1`

#### Scenario: Two previews
- **GIVEN** `ready` records of PR 42 on 18101 and PR 57 on 18102, and both PRs moved to new heads
- **WHEN** the planner plans `refresh` for each
- **THEN** each plan has non-empty `commands` and a non-null `record` that lists its volumes
- **AND** every command of PR 42 names project `openbinding-pr-42` and its record lists only `openbinding-pr-42_*` volumes
- **AND** every command of PR 57 names `openbinding-pr-57` and its record lists only `openbinding-pr-57_*` volumes

#### Scenario: Cross-preview access (live probe)
- **GIVEN** previews of PR 42 on 18101 and PR 57 on 18102 running, with the develop lab stopped
- **WHEN** a `python -c` socket client in a container of PR 42 resolves `web`, connects to `web:8080`, and connects to port 18102 through the host-side gateway address of its own network
- **THEN** `web` resolves to PR 42's own `web` container address, which differs from PR 57's, and `web:8080` answers (control)
- **AND** the connection to port 18102 fails with `ECONNREFUSED`, not with a timeout or an exec error
- **AND** from the host, `127.0.0.1:18102` answers (positive control)

Evidence: `lab/tests/test_previews.py::test_names_derive_from_the_pr_number`; `lab/tests/test_lab_compose.py::test_top_level_volumes_and_networks_carry_only_labels`; live: `lab/tests/test_preview_isolation.py::test_b_port_refused_from_a`; `lab/tests/test_preview_isolation.py::test_a_reaches_own_web`; `lab/tests/test_preview_isolation.py::test_b_port_answers_on_host`; `lab/tests/test_preview_isolation.py::test_web_resolves_to_own_container`

### Requirement: Tracked Compose file and synthetic data only
THE preview manager SHALL start a PR preview only from a lab Compose file tracked at the PR head, with the synthetic seed and synthetic `DEMO_*` secrets generated when the preview is first started and kept unchanged until destroy, never production data or secrets; IF the file is untracked, THEN it SHALL refuse with `preview_untracked_compose`.

`req~lab-deployment-preview-synthetic-only~1`

#### Scenario: Untracked Compose file
- **GIVEN** open PR 42 whose tracked files at the head do not include `compose.lab-process.json`
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has `refusal: "preview_untracked_compose"`, `record: null` and no commands

#### Scenario: Environment of a first start
- **GIVEN** open PR 42, no record and port 18101 free
- **WHEN** the planner plans `request` for PR 42
- **THEN** `DEMO_LAB_PORT` is `18101`, `DEMO_PUBLIC_ORIGIN` is `http://localhost:18101` and `DEMO_SPACE_ENABLED` is `false`
- **AND** `SPACE_API_KEY`, `SPACE_URL`, `SPACE_ORGANIZATION_ID` and `SPHERE_API_KEY` are empty
- **AND** `DEMO_PG_PASSWORD`, `DEMO_JWT_SECRET`, `DEMO_FERNET_KEY`, `DEMO_BIM_TOKEN` and `DEMO_SEED_PASSWORD` are newly generated (`generate: true`), not copied from any stored environment

#### Scenario: Formats of the generated secrets
- **GIVEN** `--seed-rng 7` for PR 42 and for PR 57
- **WHEN** the planner plans `request` for each
- **THEN** `DEMO_PG_PASSWORD` uses only letters, digits, `-`, `_` and `.`, `DEMO_FERNET_KEY` is a valid Fernet key, `DEMO_BIM_TOKEN` has 32–127 printable ASCII characters without spaces and `DEMO_SEED_PASSWORD` has at least 10 characters
- **AND** every secret of PR 42 differs from PR 57's, and a second plan of PR 42 with the same seed repeats PR 42's values

#### Scenario: Refresh and reopen keep the secrets
- **GIVEN** the record of PR 42 on 18101 at head `3f2a…`, stopped
- **WHEN** the planner plans `refresh` to head `9c1d…`, and `open`
- **THEN** each plan has the same non-secret environment as the first start
- **AND** each of the five secrets is `keep: true` and none is `generate: true`

Evidence: `lab/tests/test_previews.py::test_untracked_compose_is_refused`; `lab/tests/test_previews.py::test_first_request_plans_a_synthetic_environment`; `lab/tests/test_previews.py::test_generated_secrets_follow_the_demo_formats`; `lab/tests/test_previews.py::test_refresh_and_reopen_keep_the_environment_and_secrets`

### Requirement: Refresh on a new head
WHEN a preview is requested or refreshed while it holds a different head SHA than the PR, THE preview manager SHALL rebuild it at the PR's current head, keeping port, project, volumes and secrets; IF G12 or `lab_screenshot` targets a preview whose head SHA differs from the PR's current head, THEN it SHALL refuse with `preview_head_stale` and record no activity.

`req~lab-deployment-preview-refresh~1`

#### Scenario: New commit then request
- **GIVEN** the `ready` record of PR 42 at head `3f2a…` on port 18101
- **WHEN** PR 42 moves to head `9c1d…` and the planner plans `request`
- **THEN** the plan is a refresh of project `openbinding-pr-42` on port 18101 with the same volumes and the command `["lab_compose", "up", "--project", "openbinding-pr-42", "--build"]`

#### Scenario: Same head already running
- **GIVEN** the `ready` record of PR 42 at head `3f2a…`, which is also the PR's head
- **WHEN** the planner plans `request` for PR 42
- **THEN** the plan has no commands and the record differs only in `last_active_at` and `last_activity: "request"`

#### Scenario: Failed build keeps the old head
- **GIVEN** the `ready` record of PR 42 at head `3f2a…`
- **WHEN** the planner plans `refresh` to head `9c1d…`
- **THEN** the planned record keeps `head_sha` `3f2a…` and has `pending_head_sha` `9c1d…`, which the manager moves to `head_sha` only after `up` exits 0

#### Scenario: G12 on a stale head
- **GIVEN** the record of PR 42 at head `3f2a…` while the PR's head is `9c1d…`
- **WHEN** the planner plans `activity --kind g12`, and again `--kind screenshot`
- **THEN** the plan has `refusal: "preview_head_stale"`, `record: null` and `commands: []`

Evidence: `lab/tests/test_previews.py::test_new_head_refreshes_in_place`; `lab/tests/test_previews.py::test_same_running_head_only_records_activity`; `lab/tests/test_previews.py::test_refresh_keeps_head_until_the_build_succeeds`; `lab/tests/test_previews.py::test_g12_on_a_stale_head_is_refused`; F2: failed refresh keeps old head

### Requirement: Preview expiry after 7 idle days
WHEN 168 hours or more have passed since a PR preview's last recorded activity (a request or start, a refresh, an open, a G12 or a screenshot run), THE preview manager SHALL expire it through `labctl destroy`, except while it is `requested`, `starting`, `seeding`, `destroying` or `destroyed`.

`req~lab-deployment-preview-idle-expiry~1`

#### Scenario: Idle for exactly seven days
- **GIVEN** the `ready` record of PR 42 on 18101, last active at 2026-11-01T10:00:00Z
- **WHEN** the planner plans `expire` at 2026-11-08T10:00:00Z
- **THEN** its only command is `["labctl", "destroy", "preview", "42"]`

#### Scenario: One minute short
- **GIVEN** the same record
- **WHEN** the planner plans `expire` at 2026-11-08T09:59:00Z
- **THEN** it has no command for PR 42

#### Scenario: Transient and destroyed records are skipped
- **GIVEN** records in `requested`, `starting`, `seeding`, `destroying` and `destroyed`, each last active 200 hours before `now`
- **WHEN** the planner plans `expire`
- **THEN** it has no command for any of them

#### Scenario: Stopped and failed previews age
- **GIVEN** a `stopped` and a `failed` record, each last active 168 hours before `now`
- **WHEN** the planner plans `expire`
- **THEN** it plans `labctl destroy preview` for both

#### Scenario: Health checks are not activity
- **GIVEN** the record of PR 42
- **WHEN** the planner is asked to plan `activity --kind health`, and `--kind list`
- **THEN** it exits with the usage-error code 64 and prints no record

#### Scenario: Activity resets the clock
- **GIVEN** the record of PR 42 at the PR's head, last active at 2026-11-01T10:00:00Z
- **WHEN** the planner plans `activity --kind g12` at 2026-11-07T10:00:00Z and then `expire` at 2026-11-09T10:00:00Z
- **THEN** the expiry plan has no command for PR 42

Evidence: `lab/tests/test_previews.py::test_expiry_at_exactly_168_idle_hours`; `lab/tests/test_previews.py::test_kept_at_167_hours_59_minutes`; `lab/tests/test_previews.py::test_stopped_and_failed_previews_age`; `lab/tests/test_previews.py::test_g12_activity_resets_the_clock`

### Requirement: Destroy only through the maintenance operation
THE preview manager SHALL delete a PR preview's volumes and images only through `labctl destroy` (constitution 18.3), without force, removing only the image IDs of its record that no other record outside `destroyed` lists and no tag outside the record resolves to, and only tags that resolve to its own IDs.

`req~lab-deployment-preview-destroy-maintenance~1`

#### Scenario: Refresh, stop and expire delete nothing themselves
- **GIVEN** the `ready` record of PR 42 on 18101 with its volumes and images
- **WHEN** the planner plans `request`, `refresh`, `open`, `stop` and `expire` past 168 idle hours
- **THEN** no argv has an element equal to `-v`, `--volumes`, `--rmi` or `rmi`, nor the consecutive elements `volume rm` or `image rm`
- **AND** the only deleting command is `["labctl", "destroy", "preview", "42"]`, in the `expire` plan

#### Scenario: Image shared with another record
- **GIVEN** records of PR 42 and PR 57 that both list image ID `sha256:aa…`
- **WHEN** the planner plans `destroy-check` for PR 42
- **THEN** no command removes `sha256:aa…`

#### Scenario: Image shared only with a destroyed record
- **GIVEN** the `destroyed` record of PR 42 and the record of PR 57, both listing image ID `sha256:dd…`, which no tag in `--tags` resolves to
- **WHEN** the planner plans `destroy-check` for PR 57
- **THEN** its commands include `["docker", "image", "rm", "sha256:dd…"]`

#### Scenario: Image shared with the develop lab
- **GIVEN** the record of PR 42 listing image ID `sha256:cc…` labelled `openbinding-lab-gateway:18101`, and `--tags` resolving both `openbinding-lab-gateway:18101` and `openbinding-lab-gateway:18100` to `sha256:cc…`
- **WHEN** the planner plans `destroy-check` for PR 42
- **THEN** its commands include `["docker", "image", "rm", "openbinding-lab-gateway:18101"]` and none removes `sha256:cc…`
- **AND** no command contains `-f` or `--force` after `image rm`

#### Scenario: Port reused after a collision
- **GIVEN** the `failed` record of PR 42 with `port: null` and image ID `sha256:a1…` labelled `openbinding-lab-gateway:18101`, and the record of PR 57 on 18101 with image ID `sha256:b2…`, to which `--tags` now resolves that tag
- **WHEN** the planner plans `destroy-check` for PR 42
- **THEN** its commands include `["docker", "image", "rm", "sha256:a1…"]` and none removes the tag `openbinding-lab-gateway:18101` or `sha256:b2…`

Evidence: `lab/tests/test_previews.py::test_only_labctl_destroy_deletes`; `lab/tests/test_previews.py::test_stop_keeps_port_volumes_and_images_and_runs_down_without_volumes`; `lab/tests/test_previews.py::test_destroy_check_destroys_the_project_and_marks_the_record`; `lab/tests/test_previews.py::test_destroy_keeps_an_image_another_record_references`

### Requirement: Cap on running previews
IF starting a PR preview (a request, refresh or open that moves it from absent, stopped or failed to running) would raise the summed `mem_limit` of running lab stacks above the 9216 MiB lab cap, THEN THE preview manager SHALL refuse it with `preview_capacity_reached` and stop nothing.

`req~lab-deployment-preview-running-cap~1`

#### Scenario: Develop lab and one preview running
- **GIVEN** running `openbinding-lab` (4032 MiB) and `openbinding-pr-42` (4032 MiB), and PR 57 at a head of 4032 MiB
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan has `refusal: "preview_capacity_reached"`, no commands and no `down` of PR 42

#### Scenario: Exactly at the cap
- **GIVEN** running stacks of 5184 MiB in total and PR 57 at a head of 4032 MiB
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan is allowed (9216 MiB), and with running stacks of 5185 MiB it is refused (9217 MiB)

#### Scenario: Well under the cap
- **GIVEN** only `openbinding-lab` running (4032 MiB) and PR 57 at a head of 4032 MiB
- **WHEN** the planner plans `request` for PR 57
- **THEN** the plan is allowed

#### Scenario: Stopped previews and the develop lab stopped
- **GIVEN** a `stopped` record of PR 42 with 4032 MiB and no running stack
- **WHEN** the planner plans `request` for PR 57, then, with PR 57 running, `request` for PR 60
- **THEN** both plans are allowed (4032 MiB, then 8064 MiB)

#### Scenario: Refresh of a stopped or failed preview
- **GIVEN** the `stopped` record of PR 42 on 18101, and again a `failed` record of PR 42 with `port: null`, with running stacks of 8064 MiB
- **WHEN** the planner plans `refresh` for PR 42 to a new head
- **THEN** each plan has `refusal: "preview_capacity_reached"` and no commands

#### Scenario: Refresh of a running preview
- **GIVEN** the `ready` record of PR 42 on 18101 at head `3f2a…`, `--running` listing `openbinding-lab` (4032 MiB) and `openbinding-pr-42` (4032 MiB), and `--head-mem-mib 4032`
- **WHEN** PR 42 moves to head `9c1d…` and the planner plans `request`
- **THEN** the plan has `refusal: null` and the command `["lab_compose", "up", "--project", "openbinding-pr-42", "--build"]`

Evidence: `lab/tests/test_previews.py::test_start_refused_above_the_lab_cap`; `lab/tests/test_previews.py::test_cap_boundary_9216_allowed_9217_refused`; `lab/tests/test_previews.py::test_stopped_previews_do_not_count`; `lab/tests/test_previews.py::test_refresh_of_a_running_preview_skips_admission`

### Requirement: Refusal when preview ports are exhausted
IF no port in 18101–18199 is free, each being held by a PR preview record or listened on by another process, THEN THE preview manager SHALL refuse a new preview with `preview_ports_exhausted`, write no record and evict none.

`req~lab-deployment-preview-ports-exhausted~1`

#### Scenario: Hundredth preview
- **GIVEN** 99 records holding 18101–18199
- **WHEN** the planner plans `request` for PR 300
- **THEN** the plan has `refusal: "preview_ports_exhausted"`, `record: null` and `commands: []`

#### Scenario: Last port taken by another process
- **GIVEN** 98 records holding 18101–18198 and port 18199 listened on by another process
- **WHEN** the planner plans `request` for PR 300
- **THEN** the plan has `refusal: "preview_ports_exhausted"` and `record: null`

#### Scenario: First failing check wins
- **GIVEN** closed PR 300 with no record, `--tracked` without `compose.lab-process.json`, 99 records holding 18101–18199, running stacks of 8064 MiB and `--head-mem-mib 4032`
- **WHEN** the planner plans `request` for PR 300, then again with the PR open, then also with the file tracked, then also with the record of 18199 removed
- **THEN** the refusals are `preview_pr_not_eligible`, `preview_untracked_compose`, `preview_ports_exhausted` and `preview_capacity_reached`, in that order

Evidence: `lab/tests/test_previews.py::test_refusal_when_99_ports_are_held`; `lab/tests/test_previews.py::test_refusal_when_98_are_held_and_one_is_listened_on`; `lab/tests/test_previews.py::test_first_failing_check_wins_in_order`
