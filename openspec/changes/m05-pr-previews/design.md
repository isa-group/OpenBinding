# Design: m05-pr-previews

Status: the planner, the probe, the static rules and the Compose parameterisation (S1b, S3, S4.1, S1a, S2) are built;
F1, F2 and the 4.2 docs are pending. The owner's constraints are fixed inputs: NiPoGi lab, rootless Docker, one
Compose project per PR head, loopback ports 18101–18199, tracked Compose files only, private volumes, synthetic data,
start on demand, 7 idle days, and deletion only through `labctl destroy`.

## 1. Actors

- **Preview manager**: `labctl preview …` in the factory supervisor. It holds the state, runs Docker Compose through
  `lab_compose` with a project name, records activity and runs the expiry sweep.
- **Planner**: `lab/previews/previews.py` in this repository. It is a stdlib-only reference of the rules: port
  allocation, names, environment patch, refresh, expiry, cap and refusals. It reads a state document and the facts
  the manager passes as flags, prints the planned action as JSON and has no side effects: it never reads the clock,
  Git, Docker, the network or the environment. Its tests are the contract `labctl` must pass. This is the same pattern
  as `lab/tests/test_lab_compose.py`, which mirrors `lab_compose`. If the factory runs the planner, it runs it from the
  `develop` checkout, never from a PR head, so a PR cannot change its own preview policy.

### Planner contract

Fixed before the tests are written (slice S1b):

```
python lab/previews/previews.py plan <request|refresh|open|stop|expire|activity|destroy-check>
  --state <path to JSON state document> [--pr N] [--head SHA] [--now ISO8601]
  [--tracked <JSON file list>] [--running <JSON list of running stacks with mem_mib>]
  [--pr-info <JSON: state, head_repo, head_sha>] [--kind request|refresh|open|g12|screenshot]
  [--head-mem-mib N] [--listening <JSON list of ports>] [--tags <JSON object tag -> image ID>] [--seed-rng N]
```

| Input | Flag | Where the manager takes it from |
|---|---|---|
| State | `--state`: a file `{"records": [<record of §3>, …]}` | the per-preview records of §3, read under the project lock |
| PR | `--pr N` (decimal, no leading zeros) | the operator's command, or the PR of the G12 or screenshot run |
| Head | `--head SHA`: the PR's current head; it must equal `pr-info.head_sha` when both are given | the head ref of the PR in this repository |
| Clock | `--now`: UTC, ISO 8601; required by every plan that writes or compares a time | the manager's clock |
| PR facts | `--pr-info`: `{"state": "open|closed|merged", "head_repo": "owner/name", "head_sha": "<40 hex>"}` | the GitHub API |
| Tracked files | `--tracked`: JSON list of paths | `git ls-files` at the head |
| Running stacks | `--running`: `[{"project": "openbinding-lab", "mem_mib": 4032}, …]` | `docker compose ls` and each running file's declared `mem_limit` sum |
| Head memory | `--head-mem-mib N`: the declared `mem_limit` sum of the Compose file at the head | `lab_compose` reading that tracked file |
| Busy ports | `--listening`: JSON list of ports in 18101–18199 something listens on | the manager's probe of `127.0.0.1:<port>` |
| Activity | `--kind`: one of `request`, `refresh`, `open`, `g12`, `screenshot` | the event being recorded |
| Image tags | `--tags`: `{"openbinding-lab-gateway:18101": "sha256:…"}` | `docker image inspect` of every `openbinding-lab-gateway:*` tag (the develop lab's `:18100` included) and of the tags in the records |
| Test seed | `--seed-rng N`: replaces the system generator by `random.Random(f"{N}:{pr}")` | never: tests only |

Output: one JSON object on stdout, with these keys and no others:

| Key | Value |
|---|---|
| `action` | the plan name |
| `refusal` | `null` or one of `preview_pr_not_eligible`, `preview_untracked_compose`, `preview_ports_exhausted`, `preview_capacity_reached`, `preview_head_stale` |
| `port` | the preview's port, or `null` |
| `project` | `openbinding-pr-<n>`, or `null` |
| `env` | non-secret entries as name → value; the five secrets of §5 only as name → `{"generate": true}` (first start) or `{"keep": true}` (kept names). The planner never prints a secret value, except that with `--seed-rng` each generated entry also carries `value` so tests can check its format |
| `commands` | the argv lists the manager would run, in order (`[]` when there is nothing to run), only of these shapes: `["lab_compose", "up", "--project", "openbinding-pr-<n>", "--build"]` (first start, or a new head); `["lab_compose", "up", "--project", "openbinding-pr-<n>"]` (restart of a `stopped` or `failed` record at the same head); `["lab_compose", "down", "--project", "openbinding-pr-<n>"]` (stop, never `-v`); `["labctl", "destroy", "preview", "<n>"]` (expire); and, for `destroy-check` only, `["lab_compose", "destroy", "--project", "openbinding-pr-<n>"]` (the `down --volumes --rmi local` of §2) followed by one `["docker", "image", "rm", "<tag or image ID>"]` per removal. `lab_compose validate` before and `lab_compose seed` after an `up` (§2) are the manager's and are not listed |
| `record` | the record after the action, or `null` (refusal, no record, or `expire`) |

Exit code 0 for a plan and for a refusal: a refusal is data. Exit code 64 (`EX_USAGE`) only for usage errors, the
planner's argument parser included: an unknown plan or `--kind` (for example `health` or `list`), malformed JSON, a
missing required flag, or `--head` differing from `pr-info.head_sha`. The code is not 2, so a missing planner
(Python's "can't open file" exits 2) cannot pass a usage-error test.

Checks run in this order, and the first failing one is the refusal: eligibility (`state` is `open` and `head_repo` is
`isa-group/OpenBinding`), tracked file (`compose.lab-process.json` is in `--tracked`), free port (only when the plan
allocates one: no record, or a record with `port: null`), memory cap (only when the plan moves the preview from
absent, `stopped` or `failed` to running, §6; a refresh of a running preview skips it). They apply to the plans that
run `up`: `request`, `refresh`, and `open` of a `stopped` or `failed` record. `stop`, `expire`, `destroy-check` and
`activity` skip them, so a preview of a closed or merged PR can still be stopped, expired or destroyed. `activity`
of kind `g12` or `screenshot` has one check of its own, the stale head. A refusal writes no record and holds no port.

A record in `destroyed` counts as no record: a later request allocates, admits and generates new secrets.

| Plan | Required flags; defaults | What it does |
|---|---|---|
| `request` | `--state`, `--pr`, `--now`, `--pr-info`, `--tracked`, `--head-mem-mib`; `--head` defaults to `pr-info.head_sha`, `--running` to `[]`, `--listening` to `[]` | no record: allocate (§4), admit (§6), first start. Record on a different head: as `refresh`. Same head and `stopped` or `failed`: allocate a port again when `port` is null, admit, then `up`. Same head and running: activity only, no commands |
| `refresh` | as `request` | as `request` on an existing record, a `stopped` or `failed` one being admitted first; with no record, as `request` |
| `open` | as `request` | `stopped` or `failed`: allocate a port again when `port` is null, admit, then `up`; running: activity only. Records `open`. No record: nothing |
| `stop` | `--state`, `--pr` (no `--tracked`) | `down` without `-v`; status `stopped`; port and record kept |
| `expire` | `--state`, `--now` | one `["labctl", "destroy", "preview", "<n>"]` per record idle ≥ 168 h and not `requested`, `starting`, `seeding`, `destroying` or `destroyed`; `record: null` |
| `activity` | `--state`, `--pr`, `--now`, `--kind`; `--pr-info` too for `g12` and `screenshot` | sets `last_active_at = now` and `last_activity = kind`; refused with `preview_head_stale` for `g12` or `screenshot` when the record's `head_sha` differs from `pr-info.head_sha` |
| `destroy-check` | `--state`, `--pr`; `--tags` defaults to `{}` | the Docker commands `labctl destroy preview <n>` runs (§2, "destroy"); record `destroyed` with `port: null` |

`--seed-rng` is optional for every plan (default: the system generator). A flag a plan does not use is ignored. A
missing required flag is a usage error, exit 64 (`test_missing_required_flag_is_a_usage_error`).

A plan for a PR with no record other than `request` or `refresh` has `record: null` and no commands.

## 2. Lifecycle

`request → allocate port → up → seed → ready → (refresh on a different head) → idle → expire → destroy`

The checks, their order and the plans are those of §1: `open` and the admission of `refresh` apply to a `stopped` or
`failed` record, eligibility comes first, and a free port is checked before the memory cap.

| Step | What happens | Status after |
|---|---|---|
| request | `labctl preview request <pr>` checks that the PR is open and its head branch is in this repository, refusing otherwise with `preview_pr_not_eligible` (closed, merged or fork). It resolves the head SHA and checks that the Compose file to run is tracked at that head (`git ls-files`), refusing otherwise with `preview_untracked_compose`. With no record, or a `destroyed` one, go to allocate. With a record on a different head, go to refresh. With a record on the same head that is stopped or failed, allocate a port again if it has none, run memory admission (§6), and start it again. With the same head running, it only records activity. | `requested` |
| allocate | Lowest free port in 18101–18199 (§4). Refusal: `preview_ports_exhausted`. Memory admission (§6). Refusal: `preview_capacity_reached`. A refused request writes no record and holds no port. The five secrets of §5 are generated now, once. | `starting` |
| up | Checks out the PR head in the preview's work tree. `lab_compose validate`, then `lab_compose up` with project `openbinding-pr-<n>`, `compose.lab-process.json` (the profile the develop lab uses today), `DEMO_E2E=0` and the environment of §5. Before `up`, `docker compose config` must show `web` published on `127.0.0.1:<port>`; otherwise nothing starts. A PR head that branched before slice S2 still publishes a literal 18100, so it is refused until it is rebased onto `develop`. | `seeding` |
| seed | `lab_compose seed` with `DEMO_SEED_TOOL=seed_lab.py`, `DEMO_SEED_ARGS=--verbose` and the preview's kept `DEMO_SEED_PASSWORD`. | `ready` on exit 0 |
| ready | G12 runs inside the project (`DEMO_E2E=1` with the same `DEMO_SEED_PASSWORD`, as `docs/DEMO.md` describes), only when the record's `head_sha` is the PR's current head; otherwise it is refused with `preview_head_stale` and counts as no activity. The owner opens the preview through the tunnel. | `ready` |
| refresh | The same project, port, volumes and secrets. A stopped or failed preview first passes the checks of §1 (a port again if it has none, then memory admission, §6); a running one skips admission. `up --build` at the new head, then the idempotent seed. The new head is held in `pending_head_sha` and becomes `head_sha` only when `up` exits 0. Migrations apply at start (`req~lab-deployment-migrate-on-start~1`). The ID of every image built goes into `images`. | `ready` |
| open | `labctl preview open <pr>` records the access and prints the tunnel command. On a `stopped` or `failed` preview it first runs the checks of §1 (memory admission, §6) and `up`. | `ready` |
| stop | `labctl preview stop <pr>`: `docker compose down` without `-v`. It removes the containers and the network, frees memory and deletes no volume or image. | `stopped` |
| expire | `labctl preview expire [--dry-run]`, the hourly sweep, finds `now − last_active_at ≥ 168 h` and calls `labctl destroy preview <pr>`. | `destroying` |
| destroy | `labctl destroy preview <pr>`: `down --volumes --rmi local` (which removes only the project's images built without an `image` key), then each tag labelled in this record's `images` only if `--tags` resolves it to an ID of this record, then each image ID of this record that no other record outside `destroyed` lists and no tag outside this record resolves to (the develop lab's `openbinding-lab-gateway:18100` included). `image rm` never uses `-f` or `--force`. Then the work tree is removed, the stored secrets are deleted and the port is released. | `destroyed` |

**Idle and activity.** `last_active_at` is the UTC time of the last of these events, all recorded by the factory:
a request or start, a refresh, an open (`labctl preview open <pr>`, which prints the tunnel command and marks the
access), and a G12 or screenshot (`lab_screenshot`) run against the preview's current head. These are not activity:
health checks, automatic restarts, `list` or `status`, the expiry sweep itself, a refused G12 or screenshot run, and
traffic the factory cannot see. A manual SSH tunnel opened without `open` counts only if `open` is run. The sweep runs
hourly, so a preview is destroyed between 168 h and 169 h of idleness. It skips records in `requested`, `starting`,
`seeding`, `destroying` or `destroyed`. `failed` and `stopped` previews age like any other. Closing or merging the PR
does not destroy the preview: the same 7-day rule applies, and the operator can destroy it earlier. Pushing to the PR
starts and refreshes nothing.

## 3. State record

One JSON document per preview lives in the factory's lab state at
`<factory-state>/projects/openbinding/previews/pr-<n>.json`. It is outside the repository and outside every Docker
volume. The factory writes it atomically (temporary file, then rename) under one lock per project. For the planner,
the manager assembles the records into `{"records": [...]}`.

```json
{"pr": 42, "head_sha": "<40 hex>", "pending_head_sha": "<40 hex or null>", "previous_head_sha": "<40 hex or null>",
 "port": 18101, "project": "openbinding-pr-42", "compose_file": "compose.lab-process.json",
 "volumes": ["openbinding-pr-42_lab-pg-3", "openbinding-pr-42_lab-redis", "openbinding-pr-42_lab-artifacts-2", "openbinding-pr-42_lab-e2e"],
 "images": [{"id": "sha256:<64 hex>", "tag": "openbinding-lab-gateway:18101"}, {"id": "sha256:<64 hex>", "tag": "openbinding-pr-42-web"}],
 "mem_mib": 4032,
 "status": "requested|starting|seeding|ready|stopped|failed|destroying|destroyed",
 "created_at": "2026-11-01T10:00:00Z", "last_active_at": "2026-11-01T10:00:00Z",
 "last_activity": "request|refresh|open|g12|screenshot", "error": null}
```

`images` holds image IDs. The `tag` is a label for display only: ownership and removal go by ID, because a port, and so
the tag `openbinding-lab-gateway:<port>`, can pass to another PR after a collision (§4).

The record holds no secret. The synthetic secrets of §5 live in the factory's private per-project environment store,
the one `lab_compose` already keeps, under the project `openbinding-pr-<n>`. A destroyed record is kept with the
factory reports for 90 days (ARCHITECTURE §10, row "Factory and gate reports"). `labctl preview list` reports orphans:
projects named `openbinding-pr-*` with no record, or records with no project. It never deletes them. The operator
resolves them with `labctl destroy`.

## 4. Ports and names

- Range 18101–18199: 99 ports. 18100 belongs to the develop lab and is never allocated.
- Allocation: the lowest port that no record outside `destroyed` holds and that nothing listens on (the factory
  probes `127.0.0.1:<port>` and passes the busy ports as `--listening`). A port stays with its PR until destroy,
  including while the preview is stopped, unless `up` fails on a collision (next item).
- Collision: if `up` still fails with "port is already allocated", the record becomes `failed` with `port: null`.
  The port is released and the volumes and image IDs stay listed for `labctl destroy`. The next request or refresh
  allocates a free port again. Another PR may take the released port and build a new image under the same tag; the
  first PR's destroy then leaves that tag and image alone (§2, "destroy").
- Exhaustion: when no port in 18101–18199 is free (each held by a record or listened on by another process), the
  request is refused with `preview_ports_exhausted`. The answer lists the five least recently active previews as
  candidates for `labctl destroy`. Nothing is evicted automatically.
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
  worker and seed run. The port identifies one stack while it holds it. `${COMPOSE_PROJECT_NAME}` was considered:
  it needs a non-`DEMO_` reference rule in the validator and gives no benefit.
- Volumes and networks keep their keys. The project scopes them, and the existing rule "top-level volumes and networks
  carry only labels" forbids `name` and `external`, so no preview can declare a shared volume or network.
- For a preview, the factory sets `DEMO_LAB_PORT=<port>` and `DEMO_PUBLIC_ORIGIN=http://localhost:<port>` (links and
  CORS through the tunnel). It sets `DEMO_SPACE_ENABLED=false` and leaves `SPACE_API_KEY`, `SPACE_URL` and
  `SPACE_ORGANIZATION_ID` empty. `SPHERE_API_KEY` stays empty: constitution 16.2 allows only the public permanent-link
  API. `SPHERE_URL` and `SPHERE_ORGANIZATION_ID` keep the develop lab's public values.
- Secrets: `DEMO_PG_PASSWORD`, `DEMO_JWT_SECRET`, `DEMO_FERNET_KEY`, `DEMO_BIM_TOKEN` and `DEMO_SEED_PASSWORD` are
  generated once, when the preview is first started, stored in the private store of its project and kept unchanged
  through every refresh, stop and open until destroy. They cannot change in between: the PostgreSQL volume keeps the
  password it was initialised with, and G12's second `up` needs the same `DEMO_SEED_PASSWORD` as the seed
  (`docs/DEMO.md`, "Browser specs and visual QA inside the lab"). Formats follow `docs/DEMO.md`, "Variables":
  `DEMO_PG_PASSWORD` only letters, digits, `-`, `_` and `.` (it is embedded in a URL); `DEMO_FERNET_KEY` a Fernet key
  (32 random bytes, URL-safe base64); `DEMO_BIM_TOKEN` 32–127 printable ASCII characters without spaces;
  `DEMO_SEED_PASSWORD` at least 10 characters; `DEMO_JWT_SECRET` long and random. The system generator is
  `secrets`; `--seed-rng` exists only for the planner tests.
- Static rules (`lab/tests/`) change as tasks.md, S1a, lists: `published`, `image` and the local CORS origins are
  checked after expansion, with the variable unset (18100) and set (18101, 18199); 18099, 18200 and a non-numeric
  value are refused. The set of allowed defaults becomes
  `{DEMO_PUBLIC_ORIGIN:-http://localhost:18100, DEMO_LAB_PORT:-18100}`. Every `DEMO_LAB_PORT` reference must use
  the default `18100`. `docs/DEMO.md` must have a `DEMO_LAB_PORT` row. All other rules are unchanged: memory
  sum 4032, secrets, no `cap_add`, no binds, no networks keys.
- The develop lab after this change keeps the same port, origins, volumes and project. Its gateway image tag becomes
  `openbinding-lab-gateway:18100`, which costs one rebuild. The old `openbinding-lab-gateway:latest` image is then
  unused; it is retired through a factory maintenance operation (constitution 18.3, tasks.md F2), never an ad-hoc
  `docker rmi`.

## 6. Memory budget and cap

The lab memory cap is 9 GiB = 9216 MiB (INTENT §9, resources: 14 GiB RAM). One stack declares 4032 MiB (3648 MiB
steady, plus the `seed` one-shot). Admission runs on every move of a preview from absent, stopped or failed to
running: a first request, a request or `open` of a stopped or failed preview, and a refresh of a stopped or failed
preview. It allows the start only
if the sum of declared `mem_limit` of every running lab project (`--running`), plus the preview's own sum read from
its head's file (`--head-mem-mib`), stays at or below 9216 MiB: 9216 is allowed, 9217 is refused. With the develop
lab running, 4032 + 4032 = 8064, so **one running PR preview at a time**. Without the develop lab, two. Stopped
previews hold ports and disk but no memory, and are not counted. At the cap the request is refused with
`preview_capacity_reached`, naming the running previews and their `last_active_at`. Nothing is stopped
automatically. The requester runs `labctl preview stop <pr>` on a preview whose G12 is done, or waits.

SPACE stays disabled in previews (`DEMO_SPACE_ENABLED=false`) until the ARCHITECTURE §9.4 `pricing` profile lands.
That profile adds about 0.7 GiB per stack, which would put the develop lab plus one preview at about 9464 MiB, above
the 9216 MiB cap: enabling it in previews needs a new memory decision first (a higher cap, or no preview beside the
develop lab).

## 7. Failure and rollback

- A failed build during refresh: Compose recreates nothing, the old head keeps running, the record keeps `head_sha`,
  clears `pending_head_sha` and stores `error`.
- `up` or seed fails: status `failed`, then `down` without `-v`. The port, volumes, images and secrets are kept,
  except after a port collision, which releases the port (§4), and the logs stay readable through `lab_compose logs`. To retry, refresh. To roll back, refresh to `previous_head_sha`.
- A database that cannot migrate (for example after a force-push to an older schema): `labctl destroy preview <pr>`,
  then a new request. Data is synthetic, and the new start generates new secrets.
- Rolling back the repository change means reverting the Compose parameterisation. Because the default is 18100, the
  develop lab runs either version. The `lab_compose` validator change must land first (§9, F1), or the develop lab
  would refuse the new file.

## 8. Security

- Loopback only: `host_ip: 127.0.0.1` stays a static rule. The factory compares the interpolated port with the
  allocated one before `up`.
- No privileges: the forbidden keys (`privileged`, `cap_add`, `devices`, `pid`, `ipc`, `secrets`, …) stay refused.
  The supervisor drops every capability. Rootless Docker keeps the host's loopback unreachable from containers.
  This is an assumption, to be confirmed by `lab/tests/test_preview_isolation.py`, a live probe run from preview A
  (slice S4):
  - It runs only when `OPENBINDING_LAB_PROBE=1`. With that variable set, a missing lab, Docker or preview fails the
    test instead of skipping it. S4's evidence is a pytest run with 0 skipped.
  - Precondition: the develop lab is stopped, because develop plus two previews (3 × 4032 MiB = 12096 MiB) exceed the
    9216 MiB cap; or the probe uses two small stand-in projects named `openbinding-pr-*`.
  - Client: `docker exec` in A's `gateway` container of `python -c` with a `socket.create_connection` (5 s timeout)
    that prints `ok` or the `errno` name of the failure and exits 0.
  - Negative: from a container of A, B's port is refused through the host-side gateway address of A's network (not
    `127.0.0.1`, which is A's own loopback). The client must print `ECONNREFUSED`; a timeout, another errno or a
    non-zero exit of `docker exec` fails the test. Controls: the same client connects to A's own `web:8080` (`ok`),
    B's port answers from the host at `127.0.0.1:<B port>`, and A's `web` resolves to A's own container address,
    which differs from B's.
- Secrets: only `${VAR}` references with no default, and synthetic values generated per preview. No SPACE or SPHERE
  key and no production value is ever placed in a preview environment.
- Isolation: one network and volume set per project, no external or named shared ones, no bind mounts.
- PR code runs in the lab: only open PRs whose head branch is in this repository get a preview
  (`preview_pr_not_eligible` otherwise). Each `up` goes through `lab_compose validate`, so an edit to
  `compose.lab*.json` that breaks a validator rule (port, memory, binds) is refused.
- Retention: ARCHITECTURE §10 says "Lab previews | lab Docker volumes | expire after 7 idle days; develop preview is
  permanent". This change implements that row for volumes. Images, the work tree and the state record also go with
  the preview (§2, "destroy"; the destroyed record follows the reports row). Slice S4 extends that row to name them;
  ARCHITECTURE.md is outside this change, so that edit is a follow-up for the coordinator.

## 9. Implementation files

Repository (it can do these alone):

| File | Reason |
|---|---|
| `compose.lab.json` | `DEMO_LAB_PORT` in `published`, the image tag and the local CORS origins (§5) |
| `compose.lab-process.json`, `compose.lab-process-n2.json`, `compose.lab-process-n1-probe.json`, `compose.lab-process-n2-probe.json` | the same six lines, so they still equal the base outside `bim-service` |
| `lab/tests/test_lab_compose.py` | port, image and CORS rules after expansion; allowed defaults; `DEMO_LAB_PORT` row in `docs/DEMO.md` |
| `lab/tests/test_lab_compose_config.py` (new) | `docker compose config --format json` of the base file, compared with the expected port, image and CORS |
| `lab/tests/test_lab_process_profiles.py` | the published port it compares (`rules.PUBLISHED`) |
| `openbinding-gateway/tests/test_container_hardening.py` | `SHARED_IMAGE` and `ALLOWED_DEFAULT_REFERENCE` follow the new references |
| `lab/previews/previews.py` (new) | the planner of §1 |
| `lab/tests/test_previews.py` (new) | planner tests of every ADDED requirement, through the CLI of §1 |
| `lab/tests/test_preview_isolation.py` (new) | live isolation probe (§8) |
| `docs/DEMO.md` | `DEMO_LAB_PORT` row, the image tag, a short "PR previews" section |
| `docs/previews/README.md` | from plan to the runbook in force |
| `TESTING.md`, `docs/qa/E2E_PLAN.md` | G12 against a preview port as well as 18100 |
| `openspec/specs/lab-deployment/spec.md` | archive task only |

Factory supervisor (outside this repository; the repository cannot do these):

- `lab_compose` validator: accept `published` as `${DEMO_LAB_PORT:-18100}` and check the interpolated value is in
  18100–18199. Accept the interpolated gateway image tag and the second defaulted reference. Take a project-name
  argument and keep one stored environment per project.
- `labctl preview request|list|open|refresh|stop|expire` and `labctl destroy preview <pr>`, the state store of §3, the
  hourly expiry sweep, activity from G12 and `lab_screenshot`, the head check before G12 and `lab_screenshot`
  (`preview_head_stale`), the eligibility check, memory admission, the port probe and per-preview secret generation.
- G12 pointed at the preview project of the PR head instead of `openbinding-lab`.
- The retirement of the unused `openbinding-lab-gateway:latest` image after S2, as a maintenance operation.
- The OFT trace (G6 in `.agentic/project.yaml`) does not include `lab/`, so the tags of `lab/tests/` and
  `lab/previews/` are not traced until it is added.

## 10. Slices and size

| Slice | Content | Estimated diff lines |
|---|---|---|
| S1b tests first (planner) | `test_previews.py`; it calls the planner CLI through a subprocess, so the base fails by assertion, not by import | ~220 |
| S3 planner | `lab/previews/previews.py` and its CLI; S1b turns green | ~160 (+ ~220 of S1b in the same PR) |
| S1a tests first (rules) | changed static rules and hardening constants, `test_lab_compose_config.py`, frozen first, red on the base | ~120 |
| S2 compose parameterisation | 5 Compose files (6 lines each) and the `DEMO.md` variable row; S1a turns green | ~75 (+ ~120 of S1a in the same PR) |
| S4 docs | `docs/DEMO.md` section, runbook in force, `TESTING.md`, `E2E_PLAN.md`, isolation probe | ~110 |

Order: S1b+S3 first; then S1a+S2, which is not merged until the factory's validator change (F1) is done; then the
factory's `labctl preview` (F2), whose acceptance needs the parameterised file of S2; then S4, which follows S2 and F2.
S1a and S1b are never merged alone: they travel in the PRs of S2 and S3, so `develop` stays green. S3 + S1b is above
300 lines with its tests; the size rule counts only non-test lines (`.agentic/project.yaml`,
`change_size_limit_lines`), and S3 alone is ~160.

## 11. Open questions (not blocking)

- Should a running preview stop automatically after a number of idle hours, to free the single memory slot? Not
  specified here. Today, stopping is manual.
