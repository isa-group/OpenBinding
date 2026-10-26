## ADDED Requirements

### Requirement: Published pricing descriptor
WHEN a client sends `GET /v1/plans/pricing`, SPHERE serves the latest public version of the configured pricing and no SPHERE read of the gateway failed in the last 30 seconds, THE gateway SHALL answer `200` with a `PlansPricing` JSON document whose `pricingId`, `permanentUrl`, `versionId`, `version`, `createdAt`, `digest` and `yamlUrl` describe that version.

`req~plans-pricing-descriptor~1`

Needs: impl, utest

#### Scenario: Recorded pricing 0.2.0
- **GIVEN** SPHERE answers with the recorded manifest and YAML of `openbinding-gateway/tests/fixtures/pricing/` for the pricing id `6ab0a323697330667ccce891`, whose `latestVersionId` is `6ada6dbd4b2b5b01c587d17f` (version `0.2.0`)
- **WHEN** an anonymous client sends `GET /v1/plans/pricing`
- **THEN** the response status is `200` and its media type is `application/json`
- **AND** `pricingId` is `6ab0a323697330667ccce891` and `permanentUrl` is `https://sphere.score.us.es/p/6ab0a323697330667ccce891`
- **AND** `versionId` is `6ada6dbd4b2b5b01c587d17f`, `version` is `0.2.0` and `createdAt` is the `createdAt` of that entry of the recorded manifest, unchanged
- **AND** `digest` is `sha256-3db4ad99b33f0a591fcc71167bb7410e10a477429d48a0105afd17bf629b182c`
- **AND** `yamlUrl` is `https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891/versions/6ada6dbd4b2b5b01c587d17f/yaml`

#### Scenario: A newer public version appears
- **GIVEN** a recorded manifest whose `latestVersionId` names a version `0.3.0` listed before `0.2.0`
- **WHEN** a client sends `GET /v1/plans/pricing` after the gateway's previous SPHERE read is older than 300 seconds
- **THEN** `version` is `0.3.0` and `versionId` is the `latestVersionId` of that manifest

### Requirement: Pricing document as served
WHEN the gateway answers `GET /v1/plans/pricing` with `200`, THE gateway SHALL carry the verified Pricing2Yaml bytes of that version as the string `yaml` and the same document parsed into JSON as the object `document`.

`req~plans-pricing-document~1`

Needs: impl, utest

#### Scenario: YAML text unchanged
- **GIVEN** the recorded YAML of version `0.2.0`
- **WHEN** a client reads `yaml` from the `200` response
- **THEN** its UTF-8 encoding is byte-for-byte equal to the recorded YAML file
- **AND** the `sha256` of those bytes, as `sha256-<hex>`, equals `digest`

#### Scenario: Document as JSON without a projection
- **GIVEN** the recorded YAML of version `0.2.0`, whose repository limits are `.inf` for the plans other than `FREE`
- **WHEN** a client reads `document` from the `200` response
- **THEN** `document.version` is `0.2.0`, `document.syntaxVersion` is `3.1` and its keys are the top-level keys of the YAML, with no key added or renamed
- **AND** every `.inf`, `-.inf` or `.nan` value of the YAML is `null` in `document`
- **AND** every YAML date or timestamp is an ISO 8601 string

### Requirement: SPACE active version in the descriptor
WHEN the gateway answers `GET /v1/plans/pricing` with `200`, THE gateway SHALL set `spaceActiveVersion` to the version that SPACE's `openbinding` service has active, or to `null` when SPACE cannot be read, without changing the status.

`req~plans-pricing-space-active-version~1`

Needs: impl, utest

#### Scenario: SPACE reports the active version
- **GIVEN** the recorded SPHERE pricing and a fake plans port that reports `0.2.0` as the active version of the service `openbinding`
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the response status is `200` and `spaceActiveVersion` is `0.2.0`

#### Scenario: SPACE lags behind SPHERE
- **GIVEN** a recorded manifest whose latest version is `0.3.0` and a fake plans port that reports `0.2.0`
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** `version` is `0.3.0` and `spaceActiveVersion` is `0.2.0`

#### Scenario: SPACE is down
- **GIVEN** the recorded SPHERE pricing and a fake plans port that raises its unavailability error
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the response status is `200`, `spaceActiveVersion` is `null` and every other field is as in the recorded pricing scenario

### Requirement: Anonymous access to the published pricing
THE gateway SHALL serve `GET /v1/plans/pricing` without authentication and with a body that does not depend on the caller.

`req~plans-pricing-anonymous~1`

Needs: impl, utest

#### Scenario: Anonymous and signed-in callers
- **GIVEN** the recorded SPHERE pricing and a fake plans port that reports `0.2.0`
- **WHEN** an anonymous client, a client with a valid account bearer token and a client with a valid API key that holds no `pricing:read` permission each send `GET /v1/plans/pricing`
- **THEN** each response status is `200`
- **AND** the three bodies are byte-for-byte equal and carry the same `ETag`

### Requirement: Cache validator of the published pricing
WHEN the gateway answers `GET /v1/plans/pricing` with `200`, THE gateway SHALL send a strong `ETag` that is equal for equal bodies and different for different bodies.

`req~plans-pricing-etag~1`

Needs: impl, utest

#### Scenario: Same body, same validator
- **GIVEN** the recorded SPHERE pricing and a fake plans port that reports `0.2.0`
- **WHEN** a client sends `GET /v1/plans/pricing` twice
- **THEN** both responses carry the same strong `ETag` (a quoted value without the `W/` prefix)

#### Scenario: Another body, another validator
- **GIVEN** a first response for version `0.2.0` with `spaceActiveVersion` `0.2.0`
- **WHEN** a later response has `spaceActiveVersion` `null`, or describes version `0.3.0`
- **THEN** its `ETag` differs from the first one

### Requirement: Cache lifetime of the published pricing
WHEN the gateway answers `GET /v1/plans/pricing` with `200`, THE gateway SHALL send `Cache-Control: public, max-age=300`.

`req~plans-pricing-cache-control~1`

Needs: impl, utest

#### Scenario: Shared caches may keep it five minutes
- **GIVEN** the recorded SPHERE pricing
- **WHEN** an anonymous client and a signed-in client each send `GET /v1/plans/pricing`
- **THEN** both `200` responses carry exactly `Cache-Control: public, max-age=300`

### Requirement: Conditional request for the published pricing
WHEN a `GET /v1/plans/pricing` request carries `If-None-Match` with the current `ETag` of the response, or `*`, THE gateway SHALL answer `304` with no body, the same `ETag` and `Cache-Control: public, max-age=300`.

`req~plans-pricing-conditional~1`

Needs: impl, utest

#### Scenario: Validator still current
- **GIVEN** a client that received `ETag` `E` from `GET /v1/plans/pricing`, and SPHERE and SPACE unchanged
- **WHEN** it sends `GET /v1/plans/pricing` with `If-None-Match: E`
- **THEN** the response status is `304`, the body is empty, `ETag` is `E` and `Cache-Control` is `public, max-age=300`

#### Scenario: Validator outdated
- **GIVEN** a client that received `ETag` `E` for version `0.2.0`, and SPHERE now lists `0.3.0` as the latest version
- **WHEN** it sends `GET /v1/plans/pricing` with `If-None-Match: E` after the gateway's previous SPHERE read is older than 300 seconds
- **THEN** the response status is `200` with `version` `0.3.0` and an `ETag` other than `E`

### Requirement: Bounded reads of SPHERE
WHILE the gateway holds a verified SPHERE read younger than 300 seconds, THE gateway SHALL answer `GET /v1/plans/pricing` from it without sending a request to SPHERE.

`req~plans-pricing-sphere-read-budget~1`

Needs: impl, utest

#### Scenario: Many requests in one window
- **GIVEN** a recording SPHERE transport serving the recorded pricing and a clock the test controls
- **WHEN** clients send 50 `GET /v1/plans/pricing` requests within 299 seconds of the first one
- **THEN** the transport has recorded exactly one manifest request and one YAML request
- **AND** every response is `200` with the same body

#### Scenario: Window expired
- **GIVEN** the same transport and a verified read made 300 seconds ago
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the transport records one new manifest request before the response is sent

#### Scenario: Concurrent requests share one read
- **GIVEN** a recording SPHERE transport serving the recorded pricing with a delay of 1 second, and no verified read held
- **WHEN** 10 clients send `GET /v1/plans/pricing` at the same time
- **THEN** the transport has recorded exactly one manifest request and one YAML request, and every response is `200` with the same body

### Requirement: Pause after a failed SPHERE read
WHILE less than 30 seconds have passed since a SPHERE read of the gateway failed and no verified read younger than 300 seconds is held, THE gateway SHALL answer `GET /v1/plans/pricing` with the `503` `pricing_unavailable` problem without sending a request to SPHERE.

`req~plans-pricing-failure-pause~1`

Needs: impl, utest

#### Scenario: Outage does not multiply SPHERE requests
- **GIVEN** a recording SPHERE transport that raises a connection error, a clock the test controls, and no verified read held
- **WHEN** clients send 20 `GET /v1/plans/pricing` requests within 29 seconds of the first one
- **THEN** every response is the `503` `pricing_unavailable` problem and the transport has recorded exactly one request

#### Scenario: SPHERE back after the pause
- **GIVEN** a SPHERE read that failed 30 seconds ago and a transport that now serves the recorded pricing
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the transport records a new manifest request and the response is `200` with `version` `0.2.0`

### Requirement: Credential-free public SPHERE reads
THE gateway SHALL read SPHERE only through unauthenticated `GET` requests to the public pricing API of the configured SPHERE origin, following no redirect.

`req~plans-pricing-sphere-public-read~1`

Needs: impl, utest

#### Scenario: Requests recorded
- **GIVEN** a recording SPHERE transport serving the recorded pricing, and `SPHERE_API_KEY` set to a sample value in the environment
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** every recorded request has method `GET`, the origin `https://sphere.score.us.es` and a path that is `/api/v1/public/pricings/6ab0a323697330667ccce891` or `/api/v1/public/pricings/6ab0a323697330667ccce891/versions/6ada6dbd4b2b5b01c587d17f/yaml`
- **AND** no recorded request carries an `Authorization`, `x-api-key` or `Cookie` header, nor the sample value anywhere

#### Scenario: Redirect not followed
- **GIVEN** a SPHERE transport whose manifest answer is `302` with `Location: https://elsewhere.example.org/manifest`
- **WHEN** a client sends `GET /v1/plans/pricing` with no verified read held
- **THEN** no request is sent to `elsewhere.example.org` and the response is the `503` `pricing_unavailable` problem

### Requirement: Verified pricing content
IF the latest version's YAML differs in `sha256` from its manifest `contentHash`, exceeds 5 MiB, does not parse as a mapping, or declares a `version` other than the manifest entry, THEN THE gateway SHALL answer `GET /v1/plans/pricing` with the `503` `pricing_unavailable` problem instead of any content of that version.

`req~plans-pricing-integrity~1`

Needs: impl, utest

#### Scenario: Tampered YAML
- **GIVEN** the recorded manifest and a YAML whose bytes differ from the recorded file by one character, and no verified read and no failed read held
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the response status is `503`, `code` is `pricing_unavailable`, and the body has no `yaml`, `document` or `version` member

#### Scenario: Oversized or mislabelled YAML
- **GIVEN** in turn a YAML of 5 MiB plus one byte, a YAML that is a list, a YAML whose `version` is `0.1.5` for the manifest entry `0.2.0`, and a manifest whose `latestVersionId` is not in `versions`, each case on a fresh reader with no verified read and no failed read held
- **WHEN** a client sends `GET /v1/plans/pricing` in each case
- **THEN** the transport has recorded the request whose answer fails the check, and each response is the `503` `pricing_unavailable` problem

### Requirement: SPHERE unavailable
IF SPHERE refuses the connection, does not answer within `SPHERE_TIMEOUT_S`, answers a status other than `200` or answers a manifest that is not valid, and the gateway holds no verified read younger than 300 seconds, THEN THE gateway SHALL answer `GET /v1/plans/pricing` with `503` and an `application/problem+json` document whose `code` is `pricing_unavailable`.

`req~plans-pricing-sphere-unavailable~1`

Needs: impl, utest

#### Scenario: SPHERE down, no stale body
- **GIVEN** a SPHERE transport that raises a connection error, and a verified read of version `0.2.0` made 301 seconds ago
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the response status is `503` and its media type is `application/problem+json`
- **AND** the body is `type` `https://openbinding.dev/problems/pricing_unavailable`, `title` `pricing_unavailable`, `status` `503`, `code` `pricing_unavailable`, `detail` `The published pricing is unavailable.` and a non-empty `correlationId`, and no other member
- **AND** the response carries `Cache-Control: no-store` and no `ETag`

#### Scenario: Reason kept out of the response
- **GIVEN** in turn a SPHERE timeout, a `500` answer whose body names `sphere.score.us.es`, a `404` for the pricing id, and a manifest without `versions`, each case on a fresh reader with no verified read and no failed read held
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** each response is the same `503` problem, which names no host, URL, upstream status or exception text
- **AND** the gateway log line of each failure carries the same `correlationId` as the response

#### Scenario: No fallback pricing
- **GIVEN** SPHERE unreachable from the first request of the process
- **WHEN** a client sends `GET /v1/plans/pricing`
- **THEN** the answer is the `503` problem; no bundled, recorded or repository copy of the pricing (such as `docs/pricing/openbinding-0.2.0.yml`) is served

### Requirement: Rate limit of the published pricing
IF `PUBLIC_READ_RATE_PER_MINUTE` is greater than 0 and a caller sends more than `PUBLIC_READ_RATE_PER_MINUTE` requests to `GET /v1/plans/pricing` within 60 seconds, THEN THE gateway SHALL answer the excess requests with `429`, an `application/problem+json` document whose `code` is `rate_limit_exceeded`, and a `Retry-After` header in whole seconds.

`req~plans-pricing-rate-limit~1`

Needs: impl, utest

#### Scenario: Budget exhausted
- **GIVEN** `PUBLIC_READ_RATE_PER_MINUTE=3`, the recorded SPHERE pricing and one anonymous client address
- **WHEN** the client sends four `GET /v1/plans/pricing` requests within 10 seconds
- **THEN** the first three responses are `200` or `304`
- **AND** the fourth is `429` with `code` `rate_limit_exceeded`, `status` `429`, no `correlationId`, `Cache-Control: no-store`, and `Retry-After` an integer between 1 and 60

#### Scenario: Limit switched off
- **GIVEN** `PUBLIC_READ_RATE_PER_MINUTE=0`
- **WHEN** one client sends 500 requests within 60 seconds
- **THEN** none is answered `429`

### Requirement: Published pricing in the OpenAPI contract
THE committed OpenAPI snapshot `docs/openapi.json` SHALL describe `GET /v1/plans/pricing` as the public operation `getPlansPricing` of tag `Plans`, with the responses `200` (`PlansPricing`), `304`, `429` and `503` (`Problem` as `application/problem+json`).

`req~plans-pricing-openapi~1`

Needs: impl, utest

#### Scenario: Operation documented
- **GIVEN** `docs/openapi.json` generated by `openbinding-gateway/tools/dump_openapi.py`
- **WHEN** the OpenAPI contract tests read the operation `GET /v1/plans/pricing`
- **THEN** its `operationId` is `getPlansPricing`, its `tags` are `["Plans"]`, it has a `summary` and no `security`
- **AND** `200` references `#/components/schemas/PlansPricing` under `application/json` and declares the headers `ETag` and `Cache-Control`
- **AND** `304` has no content, `429` declares `Retry-After`, and `429` and `503` reference `#/components/schemas/Problem` under `application/problem+json`
- **AND** the snapshot is not stale (`dump_openapi.py --check` passes)

### Requirement: Deprecation signals on the old pricing routes
WHILE the gateway still serves `GET /v1/pricing`, `GET /v1/pricing/catalog` or `GET /v1/pricing/current`, THE gateway SHALL add a `Deprecation` header and `Link: </v1/plans/pricing>; rel="successor-version"` to every response of those routes.

`req~plans-pricing-deprecated-routes-signal~1`

Needs: impl, utest

#### Scenario: Old route still answering
- **GIVEN** a gateway after slice S1 and before slice S4, with SPHERE configured as today
- **WHEN** a client sends `GET /v1/pricing/current`, `GET /v1/pricing/catalog` and `GET /v1/pricing` in turn
- **THEN** every response, `200` or `503`, carries `Deprecation` in the RFC 9745 form `@<unix seconds>` and `Link: </v1/plans/pricing>; rel="successor-version"`
- **AND** the three operations are marked `deprecated: true` in `docs/openapi.json`

### Requirement: Old pricing routes retired
THE gateway SHALL answer `404` to `GET /v1/pricing`, `GET /v1/pricing/catalog` and `GET /v1/pricing/current`.

`req~plans-pricing-deprecated-routes-retired~1`

Needs: impl, utest

#### Scenario: Contract step done
- **GIVEN** a gateway after slice S4
- **WHEN** a client sends `GET /v1/pricing`, `GET /v1/pricing/catalog` and `GET /v1/pricing/current`
- **THEN** each response status is `404`
- **AND** `docs/openapi.json` lists none of the three paths and no schema `PricingCurrentView`
- **AND** `GET /v1/plans/pricing` still answers as in the recorded pricing scenario

### Requirement: No SPHERE credential in the gateway
THE gateway settings SHALL hold no SPHERE credential.

`req~plans-pricing-no-sphere-key~1`

Needs: impl, utest

#### Scenario: Settings and sources after the contract step
- **GIVEN** the gateway after slice S4 and the environment variable `SPHERE_API_KEY` set to a sample value
- **WHEN** the gateway reads its settings and serves `GET /v1/plans/pricing` through a recording SPHERE transport
- **THEN** `Settings` has no field `sphere_api_key`, `sphere_organization_id`, `sphere_organization_name` or `sphere_pricing_slug`
- **AND** no recorded request and no log line carries the sample value
- **AND** the gateway sources under `openbinding-gateway/src/` name neither `SPHERE_API_KEY` nor `sphere_api_key`, and the files `sphere_client.py` and `pricing_catalog.py` no longer exist

### Requirement: Unit suites stay off the network
IF a test of the gateway unit suite opens a connection to a host of SPHERE or SPACE, THEN THE test session SHALL fail that test with an error that names the host.

`req~plans-pricing-no-network-in-tests~1`

Needs: impl, utest

#### Scenario: Control test reaching SPHERE
- **GIVEN** the network guard of the gateway unit suite (`openbinding-gateway/tests/conftest.py`)
- **WHEN** a control test sends a real `httpx` request to `https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891`, and another one to the configured `SPACE_URL`
- **THEN** each request fails before any connection with an error that names the host

#### Scenario: Pricing tests on the recorded fixture
- **GIVEN** the network guard and the tests of the `plans-pricing` requirements
- **WHEN** the unit suite runs
- **THEN** they pass with the recorded pricing of `openbinding-gateway/tests/fixtures/pricing/` and the guard records no attempt
