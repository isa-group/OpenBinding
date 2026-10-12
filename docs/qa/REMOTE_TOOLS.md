# Remote development tools (SPACE / SPHERE) and the lab seed

Four tools in `openbinding-gateway/tools/`, with shared code in `_remote_common.py`:

| Tool | Writes | What it does |
|---|---|---|
| `remote_probe.py` | nothing (GET only) | One JSON report of the organizations in SPACE and SPHERE, and the newest pricing version without capacity units (CU). |
| `remote_provision.py` | `--apply` only | Uploads **one private development pricing `0.1.0`** to SPHERE and SPACE, behind explicit guards. |
| `seed_lab.py` | local database (+ SPACE contracts only with `--space-contracts`) | Idempotent synthetic demo data with the real roles. |

**Status: none of this has run against the real SPACE or SPHERE.** Everything was developed against
`httpx.MockTransport` simulations (`tools/tests/fakes.py`). The first lab run is the first contact with the
real APIs; section "Not verified" lists every assumption that run can break. Send back the (redacted)
output and it will be corrected.

## Ground rules the tools enforce

SPACE and SPHERE own prices, versions and contracts. These tools do not recreate that management. The
development key reaches **everything in its organization, production included**, because the development
resources live in the same organizations as production. Therefore:

- Resources are **identified, never inferred by name similarity**. Production and base resources are named on
  the command line and must exist remotely; the development target must **not** exist.
- Never: delete or update a version, overwrite an existing `0.1.0`, publish, touch a resource named as
  production, retry a rejected upload with another format. Development pricing is uploaded private.
- The tools have no `DELETE`/`PUT` code path for pricings or services (tests assert that only `GET` and
  `POST` ever reach the simulated remotes), and no `remove_contract` / `adjust_usage`.
- If the target collides, the tool stops with exit code 3 and prints the identity; choose **another**
  development slug/service name. The earlier resource is left as it is.

## Environment

The `SPACE_*`/`SPHERE_*`/`DEMO_*` variables are read from the process environment only (the supervisor injects
them into Docker); the tools open no `.env` file. The one exception is `seed_lab.py`, which takes `DATABASE_URL`
and `APP_ENV` through the gateway's `Settings`, and those honour a `.env` in the working directory like the
gateway itself.

| Variable | Rule |
|---|---|
| `SPACE_URL`, `SPHERE_URL` | https origin only: no credentials, path, query or fragment (clients add `/api/v1`). |
| `SPACE_API_KEY`, `SPHERE_API_KEY` | Non-empty, printable ASCII, no spaces. Sent as `x-api-key`. **Never printed**, never in exceptions or logs. |
| `SPACE_ORGANIZATION_ID`, `SPHERE_ORGANIZATION_ID` | Identifier characters only. Printed masked (`abcd...wxyz`). |
| `DEMO_SEED_PASSWORD` | `seed_lab.py` only. Required, at least 10 characters, no default exists anywhere. |
| `SPACE_DEV_SERVICE_NAME`, `SPACE_DEV_PLAN` | `seed_lab.py --space-contracts` only; both required. Optional: `SPACE_DEV_PRICING_VERSION` (default `0.1.0`), `SPACE_PROD_SERVICE_NAME` (extra protected name). |

Invalid configuration lists every problem by variable **name**, never by value.

**Redaction.** Everything remote (bodies, error text, exception messages) passes through `Redactor` before
it is printed: exact key values (and their URL-encoded forms), values next to `x-api-key`/`authorization`/
`token`/`secret`/`password`, and keys of that kind in JSON. Response headers are never printed. Exceptions
are reported as one redacted line, without a traceback that could chain a remote error. Organization ids are
masked; origins are printed.

**Exit codes** (`remote_provision.py`): `0` ok, `2` bad arguments/configuration or a guard refused,
`3` development target already exists, `4` a remote rejected or did not confirm a step, `5` bug in the tool.
`remote_probe.py` exits `0` whenever it could run (failed calls are inside the JSON), `2` for bad
configuration (JSON `{"ok": false, "error": ...}`), `5` for a bug.

## Commands in the lab

The scripts run inside the gateway container with its working directory at `/app`. The Dockerfile does not copy
`tools/`, so mount `openbinding-gateway/tools` read-only at `/app/tools` (same way `tests/` is mounted for the
PG harness; **not verified with lab_compose**). The six `SPACE_*`/`SPHERE_*` variables must reach the
container; `DEMO_SEED_PASSWORD` is chosen by whoever runs the seed (any synthetic value, 10+ characters).

```sh
# 1. Read-only survey. Send the JSON back (it contains digests and names only).
python tools/remote_probe.py
python tools/remote_probe.py --sphere-slug some-slug --sphere-slug other-slug   # slugs to inspect besides the known "openbinding"

# 2. Plan: reads, writes nothing, prints every guard and the exact upload.
python tools/remote_provision.py \
  --base-pricing-slug SLUG --base-version X.Y.Z --base-digest sha256-HEX \
  --dev-slug NEW-DEV-SLUG --dev-service-name NEW-DEV-SERVICE \
  --prod-slug PROD-SLUG --prod-service-name PROD-SERVICE

# 3. Apply: the same command plus --apply (only after reading the plan).
python tools/remote_provision.py --apply <same arguments>

# 4. Local demo data (database from the gateway settings: DATABASE_URL).
DEMO_SEED_PASSWORD=... python tools/seed_lab.py
DEMO_SEED_PASSWORD=... python tools/seed_lab.py --print-keys          # also prints the derived API keys
DEMO_SEED_PASSWORD=... SPACE_DEV_SERVICE_NAME=... SPACE_DEV_PLAN=... python tools/seed_lab.py --space-contracts
```

The base arguments come from the probe's `candidates.mostRecentWithoutCu` (`slug`, `version`, `digest`); the
production names are the ones the probe shows for the organization's real pricing/service.

## remote_probe.py

Single JSON document on stdout, sections:

- `config`: origins, masked ids, whether each key is configured (never the key).
- `space`: `healthcheck`; `services` (name, id, `disabled`, versions with status, whether the service's
  organization matches `SPACE_ORGANIZATION_ID`); `contracts.available: false` because the official
  `space-python-client` has no contract listing or count (see "Not verified").
- `sphere`: `visibleOrganizations`, `organization` (name/displayName: this is how the organization is
  identified), `slugListing` (whether the API lists slugs; otherwise only `openbinding` and `--sphere-slug`
  values are inspected), and per slug/version: `private` (`true`/`false`/`null` when SPHERE does not say),
  `apiCreatedAt`, the YAML's `createdAt` with `createdAtKind` (`date`/`datetime`/`other`/`missing`) and
  `createdAtFormat`, `createdAtQuoted`, `digest` (`sha256-<hex>` of the exact bytes), `saasName`, the CU scan
  and the names of the usage limits (`limitNames`, `planLimitNames`). No YAML body is printed.
- `capabilities`: each read call with its status and verdict (`allowed`/`unauthorized`/`forbidden`/
  `not-found`/`unreachable`/`error`), and `denied` (401/403). Write scope cannot be observed without writing.
- `candidates`: `mostRecentWithoutCu` with `why`; `ranking` (top 5); `excluded` (with CU, unreadable, not
  downloadable); `ambiguous` if another version ties on `createdAt` and version order.

Candidate criterion: latest YAML `createdAt` (a date means 00:00:00Z) among versions whose scan is `clean`;
ties by numeric dotted version order. A document that cannot be parsed is never considered clean.

**CU scan** (`scan_cu`, deterministic): flags (a) any key named `capacityUnits`, `taskStarts`, `solverSeconds`,
`federatedTaskStarts`, `concurrentJobs` or `studyRuns` anywhere in the document (case/separator-insensitive),
(b) any usage limit (top level, plan limits, add-on extensions) whose name or unit suggests credits, CU/capacity
units, or solver time (words credit(s), `cu`, capacity+unit, compute+unit, solver together with second/minute/
hour/time), and (c) feature expressions that reference a forbidden counter. Description text is not scanned.
Note that the repository's own test fixture `tests/fixtures/pricing_test.yml` declares `concurrentJobs`, so it
is flagged; that is correct for this scan.

## remote_provision.py

All identifying arguments are required, in both modes. `--plan` (default) performs the same **reads** as
`--apply` and prints every guard, so a plan that exits 0 is a plan whose guards passed; it writes nothing.

### Guards

| Guard | Negative case covered by tests |
|---|---|
| `dev-names-valid`: `[a-z0-9][a-z0-9_-]{1,62}` | uppercase, too short, spaces |
| `dev-slug-is-not-production` / `dev-service-is-not-production`: differ from `--prod-slug`, `--prod-service-name` and the reserved name `openbinding` | dev = prod slug; dev = prod service; reserved name |
| `dev-slug-is-not-base` | dev slug = base slug |
| `base-digest-format`, `base-version-format` | malformed values |
| `sphere-organization-identified`: `GET /orgs/{id}` works (name printed) and reports that id | — |
| `space-organization-identified`: healthcheck + `GET /services` work and no service belongs to another organization | services of another organization |
| `production-slug-identified`, `production-service-identified`: they exist remotely | missing slug / service |
| `base-version-found` (exactly once), `base-digest-matches` (digest of the re-downloaded YAML equals `--base-digest`), `base-has-no-cu` (re-scan) | missing version, digest mismatch, CU present, unreadable base |
| `dev-slug-state-known`, `dev-service-state-known`: absence/presence could be established | 500 answers |
| collision: the dev slug has **any** version in SPHERE, or the dev service exists in SPACE | exit 3 with identity (`has010`, `private`, SPHERE `digest`) |
| `dev-yaml-built`: only `version`, `createdAt`, `saasName` differ from the base, and the result scans clean | unparsable/duplicate-key bases |

Static guards run before any network call. Exit 3 is used only when the sole problem is a collision.

### The YAML (`build_dev_yaml`)

The base text with three top-level lines replaced by targeted edits; every other byte is kept, and a
semantic check (`parse(result) == parse(base) + the three keys`) must hold:

- `version: 0.1.0`
- `createdAt: '<now UTC>'` as `YYYY-MM-DDTHH:mm:ssZ` (`core/timeutil.py::utc_timestamp_z`), **always quoted**
  (the base's quote character is kept, single quotes otherwise; inserted after `version:` if absent). The
  parse -> serialize round trip of that line is verified. The ISO date-time format is the one required by the
  human and is **never changed silently**.
- `saasName: <--dev-service-name>`. This is the one change besides the two required ones, and it is a
  deliberate decision: SPACE names a service after the document's `saasName`, so uploading the base's
  `saasName` would add a version to the base's own (production) service. If that assumption is wrong the tool
  still uploads a document whose `saasName` is the development name, which is harmless.

The same bytes go to SPHERE and SPACE. `--plan` shows `createdAt` as of that run; `--apply` recomputes it, so
the digest of an applied upload differs from the plan's.

### Apply, in order

1. SPHERE: `POST /api/v1/pricings/{orgId}` (default, `--sphere-endpoint create`) or
   `POST /api/v1/pricings/{orgId}/{devSlug}/0.1.0` (`--sphere-endpoint version`), multipart file `yaml`,
   fields `private=true`, `saasName`, `name` (= dev slug), `version`. There is no code path that sends
   `private=false`, and the client refuses protected slugs. Then it re-reads the slug: the version `0.1.0`
   must be listed exactly once with `private == true` and its YAML digest is compared with what was sent
   (a difference is reported as `digestMatchesUpload: false`, not as failure). `private == false` or an
   unreported flag stops the run with exit 4 (`PUBLIC EXPOSURE` / `visibility not reported`) **before SPACE**;
   fixing it is done in the SPHERE console, the tool changes nothing.
2. SPACE: `POST /api/v1/services`, multipart file `pricing`: a native private upload of the same bytes, not the
   `sphere` + `permanentUrl` link (documented only for public pricings). The client refuses a document whose
   `saasName` is missing or protected. Then the tool re-reads the service and requires version `0.1.0`.
   SPACE has no documented public/private flag; the service stays as SPACE created it and the report says so.
3. Re-reads the production slug and service: their version lists must equal the ones before the run
   (`production.unchanged`).

Any non-2xx answer is reported literally (status plus the redacted body, truncated at 2000 characters) with exit
4 and is **not retried**: in particular if SPACE or SPHERE rejects `createdAt` with a time, the report says so
and the format stays as the human specified. A failure after SPHERE succeeded leaves the SPHERE private
version in place (nothing is deleted); rerunning with the same names exits 3, so use another dev slug and
service name.

Report fields: `guards`, `arguments`, `base` (digest, metadata, CU scan), `production` (before/after),
`collisions`, `plan` (YAML facts incl. `changes`, the exact calls, UNVERIFIED notes), `steps` (request status,
verification, ids), `outcome`.

## seed_lab.py

No import-time effects, no `--reset`, nothing deleted, no jobs/studies/solvers. Rows are found by stable keys
and created only when missing (UUIDv5 ids by username/slug under a fixed namespace):

- Users (`lab-*@example.org`, all with `DEMO_SEED_PASSWORD`): `lab-admin` (`UserRole.ADMIN`, no memberships),
  `lab-owner` (OWNER), `lab-orgadmin` (ADMIN), `lab-member` (MEMBER), `lab-viewer` (VIEWER) in `lab-main`, and
  `lab-outsider` (OWNER of `lab-other`, a different organization). Platform roles `USER`/`ADMIN` and all four
  `OrganizationRole`s are exercised. The `lab-` prefix keeps them apart from `seed_dev.py` users.
- Project `lab-main/bim-demo` (private) with case `simple-seq` built from `examples/demo/01_simple_seq` through
  the library (named artifacts, sealed versions, snapshot, case revision), as `seed_dev.py` does (the helper
  was extracted, not imported, because `seed_dev.py` changes `sys.path` and the environment on import).
- One API key per user, derived by HMAC from `DEMO_SEED_PASSWORD`, stored hashed, printed only with
  `--print-keys`. A changed password updates the password hashes and adds new derived keys; the old keys are
  not deleted. An unchanged password is not re-hashed, so a rerun changes nothing.
- The seed installs the gateway's open pricing gate while it runs (storing library content consults the
  sponsor's storage allowance) and restores the previous gate afterwards; the lab data ignores SPACE plans.
- Refuses `APP_ENV=prod`.

`--space-contracts` (SPACE keys required): only when `SPACE_DEV_SERVICE_NAME` **and** `SPACE_DEV_PLAN` are set
and the name guard passes (valid name; not `openbinding`; not `SPACE_PROD_SERVICE_NAME`). It first requires the
service to exist in SPACE, then, for each synthetic user whose email ends in `@example.org`, reads the contract
and creates one (plan `SPACE_DEV_PLAN`, version `SPACE_DEV_PRICING_VERSION`) with the official client only when
none exists, then reads it back. Existing contracts are never changed (a contract without the dev service is
reported as skipped); `remove_contract` and usage adjustments are not exposed by the wrapper.
Contract and user ids are the stable UUIDv5s, so they cannot collide with real accounts.

## Tests

```sh
cd openbinding-gateway && uv run --locked pytest tools/tests
```

`test_remote_common.py` (environment, redaction, createdAt, digests, CU scan, tolerant parsers),
`test_remote_probe.py` (simulated organizations, denied/unreachable/malformed answers, candidate ordering),
`test_remote_provision.py` (plan, apply, one negative test per guard, collisions, createdAt rejection without
retry, YAML builder), `test_redaction.py` (the synthetic keys never reach stdout, stderr, logs, exceptions or
tracebacks even when the simulated remote echoes them), `test_seed_lab.py` (SQLite in memory, real roles,
idempotence, SPACE contracts against a simulated SPACE). No test uses the network.

## Not verified

Nothing below has been checked against the real services; each item is isolated so the first lab output shows
which one failed.

1. **SPHERE slug listing** `GET /pricings/{orgId}?includePrivate=true` may not exist; the probe then reports
   `slugListing.available: false` and inspects only `openbinding` and `--sphere-slug` values.
2. **SPHERE creation of a new pricing** with `POST /pricings/{orgId}` in an organization that already has
   pricings (the known description says "first pricing of an organization"), the meaning of the `name` field,
   and whether SPHERE derives the slug from `saasName` instead of `name`. The upload verification looks for the
   version under `--dev-slug`; if it is not there the tool exits 4 and says so. `--sphere-endpoint version`
   tries the per-version endpoint instead (it may reject a slug that does not exist yet).
3. **SPHERE visibility field**: read from `private`, `isPrivate` or `visibility`; if none is present the
   result is "not reported" and the apply stops (exit 4) before SPACE.
4. **SPACE services API** (not in the SDK, which only has health, contracts and features): `GET /services`,
   `GET /services/{name}`, `GET /services/{name}/pricings`, and the response shape (`activePricings`/
   `archivedPricings` maps or lists, organization id field). Parsing is tolerant; unknown shapes are reported by
   key names (never values) and make the guards refuse rather than guess. Pagination of `GET /services` is not
   handled; collision and identification use the per-name `GET /services/{name}` as well.
5. **SPACE upload**: `POST /services` with the file in the `pricing` multipart field, and that the service takes
   its name from `saasName`.
6. **`createdAt` with a time** (`YYYY-MM-DDTHH:mm:ssZ`) may be rejected by SPACE's or SPHERE's native parser;
   the tool reports the answer and exits 4 without retrying another format.
7. **Key scopes**: SPACE needs `ALL` or `MANAGEMENT` to mutate; the probe cannot test this without writing, and
   the first write attempt will show a 401/403.
8. **Contract counts per service** are not reported: the SDK has no listing/count operation and no undocumented
   endpoint is called. `--space-contracts` relies on the SDK answering `404` (or `null`) for a missing
   contract and on `ContractToCreate` being accepted with the development service name and plan.
9. `SpaceRemote` replaces the SDK's private `_http_client` only when a test passes a simulated transport.
10. The lab mount of `tools/` at `/app/tools` and the exact `lab_compose seed` invocation are not verified.
