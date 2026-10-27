## MODIFIED Requirements

### Requirement: No local SPACE
`req~lab-deployment-no-local-space~4`
No manifest (`docker-compose.yml`, every `compose.lab*.json` including `compose.lab-pricing.json`, `compose.pgtest.json` and every file under `deploy/`) SHALL define a SPACE or SPHERE service, a `space` network, a `space*` volume, a `space` profile or the retired destructive key, so that SPACE and SPHERE are reached only as remote services configured by environment.

Needs: impl, utest

#### Scenario: Adding a SPACE container
- **GIVEN** a change that adds a `space` service to `docker-compose.yml`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: SPACE back in the pricing profile
- **GIVEN** `compose.lab-pricing.json` plus a `space-api` service, or a service whose image names `space-api`, or a `space-mongo` service
- **WHEN** the unit suite runs
- **THEN** it fails, because the pricing profile is no longer exempt

#### Scenario: SPACE network, volume or profile in any manifest
- **GIVEN** a `space` network, a `space-data` volume or a service with `profiles: ["space"]` in `compose.lab.json`, `compose.lab-pricing.json`, `compose.pgtest.json` or a file under `deploy/`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: A SPHERE service
- **GIVEN** a service named `sphere-api`, or a service whose image is `registry.example/SPHERE-ui:1`, in any manifest
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: The retired destructive key
- **GIVEN** the text of any manifest, `compose.lab-pricing.json` included, that names the retired destructive SPACE key
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: The bootstrap is not a SPACE service
- **GIVEN** `compose.lab-pricing.json` with its only service `pricing-bootstrap`, image `openbinding-lab/pricing-bootstrap:1`
- **WHEN** the unit suite runs
- **THEN** no SPACE service is found and the test passes
- **AND** the same service renamed `space-bootstrap` is reported as a SPACE service

#### Scenario: Remote SPACE by environment
- **GIVEN** `docker-compose.yml`
- **WHEN** the unit suite reads the environment of `gateway` and `worker`
- **THEN** `SPACE_URL` is `${SPACE_URL:-https://space.score.us.es}` and `SPACE_API_KEY` is `${SPACE_API_KEY:-}`

Evidence: `openbinding-gateway/tests/test_no_local_space.py`

Every manifest is checked, with no exemption: `docker-compose.yml`, `compose.lab.json` and every other `compose.lab*.json` profile, `compose.pgtest.json` and `deploy/**`. A SPACE service is one whose name starts with `space` or has a `space` element, or whose image names `space-api`. Revisions 2 and 3 (changes `m41-space-lab-profile` and `m45-lab-pricing-wiring`, never archived) exempted the local SPACE of `compose.lab-pricing.json`; revision 4 removes that exemption and the image rule of `space-api`. The destructive key is named by its parts in the test, never as a literal.

## ADDED Requirements

### Requirement: Remote bootstrap profile
`req~lab-deployment-remote-bootstrap-profile~1`
The file `compose.lab-pricing.json` SHALL define the standalone project `openbinding-lab-pricing` with exactly one service, `pricing-bootstrap`, whose keys are exactly `image` `openbinding-lab/pricing-bootstrap:1`, `build` `{context: lab/tools, dockerfile: Dockerfile}`, `user` `1000:1000`, `restart` `"no"`, `mem_limit` `96m` and `environment` `SPACE_URL=https://space.score.us.es` and `SPACE_API_KEY=${DEMO_SPACE_MANAGEMENT_KEY}`.

Needs: impl, utest

#### Scenario: The manifest
- **GIVEN** `compose.lab-pricing.json`
- **WHEN** the static checks read it
- **THEN** its top-level keys are exactly `name` and `services`, its `name` is `openbinding-lab-pricing` and its only service is `pricing-bootstrap`
- **AND** the service keys are exactly `image`, `build`, `user`, `restart`, `environment` and `mem_limit`, with the values of the statement
- **AND** `build` is a mapping of exactly `context` and `dockerfile`

#### Scenario: Retired services, volumes and keys
- **GIVEN** a copy of the manifest with a `space-api`, `space-mongo` or `space-redis` service, a top-level `volumes` or `networks` section, a `lab-pricing-mongo` volume, a `profiles` key, or on `pricing-bootstrap` a `depends_on`, `ports`, `expose`, `volumes`, `healthcheck`, `command`, `networks`, `network_mode`, `privileged` or `security_opt` key
- **WHEN** the static checks run
- **THEN** they fail

#### Scenario: Unprivileged one-shot
- **GIVEN** `pricing-bootstrap` with user `0:0`, `1000:0`, `1000` (no gid) or `root`, or with `restart` `on-failure` or `unless-stopped`
- **WHEN** the static checks run
- **THEN** they fail, because the user is the numeric non-root `1000:1000` and the one-shot never restarts

#### Scenario: Memory budget
- **GIVEN** the manifest and `docs/qa/PRICING_PROFILE.md`
- **WHEN** the static checks sum the limits
- **THEN** the profile sum is 96 MiB, equal to the runbook line `Memory sum: 96 MiB`, and within the unchanged profile ceiling of 1152 MiB
- **AND** 4032 + 4032 + 96 = 8160 MiB is within the unchanged 9216 MiB lab cap
- **AND** a copy with `mem_limit` `128m` or without `mem_limit`, or a runbook that still documents 1088 MiB, fails

#### Scenario: Secret reference
- **GIVEN** the manifest text
- **WHEN** the static checks scan every `$` in it
- **THEN** the only reference is the bare `${DEMO_SPACE_MANAGEMENT_KEY}`, exactly once, as the value of `SPACE_API_KEY`
- **AND** a copy with `${DEMO_SPACE_MANAGEMENT_KEY:-x}`, `${DEMO_SPACE_MANAGEMENT_KEY:?required}`, the unbraced `$DEMO_SPACE_MANAGEMENT_KEY`, another variable, or a literal value matching the `SECRET_SHAPES` scan fails
- **AND** a copy that still references `DEMO_SPACE_ADMIN_PASSWORD`, `DEMO_SPACE_JWT_SECRET`, `DEMO_SPACE_JWT_SALT` or `DEMO_SPACE_MONGO_PASSWORD` fails

#### Scenario: Remote SPACE over https only
- **GIVEN** a copy of the manifest with `SPACE_URL` set to `http://space.score.us.es`, `http://space-api:3000`, `https://space.example.org` or `${SPACE_URL}`
- **WHEN** the static checks run
- **THEN** they fail, because `SPACE_URL` is exactly `https://space.score.us.es`

#### Scenario: No SPHERE or proxy variable
- **GIVEN** `pricing-bootstrap` with an extra `SPHERE_API_KEY`, `SPHERE_API_URL`, `SPACE_ADMIN_USER`, `SPACE_ADMIN_PASSWORD`, `SPACE_BOOTSTRAP_PLAN`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` or lower-case proxy key
- **WHEN** the static checks run
- **THEN** they fail, because the environment has exactly the two keys of the statement

#### Scenario: Local SPACE image removed
- **GIVEN** the repository
- **WHEN** the static checks run
- **THEN** no file exists under `lab/space/`, and no manifest has a `build` whose context is `lab/space`

#### Scenario: Runbook of the profile
- **GIVEN** `docs/qa/PRICING_PROFILE.md`
- **WHEN** the static checks read it
- **THEN** it names `https://space.score.us.es`, `DEMO_SPACE_MANAGEMENT_KEY` with the supervisor's secret file outside the repository, `openbinding-lab/pricing-bootstrap:1` with `lab/tools`, and `Memory sum: 96 MiB`
- **AND** it names none of `space-api`, `space-mongo`, `space-redis`, `DEMO_SPACE_ADMIN_PASSWORD`, `DEMO_SPACE_JWT_SECRET`, `DEMO_SPACE_JWT_SALT` and `DEMO_SPACE_MONGO_PASSWORD`

#### Scenario: Base lab unchanged
- **GIVEN** `compose.lab.json`
- **WHEN** the static checks run
- **THEN** it has no SPACE service and its memory sum is still 4032 MiB

Evidence: `lab/tests/test_lab_pricing_profile.py`

The profile is optional: it is brought up on its own (`lab_compose up file=compose.lab-pricing.json`, factory follow-up F1), never as an overlay of the lab project. The supervisor injects `DEMO_SPACE_MANAGEMENT_KEY` from a root-only secret file outside the repository; Compose turns an unset variable into an empty value, which the tool refuses before any request (`req~lab-space-remote-bootstrap~1`). The tool image rules of `lab/tools/Dockerfile` (base by digest, pinned requirements, numeric non-root `USER`, the `.dockerignore` of the context) stay tested by `lab/tests/test_space_lab_bootstrap.py` under this requirement.

### Requirement: Remote SPACE bootstrap
`req~lab-space-remote-bootstrap~1`
WHEN `lab/tools/space_lab_bootstrap.py` runs, the tool SHALL, authenticated only by the MANAGEMENT key of `SPACE_API_KEY`, make the remote SPACE of `SPACE_URL` hold the `openbinding` service from the SPHERE permanent link with policy `all_last`, synchronized, and one confirmed contract per synthetic seed user, creating only what is missing.

Needs: impl, utest

#### Scenario: Configuration
- **GIVEN** an environment with `SPACE_API_KEY` set to a non-empty sample value and no other variable
- **WHEN** `Config.from_environ` reads it
- **THEN** it returns a frozen `Config` whose `space_url` is `https://space.score.us.es`, whose `plan` is `FREE`, with `poll_attempts` 60 and `poll_seconds` 5, and whose representation does not contain the key
- **AND** `SPACE_URL=https://space.example.org` and `SPACE_BOOTSTRAP_PLAN=PRO` are taken as given

#### Scenario: Key required
- **GIVEN** an environment without `SPACE_API_KEY`, or with it empty
- **WHEN** the tool runs through `main`
- **THEN** it sends no request, prints `space_lab_bootstrap: configuration: SPACE_API_KEY is required` on standard error and exits with status 1

#### Scenario: https only
- **GIVEN** `SPACE_URL` set to `http://space.score.us.es`, `http://space-api:3000`, `https://user:pw@space.score.us.es`, `https:///api`, `https://space.score.us.es:bad` or `ftp://space.score.us.es`
- **WHEN** `Config.from_environ` reads it
- **THEN** it raises `BootstrapError` stating that `SPACE_URL` must be an https URL with a host and no credentials, and no request is sent

#### Scenario: Service missing on the remote SPACE
- **GIVEN** a simulated SPACE whose `GET /api/v1/services` lists no service named `openbinding`
- **WHEN** the bootstrap runs
- **THEN** every request carries the key in the header `x-api-key`
- **AND** it creates the service with `POST /api/v1/services` and the body `{"source": "sphere", "permanentUrl": "https://sphere.score.us.es/p/6ab0a323697330667ccce891", "policy": "all_last"}`
- **AND** it sends `POST /api/v1/services/openbinding/synchronization/run` before the first poll and polls `GET /api/v1/services/openbinding/synchronization` every 5 s at most 60 times until the status (`configuration.status`, else a top-level `status`) is `ready`

#### Scenario: Contracts for the six synthetic users
- **GIVEN** the service `openbinding` with a `ready` synchronization, active pricing versions `1.0.0`, `1.2.0` and `1.10.0` (list shape, or map shape with `activePricings` and an archived `2.0.0`) and `SPACE_BOOTSTRAP_PLAN` `PRO`
- **WHEN** the bootstrap creates contracts
- **THEN** it creates, through `space-python-client`, one contract on version `1.10.0` with plan `PRO` and no add-on for each of `lab-admin`, `lab-owner`, `lab-orgadmin`, `lab-member`, `lab-viewer` and `lab-outsider`
- **AND** each user id is `uuid5(SEED_NAMESPACE, "user:<username>")` with the namespace of `openbinding-gateway/tools/seed_lab.py`, and each email is `<username>@example.org`
- **AND** each created contract is read back and must show that version and plan, else the bootstrap aborts with `contracts: <username> not confirmed`

#### Scenario: First run report
- **GIVEN** the simulated SPACE of the two scenarios above, without contracts
- **WHEN** the tool runs through `main`
- **THEN** it prints exactly one JSON line `{"contracts": {<username>: "created", ...}, "service": "created", "synchronization": "ready"}`, whose keys are exactly `service`, `synchronization` and `contracts`, and exits with status 0

#### Scenario: Idempotent second run
- **GIVEN** the simulated SPACE after a complete first run
- **WHEN** the bootstrap runs again
- **THEN** it sends no request that creates a service or a contract and no synchronization run request
- **AND** it reports `"service": "exists"`, `"synchronization": "skipped"` and every contract as `exists`
- **AND** given contracts for `lab-admin` and `lab-owner` only, it creates exactly the four missing contracts

#### Scenario: Existing service still synchronizing
- **GIVEN** an existing `openbinding` service with the right source, link and policy whose status is `queued`, `checking` or `applying`
- **WHEN** the bootstrap runs
- **THEN** it polls without a run request and reports `"synchronization": "ready"` once the status is `ready`

#### Scenario: Aborts without modifying
- **GIVEN** an existing `openbinding` service with another `source`, `permanentUrl` or `policy`
- **WHEN** the bootstrap runs
- **THEN** it raises `BootstrapError` naming the service and sends no `POST`, `PUT`, `PATCH` or `DELETE` request

#### Scenario: Other aborts
- **GIVEN** a synchronization status that becomes `failed`, `blocked` or `degraded`, or is not `ready` after 60 polls; a created service whose name is not `openbinding`; no active pricing version; a key refused with status 401 or 403; or a created contract that the read-back does not confirm
- **WHEN** the tool runs through `main`
- **THEN** it raises `BootstrapError` naming the failed item, prints one line on standard error, nothing on standard output, and exits with status 1

#### Scenario: No admin, organization or api-key steps
- **GIVEN** a simulated SPACE that records every request, and the source of the tool
- **WHEN** the bootstrap runs a first and a second time
- **THEN** no request goes to `/api/v1/users/authenticate`, to a route under `/api/v1/organizations` or to a route containing `api-keys`
- **AND** the tool reads neither `SPACE_ADMIN_USER` nor `SPACE_ADMIN_PASSWORD`, and its report has no `organization` or `apiKey` item

Evidence: `lab/tests/test_space_lab_bootstrap.py`

The HTTP routes, the body shapes and the authority of a MANAGEMENT key to create a service are UNVERIFIED against `space.score.us.es`; the first live run confirms them (design.md §6). The tool calls SPACE's HTTP API directly for services, synchronization and pricings under the constitution 16.1 exception of ADR-0022, and uses `space-python-client` for contracts.

### Requirement: Secrets and boundaries of the remote bootstrap
`req~lab-space-remote-bootstrap-secrets~1`
The bootstrap tool SHALL use the MANAGEMENT key only in memory and in the `x-api-key` header of requests to the host of `SPACE_URL`, never in output, logs, errors or files, while it holds no SPHERE key, follows no redirect and reads no proxy variable.

Needs: impl, utest

#### Scenario: Key neither printed nor persisted
- **GIVEN** `SPACE_API_KEY` set to a sample value, in a successful run and in a run that fails at the service step with an error body that echoes the key
- **WHEN** the bootstrap runs, directly and through `main`
- **THEN** standard output, standard error, the captured logs, the exception texts and their causes and contexts, and the working directory contain no occurrence of the key
- **AND** an unexpected error, or one raised by the contracts client, is reported by its exception type only

#### Scenario: Requests only to the host of SPACE_URL
- **GIVEN** a simulated run that records every request, with `SPACE_URL=https://space.score.us.es`
- **WHEN** the bootstrap runs
- **THEN** every request uses the scheme `https` and the host `space.score.us.es`, and none carries a SPHERE header

#### Scenario: No redirect followed
- **GIVEN** a simulated SPACE that answers `GET /api/v1/services` with status 302 and `Location: https://other.example/api/v1/services`
- **WHEN** the bootstrap runs
- **THEN** no request reaches `other.example` and the bootstrap aborts with `BootstrapError` naming status 302

#### Scenario: No proxy read
- **GIVEN** the process environment with `HTTPS_PROXY=http://proxy.example:3128` and `ALL_PROXY=http://proxy.example:3128`
- **WHEN** the bootstrap runs against the simulated SPACE
- **THEN** no request goes through `proxy.example`, and the HTTP client of the tool is built with `trust_env=False` and `follow_redirects=False`

#### Scenario: No SPHERE key
- **GIVEN** the source of the tool and a run with `SPHERE_API_KEY` set in the environment
- **WHEN** the static checks and the run inspect it
- **THEN** the tool reads no `SPHERE_*` variable, never names `SPHERE_API_KEY`, sends no request to `sphere.score.us.es`, and imports only the standard library, `httpx` and `space_client`

#### Scenario: Only direct caller under lab/tools
- **GIVEN** the repository sources
- **WHEN** the architecture test scans them
- **THEN** `lab/tools/space_lab_bootstrap.py` is the only direct caller of SPACE's HTTP API under `lab/tools`, and the exception is the one recorded in `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md`

Evidence: `lab/tests/test_space_lab_bootstrap.py`; `lab/tests/test_no_direct_space_http.py`

The key is never in the repository, the image or the browser: the manifest holds only the bare reference (`req~lab-deployment-remote-bootstrap-profile~1`), `lab/tools/Dockerfile` has no `ARG` or `ENV` with a secret, and the tool has no browser surface (constitution 16.5). That `space-python-client` 1.0.0 follows no off-host redirect and reads no proxy variable is UNVERIFIED (design.md §6).

### Requirement: Production runbook on the remote SPACE
`req~lab-deployment-runbook-remote-space~1`
The production runbook `docs/runbooks/production.md` SHALL document, in a section `## Remote SPACE`, that production reaches the remote SPACE `https://space.score.us.es` only through `SPACE_URL` and the `space_api_key` secret file and runs no local SPACE, with no section titled `Local SPACE` left in the runbook.

Needs: impl, utest

#### Scenario: The Remote SPACE section
- **GIVEN** `docs/runbooks/production.md`
- **WHEN** the unit suite reads its `## Remote SPACE` section
- **THEN** the section names `https://space.score.us.es`, `SPACE_URL`, `space_api_key` and `test_no_local_space.py`, and states that production runs no local SPACE
- **AND** the production `compose.yaml` has no service, network or volume whose name contains `space` or `sphere`

#### Scenario: The old section is gone
- **GIVEN** a runbook that still has `## Local SPACE (owner decision local-space)`, or a link to `#local-space-owner-decision-local-space`
- **WHEN** the unit suite runs
- **THEN** it fails

#### Scenario: Nothing blocked on a local SPACE
- **GIVEN** the `What stays blocked` section of the runbook
- **WHEN** the unit suite reads it
- **THEN** it has no item that waits for a local or production SPACE, and it does not name `space-api`, `space-mongo` or `space-redis`

#### Scenario: site.env example
- **GIVEN** the `site.env` example of the runbook
- **WHEN** the unit suite reads it
- **THEN** it sets `SPACE_URL=https://space.score.us.es`

#### Scenario: Remote SPACE section incomplete
- **GIVEN** a `## Remote SPACE` section that does not name `space_api_key`, or names `http://space.score.us.es`
- **WHEN** the unit suite runs
- **THEN** it fails

Evidence: `openbinding-gateway/tests/test_compose_production.py`

This replaces the test `test_runbook_local_space_decision_is_recorded_and_compose_has_no_space_service`, tagged `req~lab-deployment-production-runbook~1` (change `m09-compose-only`); that requirement itself is unchanged.
