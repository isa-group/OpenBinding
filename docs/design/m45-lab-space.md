Status: PROPOSED (2026-10-26), design only. Nothing here was run; items not read from a file are marked UNVERIFIED.

# Design: ROADMAP M4.5, the lab and the previews run with the local SPACE by default

Acceptance (ROADMAP M4.5): seed users have contracts; previews show real plans.

**The CRP.** The owner answered `crp-ob-m4-plans-decisions` with `accept-all` (own-7153cec8d5a447fa909601bc7ad8fe4d), but
its text is not in the repository. Where it may have chosen, this design takes what ADR-0015 and the ROADMAP imply and
marks it **to verify against the accepted CRP** (TVC).

## 0. Starting point (read from the files)
- `compose.lab.json` (4032 MiB) already passes `SPACE_ENABLED`, `SPACE_URL`, `SPACE_API_KEY`, `SPACE_SERVICE_NAME`,
  `SPACE_PRICING_VERSION`, `SPACE_DEFAULT_PLAN` to `gateway` and `worker`. `compose.lab-pricing.json` is the separate
  project `openbinding-lab-pricing` (992 MiB; 1088 with `pricing-bootstrap`), no ports, no `networks`.
- Previews run `compose.lab-process.json`, force `DEMO_SPACE_ENABLED=false` and blank `SPACE_URL`, `SPACE_API_KEY`,
  `SPACE_ORGANIZATION_ID` (`previews.py`: `EMPTY_ENV`). Admission sums the `mem_limit` of the stacks in `--running` plus
  the head's own, cap 9216 MiB (`admit`, `CAP_MIB`).
- The bootstrap makes one contract per synthetic user with one plan for all (`SPACE_BOOTSTRAP_PLAN`, default `FREE`),
  user ids `uuid5(SEED_NAMESPACE, "user:<name>")`, those of `seed_lab.py`. Plans of pricing 0.2.0: `FREE`, `RESEARCH`, `LAB`.
- `compose.lab*.json` services may not carry `networks`; top-level `networks`/`volumes` carry labels only
  (`test_lab_compose.py`).

## 1. How the gateways reach SPACE

### 1.1 Options

- **A. Fold into `compose.lab.json`** (one SPACE per stack): default network, `http://space-api:3000`, no exception.
  Every stack is 5120 MiB, so develop + one preview is 10240 MiB (refused). `EXPECTED_MIB` and `MAX_MIB` change, and
  `test_compose_lab_keeps_no_space_service` and `test_no_local_space` are rewritten; every process variant repeats it.
- **B. Separate project, one shared SPACE**, with a recorded exception: develop + one preview is 9152 MiB (fits). Contracts
  and usage counters are shared (§2.2).

Rootless Docker keeps the host loopback unreachable from containers (m05-pr-previews design.md §8), so B cannot publish
a port on the host.
**Recommendation: B.** A cannot fit a preview beside the develop lab (4032 + 4032 + 1088 = 9152 of 9216 MiB needs one
SPACE) and needs a higher cap that nobody has decided (m05-pr-previews design.md §6). B keeps `compose.lab.json` free of
SPACE services, so `no-local-space` and `test_compose_lab_keeps_no_space_service` stay true. TVC: ADR-0015 §5 says
"each stack runs its own pinned SPACE", which reads as A; B departs from it and needs the owner's confirmation and a
short ADR (revision of ADR-0015 §5, or a new one).

### 1.2 The wiring (option B)

- The pricing project joins a network `lab-pricing-net` (explicit `name:`). `compose.lab.json` and the process variants
  declare it `external: true`; only `gateway` and `worker` list `networks: [default, lab-pricing-net]`; `web`,
  `postgres`, `redis`, engines, `seed` and `e2e` stay on the default network. `space-api` lists the same two networks;
  `space-mongo`, `space-redis` and the bootstrap stay private. The name avoids the element `space` that
  `_local_space_problems` flags.
- Compose aliases each service name on every network it joins. Nothing in a stack resolves `gateway` through the shared
  network, so there is no clash. Cost: a preview's `gateway` can reach another preview's `gateway` on port 8000
  (synthetic data, no published port, authentication required): risk R2.
- `SPACE_URL` stays the supervisor reference `${SPACE_URL}` with the value `http://space-api:3000`, so M4.6 changes a
  value and not a manifest. UNVERIFIED: that the gateway accepts an `http` SPACE URL with `APP_ENV=dev` (`settings.py`
  not read for this).
- Alternative B2: no manifest exception; the factory runs `docker network connect --alias space-api` into each stack's
  default network at start. Stacks see only SPACE, but it needs new factory code, is lost when SPACE is recreated and
  cannot be checked statically. Choose it if the owner rejects R2.

### 1.3 The recorded exception

The rule "no `networks` in `compose.lab*.json`" gains one allowance: exactly `[default, lab-pricing-net]` on `gateway` and
`worker`, the top-level `lab-pricing-net` with `external: true` and nothing else, and the external key volume of §1.4.
Everything else stays forbidden. `test_lab_compose.py` becomes an allow-list test.

### 1.4 `SPACE_API_KEY` and the MANAGEMENT key (owner question 3)

`modules/plans` needs a `MANAGEMENT`-scoped key (ARCHITECTURE §9.2). The bootstrap keeps it in memory by design
(m41-space-bootstrap design.md §5: "ASSUMPTION pending question 3: the key stays inside SPACE"), while ARCHITECTURE §9.4
says "kept in the stack's secret store". The gateway needs the value, so the key cannot stay only inside SPACE.

1. The supervisor supplies a value that SPACE adopts. UNVERIFIED that SPACE 1.7.1 lets the caller choose it.
2. The bootstrap hands the key to the supervisor. Refused: the tool never prints a key, and the controller cannot open
   volumes.
3. The bootstrap writes the key to a named volume that the stacks mount read-only.

**Recommendation: 3, unless a live check shows 1 works.** TVC.

- Volume `lab-pricing-key` (fixed `name:`), declared in the pricing project, written only by `pricing-bootstrap`, mounted
  read-only at `/run/space-key` in `gateway` and `worker` (`external: true`). File `key`, mode 0400, written
  atomically on every successful run. The bootstrap image user must be the gateway image user (10001), because the lab
  drops `CAP_CHOWN` (docs/DEMO.md, "Unprivileged containers"). UNVERIFIED: the user of `lab/tools/Dockerfile`.
- No gateway code change: like the BIM token, the start command gains
  `test -s /run/space-key/key && SPACE_API_KEY="$(cat /run/space-key/key)"` before `exec` (same for the dramatiq
  command), so a stack without a key does not start open. `SPACE_API_KEY` leaves the `environment` blocks and the
  supervisor stops providing it; `SPACE_ORGANIZATION_ID` leaves `seed` (§3.4).
- It changes the bootstrap contract ("keys live in process memory only"): revision 2 of the requirement
  `lab-space-bootstrap-sphere-readonly`, ADR-0022 consequences and the runbook sentence.
- Blast radius: the key opens only the lab SPACE (synthetic contracts, public pricing), shared by all stacks (R3).

`DEMO_SPACE_ENABLED=true` in the develop lab and the previews (§4); `OpenGate` stays for unit tests only.

## 2. One SPACE per stack or one shared

### 2.1 Memory arithmetic (declared `mem_limit`, host cap 9216 MiB, spare in MiB)

| Layout | Sum | Fits 9216 |
|---|---|---|
| A (per stack): develop only / develop + 1 preview / 2 previews | 5120 / 10240 / 10240 | yes / no / no |
| B (shared): develop only | 4032 + 1088 = 5120 | yes |
| B: develop + 1 preview, or 2 previews without develop | 2 x 4032 + 1088 = 9152 | yes (64 spare) |
| B: develop + 2 previews | 12224 | no |

In general `1088 + 4032 x (previews + develop)` is at most 9216, so previews + develop is at most 2: today's "one preview
beside the develop lab" (m05-pr-previews design.md §6). These are declared limits; steady use is lower (UNVERIFIED).

`--running` must list the pricing project (1088 MiB) whenever it runs. `previews.py` sums whatever it is given, but the
factory (F2) must report it; otherwise a second preview is admitted and the host is exceeded.

### 2.2 Consequences of sharing

- Contracts are keyed by the deterministic `uuid5` id, so a preview's `lab-owner` and the develop lab's `lab-owner` are
  one SPACE user with one contract and shared usage levels (`solverHours`, `generatedInstances`, monthly).
- A G12 run in a preview can consume the develop lab's hours (R4). Mitigation: users that run real work get `RESEARCH`
  or `LAB` (§3.1). Per-stack user ids would isolate counters but touch `seed_lab.py` and the bootstrap, whose shared
  namespace a test compares: not recommended.

### 2.3 Teardown and volumes (ADR-0019)

- `labctl destroy preview <n>` removes only the preview's own volumes (`VOLUMES` in `previews.py`:
  `openbinding-pr-<n>_lab-pg-3`, `_lab-redis`, `_lab-artifacts-2`, `_lab-e2e`) and images, so the planner already
  excludes `lab-pricing-mongo`, `lab-pricing-redis` and `lab-pricing-key`; `external: true` keeps `down` of a stack from
  deleting the key volume. A destroyed preview leaves nothing in SPACE: the shared contracts serve the next stack.
- Retention (ARCHITECTURE §10): the pricing volumes follow the develop lab (permanent, removed only by an explicit
  `labctl destroy` of the pricing project); §10 gains a row in slice S5. The pricing project has no PR record, no idle
  expiry and no port.

## 3. Seed users have contracts

### 3.1 Per-user plans

One plan (`SPACE_BOOTSTRAP_PLAN`) covers all six users today. The bootstrap gains `SPACE_BOOTSTRAP_PLANS`, a comma list
`user=PLAN`, with `SPACE_BOOTSTRAP_PLAN` as the default for users not listed. Proposed lab values (TVC):
`lab-owner`, `lab-orgadmin`, `lab-member`: `RESEARCH` (real solver hours for G12 runs); `lab-admin`: `LAB`;
`lab-viewer`, `lab-outsider`: `FREE` (the only users that meet limits and the pricing-change scenario of M4). Unknown plan
names fail the run before any write (the plan must be a key of the active pricing).

### 3.2 Idempotency

Existing rule: lookup before each create (organization, key, service, contract). Added: a contract that exists with
another plan is reported `exists` with a `plan_differs` warning in the JSON line and is not changed (the tool has no
update path, and after a pricing change SPACE migrates contracts itself, ARCHITECTURE §9.4).

### 3.3 Start order (no cross-project `depends_on`, so a factory sequence for `lab_compose`)

1. Pricing project `up --wait` (databases and `space-api` healthy, then `pricing-bootstrap` exits 0). UNVERIFIED: that
   `--wait` accepts a one-shot that exited 0; if not, the bootstrap writes a marker `/run/space-key/done` that the
   factory polls.
2. Stack `up`: `gateway` and `worker` start only if the key file exists (§1.4).
3. Stack `seed` (users with deterministic ids).

Contracts exist for the six ids before the users do. With the pricing project down a stack fails closed (no key file, or
`503 pricing_unavailable`, docs/DEMO.md). Users registered later get a contract from the plans module (default plan
`DEMO_SPACE_DEFAULT_PLAN`), not from the bootstrap.

### 3.4 What the seed stops doing

`seed_lab.py --space-contracts` (SpaceRemote, `SPACE_ORGANIZATION_ID`) and its guard that refuses the service
`openbinding` (docs/DEMO.md, `SPACE_PROD_SERVICE_NAME`) were written for a remote SPACE shared with production. With a
lab-private SPACE, `openbinding` is the right name and the guard would refuse it (m41-space-lab-profile design.md §7).
Recommendation: contracts come only from the bootstrap; the lab stops using `--space-contracts`; the guard stays for
remote runs and is relaxed only when `SPACE_URL` is `http://space-api:3000`. The lab sets
`DEMO_SPACE_DEV_SERVICE=openbinding`, `DEMO_SPACE_PRICING_VERSION=0.2.0`, `DEMO_SPACE_DEFAULT_PLAN=FREE`, and the smoke
runs `--with-space`, so `plan_usage` runs for the first time.

### 3.5 Recovery

- Bootstrap exit 1: stacks stay down or fail closed; read the one-line stderr, fix, re-run. A one-shot with an unchanged
  config may not run again under `up`: use `down` then `up` (volumes are kept) or `run --rm pricing-bootstrap`
  (UNVERIFIED for the installed Compose).
- Service created but never synchronized: delete the service in SPACE and re-run (runbook).
- Mongo volume recreated: the bootstrap creates a new key and rewrites the file; restart the gateways. Wrong plan on a
  contract: delete it and re-run. Changed `DEMO_SPACE_MONGO_PASSWORD`: remove `lab-pricing-mongo` (runbook).

## 4. The DEMO_SPACE_* variables and the missing preflight

Required before bring-up of the pricing project: `DEMO_SPACE_JWT_SECRET`, `DEMO_SPACE_JWT_SALT`,
`DEMO_SPACE_ADMIN_PASSWORD`, `DEMO_SPACE_MONGO_PASSWORD` (runbook "Variables"). They belong to the pricing project: the
supervisor generates them once and keeps them, never per preview, so `previews.py` `SECRETS` does not change. Compose
turns an unset variable into an empty string, and no preflight refuses it.

- In-repo fix: write them as `${DEMO_SPACE_X:?required}`, so `docker compose config` and `up` fail on an unset or empty
  value (UNVERIFIED for the installed Compose). `rule_secrets` allows no `$` outside the four bare references, so the
  test learns this one form (it is not a default).
- Factory fix: `lab_compose validate` and `up` refuse any `${DEMO_*}` that is unset or empty (F-preflight).
- Previews planner: `DEMO_SPACE_ENABLED` becomes `true`; `EMPTY_ENV` loses `SPACE_URL`, `SPACE_API_KEY` and
  `SPACE_ORGANIZATION_ID`; it adds `SPACE_URL=http://space-api:3000`, `DEMO_SPACE_DEV_SERVICE=openbinding`,
  `DEMO_SPACE_PRICING_VERSION=0.2.0`, `DEMO_SPACE_DEFAULT_PLAN=FREE`, and refuses (`preview_space_unavailable`) when the
  pricing project is not in `--running`. `SPHERE_API_KEY` stays empty (constitution 16.2). The requirement
  `preview-synthetic-only` and the DEMO.md variable table are revised.

## 5. `lab_compose file=` support (factory follow-up F1)

`compose.lab-pricing.json` has its own `name`, and `docs/DEMO.md` already activates the process variants with
`lab_compose up file=...`. The factory code is not in this repository (UNVERIFIED which behaviours exist). The factory must:

- accept `file=compose.lab-pricing.json` for `validate`, `up`, `down`, `logs`, `status`, `metrics`, `destroy`, with the
  project taken from the manifest `name`, so `down` of one project never removes the other's containers;
- let the validator accept `build`, `restart`, the external network and volume and the §1.3 allow-list;
- report the pricing project in `--running` (F2), run the sequence of §3.3, inject `DEMO_SPACE_*` once, refuse empty
  variables, and keep `labctl destroy preview` away from `lab-pricing-*`.

OpenBinding changes the manifests, the static tests (which mirror the validator) and the `:?` form (§4). Until F1 lands
no slice is accepted live; the static slices can merge.

## 6. Tests that change and the follow-on slices

### 6.1 Tests

- `lab/tests/test_lab_pricing_profile.py`: four services (`pricing-bootstrap`); `rule_isolated` allows `build`, `restart`,
  the `lab-pricing-net` network and the `lab-pricing-key` volume; `rule_images` retires the GAP marker; the sum becomes
  1088 (`LIMITS` gains 96, `MAX_MIB` stays 1152); `${DEMO_SPACE_ADMIN_PASSWORD}` appears twice; start order exempts the
  one-shot; `rule_secrets` accepts the `:?` form; the 2 x 4032 + 1088 assertion becomes the table of §2.1.
- `openbinding-gateway/tests/test_no_local_space.py`: `_space_api_image_problems` accepts `openbinding-lab/space-api:1.7.1`
  (built, no digest) and the marker goes; `pricing-bootstrap` must not count as a SPACE service name (confirm);
  `_local_space_problems` keeps flagging a `space` network in other manifests (`lab-pricing-net` does not match).
- `lab/tests/test_lab_compose.py`: the `networks`/volume rules become the §1.3 allow-list; `EXPECTED_MIB` stays 4032.
  `lab/tests/test_previews.py` and the `m05-pr-previews` spec: new environment (§4), `preview_space_unavailable`.
- New: no stack mounts the key volume read-write, the key is in no `environment` block, `previews.py` never lists
  `lab-pricing-*`.

### 6.2 Slices

| Slice | Content | Files (owner) |
|---|---|---|
| S0 | Owner decisions of §7; the ADR for the exception (§1.3) | `docs/adr/**` (owner accepts) |
| S1 | Spec revision of `lab-deployment` (§1.3, §1.4, §3.1, §4) and bootstrap requirement revision 2 | `openspec/changes/m45-lab-space/**` (specifier) |
| S2 | Failing tests first (§6.1) | `lab/tests/**`, `openbinding-gateway/tests/test_no_local_space.py` (test-designer) |
| S3 | Compose wiring: `compose.lab-pricing.json` (bootstrap, build of `space-api`, network, key volume, `:?`), `compose.lab.json` and process variants (network, key read, `SPACE_ENABLED`), bootstrap tool (`SPACE_BOOTSTRAP_PLANS`, key file, `plan_differs`) | `compose.lab*.json`, `lab/tools/space_lab_bootstrap.py`, `lab/space/**` (implementer) |
| S4 | Preview planner and seed: environment, `preview_space_unavailable`, seed guard relaxed, no `--space-contracts` in the lab | `lab/previews/previews.py`, `openbinding-gateway/tools/seed_lab.py` (implementer) |
| S5 | Documentation: `docs/qa/PRICING_PROFILE.md` (close the GAP, wiring, key, sequence), `docs/DEMO.md` (variables, status), ARCHITECTURE §9.4 and §10, ROADMAP status | `docs/**` (doc-steward) |
| S6 | Live evidence on the lab: pricing up, six contracts, `smoke_lab --with-space`, a preview with a real plan, teardown that leaves the pricing project (needs F1, F2, preflight) | factory run; evidence in `docs/qa/**` |

Order: S0, S1, S2, then S3 and S4 (independent), S5 with them, S6 last. Split S3 if it passes about 300 diff lines.
## 7. Risks and open decisions

| # | Risk or decision | Recommended answer |
|---|---|---|
| D1 | One shared SPACE (B) against one per stack (A) | B; TVC, because ADR-0015 §5 reads as A |
| D2 | Exception to the no-`networks` rule | one allow-list entry, `[default, lab-pricing-net]` on `gateway`/`worker`; ADR before S3 |
| D3 | Where the MANAGEMENT key lives (question 3) | a read-only key volume written by the bootstrap; first check if SPACE accepts a supplied value; TVC |
| D4 | Plan per seed user; seed stops creating contracts | §3.1 mapping (TVC); bootstrap only |
| D5 | Preview start when the pricing project is down; host cap 9216 MiB (INTENT §9) | refuse the start; cap unchanged, a third running stack needs a new decision |
| R1 | The SPACE HTTP sequence, the 1.7.1 image build and every UNVERIFIED item here (`--wait` with a one-shot, `:?`, `http` SPACE URL, bootstrap image user) | check each in the live run S6 and correct this design before M4.5 is called done |
| R2 | Previews can reach each other's `gateway` through `lab-pricing-net` | accept for synthetic lab data; B2 if the owner refuses |
| R4 | Shared usage counters between develop and previews | accept; give working users `RESEARCH`/`LAB`; per-stack ids only if it bites |
| R6 | The lab and previews now need outbound HTTPS to `sphere.score.us.es` (ADR-0015) | SPACE keeps its last version when SPHERE is down; the bootstrap fails if the first sync cannot run |
| R7 | Old base images and Redis/Mongo advisories (runbook "Known advisories") | owner accepts the lab-only risk or bumps |
| R8 | M4.6 (`space.score.us.es`) retires the pricing project and the key volume | M4.6 changes `SPACE_URL` and the key supply only; remove the `lab-pricing-net` allowance then |
