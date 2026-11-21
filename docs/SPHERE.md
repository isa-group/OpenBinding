# SPHERE in OpenBinding

How OpenBinding reads pricings from [SPHERE](https://sphere.score.us.es), keeps them, and turns them into BIM
problem candidates, binding provenance and the offering version of each evaluation. The design is F3's
(`ARCHITECTURE.md` §9.2 summarises the port and the connections; this page is the reference).

## Reading pricings

**One port.** Every read of SPHERE, of an operator's `SPHERE_REGISTRIES` and of a user-supplied Pricing2Yaml URL goes
through the `PricingSource` port (`modules/plans/application/pricing_source.py`), installed by the gateway's lifespan:
`SphereHttpSource` for the default SPHERE and each registry, `UrlSource` for URLs. Its requests go through
`core/outbound.py`: https only, every DNS answer checked and pinned (global addresses, except an operator's registry),
no redirects for SPHERE, at most `OFFERING_URL_MAX_REDIRECTS` revalidated https redirects for a URL, identity
encoding, `SPHERE_MAX_BYTES` (5 MiB) and `SPHERE_TIMEOUT_S`. SPHERE ids (pricing, version, organization) are checked
(24 lowercase hexadecimal characters) before a URL is built.

**Never during compilation or evaluation.** Pricings are read before a compile or evaluation slot and outside any
database transaction, with timeouts; only immutable ids (`pricingId`, `versionId`) and content-addressed snapshots
are stored.

**Caching and back-off.** Only anonymous answers are cached (`SPHERE_CACHE_TTL_S`, then revalidated by `ETag`; SPHERE
serves no `Last-Modified`); an answer obtained with a key is never cached. Back-off follows SPHERE's own keying
(per organization key, per registry, anonymous): a 429 closes that bucket only; a 404 or 503 is a 60 s negative
entry for that path; transport failures back the host off.

**Settings** (the deployment documents them in `ACCOUNTS_AND_PLANS.md`): `SPHERE_ENABLED` (the default SPHERE),
`SPHERE_URL` (https), `SPHERE_TIMEOUT_S`, `SPHERE_MAX_BYTES`, `SPHERE_CACHE_TTL_S`, `SPHERE_BACKOFF_MAX_S`,
`SPHERE_REGISTRIES` (`{"<alias>": {"url": "https://…", "api_key": "…"}}`), `SPHERE_OPENBINDING_PRICING_ID` (the family
`GET /v1/plans/pricing` serves), `OFFERING_URL_MAX_REDIRECTS`, `OFFERING_URL_MIN_INTERVAL_S`, and `SECRETS_FERNET_KEYS`
(organization connections are encrypted with them).

## Snapshots

Every version read is kept once in `pricing_snapshots`: its bytes in the content-addressed store, its source key
(`sphere:<pricingId>@<versionId>`, `registry:<alias>:…`, or `url:<sha256 of the canonical URL>`), its scope, its
SPHERE ids, label and date, the family's `owner` and `slug` (from SPHERE's permalink and organization routes), the
normaliser's verdict, and whether SPHERE's `contentHash` verified. A version's bytes must match its `ETag`;
`contentHash` is SPHERE's **functional** hash (`content_hash.py`: the js-yaml reading, sorted keys, `saasName`
dropped), so new bytes with the same hash are a **rename**, not new content.

**Scopes.** A public version is shared (one row per immutable `versionId`). A private version read with an
organization's key is that organization's; one read with a registry's operator key is `registry:<alias>`, readable
by the signed-in users of this instance, never by visitors; every URL copy is the reading organization's and counts
against the reader's storage. Rows are insert-only; an organization's own rows go with it.

## Connections and private pricings

An organization ADMIN connects the organization with a SPHERE API key (`PUT /v1/organizations/{org}/connections/sphere`).
The key is checked with `/users/me`, kept as a Fernet token and decrypted only for one call; of `/users/me` only the
user id, username, the key's scopes and expiry are kept. SPHERE decides what a key reads: a MANAGEMENT or ALL key of
an organization ADMIN or OWNER reads every private version of that organization; a VIEW key reads a private pricing
only with an explicit grant. The key is sent only to the default SPHERE; a 401 marks the connection invalid and the
read is retried anonymously.

## Problems from SPHERE: the import recipe

A SPHERE import turns pricings into ordinary BIM candidates. It is described by a **recipe**, JSON validated by the
gateway (`modules/problems/resources/sphere-recipe/1/recipe.schema.json`, the OpenAPI component `SphereImportRecipe`)
and stored, with every version pinned, in the provenance of the revision it generates.

```json
{
  "recipeVersion": "1", "currency": "USD", "billing": "monthly",
  "demand": {"monthlyEmails": {"value": 30000, "unit": "email/month"}, "dailyEmails": {"value": 1000, "unit": "email/day"}},
  "features": {"subscription": {"unit": "USD/month", "direction": "minimize"},
               "availability": {"unit": "", "direction": "maximize", "domain": "ratio"},
               "latency": {"unit": "ms", "direction": "minimize"}},
  "tasks": [{
    "task": "dailySummary", "capability": "service/email", "service": "email",
    "from": [
      {"sphere": {"pricing": "6ade364540e55445692b0eda", "version": "6ade36454b2b5b01c587db3d"}, "provider": "mailgun", "addons": []},
      {"sphere": {"pricing": "6adf1a6240e55445692b6f14", "version": "6adf1a62daa2ba78b21d7119"}, "provider": "sendgrid",
       "assume": {"emailsPerDay": "unlimited"}},
      {"sphere": {"pricing": "6ade2d2540e55445692b07c6", "version": "6ade2d254b2b5b01c587d7ee"}, "provider": "resend",
       "names": {"emailsPerMonth": "transactionalEmailsPerMonth", "emailsPerDay": "transactionalEmailsPerDay",
                 "guaranteedUptimeSla": "uptimeSla"}}
    ],
    "require": {"limits": {"emailsPerMonth": {"atLeast": "monthlyEmails"}, "emailsPerDay": {"atLeast": "dailyEmails"}}},
    "properties": {
      "subscription": "price",
      "availability": {"guarantee": "guaranteedUptimeSla", "map": {"true": 0.9995, "false": 0.99},
                       "sendgrid": {"manual": {"*": 0.999}}},
      "latency": {"manual": {"mailgun": 250, "mailgun.FOUNDATION": 200, "*": 400}}
    }
  }]
}
```

`examples/tomatometer/email-recipe.json` is the full TomatoMeter recipe (five providers); `examples/tomatometer/` also
holds the base problem as a JSON file map (`README.md` says why it is not a package directory).

- **Sources.** `from[].sphere` names a version by immutable ids (`latest` only in a preview: apply refuses it,
  `sphere_version_unpinned`), optionally on a `registry`. `from[].candidate` is a hand-made candidate. `plans` and
  `addons` restrict what is taken (by the pricing's own names); `names` maps a recipe name to the pricing's (limit and
  guarantee names differ across providers); `assume` answers a required limit the pricing does not declare
  (`"unlimited"` or a number, recorded as a value set by hand, warning `sphere_limit_assumed`); `billing` names that
  source's billing period when it differs from the recipe's; `seats` prices per-user units.
- **Candidates.** Each plan and each plan with one subscription add-on available for it (a metered add-on, paid per
  quantity used, is never imported; configurations are F8's). Ids are `<service>.<provider>.<plan>[.<addon>]`, each
  segment slugged; the catalog `sphere-<service>` carries no version, so `sphere-email/email.mailgun.foundation`
  survives new pricing versions and renames. Two plans with one slug (`Pro`, `PRO`) are refused, never suffixed.
  Private plans, plans without a published price and prices whose expression has no value are left out with their
  findings.
- **Values** (plan §2.8):

  | Spec | Written as | Origin |
  |---|---|---|
  | `"price"` | the subscription per month: plan + add-on, each part made monthly (`/year` ÷ 12), per-seat parts × seats, × the billing multiplier; the feature must be `scope: selectedCandidate` (paid once per selected candidate) | `priced` (the parts and the formula) |
  | `"guarantee:<name>"`, `{"guarantee": <name>, "scale": x}`, `{"guarantee": <name>, "map": {...}}` | a QoS feature: a numeric guarantee × scale, a boolean one through its table; `docUrl` kept | `guarantee` |
  | `"limit:<name>"`, `{"limit": <name>, "unlimitedAs": n}` | a candidate property (unlimited is `1e8`), or a feature with an explicit `unlimitedAs` | `limit` |
  | `"feature:<name>"` | a candidate property | `feature` |
  | a number, `{"manual": {"<provider>.<plan>" \| "<provider>" \| "*": v}}` | a constant, or a value set by hand (most specific key wins) | `manual` |

- **Demand and requirements.** `require.limits` names a demand per limit and `require.features` boolean features that
  must hold. They become the task's compile-time `requires.predicate`
  (`candidate.properties.emailsPerDay >= 1000 && candidate.properties.emailsPerMonth >= 30000`), the demand written
  as a literal: the compiler decides eligibility, and a plan that misses the demand stays in the catalog,
  ineligible. Another demand is another revision. Every property a predicate reads is written on every generated
  candidate; a candidate of another catalog that provides the capability must carry it too
  (`sphere_property_missing_on_candidate`).
- **An existing problem.** The import owns only its catalogs `sphere-<service>`, its tasks' `requires.predicate`, the
  features it declares (added when missing; an existing one must agree) and wider domains and normalisation bounds
  (`sphere_rescaled`). A predicate or a `sphere-<service>` resource it did not write is refused, never overwritten.
- **Determinism.** Canonical JSON, candidates by id, the recipe digest in `instance.json`'s annotations
  (`openbinding.org/sphere-recipe`), and no snapshot digest, content hash, version id or pricing title in any file:
  the same recipe over the same pricings always gives the same bytes, and a rename none.

The `sphere_*` findings are listed in [ERRORS.md](ERRORS.md#sphere-imports).

## Preview and apply

- `POST /v1/organizations/{org}/problems/{problem}/sphere/expand` (MEMBER, `compile` work): reads and snapshots every
  pricing the recipe names (one after another, within 30 s), generates the package over `base` (or a new problem whose
  slug is `{problem}`), compiles it and answers the candidates with the explanation of each requirement term, the
  changes against the base, the facts with their value sources, the snapshots read and the `packageDigest`. Findings,
  the compiler's included, come back with a 200.
- `POST …/sphere/apply`: stores exactly what the preview showed — a pinned recipe, the stored snapshots (no SPHERE
  call after a preview), `expect.packageDigest` (else `409 sphere_preview_stale`), the existing revision when the
  package is already stored (200: retries are idempotent), a free slug for a new problem (`409 problem_exists`), and
  `base` checked under the problem lock (`409 revision_moved`). The revision's origin is `sphere`.
- `GET …/sphere/recipe[?revision=N]`: the pinned recipe of a generated revision.

## The wizard

"Add candidates from SPHERE" is a dialog of the problem pages (no route): the problems tab's New ▾ "From SPHERE"
starts a new problem, the problem page's New version ▾ "Add candidates from SPHERE" adds to its latest version, and
"Update from SPHERE" opens on the recipe the latest import pinned. Six steps, in SPHERE's order:

1. **Pricing**: SPHERE's search through the gateway (300 ms after typing; a busy SPHERE is waited for by its
   `Retry-After`), filtered by collection, a minimum price "at least" on SPHERE's whole-result histogram, sort by name
   or minimum price, the organization's SPHERE organizations when it is connected and the operator's registries;
2. **Version**: the family's versions by name and date, SPHERE's latest (by date) marked and chosen;
3. **Task and plans**: the task (an existing service task, or a new problem's name, task and capability), the
   provider key, the plans drawn by pricing-renderer beside a checklist (private or unreadable plans disabled with the
   summary's reason; per-use add-ons listed apart, never imported), add-on variants, the billing period the pricing
   declares and seats for per-seat plans;
4. **Mapping**: how each problem feature is read (price, limit, feature, guarantee by table or scale, one number, by
   hand), a pricing's own name for a limit or guarantee, what to assume for a limit it does not declare, the demand and
   the requirements, dominance pruning;
5. **Preview**: the gateway's expansion: findings, changes against the base, each candidate with whether the
   requirements hold and why not, the matrix with every value's source, values left to set by hand, and, for an update,
   each kept plan whose pinned version changes drawn before and after;
6. **Generate**: apply with the preview's package digest; a 409 offers to reload and preview again.

The step and the pricing and version being added are in the address (`?sphereStep=&sphere=&sphereVersion=`); the rest
of the form is kept for the session, so a reload lands on the same step. The browser never calls SPHERE: only an "Open
in SPHERE" link leaves for it.

## On the screens

- Every value an import wrote says its source (Priced, Guarantee, Limit, Feature, Manual) and the upstream plan by its
  name and version label; a candidate's properties are a read-only group of the matrix; the problem editor warns before
  a value with a source is edited (it becomes hand-written).
- A composition's Overview draws each upstream plan from its stored snapshot (version name and date, "Open in SPHERE")
  and its storefront from the offering version the evaluation read; with no snapshot the card keeps the reference face.
  The catalog lists the source kinds of each global value and warns when only values set by hand give one. The version
  comparison draws an upstream plan that changes through the plan change review.
- An organization's SPHERE key is connected in the beta Connections tab (ADMIN).

## Value origins and provenance

`problem_value_origins` keeps, for each value an import wrote, its candidate and target, its source kind (`priced`,
`guarantee`, `limit`, `feature`, `manual`), the value, the snapshot and SPHERE ids, the plan and add-ons, and how it
was read. Rows are written with their revision and never change. The facts of a revision show each value's `source`
next to where the package writes it, every candidate's properties, and each generated candidate's `provenance`.

An editor save or an upload carries every row whose value the new revision keeps (from the latest revision under the
problem lock); a changed value loses its source. A candidate keeps its provenance only while every value read from a
pricing was carried.

**Binding provenance.** Derive writes the `from` of every generated candidate (`owner/name`, the version id, the plan
and add-ons). Wherever a document is assessed against its problem, a `from` on a generated candidate must say what the
revision recorded (`c2y_provenance_mismatch`, an error); an entry without one is valid with
`c2y_provenance_missing` (a warning). A hand-written `from` on a candidate no import generated is not checked; it is
snapshotted at seal (at most 8 resolutions over the network per seal), and `resolve_provenance` does the same later
in the upstream watcher (see "Watching upstream pricings").

## The offering

A composition's `offering` (`sphere: owner/name`, optionally on a `registry`, or an https `url`) is read when an
evaluation is created — a seal, a derivation that seals, a fork, a re-evaluation on a new basis — never on
`versions/check`, `evaluate` or `neighborhood`. `owner/name` is resolved by organization and exact slug (two families
with one name are ambiguous) and its latest version is read; a URL is kept in the organization's scope. The version read
is stored on the evaluation (`offering_snapshot_id`, `offering_status`); an unreadable or invalid offering is a warning
(`c2y_offering_unreadable`, `c2y_offering_invalid_pricing`) and never invalidates a binding.

`GET /v1/organizations/{org}/compositions/{composition}/upstream?version=` answers, from stored data only, each binding
entry's upstream plan and snapshot, the source kinds of each global value and the offering version the current
evaluation read; a visitor of a public composition sees public snapshots only.

## Watching upstream pricings (F6)

Every sealed version records what it reads upstream as watch references; the upstream watcher asks each watched
family's manifest once per interval (`UPSTREAM_POLL_INTERVAL_S`, 300 s; staggered per watch) with `If-None-Match` and
`revalidate=True`, so a fresh cache entry or a recent 404 never answers for SPHERE. A new latest version (SPHERE's
order: by `createdAt`, never the highest label) is snapshotted as a system read, passing the manifest already read.
A 429 closes the watch's bucket (every public watch, one registry's, or one organization's keyed ones; a URL offering's
host is a bucket of its own) until `Retry-After`, in the
database, so a leadership change keeps it; a failure backs off exponentially to an hour; a family is gone only after
two 404s from requests actually sent at least one interval apart by the database clock. An organization-scoped watch
reads with its connection's key; a missing key, or one SPHERE refuses during the read (the adapter would then answer
anonymously), is `credential_missing`, never an event. A family rename (a new manifest `name` and ETag, the same
versions) changes the ETag only. A version whose `contentHash` changes under the same id is logged as
`content_rewritten`, and only for snapshots whose stored hash was verified against the bytes. At most
`UPSTREAM_READS_PER_CYCLE` requests are sent per cycle.

The classifier compares the pinned and the new version for each live version's bound selection with
pricing-renderer's `compareSelections`, ported (`plans/domain/pricing2yaml/compare.py`), and judges the candidate with
the generator's own functions (`problems/application/sphere/candidate.py`): see
[ADR 0057](adr/0057-upstream-watches-and-events.md) and `tools/dump_upstream_goldens.py` (goldens G1–G20, offline).

The tests and fixtures publish synthetic upstream versions from the scenario catalog
(`tests/fixtures/sphere/scenarios.json`, derived offline by `tools/record_sphere_fixtures.py --derive` and checked by
`--check-derived`; `RecordedSphere.publish(scenario)` serves one). They are never published to SPHERE.

## Fixtures and the live check

The tests never reach the network: SPHERE answers are recorded in `openbinding-gateway/tests/fixtures/sphere`
(provenance and licence in its `README.md`) and served by `tests/sphere_recorded.py`; the unit shards run with
`OPENBINDING_FORBID_NETWORK=1`.

- Re-recording: `python tools/record_sphere_fixtures.py --check` reports drift against the live API (GET only,
  anonymous); `--update` rewrites changed files, deliberately, in a commit of its own.
- The live check: `python tools/sphere_smoke.py` (read-only, about ten anonymous GETs) verifies bytes against their
  `ETag`, the functional hash against `contentHash`, revalidation and the rate-limit headers.
- The generator's goldens: `python tools/dump_sphere_goldens.py [--check]` regenerates
  `tests/golden/sphere/<case>.*.json` (JSON file maps, never package directories) from `tests/golden/sphere/cases.json`.
- The lab seed builds `lab-main/tomatometer-email` revision 2 from the e-mail recipe and a composition derived from it
  with the offering `sphere/tomatometer`; with SPHERE unreachable it logs `sphere: skipped`, and the smoke reports its
  SPHERE steps skipped.
