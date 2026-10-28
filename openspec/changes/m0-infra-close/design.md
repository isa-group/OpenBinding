# Design: m0-infra-close

## 1. Context

`m09-compose-only` made Docker Compose the only deployment tool and added the production definition
`deploy/compose/production/`. Its tasks.md (lines 109-140) leaves follow-ups F1 to F9 open. `m05-pr-previews` leaves
tasks 4.2 and 4.3 open. This change collects the infra tail of M0 in six slices (tasks.md). S0 (this
specification), S1 and S1b are built, and the R1 fix round of the review panel (tasks.md R1) follows them. S2, S3 and
S4 wait for a decision each.

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

### 1.2 Where nginx resolved the gateway before S1

`nginx/production/nginx.conf` used the literal `proxy_pass http://gateway:8000/` for `/api/` (line 40) and
`http://gateway:8000` for `/static/` and `/avatars/` (lines 63, 76). With a literal host name, nginx resolves it once,
when it loads the configuration, and keeps that address. `docs/runbooks/production.md:48-51` and its section "502 after a gateway restart" (`:410-426`) describe the
outcome: after the Docker daemon restarts the gateway, the public origin answers 502 while `$DC ps` shows every service
healthy, until `$DC restart nginx`. The same file is the configuration of the production image
(`nginx/production/Dockerfile`, `FROM nginx:1.27.3`) and of the `prod` profile of `docker-compose.yml:519-525`.

## 2. Decisions

### D1. Nginx resolves `gateway` at request time

In the `server` block of `openbinding.score.us.es`, the one that proxies, the resolver is set and the upstream,
scheme included, goes into a variable at server level. Each `proxy_pass` uses it:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
resolver_timeout 5s;
set $gateway_upstream http://gateway:8000;
...
proxy_pass $gateway_upstream$gateway_api_uri;   # /api/ (D2)
proxy_pass $gateway_upstream;                   # /static/ and /avatars/
```

- `127.0.0.11` is the embedded DNS server of Docker on user-defined networks. Every Compose network is one, the
  production network and the default network of the `prod` profile included.
- When `proxy_pass` contains a variable, nginx resolves the name through `resolver` when a request needs it, and
  caches the answer.
- `valid=10s` caps that cache at 10 s, whatever TTL the answer carries. After the gateway gets a new address, requests
  reach it again within 10 s, with no restart of nginx.
- `ipv6=off`: the Compose networks of this repository have no IPv6, so nginx does not ask for AAAA records.
- `resolver_timeout 5s` (added in the R1 fix round; the nginx default is 30 s): a request waits at most 5 s for the
  DNS answer, then nginx answers 502. A gateway name that does not resolve fails fast instead of holding the client.
- The behaviour is `req~lab-deployment-production-proxy-upstream~1` (D5).

The `restart: true` of `nginx` on `gateway` stays. `req~lab-deployment-production-health-restart~1` requires it, and
it still covers the recreations that Compose makes itself. Only the comment that explains it changes
(`deploy/compose/production/compose.yaml:353-356`, slice S1b). Each recreation of the gateway by Compose therefore
still restarts nginx, and with it the whole public origin; §6 Q2 asks whether a later revision drops it.

The runbook (S1b) says that nginx follows the gateway address at request time, within the `valid=10s` cache. Its
`$DC restart nginx` steps after a recreation of the gateway stay as a precaution. A restart of nginx interrupts the
synchronous solves that are running (up to 1860 s, `proxy_read_timeout`) and can hide a resolver fault, so the runbook
checks the gateway and nginx logs first (R1-SEC-003). A restart applies new certificates only: `nginx.conf` is built
into the image (`nginx/production/Dockerfile`), so a changed `nginx.conf` needs a new `NGINX_IMAGE` in `images.env`
and `$DC up -d` (R1-REV-002).

Options considered:
- `upstream gateway_upstream { zone ...; server gateway:8000 resolve; }`. Open-source nginx supports `resolve` since
  1.27.3 (nginx CHANGES, 26 Nov 2024), together with a `zone` and a `resolver`. It is compatible with the D2 map
  (`proxy_pass http://gateway_upstream$gateway_api_uri;` passes the raw URI as well), and it would also bring
  keepalive connections, retries on the next server and re-resolution in the background instead of on the request
  path. It is rejected because it needs nginx 1.27.3 or newer in the image: the pinned image is exactly that first
  release, so the configuration could never go back to an older image. The deciding reason is that the variable form
  covers the need at the traffic level of this origin: one gateway container, and at most one DNS query per nginx worker process every 10 s.
- Leave it as it is, with the runbook restart. Rejected: it is the accepted finding R2-REV-002 that this change closes.

### D2. The raw request URI reaches the gateway, without the `/api` prefix

With a variable in `proxy_pass`, nginx no longer replaces the matched location prefix. A URI in a `proxy_pass` with
variables replaces the whole request URI. So the prefix is stripped from `$request_uri`, which holds the URI as the
client sent it, query string included, still encoded:

```nginx
map $request_uri $gateway_api_uri {
    default         "";
    ~^/api(/.*)$    $1;
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
  client sent it, as before S1.
- `location = /api` (the `308` to `/api/`) does not change.

### D3. F5: the Kubernetes notes of `bim-toolchain/docs/SERVICE.md` go

ADR-0021 and `req~lab-deployment-compose-only~1` make Docker Compose the only deployment tool, and INTENT §8 lists
"Kubernetes or any orchestrator other than Docker Compose" as a non-goal. `SERVICE.md` still gives Kubernetes advice:

- line 742 called the token mount "a Docker or Kubernetes secret". It is now "a Docker or Compose secret, or any
  mounted file";
- lines 751-755, the paragraph "Kubernetes notes", become "Operation notes", with no orchestrator named: `/healthz`
  for liveness and `/readyz` for readiness, and a failing start exits non-zero; container platforms may inject
  service-link variables such as `BIM_SERVICE_PORT`, which is why unknown `BIM_SERVICE_*` variables are ignored; put
  the service behind TLS and restrict network access to the callers, because the token is a defence in depth, not the
  perimeter. The behaviour of the service does not change.

`bim-toolchain/` is being extracted to `isa-group/bim-toolchain` (`AGENTS.md:26`). The same edit has to reach that
repository too (§4, R4).

### D4. The README pointer

`README.md:122-126` already points to `docs/runbooks/production.md`. S1 adds one sentence after it: the project
deploys with Docker Compose only, and the standalone bim-service container is described in
`bim-toolchain/docs/SERVICE.md` (linked). The README stays short, and the runbook stays the one place where the open
production items are described.

### D5. Two requirements: one for the CI render, one for the proxy behaviour of F9, none for F5

The delta adds two requirements:

- `req~lab-deployment-compose-config-in-ci~1`, as `m09-compose-only` planned (`m09-compose-only/design.md` §8).
- `req~lab-deployment-production-proxy-upstream~1` (added in the R1 fix round, finding R1-ARC-001). F9 is more than
  a defect fix: D1 (resolution at request time, cache of at most 10 s, resolver timeout of 5 s, 502 when the name does
  not resolve) and D2 (the raw URI minus `/api`, 400 when the raw URI does not start with `/api/`, the raw URI for
  `/static/` and `/avatars/`) change what the public origin passes to the gateway. Constitution 1.1 asks for a
  requirement for every behaviour change, so the proxy behaviour is specified and traced.

F5 removes stale documentation and the README pointer is documentation, so neither adds a requirement.

- `nginx/production/nginx.conf` carries `# [impl->req~lab-deployment-production-proxy-upstream~1]`.
- S1b adds a static test, `openbinding-gateway/tests/test_production_nginx.py`, tagged
  `[utest->req~lab-deployment-production-proxy-upstream~1]`. It pins the `resolver` line, the
  `resolver_timeout 5s;` line (R1 fix round, with an in-memory copy without it that fails), that every `proxy_pass` of `nginx/production/nginx.conf` goes through `$gateway_upstream`, that there is no
  `rewrite`, and the `/api` `map` on `$request_uri`. It comes after the S1 code, so the cases that break each rule on
  an in-memory copy are its evidence that it detects the defect.
- The static test checks the configuration only. The scenarios that need a running nginx (a recreated gateway, the
  request targets that reach the gateway, the 400 and the 502) are verified by the lab procedure of §3, and the MRP
  records its output.

### D6. The CI job (S3, planned, not built)

The job `compose-config` of `.github/workflows/ci.yml` follows `m09-compose-only/design.md` §8:

- `timeout-minutes: 10`, and checkout with `persist-credentials: false`. It adds no new action
  (`lab/tests/test_ci_gate_tooling.py`).
- It is not gated by the change detection of job `changes`, so it runs on every pull request and push. It is added to
  the `needs` of `ci-required`.
- Development: the same `.env` preparation as job `test`, then `docker compose --profile dev config --quiet`.
- Production: `docker compose -f deploy/compose/production/compose.yaml --profile "*" --env-file deploy/compose/production/images.env --env-file deploy/compose/production/ci.env config --quiet`.
- Lab: a shell loop over `compose.lab*.json` at the repository root, so a new lab file is covered without editing the
  job. Each file is rendered with `docker compose -f <file> --profile "*" config --quiet`, with a dummy value for
  every referenced variable, like `DUMMY_ENV` of `lab/tests/test_lab_compose_config.py`. The loop renders every file
  and fails at the end if any render failed, so the log names every broken file.

Profiles. `m09-compose-only/design.md` §8 rendered the lab files (and `compose.pgtest.json`) with `--profile "*"`.
This change keeps that for the lab renders and uses it for the production render too. The evidence, read on
2026-10-28:

- Seven of the nine lab files (`compose.lab.json`, `compose.lab-process.json`, `compose.lab-process-n2.json`,
  `compose.lab-process-n1-probe.json`, `compose.lab-process-n2-probe.json`, `compose.lab-engines.json`,
  `compose.lab-engines-java.json`) and `compose.pgtest.json` put their `seed` service under `"profiles": ["seed"]`.
  `compose.lab-pricing.json` and `compose.lab-pgreset.json` have no profile.
- `lab/tests/test_lab_compose_config.py` already renders two lab files with `--profile seed` (line 78), and its
  assertions read the `seed` service of the output (line 97). Compose leaves the services of a profile that is not
  enabled out of the project it resolves, so a profile-less render would check less than the existing unit test.
- `--profile "*"` rather than `--profile seed`: a profile added to a lab file later is covered without editing the
  job.
- `deploy/compose/production/compose.yaml` has no `profiles:` key today, so `--profile "*"` changes nothing there. It
  is used so that a service added later under a profile (a backup or maintenance job, for example) is rendered too.
- `docker-compose.yml` keeps `--profile dev`, as the requirement says: `--profile "*"` there would render the `prod`
  profile, which job `test` already renders through interpolation of the whole file, and the `benchmark`,
  `db-tools` and `federated-example` services, which are not part of the M0.9 acceptance.
- A profile-less render is not necessary for any file. Docker documents `--profile "*"` as enabling every profile
  (docs.docker.com/compose/how-tos/profiles); the Compose release that added it is not confirmed (the same open
  fact as `m09-compose-only` intake F22). S3 runs the loop through a registered check before the job is pushed. If
  the runner's Compose refuses `"*"`, the job passes one `--profile` for each name that
  `docker compose -f <file> config --profiles` prints, which renders the same services.

The same choice holds for `compose.pgtest.json` if the answer to Q1 (§6) adds it: it is one more file in the same
loop, rendered with `--profile "*"`.
- The step "Validate Docker Compose configuration" of job `test` stays. It checks the exact `.env` that job uses
  before `docker compose up`.
- `lab/tests/test_ci_compose_config.py` reads `ci.yml` and checks the three renders, `--quiet`, `--profile dev`,
  `--profile "*"` on the lab and production renders, the env files, the glob and the `needs` entry. It also checks a mutated copy for each of them, tagged
  `[utest->req~lab-deployment-compose-config-in-ci~1]`. The job itself carries
  `# [impl->req~lab-deployment-compose-config-in-ci~1]`.

Pushing a workflow change needs a token with Workflows: write (CRP-M09-3), so the requirement's `Evidence:` points at
files that do not exist yet. They are marked as planned in the spec and in tasks.md.

## 3. What is verified where

Workers have no Docker. Only static checks run in a worker's `qa_run`.

| Item | Worker (static, `qa_run`) | Lab (coordinator, with Docker) |
|---|---|---|
| F9 nginx (`req~lab-deployment-production-proxy-upstream~1`) | `test_production_nginx.py` (tagged `[utest->…]`); `test_compose_production.py`, with its runbook assertions changed as tasks.md S1b lists | the procedure below |
| F5 SERVICE.md | `git diff --check`; `git grep -n -i kubernetes -- bim-toolchain/docs/SERVICE.md` prints nothing | none |
| README pointer | `git diff --check` | none |
| S3 CI job | `test_ci_compose_config.py` | the CI run of the pull request |

F9 in the lab, run by the coordinator on a head with S1 and S1b:

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
7. Stop the stand-in, so that no container has the alias `gateway`, and wait 11 s. `curl -sk -o /dev/null
   -w '%{http_code} %{time_total}'` of `/api/health` answers 502 within about 5 s (`resolver_timeout 5s`; the
   requirement's bound is 6 s), and never 200 or another body.
   If a host is available whose DNS can answer the bare name `gateway` (a search domain or a local record), run this
   step there too, because Docker's embedded DNS forwards names it does not know to the host's resolvers. The MRP
   records the status and the time.

The alias is a contingency, not part of the procedure. Apply it only if step 7 shows a fall-through to another host:
a network alias under a reserved suffix, for example `gateway.openbinding.invalid` on the gateway service, used in
`set $gateway_upstream`, so that no outside resolver can answer it.

Evidence limitation: the lab cannot run this procedure, because it brings up only tracked Compose files. F9 is therefore
verified by the static tests and the review panel only, not in a real nginx. The procedure is the pre-deployment check
of `docs/runbooks/production.md` (section "Nginx check before the first deployment of this configuration"), which the
operator runs at the R1 production deployment. This is an evidence limitation, not a waived gate.

Then the `prod` profile of `docker-compose.yml`: `docker compose --profile prod up -d`, then
`docker compose up -d --force-recreate --no-deps gateway`. Within 10 s of the gateway becoming healthy,
`/api/health/ready` answers 200 through nginx, and nginx was not restarted. The two `/api/v1/examples/...` requests
of R2 (§4) answer through nginx with the same status and body as the same requests made to `gateway:8000` from a
container on the same network.

## 4. Risks

- R1. A typo in `resolver` or a missing `resolver` makes every `/api/` request fail with 502 ("no resolver defined").
  Mitigation: the static test checks the line, the lab procedure step 4 runs before merge, and the nginx health check
  (`nginx -t`) catches syntax errors.
- R2. D2 changes the URI that the gateway receives for `/api/` paths. It is now the URI the client sent. A client
  that calls `gateway-dev:8000` directly in development gets the same; `nginx/local/nginx.conf` (and
  `frontend/nginx.lab.conf`) still normalise the URI (R6).
  - Encoded characters: uvicorn percent-decodes the path into `scope["path"]`, and the router matches on that, so
    `/api/v1/x%2Fy` probably routes the same as before. What differs is `scope["raw_path"]`, which now keeps `%2F`.
    One route takes a path parameter that can hold `/`: `GET /v1/examples/{example_path:path}` (`routes/v1.py:655`).
  - What changes for sure is the rest of the normalisation that nginx does for location matching and no longer
    passes on: `/api//v1/jobs` reaches the gateway as `//v1/jobs` instead of `/v1/jobs`, and `/api/v1/x/../jobs` as
    `/v1/x/../jobs`, without merged slashes or resolved dot segments.
  - The examples route guards path traversal itself (`resolve()` and `relative_to` in
    `services/discovery.py:193-195`), so this changes behaviour but opens no path out of `examples/`.

  Mitigation and settling step: the lab procedure (§3) requests `/api/v1/examples/<a file of examples/>` and
  `/api/v1/examples/<directory>%2F<file>` and compares the answers with the same requests made directly to the
  gateway, and the MRP records the gateway's answers to `//v1/jobs` and `/v1/x/../jobs` (step 5).
- R3. Up to 10 s of 502 after the gateway changes address, the cache bound of `valid=10s`. Today it lasts until
  someone restarts nginx.
- R4. `bim-toolchain/` is being extracted. If the extraction copies an older `SERVICE.md`, the Kubernetes notes come
  back there. Follow-up: carry the same edit to `isa-group/bim-toolchain`.
- R5. S2, S3 and S4 may never get their decision. Then tasks.md keeps them unchecked and the M0.9 acceptance stays met
  for development only. The archive task records that.
- R6. Production now differs from `frontend/nginx.lab.conf` and `nginx/local/nginx.conf`. Those two still resolve
  the gateway once, when nginx starts, and still pass the normalised `/api/` URI through the prefix-replacing
  `proxy_pass http://gateway:8000/` (lab) and `proxy_pass http://gateway-dev:8000/` (local). So a green lab preview
  does not show how production handles encoded or dot-segment paths, nor a recreated gateway. Mitigation: the lab
  procedure of §3 runs the production image itself. Follow-up (tasks.md): the D1 and D2 behaviour for both configs.

## 5. Rollback

Each slice is one squash commit into `develop`. Reverting it restores the previous files: the literal `proxy_pass` and
the old `SERVICE.md` text for S1, the resolve-once runbook text and its tests for S1b. Nothing in S0, S1 or S1b migrates data or
changes an API. If production ever runs an image with the S1 configuration, the rollback is the previous image digest
in `images.env`, as `docs/runbooks/production.md` describes for any release.

## 6. Open questions

- Q1. `m09-compose-only` F1 also listed `compose.pgtest.json` for the CI render. The requirement covers
  `compose.lab*.json` only, as the owner request states. Should S3 render `compose.pgtest.json` too? The profile
  choice is settled (D6): it would be one more file of the same loop, rendered with `--profile "*"`. If the answer
  comes before the archive, the requirement text changes in place (it is not in the living spec yet); after it, a
  revision `~2`.
- Q2. After the lab F9 procedure (§3) passes, should a revision `req~lab-deployment-production-health-restart~2`
  drop `restart: true` for `nginx` on `gateway`? With request-time resolution it no longer fixes a stale address,
  and each recreation of the gateway by Compose restarts the whole public origin and interrupts the running
  synchronous solves. Owner or coordinator, in a later change (tasks.md follow-ups).
- CRP-M09-2 (S2), CRP-M09-3 (S3) and factory F2 of `m05-pr-previews` (S4): tasks.md.
