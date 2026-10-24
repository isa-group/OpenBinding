# Design: m05-pr-previews

Status: plan. Nothing here is built yet. The owner's constraints are fixed inputs: NiPoGi lab, rootless Docker, one
Compose project per PR head, loopback ports 18101–18199, tracked Compose files only, private volumes, synthetic data,
start on demand, 7 idle days, and deletion only through `labctl destroy`.

## 1. Actors

- **Preview manager**: `labctl preview …` in the factory supervisor. It holds the state, runs Docker Compose through
  `lab_compose` with a project name, records activity and runs the expiry sweep.
- **Planner**: `lab/previews/previews.py` in this repository. It is a stdlib-only reference of the rules: port
  allocation, names, environment patch, refresh, expiry, cap and refusals. It reads a state document and a request,
  prints the planned action as JSON and has no side effects. Its tests are the contract `labctl` must pass. This is
  the same pattern as `lab/tests/test_lab_compose.py`, which mirrors `lab_compose`. If the factory runs the planner,
  it runs it from the `develop` checkout, never from a PR head, so a PR cannot change its own preview policy.

## 2. Lifecycle

`request → allocate port → up → seed → ready → (refresh on new head) → idle → expire → destroy`

| Step | What happens | Status after |
|---|---|---|
| request | `labctl preview request <pr>` checks that the PR is open, its head branch is in this repository and the head SHA is resolved. It also checks that the Compose file to run is tracked at that head (`git ls-files`), refusing otherwise with `preview_untracked_compose`. With no record, go to allocate. With a record on another head, go to refresh. With a record on the same head that is stopped, start it again. With the same head running, it only records activity. | `requested` |
| allocate | Lowest free port in 18101–18199 (§4). Refusal: `preview_ports_exhausted`. Memory admission (§6). Refusal: `preview_capacity_reached`. A refused request writes no record and holds no port. | `starting` |
| up | Checks out the PR head in the preview's work tree. `lab_compose validate`, then `lab_compose up` with project `openbinding-pr-<n>`, the profile the develop lab uses (today `compose.lab-process.json`), `DEMO_E2E=0` and the environment of §5. Before `up`, `docker compose config` must show `web` published on `127.0.0.1:<port>`; otherwise nothing starts. A PR head that branched before slice S2 still publishes a literal 18100, so it is refused until it is rebased onto `develop`. | `seeding` |
| seed | `lab_compose seed` with `DEMO_SEED_TOOL=seed_lab.py`, `DEMO_SEED_ARGS=--verbose`. | `ready` on exit 0 |
| ready | G12 runs inside the project (`DEMO_E2E=1`, as `docs/DEMO.md` describes). The owner opens the preview through the tunnel. | `ready` |
| refresh | The same project, port and volumes. `up --build` at the new head, then the idempotent seed. Migrations apply at start (`req~lab-deployment-migrate-on-start~1`). The ID of every image built goes into `images`. | `ready` |
| open | `labctl preview open <pr>` records the access and prints the tunnel command. On a `stopped` preview it first runs memory admission (§6) and `up`. | `ready` |
| stop | `labctl preview stop <pr>`: `docker compose down` without `-v`. It removes the containers and the network, frees memory and deletes no volume or image. | `stopped` |
| expire | `labctl preview expire [--dry-run]`, the hourly sweep, finds `now − last_active_at ≥ 168 h` and calls `labctl destroy preview <pr>`. | `destroying` |
| destroy | `labctl destroy preview <pr>`: `down --volumes --rmi local`, then removal of the tag `openbinding-lab-gateway:<port>` and of every image ID in `images`, including the builds that earlier refreshes left dangling. Then the work tree is removed and the port released. | `destroyed` |

**Idle and activity.** `last_active_at` is the UTC time of the last of these events, all recorded by the factory:
an on-demand request or start, a refresh, `labctl preview open <pr>` (which prints the tunnel command and marks the
access), and a G12 or `lab_screenshot` run against the preview. These are not activity: health checks, automatic
restarts, `list` or `status`, the expiry sweep itself, and traffic the factory cannot see. A manual SSH tunnel opened
without `open` counts only if `open` is run. The sweep runs hourly, so a preview is destroyed between 168 h and 169 h
of idleness. It skips records in `starting`, `seeding` or `destroying`. `failed` and `stopped` previews age like any
other. Closing or merging the PR does not destroy the preview: the same 7-day rule applies, and the operator can
destroy it earlier.

## 3. State record

One JSON document per preview lives in the factory's lab state at
`<factory-state>/projects/openbinding/previews/pr-<n>.json`. It is outside the repository and outside every Docker
volume. The factory writes it atomically (temporary file, then rename) under one lock per project.

```json
{"pr": 42, "head_sha": "<40 hex>", "previous_head_sha": "<40 hex or null>", "port": 18101,
 "project": "openbinding-pr-42", "compose_file": "compose.lab-process.json",
 "volumes": ["openbinding-pr-42_lab-pg-3", "openbinding-pr-42_lab-redis", "openbinding-pr-42_lab-artifacts-2", "openbinding-pr-42_lab-e2e"],
 "images": ["openbinding-lab-gateway:18101", "openbinding-pr-42-web", "..."], "mem_mib": 4032,
 "status": "requested|starting|seeding|ready|stopped|failed|destroying|destroyed",
 "created_at": "2026-11-01T10:00:00Z", "last_active_at": "2026-11-01T10:00:00Z",
 "last_activity": "request|refresh|open|g12|screenshot", "error": null}
```

The record holds no secret. The synthetic secrets of §5 live in the factory's private per-project environment store,
the one `lab_compose` already keeps. A destroyed record is kept with the factory reports for 90 days (ARCHITECTURE
§10, row "Factory and gate reports"). `labctl preview list` reports orphans: projects named `openbinding-pr-*` with no
record, or records with no project. It never deletes them. The operator resolves them with `labctl destroy`.

## 4. Ports and names

- Range 18101–18199: 99 ports. 18100 belongs to the develop lab and is never allocated.
- Allocation: the lowest port that no record outside `destroyed` holds and that nothing listens on (the factory
  probes `127.0.0.1:<port>`). A port stays with its PR until destroy, including while the preview is stopped.
- Collision: if `up` still fails with "port is already allocated", the record becomes `failed` with `port: null`.
  The port is released and the volumes stay listed for `labctl destroy`. The next request or refresh allocates a
  free port again.
- Exhaustion: when all 99 ports are held, the request is refused with `preview_ports_exhausted`. The answer lists the
  five least recently active previews as candidates for `labctl destroy`. Nothing is evicted automatically.
- Names come from the PR number in decimal, with no leading zeros. The project is `openbinding-pr-<n>`, which matches
  `^[a-z][a-z0-9-]{0,62}$` and Compose's project rule. Compose prefixes volumes (`openbinding-pr-<n>_lab-pg-3`, …),
  the network (`openbinding-pr-<n>_default`) and the images built without an `image` key
  (`openbinding-pr-<n>-web`, …). The file's top-level `name` (`openbinding-lab`) is overridden by the project
  argument, so the develop lab keeps its name.

## 5. Parameterising the tracked Compose files

One variable, `DEMO_LAB_PORT`, with the default `18100`, goes into `compose.lab.json` and the four profiles that
must equal it outside `bim-service`: `compose.lab-process.json`, `-n2`, `-n1-probe` and `-n2-probe`.

| Field | Today | After |
|---|---|---|
| `web.ports[0].published` | `18100` | `"${DEMO_LAB_PORT:-18100}"` (`host_ip` stays `127.0.0.1`) |
| `gateway`/`worker`/`seed` `image` | `openbinding-lab-gateway:latest` | `openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}` |
| `gateway`/`seed` `CORS_ALLOW_ORIGINS` | `http://localhost:18100,http://127.0.0.1:18100,${DEMO_PUBLIC_ORIGIN}` | the same with `${DEMO_LAB_PORT:-18100}` for both ports |

- The image tag is per port because a shared `latest` would let a preview build overwrite the image the develop
  worker and seed run. The port identifies one stack for its whole life. `${COMPOSE_PROJECT_NAME}` was considered:
  it needs a non-`DEMO_` reference rule in the validator and gives no benefit.
- Volumes and networks keep their keys. The project scopes them, and the existing rule "top-level volumes and networks
  carry only labels" forbids `name` and `external`, so no preview can declare a shared volume or network.
- For a preview, the factory sets `DEMO_LAB_PORT=<port>` and `DEMO_PUBLIC_ORIGIN=http://localhost:<port>` (links and
  CORS through the tunnel). It sets `DEMO_SPACE_ENABLED=false` and leaves `SPACE_API_KEY`, `SPACE_URL` and
  `SPACE_ORGANIZATION_ID` empty. It generates fresh values for `DEMO_PG_PASSWORD`, `DEMO_JWT_SECRET`,
  `DEMO_FERNET_KEY`, `DEMO_BIM_TOKEN` and `DEMO_SEED_PASSWORD`. `SPHERE_API_KEY` stays empty: constitution 16.2
  allows only the public permanent-link API. `SPHERE_URL` and `SPHERE_ORGANIZATION_ID` keep the develop lab's
  public values.
- Static rules (`lab/tests/`) change as follows. `published` and `image` are checked after expansion, with the
  variable unset (18100) and set (18101, 18199). The set of allowed defaults becomes
  `{DEMO_PUBLIC_ORIGIN:-http://localhost:18100, DEMO_LAB_PORT:-18100}`. Every `DEMO_LAB_PORT` reference must use
  the default `18100`. `DEMO_LAB_PORT` must be documented in `docs/DEMO.md`. All other rules are unchanged: memory
  sum 4032, secrets, no `cap_add`, no binds, no networks keys.
- The develop lab after this change keeps the same port, origins, volumes and project. Its gateway image tag becomes
  `openbinding-lab-gateway:18100`, which costs one rebuild.

## 6. Memory budget and cap

The lab memory cap is 9 GiB = 9216 MiB (INTENT §9, resources: 14 GiB RAM). One stack declares 4032 MiB (3648 MiB
steady, plus the `seed` one-shot). Admission: a start is allowed only if the sum of declared `mem_limit` of every
running lab project, plus the preview's own sum read from its head's file, stays at or below 9216 MiB. With the
develop lab running, 4032 + 4032 = 8064, so **one running PR preview at a time**. Without the develop lab, two.
Stopped previews hold ports and disk but no memory. At the cap the request is refused with
`preview_capacity_reached`, naming the running previews and their `last_active_at`. Nothing is stopped
automatically. The requester runs `labctl preview stop <pr>` on a preview whose G12 is done, or waits.

## 7. Failure and rollback

- A failed build during refresh: Compose recreates nothing, the old head keeps running, the record keeps `head_sha`
  and stores `error`.
- `up` or seed fails: status `failed`, then `down` without `-v`. The port and volumes are kept and the logs stay
  readable through `lab_compose logs`. To retry, refresh. To roll back, refresh to `previous_head_sha`.
- A database that cannot migrate (for example after a force-push to an older schema): `labctl destroy preview <pr>`,
  then a new request. Data is synthetic.
- Rolling back the repository change means reverting the Compose parameterisation. Because the default is 18100, the
  develop lab runs either version. The `lab_compose` validator change must land first (§9), or the develop lab would
  refuse the new file.

## 8. Security

- Loopback only: `host_ip: 127.0.0.1` stays a static rule. The factory compares the interpolated port with the
  allocated one before `up`.
- No privileges: the forbidden keys (`privileged`, `cap_add`, `devices`, `pid`, `ipc`, `secrets`, …) stay refused.
  The supervisor drops every capability. Rootless Docker keeps the host's loopback unreachable from containers.
  This is an assumption, to be confirmed by `lab/tests/test_preview_isolation.py`, a live probe run from preview A.
  The probe connects to preview B's port through the host-side gateway address of A's network, not through
  127.0.0.1, which is A's own loopback.
- Secrets: only `${VAR}` references with no default, and fresh synthetic values per preview. No SPACE or SPHERE key
  and no production value is ever placed in a preview environment.
- Isolation: one network and volume set per project, no external or named shared ones, no bind mounts.
- PR code runs in the lab: only PRs whose head branch is in this repository get a preview. Each `up` goes through
  `lab_compose validate`, so a PR that edits `compose.lab*.json` (port, memory, binds) is refused.
- Retention: ARCHITECTURE §10 already says "Lab previews | lab Docker volumes | expire after 7 idle days; develop
  preview is permanent". This change implements that row and adds no data class. Images and work trees go with the
  preview, and the record follows the reports row.

## 9. Implementation files

Repository (it can do these alone):

| File | Reason |
|---|---|
| `compose.lab.json` | `DEMO_LAB_PORT` in `published`, the image tag and the local CORS origins (§5) |
| `compose.lab-process.json`, `compose.lab-process-n2.json`, `compose.lab-process-n1-probe.json`, `compose.lab-process-n2-probe.json` | the same six lines, so they still equal the base outside `bim-service` |
| `lab/tests/test_lab_compose.py` | port, image and CORS rules after expansion; allowed defaults; `DEMO_LAB_PORT` documented |
| `lab/tests/test_lab_process_profiles.py` | constants of the image and port, if they compare literals |
| `openbinding-gateway/tests/test_container_hardening.py` | `SHARED_IMAGE` and `ALLOWED_DEFAULT_REFERENCE` follow the new references |
| `lab/previews/previews.py` (new) | the planner of §1 |
| `lab/tests/test_previews.py` (new) | unit tests of every ADDED requirement on the planner |
| `lab/tests/test_preview_isolation.py` (new) | live isolation probe, skipped without a lab |
| `docs/DEMO.md` | `DEMO_LAB_PORT` row, the image tag, a short "PR previews" section |
| `docs/previews/README.md` | from plan to the runbook in force |
| `TESTING.md`, `docs/qa/E2E_PLAN.md` | G12 against a preview port as well as 18100 |
| `openspec/specs/lab-deployment/spec.md` | archive task only |

Factory supervisor (outside this repository; the repository cannot do these):

- `lab_compose` validator: accept `published` as `${DEMO_LAB_PORT:-18100}` and check the interpolated value is in
  18100–18199. Accept the interpolated gateway image tag and the second defaulted reference. Take a project-name
  argument and keep one stored environment per project.
- `labctl preview request|list|open|refresh|stop|expire` and `labctl destroy preview <pr>`, the state store of §3, the
  hourly expiry sweep, activity from G12 and `lab_screenshot`, memory admission, the port probe and per-preview
  secret generation.
- G12 pointed at the preview project of the PR head instead of `openbinding-lab`.

## 10. Slices and size

| Slice | Content | Estimated diff lines |
|---|---|---|
| S1a tests first (rules) | changed static rules and hardening constants, frozen first, red on the base | ~90 |
| S2 compose parameterisation | 5 Compose files (6 lines each) and the `DEMO.md` variable row; S1a turns green | ~75 (+ ~90 of S1a in the same PR) |
| S1b tests first (planner) | `test_previews.py`; it calls the planner CLI through a subprocess, so the base fails by assertion, not by import | ~170 |
| S3 planner | `lab/previews/previews.py` and its CLI; S1b turns green | ~130 (+ ~170 of S1b in the same PR) |
| S4 docs | `docs/DEMO.md` section, runbook in force, `TESTING.md`, `E2E_PLAN.md`, isolation probe | ~90 |

S1a and S1b are never merged alone: they travel in the PRs of S2 and S3, so `develop` stays green. S2 needs the factory's
validator change first. S4 needs the factory's `labctl preview` first.

## 11. Open questions (not blocking)

- Should a running preview stop automatically after a number of idle hours, to free the single memory slot? Not
  specified here. Today, stopping is manual.
