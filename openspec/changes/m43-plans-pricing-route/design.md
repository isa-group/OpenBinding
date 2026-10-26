# Design: m43-plans-pricing-route

Status: specification only (slice S0). No source file, test, fixture or `docs/openapi.json` is edited here. Fixed
inputs: ROADMAP M4.3, ADR-0015 (§1, §3, §5, §7), ADR-0013 (the committed snapshot is the contract), ADR-0011 and
`docs/ERRORS.md` (problem documents), `docs/ARCHITECTURE.md` §9.1-§9.3, `docs/ACCOUNTS_AND_PLANS.md`,
`docs/qa/PRICING_PROFILE.md`, the current `routes/pricing.py`, `models/pricing.py`, `pricing_catalog.py`,
`sphere_client.py`, `core/public_errors.py`, `models/problem.py`, and the frontend callers in
`frontend/src/api/client.ts`, `frontend/src/api/auth.ts`, `frontend/src/pages/Pricing/` and
`frontend/src/pages/EngineDetail/EngineDetail.tsx` (read only).

## 1. Context

Today three public routes show the pricing: `GET /v1/pricing` (deprecated, the YAML with `ETag` and
`Cache-Control: public, max-age=300`), `GET /v1/pricing/catalog` (the document as JSON, `.inf` as `null`) and
`GET /v1/pricing/current` (`{version, digest, url}`). They read SPHERE's private API (`/users/me/orgs`,
`/pricings/{org}/{slug}`) with `SPHERE_API_KEY` through `sphere_client.py`, show only the version named by
`SPACE_PRICING_VERSION`, pin its digest per process and answer `503 pricing_unavailable` as `application/json`
(platform shape, `{"detail": {...}}` plus the canonical keys). The Pricing page reads `/catalog` and `/current`; the
engine detail page reads `/catalog`.

ADR-0015 replaces this by one route served from SPHERE's public permanent-link API, with no key, in the `plans`
module. SPHERE's public API, read on 2026-10-26 by a lookup (sources:
`https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891` and
`.../versions/6ada6dbd4b2b5b01c587d17f/yaml`; medium confidence), answers:

- `GET /api/v1/public/pricings/{pricingId}`: `{pricingId, name, permanentUrl, latestVersionId, versions: [{versionId,
  version, createdAt, contentHash}]}`, newest first; `contentHash` is 64 lowercase hex characters.
- `GET /api/v1/public/pricings/{pricingId}/versions/{versionId}/yaml`: the Pricing2Yaml text, `application/yaml`.

`contentHash` is taken as the SHA-256 of the YAML bytes SPHERE serves, and the route's `digest` is `sha256-` plus
the hash of those bytes, checked against `contentHash` at runtime (§2 step 4, D9). Open risk (§11), settled by the
coordinator: ROADMAP M4.0 (line 133) records the `contentHash` of 0.2.0 as `3db4ad99…182c` and says it equals the file
`docs/pricing/openbinding-0.2.0.yml`, but that file in this tree hashes to
`4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1`. Either `3db4ad99…` is the digest of the bytes
SPHERE serves (and the repository copy differs from them), or the ROADMAP entry is stale. The scenarios and examples of
this change use the digest of the recorded fixture YAML, `4b9c7203…5b1` (§9), never `3db4ad99…`.

The test fixtures of this change (§9) are two files under `openbinding-gateway/tests/fixtures/pricing/`, written by a
parallel fixture task:

- `manifest.json`: the manifest of pricing `6ab0a323697330667ccce891` in exactly the shape above, `{pricingId, name,
  permanentUrl, latestVersionId, versions: [{versionId, version, createdAt, contentHash}]}`, with `latestVersionId`
  `6ada6dbd4b2b5b01c587d17f` (version `0.2.0`) and that entry's `contentHash` equal to the SHA-256 of
  `openbinding-0.2.0.yml` (`4b9c7203…5b1`);
- `openbinding-0.2.0.yml`: a byte copy of `docs/pricing/openbinding-0.2.0.yml`, standing for the YAML of version
  `6ada6dbd4b2b5b01c587d17f`.

Both are DERIVED, not recorded live (the fixture task had no network). Slice S1 re-records them from SPHERE without any
credential (two plain GETs of the public URLs above, no key, no cookie) before any test relies on their shape, and
updates the scenario values here through a revision if the live shape or hash differs.

## 2. Behaviour of `GET /v1/plans/pricing`

1. Rate limit (§6). Then, when a verified read younger than 300 s is held, go to step 5.
2. Manifest: `GET {SPHERE_URL}/api/v1/public/pricings/{SPHERE_PRICING_ID}`, no credential, no cookie, no redirect
   followed, timeout `SPHERE_TIMEOUT_S` (10 s), body bounded to 1 MiB. Valid when it is a JSON object whose
   `pricingId` equals `SPHERE_PRICING_ID`, whose `permanentUrl` equals `{SPHERE_URL}/p/{SPHERE_PRICING_ID}`, whose
   `versions` is a list and whose `latestVersionId` names exactly one entry of it with a non-empty `version`, a
   string `createdAt` and a 64-hex `contentHash`. Anything else is a failure.
3. YAML: when the held read already has the same `versionId` and `contentHash`, its YAML is reused (an immutable
   version is not fetched twice); otherwise
   `GET {SPHERE_URL}/api/v1/public/pricings/{SPHERE_PRICING_ID}/versions/{versionId}/yaml` under the same rules,
   bounded to 5 MiB (5 242 880 bytes; reading stops past the bound).
4. Verification: `sha256(bytes)` hex equals `contentHash`; `yaml.safe_load` gives a mapping whose `version` (as a
   string) equals the entry's `version`. The verified read (manifest entry, bytes, parsed document, time) replaces
   the held one.
5. SPACE: `PlanPort.active_version() -> str | None` of the M4.2 plans module (`m42-plans-module`, added there in the
   round-2 revision). The method sends no request: it returns the version carried by the payload of the last SPACE
   pricing event the plans module received, held in memory, and `None` before the first event and while SPACE is
   unavailable. `None` gives `null`; the field never changes the status (§10 D3). The payload field that carries the
   version is UNVERIFIED until the M4.2 S8 suite runs against a real SPACE (§11).
6. Body (§3), `ETag`, `Cache-Control`; `304` when `If-None-Match` matches (§5).

Failures of steps 2-4 are logged by `log_internal_failure` (masked, bounded, with the correlation id) and answered with
the `503` problem (§4.3). A failure is not cached as a pricing; to keep an outage from multiplying SPHERE requests,
the reader sends no new SPHERE request for 30 s after a failure and answers `503` meanwhile
(`req~plans-pricing-failure-pause~1`). Concurrent requests that find no fresh read share one SPHERE read (single
flight, scenario "Concurrent requests share one read" of `req~plans-pricing-sphere-read-budget~1`). The held read is per process; the gateway runs several
workers, so SPHERE sees at most one manifest read per worker per 300 s.

No step reads `SPACE_PRICING_VERSION`, `SPHERE_ENABLED`, `SPHERE_API_KEY` or the repository copy in `docs/pricing/`.

## 3. Response body `PlansPricing`

| Field | Type | Source |
|---|---|---|
| `pricingId` | string | manifest `pricingId` (= `SPHERE_PRICING_ID`) |
| `permanentUrl` | string, URI | manifest `permanentUrl` (`https://sphere.score.us.es/p/6ab0a323697330667ccce891`); the source link |
| `versionId` | string | manifest `latestVersionId` |
| `version` | string | `version` of that entry (the label, `0.2.0`) |
| `createdAt` | string | `createdAt` of that entry, unchanged |
| `digest` | string, `^sha256-[0-9a-f]{64}$` | `sha256-` + the verified `contentHash`; the same notation as `/v1/pricing/current` and the profile catalogue |
| `yamlUrl` | string, URI | the public YAML URL of step 3, for a download link |
| `spaceActiveVersion` | string or `null` | `PlanPort.active_version()` (step 5): the version of the last SPACE pricing event; `null` before the first event and while SPACE is unavailable |
| `yaml` | string | the verified bytes decoded as UTF-8, unchanged: the document as served by SPHERE, for the `pricing-renderer` web component (`yaml` attribute) and for checking `digest` |
| `document` | object | the same YAML parsed, `.inf`/`-.inf`/`.nan` as `null`, dates as ISO 8601 strings, keys in YAML order and none added: the input of the `pricing-renderer` React component (`pricing` prop, a parsed object) and of today's `pricingModel.ts` |

Every field is required. The body is the same for every caller. `document` is exactly what `/v1/pricing/catalog` serves
today, so the frontend migration (S3) is a change of path and of the field it reads: `document` for the catalogue, and
`version`, `digest`, `yamlUrl` for the three fields of `PricingCurrentView` (`url` becomes `yamlUrl`).

## 4. OpenAPI additions (for slice S1; `docs/openapi.json` is regenerated, never hand-edited)

### 4.1 Tag

In `main.py`'s tag list: `{"name": "Plans", "description": "The published OpenBinding pricing, read from SPHERE's public
API without a key, and plan information. Pricings and contracts are administered in the SPHERE and SPACE consoles."}`.

### 4.2 Path

```json
"/v1/plans/pricing": {
  "get": {
    "operationId": "getPlansPricing",
    "summary": "Published pricing",
    "description": "The latest public version of the OpenBinding pricing in SPHERE: permanent link, SPHERE version id and label, digest, the YAML as SPHERE serves it, the same document as JSON, and the version SPACE has active as of its last pricing event (null before the first event and while SPACE is unavailable). Public; the body is the same for every caller.",
    "tags": ["Plans"],
    "parameters": [
      {"name": "If-None-Match", "in": "header", "required": false, "schema": {"type": "string"},
       "description": "An ETag from a previous answer, or *; a match answers 304."}
    ],
    "responses": {
      "200": {
        "description": "The verified published pricing.",
        "headers": {
          "ETag": {"schema": {"type": "string"}, "description": "Strong validator of this body."},
          "Cache-Control": {"schema": {"type": "string", "const": "public, max-age=300"}}
        },
        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/PlansPricing"}}}
      },
      "304": {
        "description": "The ETag in If-None-Match is current; no body.",
        "headers": {
          "ETag": {"schema": {"type": "string"}},
          "Cache-Control": {"schema": {"type": "string", "const": "public, max-age=300"}}
        }
      },
      "429": {
        "description": "Too many requests from this caller in 60 s (`rate_limit_exceeded`).",
        "headers": {
          "Retry-After": {"schema": {"type": "integer", "minimum": 1}},
          "Cache-Control": {"schema": {"type": "string", "const": "no-store"}}
        },
        "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}
      },
      "503": {
        "description": "SPHERE cannot be read, or its answer failed verification (`pricing_unavailable`). No pricing is served.",
        "headers": {"Cache-Control": {"schema": {"type": "string", "const": "no-store"}}},
        "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}
      }
    }
  }
}
```

No `security`, no `x-required-api-key-permissions`: the operation joins the `public` set of
`tests/test_openapi_contract.py`. `If-None-Match` may be left out of `parameters` if FastAPI's generation makes it
awkward; the `304` response is required either way.

### 4.3 Schema and errors

```json
"PlansPricing": {
  "type": "object",
  "additionalProperties": false,
  "description": "The latest public version of the OpenBinding pricing in SPHERE, verified against its content hash.",
  "required": ["pricingId", "permanentUrl", "versionId", "version", "createdAt", "digest", "yamlUrl",
               "spaceActiveVersion", "yaml", "document"],
  "properties": {
    "pricingId": {"type": "string", "minLength": 1},
    "permanentUrl": {"type": "string", "format": "uri"},
    "versionId": {"type": "string", "minLength": 1},
    "version": {"type": "string", "minLength": 1},
    "createdAt": {"type": "string"},
    "digest": {"type": "string", "pattern": "^sha256-[0-9a-f]{64}$"},
    "yamlUrl": {"type": "string", "format": "uri"},
    "spaceActiveVersion": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    "yaml": {"type": "string"},
    "document": {"type": "object", "additionalProperties": true}
  }
}
```

Examples (they validate against the schemas; `yaml` and `document` shortened):

```json
{"pricingId": "6ab0a323697330667ccce891",
 "permanentUrl": "https://sphere.score.us.es/p/6ab0a323697330667ccce891",
 "versionId": "6ada6dbd4b2b5b01c587d17f", "version": "0.2.0", "createdAt": "<createdAt of the recorded manifest>",
 "digest": "sha256-4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1",
 "yamlUrl": "https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891/versions/6ada6dbd4b2b5b01c587d17f/yaml",
 "spaceActiveVersion": "0.2.0",
 "yaml": "syntaxVersion: '3.1'\nsaasName: OpenBinding\nversion: 0.2.0\n…",
 "document": {"syntaxVersion": "3.1", "saasName": "OpenBinding", "version": "0.2.0", "createdAt": "2026-10-22", "currency": "EUR"}}
```

```json
{"type": "https://openbinding.dev/problems/pricing_unavailable", "title": "pricing_unavailable", "status": 503,
 "code": "pricing_unavailable", "detail": "The published pricing is unavailable.",
 "correlationId": "4bf92f3577b34da6a3ce929d0e0e4736"}
```

```json
{"type": "https://openbinding.dev/problems/rate_limit_exceeded", "title": "rate_limit_exceeded", "status": 429,
 "code": "rate_limit_exceeded", "detail": "Too many reads of the published pricing; retry shortly."}
```

Errors reuse `#/components/schemas/Problem` (ADR-0011): `type`, `title` = `code`, `status`, `code`, `detail` as a
string, `correlationId` on 5xx only (added by `CorrelationIdMiddleware`), no `diagnostics` (none is a 422). The `503`
uses the existing `PUBLISHED_PRICING_UNAVAILABLE` of `core/public_errors.py` (status, code and sentence unchanged). The
media type is `application/problem+json`: `/v1/plans` is a new prefix with no client of the platform shape, so it
joins the prefixes that answer `Problem`. In `main.py` both decisions read the same predicate: `_problem_media_type`
(media type of 422s) and `http_error` (which builds `Problem` for `_is_bim_request` paths and the platform
`{"detail": {...}}` body otherwise). Adding `/v1/plans` to `_BIM_PATH_PREFIXES`, or a shared predicate that both use,
gives `Problem` for the `429` and `503`; changing the media type alone would not. `_BIM_PATH_PREFIXES` also drives
the OpenAPI post-processing of `main.py`, which then declares `application/problem+json` for these errors. The M4.2
routes under `/v1/plans` follow the same rule. The prefix change (`main.py` predicate and `docs/ERRORS.md`
§"Media type" gaining `/v1/plans`) is made once, by the first slice that adds a `/v1/plans` route: M4.2 slice S5
(`GET /v1/plans/events`) or this change's S1, whichever merges first; the other one finds it done and only checks it.

### 4.4 Deprecated operations (S1, compatible) and their removal (S4, breaking)

S1 sets `deprecated: true` on `getPricingCatalog` and `getCurrentPricing` (`getPricingDocument` already has it) and adds
to each the response headers `Deprecation` and `Link` with a description naming `/v1/plans/pricing`. S4 removes the
three paths, the schema `PricingCurrentView` and, if no operation keeps it, the tag `Pricing`.

## 5. HTTP caching

- `ETag`: `"sha256-<hex>"` of the exact bytes of the `200` body, so equal bodies give equal validators and any change
  (a new version, `spaceActiveVersion` moving) gives another one. Strong: no `W/`.
- `Cache-Control: public, max-age=300` on `200` and `304` (the same lifetime as SPACE's five-minute synchronization and
  as today's `/v1/pricing`). `public` is safe because the body never depends on the caller; no `Vary` on
  `Authorization` is needed.
- `If-None-Match` (a list of validators or `*`) matching the current `ETag` gives `304`, no body, with `ETag` and
  `Cache-Control`. The gateway still needs a current read to compare with, so while SPHERE is down a conditional
  request also gets the `503`.
- `503` and `429` carry `Cache-Control: no-store`, so no cache keeps a failure.

## 6. Authentication and rate limit

- Anonymous allowed. A valid bearer token or API key is accepted and changes nothing; no API-key permission is
  required. Today `required_permissions` in `security/apikeys.py` maps `/v1/pricing*` to `pricing:read`, but those
  routes never authenticate (they depend only on `get_settings`), so the permission is never checked there. The new
  route keeps that behaviour explicitly: `/v1/plans/pricing` joins `OPEN_V1_GET_PATHS` (`security/apikeys.py`), as
  `tests/test_api_key_route_table.py` requires for an open GET path, and the route authenticates only when the rate
  limit needs the account as its key (§6, optional user). Malformed or expired credentials are treated as the gateway
  treats them on its other public routes; this change does not alter that rule.
- Rate limit class: public read. The limit is `PUBLIC_READ_RATE_PER_MINUTE` (default 240, `0` switches it off) per
  caller (the account when a valid credential is presented, else the client address) over a sliding 60 s window, as
  in `access/public_read.py::check_rate`, but in its own bucket (`plans-pricing`), so reading the pricing does not
  consume the budget of public project reads. Every request counts, `304` and `503` included. The excess gets `429`
  `rate_limit_exceeded` (§4.3) with `Retry-After` = whole seconds until the oldest counted request leaves the window
  (1-60).

## 7. Configuration

| Setting | S1 | S4 |
|---|---|---|
| `SPHERE_URL` | kept: SPHERE origin, default `https://sphere.score.us.es` | kept |
| `SPHERE_PRICING_ID` | new: default `6ab0a323697330667ccce891` | kept |
| `SPHERE_TIMEOUT_S` | kept (10 s), also used by the new reader | kept |
| `SPHERE_API_KEY`, `SPHERE_ORGANIZATION_ID`, `SPHERE_ORGANIZATION_NAME`, `SPHERE_PRICING_SLUG`, `SPHERE_ENABLED` | kept, used only by the deprecated routes; the new route ignores them | removed |
| `SPACE_PRICING_VERSION` | not read by the new route | not touched here: it pins new contracts in the entitlement code (M4.2 decides its fate) |

After S4 an environment that still sets `SPHERE_API_KEY` is ignored as an unknown variable (the settings model ignores
extra variables today; S4 keeps that, so a stale deployment variable does not stop the gateway). The deployment files
and `docs/ACCOUNTS_AND_PLANS.md` drop the removed variables in S4.

## 8. Expand/contract plan for the deprecated routes

| Step | Slice | Compatibility | Content | Gate |
|---|---|---|---|---|
| Expand | S1 | compatible (new operation; `deprecated: true` and new response headers on old ones) | `GET /v1/plans/pricing`; `Deprecation: @<unix seconds of the UTC midnight of the day S1 merges into develop>` and `Link: </v1/plans/pricing>; rel="successor-version"` on every response of the three old routes; old routes otherwise unchanged | G1-G6, OpenAPI snapshot fresh |
| Migrate | S3 (frontend lead, another change) | client change | Pricing page and engine detail read `/v1/plans/pricing`; mocks of the e2e specs follow; `frontend-catalog-pricing` requirements that name `/v1/pricing/*` are revised by that lead | `grep -rn "/v1/pricing" frontend/src` finds nothing outside comments that name the history |
| Contract | S4 | **breaking**: three operations and one schema removed | delete the three routes, `routes/pricing.py`, `models/pricing.py`, `pricing_catalog.py`, `sphere_client.py`, the `/v1/pricing` override in `main.py`, the `/v1/pricing` branch of `security/apikeys.py`, the SPHERE key settings (§7) and their tests; drop `sphere_client.py` from the pinned deviations of `lab/tests/test_no_direct_space_http.py` | owner approval of the removal recorded; S3 merged; S1 shipped in a release before; `oasdiff breaking` (when registered) lists exactly the removed operations and schema; CHANGELOG "Removed" entry |

No `Sunset` header is sent: no removal date is recorded. When the owner fixes the S4 release date, a `Sunset` header
with that date may be added to the old routes without a new requirement revision (it adds a header, it does not change
`req~plans-pricing-deprecated-routes-signal~1`).

This change is archived only after S4. `req~plans-pricing-deprecated-routes-signal~1` describes the expand phase
only; S4 deletes the code and tests that cover it, so S4 also removes that requirement from this change's delta
(`specs/plans-pricing/spec.md`) before the archive, and the living spec never holds an uncovered requirement.

The `pricing:read` API-key permission stays an accepted value after S4 (removing it would invalidate stored keys that
hold it); retiring it is a followup.

## 9. Placement, architecture and tests

- The SPHERE reader lives in the plans module (`openbinding-gateway/src/openbinding_gateway/modules/plans/`, created by
  M4.2; S1 creates the package if M4.2 has not merged yet, coordinated with the M4.2 lead). It is the only gateway code
  that sends HTTP to SPHERE. The architecture test `lab/tests/test_no_direct_space_http.py`
  (`req~lab-space-no-direct-http~1` of `m41-space-bootstrap`) lists in `ALLOWED_PREFIXES` the old path
  `openbinding-gateway/src/openbinding_gateway/plans/`, not `modules/plans/`; aligning it with `modules/plans/` is a
  prerequisite of S1, owned by the lab-tests change (M4.2 tasks list the same alignment), and S1 does not start its
  reader before that alignment has merged. The route module only calls the reader and the plans port.
- The reader takes an `httpx.AsyncBaseTransport` and a clock as parameters, so tests inject `httpx.MockTransport` and a
  fake clock. httpx is created with `follow_redirects=False`, `trust_env=False` and no default headers.
- Unit tests read the pricing fixture at `openbinding-gateway/tests/fixtures/pricing/` (written by a parallel fixture
  task, not by this change): `manifest.json` (the manifest of `6ab0a323697330667ccce891`) and `openbinding-0.2.0.yml`
  (the YAML of version `6ada6dbd4b2b5b01c587d17f`), whose SHA-256 `4b9c7203…5b1` is the manifest `contentHash` (§1).
  They are derived, not recorded live; S1 re-records them keyless from SPHERE before relying on their shape (§1). The
  scenarios name them, or call them "the recorded manifest", "the recorded YAML" and together "the recorded SPHERE
  pricing". Tests that need `0.3.0`, a tampered YAML or a
  broken manifest derive them in memory from these two files. SPACE is a fake plans port. No unit test opens a connection to SPACE or SPHERE (ADR-0015
  §5, constitution 16.6): a session-wide guard in `openbinding-gateway/tests/conftest.py` refuses, before connecting,
  any socket connection to the SPHERE host (`sphere.score.us.es` and the host of `SPHERE_URL`) and to the host of
  `SPACE_URL`, naming the host (`req~plans-pricing-no-network-in-tests~1`).
- OFT tags: `[impl->req~plans-pricing-…~1]` in the reader and the route, `[utest->req~plans-pricing-…~1]` in the
  tests.

## 10. Decisions taken from the accepted CRP (verify against the CRP text)

The owner accepted `crp-ob-m4-plans-decisions` with "accept-all" (own-7153cec8d5a447fa909601bc7ad8fe4d), whose text is
not in the repository. Each choice below is the option consistent with ADR-0015, ROADMAP M4 and ARCHITECTURE §9; the
coordinator compares them with the CRP text and opens a revision where they differ.

- D1 Version served: SPHERE's `latestVersionId`, not `SPACE_PRICING_VERSION` (ADR-0015 §1 `all_last`, §3). Rejected:
  keeping the configured version (contradicts `all_last`); a `?version=` parameter (no consumer).
- D2 Document as served: both `yaml` (exact bytes, verifiable against `digest`) and `document` (JSON, today's
  `/catalog` rule). Rejected: YAML only (the React renderer and `pricingModel.ts` take an object); JSON only (the hash
  cannot be checked by a client).
- D3 `spaceActiveVersion` is part of the descriptor (ARCHITECTURE §9.2 "the version SPACE has activated"). Its only
  source is `PlanPort.active_version()` of M4.2, which returns the version of the last SPACE pricing event held in
  memory, and `None` before the first event and while SPACE is unavailable; the field is then `null`, and SPACE's
  availability never turns the route into an error. Rejected: `503` when SPACE is down (couples a public page to
  SPACE); a SPACE read per request or per route cache (a second SPACE client outside the port, and a SPACE call on an
  anonymous route); leaving the field out (ARCHITECTURE asks for it). This matches M4.2 (`m42-plans-module`), which
  states that API-key authentication is not gated by plans: neither the caller's credential nor SPACE's state decides
  whether this public route answers.
- D4 Anonymous access, no API-key permission (a pricing is public, the Pricing page is public, and today's routes are
  public too). Rejected: requiring `pricing:read` from API keys (an anonymous caller would then have more access than
  a key).
- D5 Caching: strong `ETag` over the body, `public, max-age=300`, `304`; server read TTL 300 s; after it, no stale body:
  `503`. Rejected: serving the last verified read while SPHERE is down (the M4.3 owner request asks for no invented
  or stale body, and ARCHITECTURE §9.2 serves only a hash-verified read); a bundled copy (`docs/pricing/`) as
  fallback (ADR-0015 §5 keeps recorded pricings to tests).
- D6 Errors: `503 pricing_unavailable` for every SPHERE or verification failure (the code and sentence clients already
  branch on), as `application/problem+json` for the whole `/v1/plans` prefix. Rejected: `502` for a failed
  verification (a new code for the same client action); the platform `{"detail": {...}}` shape on a new prefix.
- D7 Rate limit: public-read class, `PUBLIC_READ_RATE_PER_MINUTE`, own bucket. Rejected: no limit (the route is
  anonymous); the auth limiter (built for login attempts).
- D8 Removal: deprecated routes removed in S4 after the frontend migrates and after S1 has shipped in one release, with
  `Deprecation` and `Link` headers meanwhile and no `Sunset` until a date is fixed. The removal is breaking and needs
  the owner's recorded approval at S4 even if the CRP covers it.
- D9 Integrity: `contentHash` is the SHA-256 of the YAML bytes; YAML bound 5 MiB (ARCHITECTURE §9.2), manifest bound
  1 MiB; `permanentUrl` and `pricingId` must match the configuration.
- D10 Settings: new `SPHERE_PRICING_ID`; `SPHERE_API_KEY`, `SPHERE_ORGANIZATION_ID`, `SPHERE_ORGANIZATION_NAME`,
  `SPHERE_PRICING_SLUG` and `SPHERE_ENABLED` removed in S4 (ROADMAP "no SPHERE key in settings").

## 11. Risks and open questions

- The manifest field names and the YAML path come from one lookup of the live service (medium confidence); the
  fixture is derived from that lookup, not recorded live, so S1 re-records it keyless before relying on it, and the
  first preview run confirms the shape live.
- That `contentHash` is the SHA-256 of the raw YAML bytes rests on the ROADMAP record of M4.0; if SPHERE hashes a
  normalised form, every read fails closed with `503` (never a wrong pricing), and D9 needs a revision.
- Open, for the coordinator: ROADMAP line 133 gives `3db4ad99b33f0a591fcc71167bb7410e10a477429d48a0105afd17bf629b182c`
  as the hash of 0.2.0 and as the hash of `docs/pricing/openbinding-0.2.0.yml`, but that file in this tree hashes to
  `4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1` (§1). Either `3db4ad99…` is the hash of the bytes
  SPHERE serves (the repository copy then differs from SPHERE's, by line endings or a later edit) or the ROADMAP entry
  is stale. The route is unaffected (it checks whatever SPHERE serves against SPHERE's own `contentHash`); the
  scenarios use the fixture digest `4b9c7203…5b1`. Revision trigger: if the keyless re-recording in S1 shows a YAML or
  `contentHash` other than the fixture's, the fixture is replaced by the recorded bytes and the digest values of
  `req~plans-pricing-descriptor~1` are revised (a new revision of that requirement, `~2`).
- SPHERE's own caching headers are unknown; the gateway does not rely on them.
- `spaceActiveVersion` depends on `PlanPort.active_version()` of `m42-plans-module`. S1 already reads the field
  through that port method, so its tests (the anonymous and `ETag` scenarios) use a fake port returning `0.2.0` or
  `None`; until the method has merged in M4.2, the production wiring of S1 gives a port whose `active_version()`
  returns `None` (the field is `null`), and S2 (the real adapter's value and the tests of
  `req~plans-pricing-space-active-version~1`) waits for it. Which field of SPACE's pricing event payload carries the version is
  UNVERIFIED until the M4.2 S8 suite; if it differs, M4.2 revises its adapter and this change is unaffected (it reads
  only the method). Because the value comes from events, `spaceActiveVersion` can lag SPACE by the event delivery
  delay, and after a gateway restart it is `null` until the next pricing event; ARCHITECTURE §9.2 "the version SPACE
  has activated" is to be read with that meaning (tasks.md, follow-ups).
- Per-process read cache: with N workers SPHERE sees up to N manifest reads per 300 s; acceptable at the lab's scale.
- Behind a proxy that hides client addresses, the anonymous rate-limit key is shared; the gateway's existing
  client-address rule applies unchanged.
- The CRP text is not in the repository (§10).

## 12. Requirements and slices

| Requirement | Slice |
|---|---|
| `plans-pricing-descriptor`, `plans-pricing-document`, `plans-pricing-anonymous`, `plans-pricing-etag`, `plans-pricing-cache-control`, `plans-pricing-conditional`, `plans-pricing-sphere-read-budget`, `plans-pricing-failure-pause`, `plans-pricing-sphere-public-read`, `plans-pricing-integrity`, `plans-pricing-sphere-unavailable`, `plans-pricing-rate-limit`, `plans-pricing-openapi`, `plans-pricing-no-network-in-tests` | S1 |
| `plans-pricing-deprecated-routes-signal` | S1; removed from the delta in S4 (§8) |
| `plans-pricing-space-active-version` | S2 (S1 when `PlanPort.active_version()` of M4.2 has merged) |
| `plans-pricing-deprecated-routes-retired`, `plans-pricing-no-sphere-key`, REMOVED `frontend-catalog-pricing-read-only-source` | S4 |
