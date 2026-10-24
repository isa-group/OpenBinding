# Design: m41-space-bootstrap

Status: slice S-A (this delta spec, ADR 0022), S-B (tests) and S-D (Dockerfiles, runbook) are done; S-C (the tool) is in
progress. Fixed inputs: ROADMAP M4.1,
ARCHITECTURE §9.4, constitution 16.1, 16.2 and 16.4, ADR-0015 §2 and §5, the owner answers own-78031d63
(build-pinned-exception), own-e95fb0a1 (approve-m41) and own-36b6e089 (24-10-2026: "M4.1 second part, SPACE image from
the v1.7.1 commit and bootstrap with exception 16.1 in lab/tools"), and `openspec/changes/m41-space-lab-profile/`
(design.md §8, the bootstrap stubs of its delta spec).

## 1. Relation to m41-space-lab-profile

`m41-space-lab-profile` carries two placeholder requirements, `req~lab-deployment-pricing-profile-bootstrap~1` and
`req~lab-deployment-pricing-profile-bootstrap-boundary~1`. This change does not reuse their ids and does not edit that
change. When `m41-space-lab-profile` is archived, the coordinator replaces those two stubs by the five requirements of
this delta (`lab-space-image-pinned-commit`, `lab-space-bootstrap-creates`, `lab-space-bootstrap-idempotent`,
`lab-space-bootstrap-sphere-readonly`, `lab-space-no-direct-http`), so the living spec never holds both. The stub
"WHILE no such exception is recorded, no module calls SPACE directly" is superseded by ADR 0022 and
`req~lab-space-no-direct-http~1`.

The requirement texts are short because each block (header, statement, id and Evidence line) stays under 500
characters; the concrete values (names, link, policy, polling bounds, user list) are in the scenarios. Where a
requirement has more tests than fit, the Evidence line of the block lists the main ones and the Evidence line of a
scenario lists the others, so every test function appears once at least.

## 2. SPACE image (`lab/space/Dockerfile`)

At commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` (tag `v1.7.1` of `SCORELabUS/space`; the tag is never used, a tag
can move) the repository has no `api/Dockerfile`; the api is built by the upstream release file
`api/docker/release/Dockerfile` (node 21.1-slim, pnpm 10.9.0, `pnpm install --frozen-lockfile`, port 3000). The api has
no `package-lock.json`, so the lockfile is `pnpm-lock.yaml` and the install is frozen against it. The lab file
reproduces that build with pinned inputs:

| Stage | Base (pinned by digest) | Does |
|---|---|---|
| `source` | `node:21.1@sha256:0052410af98158173b17a26e0e2a46a3932095ac9a0ded660439a8ffae65b1e3` (has git) | `git init`, `git fetch --depth 1 https://github.com/SCORELabUS/space.git ef4dc894…`, `git checkout FETCH_HEAD`, then `test "$(git rev-parse HEAD)" = ef4dc894…` (the build fails otherwise) |
| `api` | `node:21.1-slim@sha256:cba276a6db06f49c589bcea35c598b5a960880ed5631bd4407a61c414ec7a9b9` | copies `api/` from `source`, installs pnpm `10.9.0` exactly, `pnpm install --frozen-lockfile`, the build and start commands of the upstream release file, `EXPOSE 3000`, `USER 1000:1000` |

The commit is a literal in the file, not an `ARG` with a default, so the static test pins it. No `ARG` or `ENV` holds a
secret: `JWT_SECRET`, `JWT_SALT`, `ADMIN_PASSWORD` and the Mongo password reach the container only as Compose
environment references (`m41-space-lab-profile` design.md §2).

The digests of `node:21.1-slim`, `node:21.1` and `python:3.12.8-slim-bookworm` (§3) come from a Docker Hub lookup of
24-10-2026 with MEDIUM confidence. They are NOT built or pulled here: workers have no Docker and no network. A wrong
digest fails the build loudly (never a silent fallback); the coordinator's lab verifies the build and only then the
runbook lists them as verified. mongo `7.0.16@sha256:c630c593…` and redis `7.4.2@sha256:fbdbaea4…` stay by digest as in
`m41-space-lab-profile`.

## 3. Tool image (`lab/tools/Dockerfile`)

`FROM python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0`, a
requirements file with exact `name==version` lines (`space-python-client==1.0.0` and `httpx==0.28.1`, the versions locked
in `openbinding-gateway/uv.lock`, plus their exact transitive pins), `pip install --no-cache-dir -r`, the tool copied in, no secret,
`USER 1000:1000`. The build context is the repository root (`.`). The tool keeps its own copy of the six usernames and
of `SEED_NAMESPACE` (importing `seed_lab.py` would pull the gateway into the image); the test
`test_the_constants_and_the_synthetic_users_follow_the_seed` compares the namespace and the six usernames (in order)
with the text of `openbinding-gateway/tools/seed_lab.py`. The static rules also require: `ENTRYPOINT` running the tool,
`pip install` only from `requirements.txt`, and in the SPACE file `git fetch` (never `git clone`), `checkout FETCH_HEAD`,
the HEAD check comparing with the literal commit, and every `pnpm install` frozen.

## 4. Bootstrap tool (`lab/tools/space_lab_bootstrap.py`)

Environment, read by `Config.from_environ` into a frozen `Config`: `SPACE_URL` (default `http://space-api:3000`),
`SPACE_ADMIN_USER` (default `lab-space-admin`), `SPACE_ADMIN_PASSWORD` (required and non-empty, else `BootstrapError`)
and `SPACE_BOOTSTRAP_PLAN` (the plan of the contracts, default `FREE`). `Config` also holds `poll_attempts` (60) and
`poll_seconds` (5). Nothing else is read; no `SPHERE_*` variable.

HTTP sequence (from the SPACE documentation of the main branch; MEDIUM confidence, UNVERIFIED against a live v1.7.1;
the live proof is slice S5 of `m41-space-lab-profile`):

1. `POST /api/v1/users/authenticate` with the admin user and password; the response's `apiKey` is sent as `x-api-key`.
2. `GET /api/v1/organizations`; if `openbinding` is missing, `POST /api/v1/organizations` with the admin as owner.
3. If the organization has no `MANAGEMENT` key, `POST /api/v1/organizations/{id}/api-keys` `{scope: MANAGEMENT}`;
   otherwise the existing key is reused. ASSUMPTION (UNVERIFIED): the organization lookup returns the value of an
   existing key. If v1.7.1 does not, the fallback is the admin key for steps 4-6, or the owner's question 3 (§5);
   creating a new key on every run would break `lab-space-bootstrap-idempotent`.
4. `GET /api/v1/services`; if `openbinding` is missing, `POST /api/v1/services` `{source: sphere, permanentUrl:
   https://sphere.score.us.es/p/6ab0a323697330667ccce891, policy: all_last}`. An existing `openbinding` with another
   source, link or policy, or a created service whose name is not `openbinding`, aborts (never modified).
5. `POST /api/v1/services/openbinding/synchronization/run` only when the service was just created or has never reached
   `ready`; then `GET …/synchronization` every `poll_seconds` (5 s), at most `poll_attempts` (60) times, until `ready`;
   the statuses `failed`, `blocked` and `degraded`, or exhaustion of the polls, abort.
6. `GET /api/v1/services/openbinding/pricings`: the newest active version (archived versions are ignored; no active
   version aborts).
7. Contracts through `space-python-client` (`contracts.get_contract`, `contracts.add_contract`, as the existing
   `SpaceRemote` uses them; `bootstrap` takes the contracts client, the httpx transport and the sleep function as
parameters so tests inject fakes): one per seed user (`lab-admin`, `lab-owner`, `lab-orgadmin`, `lab-member`, `lab-viewer`,
   `lab-outsider`), user id `uuid5(SEED_NAMESPACE, "user:<username>")` of `openbinding-gateway/tools/seed_lab.py`.

Steps 1-6 use httpx: `space-python-client` 1.0.0 covers contracts, features and health only, with no organization,
api-key, user or service operation; that is the 16.1 exception of ADR 0022. Steps 4-7 use the organization's
`MANAGEMENT` key in memory (UNVERIFIED which key SPACE 1.7.1 requires for service routes). Each contract subscribes
`openbinding` at that version with the plan `Config.plan` (from `SPACE_BOOTSTRAP_PLAN`, default `FREE`) and no add-on,
the same plan for every user; mapping seed roles to plans is M4.2.

Output: ONE JSON line on standard output and exit status 0, `{"organization", "apiKey", "service", "synchronization",
"contracts": {<username>: …}}`. A present item is `exists` (created: `created`); the synchronization is `ready` after a
wait and `skipped` for an already existing service; the contracts map holds one entry per seed user. Any failure raises
`BootstrapError` naming the failed item without response bodies or headers; `main` prints one redacted line on standard
error and exits 1. A partial state is completed on the next run (idempotence is by lookup before each create). Tests use a simulated transport and an injected sleep; they never reach SPACE or SPHERE (constitution 16.6).

## 5. Secrets and the MANAGEMENT key

The admin password and every api key live only in process memory: never written to disk, logged, printed or put in an
exception text (errors are re-raised with a redacted message). The tool sends nothing to SPHERE: SPACE reads the public
link itself (constitution 16.2). ASSUMPTION pending the owner's question 3: the `MANAGEMENT` key stays inside SPACE until
M4.5 and a re-run reuses the organization's existing key. The alternative is to hand it to the stack's secret store
(ARCHITECTURE §9.4); choosing it needs a revision 2 of `lab-space-bootstrap-sphere-readonly`.

## 6. Architecture test (`lab/tests/test_no_direct_space_http.py`)

Scans tracked Python and frontend TypeScript sources, test directories excluded (their HTTP is simulated). A module is
a direct caller when it creates an HTTP client or sends a request (`httpx.Client`/`AsyncClient`/`get`/`post`,
`requests`, `aiohttp`, `urllib.request`, `fetch`, `axios`) and names a SPACE or SPHERE target (`SPACE_URL`, `space_url`,
`SPHERE_*URL`, `sphere_url`, `sphere.score.us.es`, `space.score.us.es`, SPACE route prefixes `/api/v1/services`,
`/api/v1/organizations`, `/api/v1/contracts`, `/users/authenticate`, `/synchronization/run`, SPHERE
`/api/v1/public/pricings`). Using httpx only for types or transports (`httpx.AsyncBaseTransport`,
`httpx.MockTransport`, `logging.getLogger("httpx")`) is not a call, and the official clients (`space_client`,
`space-react-client`) are fine. The test also asserts that ADR 0022 exists and names `lab/tools`. Allowed: `lab/tools/**` and the
gateway plans module (`openbinding_gateway/plans/**`; today the SPACE adapter is `openbinding_gateway/space_client/**`,
which makes no direct call and uses `space-python-client`).

Pinned known deviations, each with its reason:

- `openbinding-gateway/tools/_remote_common.py`: its `SpaceRemote` uses httpx for services and pricings and its
  `SphereRemote` calls SPHERE directly; it is a development probe outside `lab/tools`, and `remote_probe.py`,
  `remote_provision.py` and `seed_lab.py` reach SPACE only through it (they use httpx for transport types only and are
not detected).
- `openbinding-gateway/src/openbinding_gateway/sphere_client.py`: the gateway's home-made SPHERE client (httpx with
  `x-api-key` from `sphere_api_key`, used by `pricing_catalog.py`), which ADR-0015 §7 removes.

Both also hold a SPHERE key, which constitution 16.2 forbids. The pinned list fails when an entry stops being needed, so
it can only shrink. Moving or retiring them is a followup.

## 7. Compose wiring (follow-up for the coordinator; no compose file is edited here)

As written in `docs/qa/PRICING_PROFILE.md` (sections "Compose wiring still needed" and "Bootstrap"). In
`compose.lab-pricing.json`:

- add the one-shot `pricing-bootstrap`: `build: {context: ., dockerfile: lab/tools/Dockerfile}`,
  `SPACE_URL=http://space-api:3000`, `SPACE_ADMIN_USER=lab-space-admin`,
  `SPACE_ADMIN_PASSWORD=${DEMO_SPACE_ADMIN_PASSWORD}`, `depends_on: {space-api: {condition: service_healthy}}`,
  `mem_limit: 96m`, no ports, `restart: "no"`;
- replace the marker image of `space-api` by `build: {context: lab/space, dockerfile: Dockerfile}` with the image name
  `openbinding-lab/space-api:1.7.1` (the local file; a git URL context is not used).

Consequences for `lab/tests/test_lab_pricing_profile.py` and `lab/tests/test_no_local_space.py`:

- `build` is allowed for `space-api` and `pricing-bootstrap` (`pinned-images` ~2, the `isolated` allow-list, which also
  needs `restart`); the marker rule and the runbook GAP section are retired;
- the profile has four services and the memory sum becomes 1088 MiB (992 + 96);
- `${DEMO_SPACE_ADMIN_PASSWORD}` appears twice (`space-api` and `pricing-bootstrap`), where today it must appear once
  (`secret-references` ~2);
- `start-order` exempts the one-shot `pricing-bootstrap`;
- `no-local-space` accepts the built `space-api` image name.

The runbook GAP is closed once the lab has built the image and verified the three base digests.

## 8. Requirements and slices

| Requirement | Slice | Evidence file |
|---|---|---|
| `lab-space-image-pinned-commit` | S-B tests, S-D Dockerfiles | `lab/tests/test_space_lab_bootstrap.py` |
| `lab-space-bootstrap-creates` | S-B tests, S-C tool | same |
| `lab-space-bootstrap-idempotent` | S-B tests, S-C tool | same |
| `lab-space-bootstrap-sphere-readonly` | S-B tests, S-C tool | same |
| `lab-space-no-direct-http` | S-B test, S-A ADR 0022 | `lab/tests/test_no_direct_space_http.py` |

## 9. Deviations

- PR size: over the ~300-line guideline (tool, two Dockerfiles, ADR, spec). The parts depend on each other: the tool
  without the architecture test would be an unrecorded 16.1 exception.
- G1 `openspec validate m41-space-bootstrap --strict` is NOT run: owner exemption until PR 37 merges. The format was
  checked by reading against `openspec/changes/m41-space-lab-profile/`.

## 10. Risks and open questions

- The HTTP sequence, the key each route needs and whether an existing key's value can be read back are UNVERIFIED for
  v1.7.1 (S5 proves them live).
- The three base digests have medium confidence and are unbuilt (§2).
- Owner question 3: placement of the `MANAGEMENT` key (§5).
- The detection rule of §6 is textual; a false positive is fixed in the module or pinned with a reason, never ignored.
