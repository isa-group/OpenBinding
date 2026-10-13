# Remote development tools (SPACE / SPHERE) and the lab seed

Four tools in `openbinding-gateway/tools/`, with shared code in `_remote_common.py`:

| Tool | Writes | What it does |
|---|---|---|
| `remote_probe.py` | nothing (GET only) | One JSON report of the organizations in SPACE and SPHERE, and the newest pricing version without credits/CU (class A) and the newest one also without usage counters (class B). |
| `remote_provision.py` | `--apply` only | Uploads **one private development pricing `0.1.0`** to SPHERE and SPACE, behind explicit guards. |
| `seed_lab.py` | local database (+ SPACE contracts only with `--space-contracts`) | Idempotent synthetic demo data with the real roles. |

**Status: developed against `httpx.MockTransport` simulations (`tools/tests/fakes.py`), then run once against the
real remotes on 2026-10-13.** `remote_probe.py` and `remote_provision.py --apply` ran (results under "Observed in the
real remotes" and "Primera aplicación real"): SPHERE accepted the private development pricing, SPACE rejected it
with HTTP 400. `seed_lab.py` ran in the lab; its `--space-contracts` option has **not** been run against a real SPACE. Section "Not verified" lists the assumptions that no real run has confirmed yet.

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
| `SPACE_DEV_SERVICE_NAME`, `SPACE_DEV_PLAN` | `seed_lab.py --space-contracts` only; both required, and the service name must equal `SPACE_SERVICE_NAME` (the gateway's setting, which the lab compose file feeds from the same `DEMO_SPACE_DEV_SERVICE`). Optional: `SPACE_DEV_PRICING_VERSION` (default `0.1.0`), `SPACE_PROD_SERVICE_NAME` (extra protected name). |

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
PG harness). This mount works in the lab: `seed_lab.py` and `smoke_lab.py` ran that way with `lab_compose` on 2026-10-13. The six `SPACE_*`/`SPHERE_*` variables must reach the
container; `DEMO_SEED_PASSWORD` is chosen by whoever runs the seed (any synthetic value, 10+ characters).

```sh
# 1. Read-only survey. Send the JSON back (it contains digests and names only).
python tools/remote_probe.py
python tools/remote_probe.py --sphere-slug some-slug --sphere-slug other-slug   # slugs to inspect besides the known "openbinding"

# 2. Plan: reads, writes nothing, prints every guard and the exact upload.
python tools/remote_provision.py \
  --base-pricing-slug SLUG --base-version X.Y.Z --base-digest sha256-HEX \
  --dev-slug NEW-DEV-SLUG --dev-service-name NEW-DEV-SERVICE \
  --prod-slug PROD-SLUG --prod-service-name PROD-SERVICE   # or --prod-service-none if SPACE has no services
# --base-digest also takes sha256- + 12..64 hex (the 12 hex of remote_probe --summary)

# 3. Apply: the same command plus --apply (only after reading the plan).
python tools/remote_provision.py --apply <same arguments>

# 4. Local demo data (database from the gateway settings: DATABASE_URL).
DEMO_SEED_PASSWORD=... python tools/seed_lab.py
DEMO_SEED_PASSWORD=... python tools/seed_lab.py --print-keys          # also prints the derived API keys
DEMO_SEED_PASSWORD=... SPACE_SERVICE_NAME=... SPACE_DEV_SERVICE_NAME=<same name> SPACE_DEV_PLAN=... python tools/seed_lab.py --space-contracts
```

The base arguments come from the probe's `candidates.mostRecentWithoutCu` (`slug`, `version`, `digest`; in
`--summary` mode `candidates.latestWithoutCu`); the production names are the ones the probe shows for the
organization's real pricing/service. If that base declares usage counters (class B, see below) add
`--accept-usage-counters` to both the plan and the apply command.

## Two classes of findings: A (credits/CU) and B (usage counters)

The human decision is to retire the *currency* (credits, CU, capacity) and the monthly counters from the
OpenBinding system (already done in the code). For the **remote development pricing** the base is "the most
recent remote version without CU". The scan therefore separates two classes, and every finding carries
`"class": "A"` or `"B"`:

| Class | What it is | Matches |
|---|---|---|
| **A** credits / CU | a currency of capacity | a key `capacityUnits` anywhere (case and separator insensitive: `capacity_units`, `CapacityUnits`); a usage limit (top level, plan limits, add-on extensions) whose name or unit suggests credits (word `credit(s)`), CU (word `cu`) or capacity/compute units; a feature expression that references any of those names |
| **B** usage counters | a monthly allowance of work | keys `taskStarts`, `solverSeconds`, `federatedTaskStarts`, `concurrentJobs`, `studyRuns` anywhere (same insensitivity); a usage limit whose name or unit combines `solver` with a time word (second/minute/hour/time/duration); a feature expression that references any of those names |

When a name could be both (a counter limit measured in `CU`), class A is checked first and a class A finding is
added; the key itself is still reported as class B. Description text is never scanned.

Scan result: `hasCu` (any A), `hasUsageCounters` (any B), `cuCount`, `counterCount`, `findings`
(`kind`, `class`, `path`, `name`, `unit`), `status`: `cu` (any A, whatever B), `counters` (only B), `clean`, or
`unparsed` (never clean; `hasCu`/`hasUsageCounters` are `null`).

**Observed fact in the real SPHERE** (organization `openbinding`, slug `openbinding`, 7 versions: `0.1.0`,
`0.1.1`, `0.1.1-draft.1` [private], `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`) from the first probe: none contains
`capacityUnits`, but all declare the usage counters `concurrentJobs`, `federatedTaskStarts`, `solverSeconds`,
`studyRuns` and `taskStarts` (33 findings per version). With the old single-class rule that gave
`candidates.latestWithoutCu = null`. With the two classes, `latestWithoutCu` is the newest of those versions
(class B does not exclude it) and `latestWithoutUsageCounters` is `null` (probably, until a version without
counters exists).

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
- `candidates`: `mostRecentWithoutCu` (no class A; class B does not exclude) with `why`; `ranking` (top 5);
  `excluded` (`has-cu`, `yaml-unparsed`, `yaml-not-downloadable`); `ambiguous` if another version ties on
  `createdAt` and version order. `candidates.withoutUsageCounters` has the same fields for the stricter rule (no
  A and no B; its head is `mostRecent`, `null` when none; extra exclusion reason `has-usage-counters`).

**Compact mode** `--summary` (for runners that keep only the last ~5000 characters of output; lab command:
`DEMO_SEED_TOOL=remote_probe.py DEMO_SEED_ARGS=--summary`). The full report goes to **stderr**; the **last line
of stdout** is one JSON line without indentation (under 4000 characters for a few dozen versions):

- `sphere.orgs`: `[name, maskedId, isConfigured]`; `sphere.pricings.<slug>`: `saasName` (the most common one),
  `versions` sorted by `createdAt` then version, each `[version, private(bool|null), createdAt as text,
  kind(date|datetime|other|missing), hasCu(bool|null), number of class A findings, hasCounters(bool|null),
  number of class B findings, digest (12 hex), saasName]` where the last item is `null` when it equals the
  pricing's `saasName` (to stay short); `status`/`total` appear only when the call was not 200 or versions were
  cut by `--max-versions`.
- `space.health` `[ok, status]`; `space.services` `[name, maskedId, versionCount, {status: [versions]}]`.
- `denied`: `[service, call, status]` for 401/403; `cuNames`: names of class A findings found in any version;
  `counterNames`: names of class B findings found in any version; `errors`: failed sections.
- `candidates.latestWithoutCu` and `candidates.latestWithoutUsageCounters`, each `[slug, version, createdAt,
  digest12]` or `null`, with their reasons `candidates.reason` and `candidates.reasonCounters`.

Keys, headers and YAML bodies are never included. Without `--summary` the output is unchanged in structure
(plus the class fields above). The summary stays under 4000 characters for about 30 versions (the real remote
has 7); the test asserts that with every version carrying both classes.

Candidate criteria: latest YAML `createdAt` (a date means 00:00:00Z) among versions without class A
(`mostRecentWithoutCu`) or without A and B (`withoutUsageCounters`); ties by numeric dotted version order. A
document that cannot be parsed is never eligible.

**Scan** (`scan_cu`, deterministic): see "Two classes of findings" above. Note that the repository's own test
fixture `tests/fixtures/pricing_test.yml` declares `concurrentJobs`, so it has class B findings; that is
correct for this scan.

## remote_provision.py

All identifying arguments are required, in both modes (`--prod-service-name` or `--prod-service-none`). `--plan` (default) performs the same **reads** as
`--apply` and prints every guard, so a plan that exits 0 is a plan whose guards passed; it writes nothing.

### Guards

| Guard | Negative case covered by tests |
|---|---|
| `dev-names-valid`: `[a-z0-9][a-z0-9_-]{1,62}` | uppercase, too short, spaces |
| `dev-slug-is-not-production` / `dev-service-is-not-production`: differ from `--prod-slug`, `--prod-service-name` and the reserved name `openbinding` | dev = prod slug; dev = prod service; reserved name |
| `dev-slug-is-not-base` | dev slug = base slug |
| `prod-service-specified`: exactly one of `--prod-service-name` / `--prod-service-none` | (argparse also rejects both and neither, exit 2) |
| `base-digest-format`: 64 hex, or a prefix of 12-64 hex, with or without `sha256-` | prefix of 11 hex, non-hex, more than 64 |
| `base-version-format` | malformed values |
| `sphere-organization-identified`: `GET /orgs/{id}` works (name printed) and reports that id | — |
| `space-organization-identified`: healthcheck + `GET /services` work and no service belongs to another organization | services of another organization |
| `production-slug-identified`, `production-service-identified`: they exist remotely (with `--prod-service-none`: SPACE's `GET /services` answered 200, was understood, and is empty) | missing slug / service; with `--prod-service-none`: non-empty listing, failed listing, unrecognized shape (exit 2) |
| `base-version-found` (exactly once), `base-digest-matches` (the digest of the re-downloaded YAML equals `--base-digest`, or starts with it when a prefix is given and exactly one listed version of the base slug does), `base-has-no-cu` (re-scan; fails only on **class A** or an unreadable base) | missing version, digest mismatch, ambiguous prefix, other version not downloadable, CU present, unreadable base |
| `base-usage-counters`: if the base has **class B** findings it needs `--accept-usage-counters` | counters without the flag (exit 2), with the flag (OK), flag with a CU base (still refused by `base-has-no-cu`) |
| `dev-slug-state-known`, `dev-service-state-known`: absence/presence could be established | 500 answers |
| collision: the dev slug has **any** version in SPHERE, or the dev service exists in SPACE | exit 3 with identity (`has010`, `private`, SPHERE `digest`) |
| `dev-yaml-built`: only `version`, `createdAt`, `saasName` differ from the base, the result has no class A finding and exactly the base's class B findings | unparsable/duplicate-key bases |

Static guards run before any network call. Exit 3 is used only when the sole problem is a collision.

**Usage counters (`--accept-usage-counters`).** Without the flag, a base with class B findings exits `2`; the
guard detail and `outcome.reason` list the counter names and say to rerun with the flag or choose another
base. With the flag the guard passes, `plan.usageCounters` is `{"status": "accepted", "names": [...]}`
(`"none"` for a base without counters, `"refused"` when blocked) and the development YAML keeps the base
content: only `version`, `createdAt` and `saasName` change, **no counter is removed**. The flag never excuses
class A. `arguments.acceptUsageCounters` echoes it.

**Digest prefix (`--base-digest`).** The runners keep only ~5000 characters of output and
`remote_probe.py --summary` prints 12 hex, so `--base-digest` also takes `sha256-` + 12 to 64 hex (or 12-64 hex
without prefix). With a full digest nothing changes. With a prefix, `base-digest-matches` passes only if the
full digest of the re-downloaded YAML starts with it **and** it is the only listed version of the base slug
whose digest does: every other listed version is downloaded (GET) and hashed; two versions sharing the prefix
are refused with an explanation (`base.digestPrefixVersions` lists them), and a version that cannot be
downloaded makes uniqueness unknown, which also refuses. The plan always prints the full digest
(`base.digest`, and in the guard detail); `arguments.baseDigest` records what was passed and
`base.digestSpecified` says `full` or `prefix`.

**No services in SPACE (`--prod-service-none`).** Mutually exclusive with `--prod-service-name`; one of them is
required. `production-service-identified` passes only if `GET /services` answered 200, the shape was
recognized and the list is empty (detail: `SPACE lists no services; nothing to protect`); otherwise it fails
(exit 2) and lists the existing names. The reserved name `openbinding` stays protected for the development
slug and service name. In `production`, `before`/`after` carry `spaceServicesOtherThanDev` instead of
`spaceVersions`; `unchanged` compares "still empty" (any SPACE service other than the development one makes
it false, exit 4). `arguments.prodServiceNone` echoes the flag.

**Observed in the real remotes (probe `--summary`).** SPHERE organization `openbinding` has the pricing slug
`openbinding` with 7 versions (`0.1.0` ... `0.1.5`; newest `0.1.5`, digest starting `7c53a5d8589b`,
`createdAt` a date, `2026-09-23`), none with class A and all with class B. SPACE is healthy (healthcheck 200)
but `GET /services` returns an **empty list**: no service exists in SPACE, production included. Decision
(reversible, private development only): base `openbinding@0.1.5` with `--accept-usage-counters`; development
slug `openbinding-dev`, SPACE service `openbinding-dev`; production SPHERE slug `openbinding`:

```sh
python tools/remote_provision.py \
  --base-pricing-slug openbinding --base-version 0.1.5 --base-digest sha256-7c53a5d8589b \
  --accept-usage-counters --dev-slug openbinding-dev --dev-service-name openbinding-dev \
  --prod-slug openbinding --prod-service-none
```

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

### Primera aplicación real (first real application)

First remote write, private development only. No secret value appears here.

- **SPHERE accepted** the private pricing `openbinding-dev` version `0.1.0` (id
  `6acda0164b2b5b01c587c19a`, `private=true` verified, the digest of the uploaded YAML equals the re-read
  one, `createdAt` `'2026-10-13T03:05:58Z'` with the time was accepted). Production (slug `openbinding`,
  7 versions) is unchanged.
- **SPACE (`https://space.score.us.es`) rejected** the same YAML with HTTP 400:
  `{"error":"Pricing parsing error: The createdAt field must be a string in the format yyyy-mm-dd or a valid Date object"}`.
  SPACE's native parser does not accept the quoted `YYYY-MM-DDTHH:mm:ssZ` string. This is risk D13. The format
  was **not** changed and nothing was retried.
- SPACE has no service (`GET /services` = `[]`), so there is no development service and no contract.
- **Consequence for the lab.** With `SPACE_ENABLED=true` the synthetic users have no contract, and
  `/v1/users/me`, job launches, etc. answer `503 pricing_unavailable` (intended fail-closed). The lab therefore
  takes `DEMO_SPACE_ENABLED=false` (open development gate, no real entitlements) until SPACE accepts the pricing;
  see `docs/DEMO.md`, "SPACE status".
- **Re-running the same command exits 3**: the SPHERE slug already exists (collision guard). The pending SPACE
  upload therefore cannot be done by running `remote_provision.py --apply` again.

Options for the human to decide (**none executed**):

1. Upload the YAML with an **unquoted** timestamp (`createdAt: 2026-10-13T03:05:58Z`). The error says "a valid
   Date object", so a YAML timestamp may be parsed as a Date; SPACE might re-serialize it (for example with
   milliseconds), so the round-trip must be verified.
2. SPACE extends its parser to accept the quoted date-time string.

**Pending work (not implemented):** a future option of `remote_provision.py` that reuses the private version
already created in SPHERE (skips the SPHERE write and the collision on it) and only performs the SPACE upload
and its verification, with the format decided above.

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
and the name guard passes (valid name; not `openbinding`; not `SPACE_PROD_SERVICE_NAME`) and the name equals
the gateway's `SPACE_SERVICE_NAME` (`settings.space_service_name`), so the seeded contracts are the ones the
gateway reads; a mismatch is reported as skipped, nothing is written. It first requires the
service to exist in SPACE, then, for each synthetic user whose email ends in `@example.org`, reads the contract
and creates one (plan `SPACE_DEV_PLAN`, version `SPACE_DEV_PRICING_VERSION`) with the official client only when
none exists, then reads it back. Existing contracts are never changed (a contract without the dev service is
reported as skipped); `remove_contract` and usage adjustments are not exposed by the wrapper.
Contract and user ids are the stable UUIDv5s, so they cannot collide with real accounts.

## Tests

```sh
cd openbinding-gateway && uv run --locked pytest tools/tests
```

`test_remote_common.py` (environment, redaction, createdAt, digests, class A/B scan, tolerant parsers),
`test_remote_probe.py` (simulated organizations, denied/unreachable/malformed answers, candidate ordering for
both lists, summary size),
`test_remote_provision.py` (plan, apply, one negative test per guard, class A base refused, class B base refused
without the flag and accepted with it, collisions, createdAt rejection without retry, YAML builder), `test_redaction.py` (the synthetic keys never reach stdout, stderr, logs, exceptions or
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
10. *Resolved:* the lab mount of `tools/` at `/app/tools` and the `lab_compose seed` invocation worked on 2026-10-13
    (`seed_lab.py`, `smoke_lab.py`). `--space-contracts` has not been run against a real SPACE.
