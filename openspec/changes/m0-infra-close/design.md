# Design: m0-infra-close

## 1. Context

`m09-compose-only` made Docker Compose the only deployment tool and added the production definition
`deploy/compose/production/`. Its tasks.md (lines 109-140) leaves follow-ups F1 to F9 open. `m05-pr-previews` leaves
tasks 4.2 and 4.3 open. This change collects the infra tail of M0 in five slices (tasks.md). Only S0 (this
specification) and S1 are built now. S2, S3 and S4 wait for a decision each.

### 1.1 What CI renders today

- Job `test`, step "Validate Docker Compose configuration" (`.github/workflows/ci.yml:424-425`), runs
  `docker compose config` (without `--quiet`) on `docker-compose.yml`. The job sets `COMPOSE_PROFILES: dev,federated-example`
  (`ci.yml:393`), and the step "Prepare environment" before it copies `.env.example` to `.env` and appends a generated
  `GATEWAY_JWT_SECRET`. The `prod` service needs that value, because `docker compose config` interpolates the whole
  file, profiles that are not selected included (`ci.yml:404-411`). Job `test` runs only when the change detection
  reports the gateway area (`ci.yml:388-389`, `if: needs.changes.outputs.gateway == 'true'`), so a pull request that
  touches only a Compose file of another area renders nothing.
- Job `lab` runs `pytest lab/tests` with `OPENBINDING_COMPOSE_CONFIG=1` (`ci.yml:214-217`). So
  `lab/tests/test_lab_compose_config.py` renders two lab files with `docker compose ... --profile seed config --format json`:
  `compose.lab.json` and `compose.lab-process.json` (`COMPOSE_FILES`, line 15). It sets a dummy value for every
  referenced variable (`DUMMY_ENV`).
- The other seven lab files are not rendered in CI: `compose.lab-engines.json`, `compose.lab-engines-java.json`,
  `compose.lab-pricing.json`, `compose.lab-pgreset.json`, `compose.lab-process-n2.json`,
  `compose.lab-process-n1-probe.json` and `compose.lab-process-n2-probe.json`. The static rules of `lab/tests/` read them
  as JSON but do not run Compose on them.
- `deploy/compose/production/compose.yaml` is not rendered in CI at all. `m09-compose-only` S3 lists the render as a
  check that is run by hand (`m09-compose-only/tasks.md:79`).

So the M0.9 acceptance "`docker compose config` passes in CI for development, lab and production" is met for
development only, and for two lab files only as a side effect of a unit test.

### 1.2 Where nginx resolves the gateway today

`nginx/production/nginx.conf` uses the literal `proxy_pass http://gateway:8000/` for `/api/` (line 40) and
`http://gateway:8000` for `/static/` and `/avatars/` (lines 63, 76). With a literal host name, nginx resolves it once,
when it loads the configuration, and keeps that address. `docs/runbooks/production.md:48-51` and its section "502 after a gateway restart" (`:410-426`) describe the
outcome: after the Docker daemon restarts the gateway, the public origin answers 502 while `$DC ps` shows every service
healthy, until `$DC restart nginx`. The same file is the configuration of the production image
(`nginx/production/Dockerfile`, `FROM nginx:1.27.3`) and of the `prod` profile of `docker-compose.yml:519-525`.

## 2. Decisions

### D1. Nginx resolves `gateway` at request time

In the `http` context (the file is included from `conf.d`):

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
```

In the `server` block that proxies, the upstream goes into a variable, and each `proxy_pass` uses it:

```nginx
set $gateway_upstream gateway:8000;
...
proxy_pass http://$gateway_upstream$gateway_api_uri;   # /api/ (D2)
proxy_pass http://$gateway_upstream;                   # /static/ and /avatars/
```

- `127.0.0.11` is the embedded DNS server of Docker on user-defined networks. Every Compose network is one, the
  production network and the default network of the `prod` profile included.
- When `proxy_pass` contains a variable, nginx resolves the name through `resolver` when a request needs it, and
  caches the answer.
- `valid=10s` caps that cache at 10 s, whatever TTL the answer carries. After the gateway gets a new address, requests
  reach it again within 10 s, with no restart of nginx.
- `ipv6=off`: the Compose networks of this repository have no IPv6, so nginx does not ask for AAAA records.

The `restart: true` of `nginx` on `gateway` stays. `req~lab-deployment-production-health-restart~1` requires it, and
it still covers the recreations that Compose makes itself. Only the comment that explains it changes
(`deploy/compose/production/compose.yaml:353`).

Options considered:
- `upstream gateway_upstream { zone ...; server gateway:8000 resolve; }`. Open-source nginx supports `resolve` since
  1.27.3 (nginx CHANGES, 26 Nov 2024), together with a `zone` and a `resolver`. It is rejected: it keeps the
  prefix-replacing `proxy_pass .../` of `/api/`, which passes the normalized URI (D2), and it ties the configuration
  to the exact image version pinned today.
- Leave it as it is, with the runbook restart. Rejected: it is the accepted finding R2-REV-002 that this change closes.

### D2. The raw request URI reaches the gateway, without the `/api` prefix

With a variable in `proxy_pass`, nginx no longer replaces the matched location prefix. A URI in a `proxy_pass` with
variables replaces the whole request URI. So the prefix is stripped from `$request_uri`, which holds the URI as the
client sent it, query string included, still encoded:

```nginx
map $request_uri $gateway_api_uri {
    ~^/api(/.*)$  $1;
    default       "";
}
```

and, in `location ^~ /api/`:

```nginx
if ($gateway_api_uri = "") { return 400; }
```

- `/api/v1/jobs?limit=5` reaches the gateway as `/v1/jobs?limit=5`, and `/api/v1/x%2Fy` as `/v1/x%2Fy`.
- `rewrite ^/api/(.*)$ /$1 break;` is rejected. `rewrite` matches the normalized URI, which nginx has already decoded,
  so `%2F` becomes `/` and the gateway would route a different path than the client sent. The prefix-replacing
  `proxy_pass http://gateway:8000/` of today passes the normalized URI as well, according to the nginx documentation
  of `proxy_pass`. So D2 also stops that decoding on `/api/`.
- The `400` covers the requests that match `location ^~ /api/` only after normalization, for example `/%61pi/x`, so
  their raw form does not start with `/api/`. Nginx refuses them instead of passing an empty URI.
- `/static/` and `/avatars/` keep a `proxy_pass` without a URI. Then nginx passes the request URI in the form the
  client sent it, as it does today.
- `location = /api` (the `308` to `/api/`) does not change.

### D3. F5: the Kubernetes notes of `bim-toolchain/docs/SERVICE.md` go

ADR-0021 and `req~lab-deployment-compose-only~1` make Docker Compose the only deployment tool, and INTENT §8 lists
"Kubernetes or any orchestrator other than Docker Compose" as a non-goal. `SERVICE.md` still gives Kubernetes advice:

- line 742 calls the token mount "a Docker or Kubernetes secret". It becomes "a Docker Compose secret";
- lines 751-755, the paragraph "Kubernetes notes", go. Two parts do not depend on Kubernetes and stay, reworded for
  Compose: use `/healthz` for the container health check and `/readyz` for readiness, and a failing start exits
  non-zero; put the service behind TLS and reach it only from the services that call it, because the token is a
  defence in depth, not the perimeter. The sentence on `BIM_SERVICE_PORT` and `BIM_SERVICE_SERVICE_HOST`, the
  variables that Kubernetes injects, goes. The behaviour it explains, ignoring unknown `BIM_SERVICE_*` variables, is
  not changed by this change.

`bim-toolchain/` is being extracted to `isa-group/bim-toolchain` (`AGENTS.md:26`). The same edit has to reach that
repository too (§4, R4).

### D4. The README pointer

`README.md:122-126` already points to `docs/runbooks/production.md`. S1 adds one sentence after it. The sentence
names the runbook section "What stays blocked" (`docs/runbooks/production.md:747`) as the list of open production
items. After S1 removes its F9 bullet, that list holds: the image registry and publish workflow (CRP-4), non-root
users and dropped capabilities (F7, S2), the CI compose-config job (S3), the first render on a host with Docker, and
the host facts (Q3). The README stays short, and the runbook stays the one place where these items are described.

### D5. One requirement, and none for F9 or F5

The delta adds only `req~lab-deployment-compose-config-in-ci~1`, as `m09-compose-only` planned
(`m09-compose-only/design.md` §8). F9 fixes a known defect of the production proxy, F5 removes stale documentation, and
the README pointer is documentation. None of them adds an obligation that is not already in the living spec or the
deltas of `m09-compose-only`.

- S1 still writes a static test first, `openbinding-gateway/tests/test_production_nginx.py`. It checks that every
  `proxy_pass` of `nginx/production/nginx.conf` goes through `$gateway_upstream`, that the `resolver` line is present,
  that the `map` reads `$request_uri`, and that no `rewrite` touches `/api/`. Its tests carry no `[utest->…]` tag,
  because no requirement covers them.
- A later change can add a requirement for request-time resolution if the owner wants it traced.

### D6. The CI job (S3, planned, not built)

The job `compose-config` of `.github/workflows/ci.yml` follows `m09-compose-only/design.md` §8:

- `timeout-minutes: 10`, and checkout with `persist-credentials: false`. It adds no new action
  (`lab/tests/test_ci_gate_tooling.py`).
- It is not gated by the change detection of job `changes`, so it runs on every pull request and push. It is added to
  the `needs` of `ci-required`.
- Development: the same `.env` preparation as job `test`, then `docker compose --profile dev config --quiet`.
- Production: `docker compose -f deploy/compose/production/compose.yaml --env-file deploy/compose/production/images.env --env-file deploy/compose/production/ci.env config --quiet`.
- Lab: a shell loop over `compose.lab*.json` at the repository root, so a new lab file is covered without editing the
  job. Each file is rendered with `docker compose -f <file> config --quiet`, with a dummy value for every referenced
  variable, like `DUMMY_ENV` of `lab/tests/test_lab_compose_config.py`. The loop renders every file and fails at the
  end if any render failed, so the log names every broken file.
- The step "Validate Docker Compose configuration" of job `test` stays. It checks the exact `.env` that job uses
  before `docker compose up`.
- `lab/tests/test_ci_compose_config.py` reads `ci.yml` and checks the three renders, `--quiet`, the env files, the glob
  and the `needs` entry. It also checks a mutated copy for each of them, tagged
  `[utest->req~lab-deployment-compose-config-in-ci~1]`. The job itself carries
  `# [impl->req~lab-deployment-compose-config-in-ci~1]`.

Pushing a workflow change needs a token with Workflows: write (CRP-M09-3), so the requirement's `Evidence:` points at
files that do not exist yet. They are marked as planned in the spec and in tasks.md.

## 3. What is verified where

Workers have no Docker. Only static checks run in a worker's `qa_run`.

| Item | Worker (static, `qa_run`) | Lab (coordinator, with Docker) |
|---|---|---|
| F9 nginx | `test_production_nginx.py`; `test_compose_production.py`, with its runbook assertions changed as tasks.md S1 lists | the procedure below |
| F5 SERVICE.md | `git diff --check` | none |
| README pointer | `git diff --check` | none |
| S3 CI job | `test_ci_compose_config.py` | the CI run of the pull request |

F9 in the lab, run by the coordinator on the S1 head:

1. Build the image: `docker build -t m0ic-nginx nginx/production`.
2. `docker run --rm m0ic-nginx nginx -t` passes, with a self-signed certificate mounted at `/etc/nginx/ssl`.
3. On a throwaway network, start a stand-in gateway with the alias `gateway` that logs the request line, for example
   `python -m http.server 8000`, and start the image next to it.
4. `curl -sk --resolve openbinding.score.us.es:<port>:127.0.0.1 "https://openbinding.score.us.es:<port>/api/v1/x%2Fy?a=1"`.
   The stand-in logs `GET /v1/x%2Fy?a=1`.
5. `curl` of `/%61pi/x` answers 400, and `curl` of `/api/v1/jobs?limit=5` reaches the stand-in as
   `GET /v1/jobs?limit=5`. `curl --path-as-is` of `/api//v1/jobs` and of `/api/v1/x/../jobs` reaches the stand-in as
   `//v1/jobs` and `/v1/x/../jobs`, and the MRP records the gateway's answer to both (R2).
6. Replace the stand-in with a new container with the same alias and a different address, then wait 11 s. The next
   `curl` of `/api/health` reaches the new stand-in, not a 502, without restarting nginx.

Then the `prod` profile of `docker-compose.yml`: `docker compose --profile prod up -d`, then
`docker compose up -d --force-recreate --no-deps gateway`. Within 10 s of the gateway becoming healthy,
`/api/health/ready` answers 200 through nginx, and nginx was not restarted. The two `/api/v1/examples/...` requests
of R2 (§4) answer through nginx with the same status and body as the same requests made to `gateway:8000` from a
container on the same network.

## 4. Risks

- R1. A typo in `resolver` or a missing `resolver` makes every `/api/` request fail with 502 ("no resolver defined").
  Mitigation: the static test checks the line, the lab procedure step 4 runs before merge, and the nginx health check
  (`nginx -t`) catches syntax errors.
- R2. D2 changes the URI that the gateway receives for encoded characters in `/api/` paths: `%2F` now stays encoded.
  It is the URI the client sent, which is what the gateway receives without nginx in development (`gateway-dev:8000`).
  One route takes a path parameter that can hold `/`: `GET /v1/examples/{example_path:path}` (`routes/v1.py:655`). A
  client that relied on nginx decoding `%2F` before that route would see a different match. The same holds for the
  rest of the normalization that nginx does for location matching and no longer passes on: `/api//v1/jobs` now reaches
  the gateway as `//v1/jobs` instead of `/v1/jobs`, and `/api/v1/x/../jobs` as `/v1/x/../jobs`. That route guards
  path traversal itself (`resolve()` and `relative_to` in `services/discovery.py:193-195`), so this changes behaviour
  but opens no path out of `examples/`. Mitigation: the lab
  procedure (§3) also requests `/api/v1/examples/<a file of examples/>` and `/api/v1/examples/<directory>%2F<file>`
  and compares the answers with the same requests made directly to the gateway.
- R3. Up to 10 s of 502 after the gateway changes address, the cache bound of `valid=10s`. Today it lasts until
  someone restarts nginx.
- R4. `bim-toolchain/` is being extracted. If the extraction copies an older `SERVICE.md`, the Kubernetes notes come
  back there. Follow-up: carry the same edit to `isa-group/bim-toolchain`.
- R5. S2, S3 and S4 may never get their decision. Then tasks.md keeps them unchecked and the M0.9 acceptance stays met
  for development only. The archive task records that.

## 5. Rollback

Each slice is one squash commit into `develop`. Reverting it restores the previous files: the literal `proxy_pass` and
the restart instructions of the runbook for S1, the old `SERVICE.md` text for F5. Nothing in S0 or S1 migrates data or
changes an API. If production ever runs an image with the S1 configuration, the rollback is the previous image digest
in `images.env`, as `docs/runbooks/production.md` describes for any release.

## 6. Open questions

- Q1. `m09-compose-only` F1 also listed `compose.pgtest.json` for the CI render. The requirement covers
  `compose.lab*.json` only, as the owner request states. Should S3 render `compose.pgtest.json` too, through a revision
  `~2` of the requirement?
- CRP-M09-2 (S2), CRP-M09-3 (S3) and factory F2 of `m05-pr-previews` (S4): tasks.md.
