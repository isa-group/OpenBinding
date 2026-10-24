## MODIFIED Requirements

### Requirement: Single loopback port in the lab
THE lab profile SHALL publish exactly one host port, from the `web` service, bound to `127.0.0.1` at `${DEMO_LAB_PORT:-18100}`, so the develop lab keeps 18100.

`req~lab-deployment-single-loopback-port~2`

Evidence: GAP `lab/tests/test_lab_compose.py::test_single_published_port_on_loopback` (parameterised form); `lab/tests/test_lab_compose.py::test_no_expose_of_published_ports_on_other_services`

#### Scenario: A debug port added to the gateway
- **GIVEN** a change that publishes `8000:8000` for the gateway in `compose.lab.json`
- **WHEN** the lab static checks run
- **THEN** they fail

#### Scenario: Develop lab without the variable
- **GIVEN** `compose.lab.json` and no `DEMO_LAB_PORT` in the environment
- **WHEN** the published port of `web` is interpolated
- **THEN** it is `127.0.0.1:18100`

## ADDED Requirements

### Requirement: Preview on demand per PR head
THE preview manager SHALL start a PR preview, built from the PR's current head SHA, only on an explicit request that names an open PR.

`req~lab-deployment-preview-on-demand~1`

Evidence: GAP `lab/tests/test_previews.py::test_only_a_request_starts_a_preview`

#### Scenario: Request for an open PR
- **GIVEN** open PR 42 with head `3f2a…` and no preview
- **WHEN** an operator runs `labctl preview request 42`
- **THEN** one stack for PR 42 is built from head `3f2a…`

#### Scenario: Push without a request
- **GIVEN** open PR 42 without a preview
- **WHEN** a new commit is pushed to its branch
- **THEN** no preview is started

### Requirement: Preview port range on loopback
THE preview manager SHALL publish each PR preview on exactly one port of `127.0.0.1` in the range 18101–18199, never on 18100 and never on another interface.

`req~lab-deployment-preview-port-range~1`

Evidence: GAP `lab/tests/test_previews.py::test_ports_are_loopback_in_18101_18199`

#### Scenario: First preview
- **GIVEN** no PR preview exists and the develop lab holds 18100
- **WHEN** a preview for PR 42 is requested
- **THEN** it is published on `127.0.0.1:18101`

#### Scenario: Port 18100 is never allocated
- **GIVEN** every record of the preview state
- **WHEN** the allocated ports are listed
- **THEN** none is 18100 and none is outside 18101–18199

### Requirement: One project and private volumes per preview
THE preview manager SHALL run each PR preview as its own Compose project `openbinding-pr-<number>` whose network and named volumes no other project uses, with no host bind mount.

`req~lab-deployment-preview-isolation~1`

Evidence: GAP `lab/tests/test_previews.py::test_names_derive_from_the_pr_number`; GAP `lab/tests/test_preview_isolation.py`

#### Scenario: Two previews
- **GIVEN** previews for PR 42 and PR 57
- **WHEN** their volumes are listed
- **THEN** PR 42 has only `openbinding-pr-42_*` volumes and PR 57 only `openbinding-pr-57_*`

#### Scenario: Cross-preview access
- **GIVEN** previews for PR 42 and PR 57
- **WHEN** a container of PR 42 resolves `web`, and connects to port 18102 of PR 57 through the host-side gateway address of its own network
- **THEN** `web` is its own preview's, and port 18102 is unreachable

### Requirement: Tracked Compose file and synthetic data only
THE preview manager SHALL start a PR preview only from a tracked lab Compose file at the PR head, with freshly generated synthetic `DEMO_*` values and the synthetic seed, never production data or secrets.

`req~lab-deployment-preview-synthetic-only~1`

Evidence: GAP `lab/tests/test_previews.py::test_environment_is_synthetic_and_fresh`

#### Scenario: Generated Compose file
- **GIVEN** a request whose Compose file is not tracked at the PR head
- **WHEN** the preview manager plans the start
- **THEN** it refuses with `preview_untracked_compose`

#### Scenario: Environment of a preview
- **GIVEN** a preview for PR 42
- **WHEN** its environment is planned
- **THEN** `DEMO_SPACE_ENABLED` is `false`, `SPACE_API_KEY` and `SPHERE_API_KEY` are empty and every secret `DEMO_*` value differs from the develop lab's

### Requirement: Refresh on a new head
WHEN a preview is requested for a PR whose preview runs an older head SHA, THE preview manager SHALL rebuild that preview at the new head, keeping its port, project and volumes.

`req~lab-deployment-preview-refresh~1`

Evidence: GAP `lab/tests/test_previews.py::test_new_head_refreshes_in_place`

#### Scenario: New commit then request
- **GIVEN** the preview of PR 42 at head `3f2a…` on port 18101
- **WHEN** PR 42 moves to head `9c1d…` and a preview is requested
- **THEN** project `openbinding-pr-42` is rebuilt at `9c1d…` on port 18101 with the same volumes

### Requirement: Preview expiry after 7 idle days
WHEN 168 hours pass after a PR preview's last recorded activity (request, refresh, open, G12 or screenshot run), THE preview manager SHALL expire it through `labctl destroy`.

`req~lab-deployment-preview-idle-expiry~1`

Evidence: GAP `lab/tests/test_previews.py::test_expiry_after_168_idle_hours`

#### Scenario: Idle for seven days
- **GIVEN** the preview of PR 42 last active at 2026-11-01T10:00Z
- **WHEN** the expiry sweep runs at 2026-11-08T10:30Z
- **THEN** `labctl destroy` removes it and port 18101 is free

#### Scenario: Health checks are not activity
- **GIVEN** the preview of PR 42 whose only events for 7 days are health checks and `labctl preview list`
- **WHEN** the expiry sweep runs
- **THEN** the preview is expired

#### Scenario: Activity resets the clock
- **GIVEN** the preview of PR 42 last active on day 0
- **WHEN** a G12 run uses it on day 6 and the sweep runs on day 8
- **THEN** the preview is kept

### Requirement: Destroy only through the maintenance operation
THE preview manager SHALL delete a PR preview's volumes and images only through `labctl destroy`, the maintenance operation of constitution 18.3.

`req~lab-deployment-preview-destroy-maintenance~1`

Evidence: GAP `lab/tests/test_previews.py::test_only_labctl_destroy_deletes`

#### Scenario: Refresh and stop delete nothing
- **GIVEN** the preview of PR 42 with its volumes
- **WHEN** it is refreshed or stopped
- **THEN** every `openbinding-pr-42_*` volume still exists

### Requirement: Cap on running previews
IF starting a PR preview would raise the summed `mem_limit` of running lab stacks above the 9216 MiB lab cap, THEN THE preview manager SHALL refuse it with `preview_capacity_reached`.

`req~lab-deployment-preview-running-cap~1`

Evidence: GAP `lab/tests/test_previews.py::test_start_refused_above_the_lab_cap`

#### Scenario: Develop lab and one preview running
- **GIVEN** the develop lab (4032 MiB) and the preview of PR 42 (4032 MiB) running
- **WHEN** a preview for PR 57 is requested
- **THEN** it is refused with `preview_capacity_reached`, nothing starts and PR 42 keeps running

### Requirement: Refusal when preview ports are exhausted
IF all 99 ports 18101–18199 are held by existing PR previews, THEN THE preview manager SHALL refuse a new preview with `preview_ports_exhausted` and evict none.

`req~lab-deployment-preview-ports-exhausted~1`

Evidence: GAP `lab/tests/test_previews.py::test_refusal_when_99_ports_are_held`

#### Scenario: Hundredth preview
- **GIVEN** 99 PR previews holding 18101–18199
- **WHEN** a preview for another PR is requested
- **THEN** it is refused with `preview_ports_exhausted` and the 99 previews are unchanged
