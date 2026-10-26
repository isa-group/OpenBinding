# Intake: P-20261026-1, stop making up DOIs and dead URLs in the gateway's citations

- Kind: reliability, size S, owner-approved · Base: `task/786fbb84c30f4acf` at `212b9662`
- INTENT objective: **O4, reproducibility inside the platform** (`INTENT.md:165`). Journey 1: "A paper's reader opens
  a problem, a collection or a published result from its permanent link and verifies it by digest, without an
  account" (`INTENT.md:48-49`). Principle 9, evidence honesty (`INTENT.md:92`).
- Living spec: `openspec/specs/resolver-verifier/spec.md` has no citation requirement. Its TODO lists "Citation
  metadata (BibTeX/DOI) generation as a requirement" (`spec.md:83`). This change adds that requirement.

## 1. Objective

Every `citation` returned by `GET /v1/resolve/{kind}/{digest}` and `POST /v1/verifier/inspect[-file]` contains only
recorded facts: no made-up DOI, venue or year, and a `url` that opens a live frontend route on the deployment's own
origin. The response schema does not change.

## 2. What the code does today (verified at `212b9662`)

| # | Fact | Evidence |
|---|---|---|
| F1 | Two separate builders. Both make up the DOI `10.1109/OPENBINDING.<digest[7:19]>`, fix `year = 2026`, set venue "OpenBinding Canonical Provenance Registry" and hard-code `https://openbinding.score.us.es` | `routes/resolve.py:168-206` (DOI :179, base :180); `routes/verifier.py:50-98` (DOI :60, URL :61, :69) |
| F2 | Fallback URL `/verifier?digest=` matches no route. The verifier screen is `/app/verifier` | `resolve.py:184`, `verifier.py:61`; `frontend/src/routes/d6.tsx:28` |
| F3 | The resolver citation points at `/app/<org>/<project>` (live: `d3.tsx:26`). The verifier citation points at `/cases/<slug>` (live, `d4.tsx:28`), `/collections/<slug>` (live, `d4.tsx:43`) and `/reports/<slug>`. The reports route is retired and only redirects to publications | `resolve.py:181-182`; `verifier.py:68-75`; `frontend/src/routes/retiredRoutes.tsx:46-47` |
| F4 | Call sites: 11 in `resolve.py` (272, 329, 383, 422, 488, 557, 611, 661, 709, 761, 816) and 2 in `verifier.py` (415, 455) | grep `_build_citation` |
| F5 | Missing author: both builders insert "OpenBinding Research Group" as the author. This is also made up, and the proposal does not mention it | `resolve.py:176`, `verifier.py:57` |
| F6 | The verifier builds a citation even when nothing visible matches the digest (`computed`, `mismatch`, `not_found` with a digest). The title is then "Reproducible Service Binding Blob" | `verifier.py:55-57,414-415,454-455` |
| F7 | `PUBLIC_BASE_URL` is the **gateway's** origin. CAS builds `/api/v1/auth/cas/callback` from it. `FRONTEND_URL` is the frontend's origin. They differ in dev (`:8000` vs `:5173`); prod and lab set them equal | `core/settings.py:332-343`; `routes/cas.py:64`; `routes/auth.py:365`; `docker-compose.yml:69,77,170,178`; `compose.lab.json:189-190` |
| F8 | Recorded publication citations exist as free-form dicts with no validated keys: `ArtifactPublication.citation` (per artifact version) and `Publication.citation` (per report edition) | `db/artifact_models.py:81-87`; `db/platform_models.py:559-583`; `models/platform.py:450`; `models/artifacts.py:60`; `routes/library.py:243`; `routes/studies.py:1390-1394` |
| F9 | Schema: `doi`, `venue` and `url` are already `Optional[str]`. `year: int = 2026` is required with a made-up default. `authors` defaults to `[]`. `VerifierInspectResponse.citation` and `ResolveResponse.citation` are `Optional` | `models/platform.py:558-566,595,648`; `docs/openapi.json:10201-10267` |
| F10 | The public permanent link is the live route `/resolve/:kind/:digest`, which needs no account. The verifier API needs an account. The frontend already cites `${origin}/resolve/<kind>/<digest>` and falls back to `/app/verifier?digest=` | `frontend/src/routes/d1.tsx:28`; `spec.md:39-49` (`req~resolver-verifier-inspect-auth~1`); `frontend/src/pages/Reports/Verifier.tsx:134`; `frontend/src/pages/Platform/verifierOptions.ts:13-18` |
| F11 | Tests: only `@misc`, the badge, the title and the digest are checked. `test_b1_verifier.py` normalizes the made-up DOI out of its comparison of hidden and unknown digests | `tests/test_verifier.py:65-67,137-139`; `tests/test_b1_verifier.py:76-85` |
| F12 | A route-table contract helper already exists and can be reused for citation URLs: `assert_is_a_frontend_screen`, which reads `frontend/src/routes/d*.tsx` | `tests/test_b2_resolve_urls.py:44-111` |
| F13 | Layering: `services/` must not import `routes`. Shared route code belongs in `services/` or `domain/` | `tests/test_architecture_layers.py:15,101-110,415-427` |
| F14 | The normative doc shows a made-up Zenodo DOI in its example response, with a field shape (`citations.uri`) that the API does not have | `docs/RESOLVER_AND_VERIFIER.md:10` (cited by spec), `:132-135` |

## 3. Scope and non-goals

In scope:

- One shared citation builder in `services/citations.py`. It is used by all 13 call sites, and both private
  `_build_citation` functions are removed.
- `doi` and `venue` are taken only from the recorded publication citation of the exact version (F8), and `doi` only
  when it is a well-formed DOI (`10.<4-9 digits>/<suffix>`, with an optional `https://doi.org/` prefix removed).
  Otherwise they are `null`, and the BibTeX entry leaves out the `doi`/`howpublished` lines.
- `year` comes from the recorded citation's integer `year`. Without one, it comes from the publication's
  `published_at`, and without that, from the element's sealed or created date (`created_at` of the revision or
  version, `VerifierEntityMatch.created_at`). Never a constant.
- `url` is built on the configured frontend origin and points at a live route (link target: CRP-1).
- Missing author: `authors = []`, not "OpenBinding Research Group" (F5, part of CRP-2).
- Gateway tests that fail on any DOI starting with `10.1109/OPENBINDING`, on the venue string, on the
  `openbinding.score.us.es` literal when the setting differs, and on any citation URL that is not a live route
  (F12).
- The doc example (F14) and the spec requirement (coordinator, OpenSpec delta).

Non-goals:

- No schema change: no field removed, no field made optional, and `docs/openapi.json` stays byte-identical. The
  `year` default of 2026 in the model (F9) stays. Changing it would change the OpenAPI snapshot (followup).
- `locations[].web_url` of reports (`resolve.py:88-89,476`) still points at the retired `/reports/` route. That is
  tracked as `KNOWN_REDIRECTING_WEB_URLS` "retarget the resolver in M9.6 or earlier" (`test_b2_resolve_urls.py:63`).
  It is a separate followup.
- Frontend: it already ignores the gateway citation (`Verifier.test.tsx:91-92`, `Verifier.tsx:130-137`). The stale
  test comment ("whose DOI and venue are made up") is a followup for R9, not part of this change.
- Validating or migrating stored publication citations; DOI minting or Zenodo (M6.5, `ROADMAP.md:162`).
- `markdown_badge` (a shields.io image, not a made-up fact) stays. It now links to the new `url`.

## 4. Slices

No parallel slices: S2 reuses S1's module. S3 is docs only and can run in parallel with S1 and S2 (disjoint files).
**No feature flag.** Each slice removes made-up values from one endpoint family and is safe to merge on its own.
Between S1 and S2, `/v1/verifier` still returns the old values, as it does today, and nothing breaks.

| # | Slice (one capability) | Role / budget | Owned files | Read-only context | Est. diff (src, tests excluded) | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | Shared honest-citation builder, used by `/v1/resolve` (11 sites) | implementer, default model, medium effort, ~40 turns | `openbinding-gateway/src/openbinding_gateway/services/citations.py` (new), `openbinding-gateway/src/openbinding_gateway/routes/resolve.py`, `openbinding-gateway/tests/test_citations.py` (new) | `models/platform.py`, `core/settings.py`, `db/artifact_models.py`, `db/platform_models.py`, `tests/test_b2_resolve_urls.py`, `tests/test_resolve.py`, `frontend/src/routes/*.tsx`, `tests/test_architecture_layers.py` | ~90 new + ~110 changed in resolve.py (−39 builder, 11 call sites, publication lookup for report / resource / collection) ≈ 200-230 | **medium**: `routes/**` is R3 (`.agentic/project.yaml:112-114`). It is not breaking, but every value of a public anonymous endpoint changes. The publication lookup reads data only after the existing visibility filter | CRP-1, CRP-2 answered; OpenSpec change validated |
| S2 | `/v1/verifier` uses the shared builder | implementer, default model, medium effort, ~30 turns | `openbinding-gateway/src/openbinding_gateway/routes/verifier.py`, `openbinding-gateway/tests/test_verifier_citations.py` (new), `openbinding-gateway/tests/test_verifier.py` (lines 65-67, 137-139 only), `openbinding-gateway/tests/test_b1_verifier.py` (the `normalized` helper, line 79, only if it breaks) | `services/citations.py` (from S1), `tests/test_b1_verifier.py` | −49 builder, +~25 (settings dependency, publication lookup, 2 call sites) ≈ 75-90 | **medium**: R3, and it touches `req~resolver-verifier-inspect-indistinguishable~1`. Hidden and unknown digests must still give byte-identical answers apart from the digest (`spec.md:63-73`). Add security-auditor only if the coordinator counts the recorded citation as external input (`REVIEW.md:34`) | S1 merged |
| S3 | Normative doc tells the truth about citations | doc-steward, default model, low effort, ~15 turns | `docs/RESOLVER_AND_VERIFIER.md` | `models/platform.py:558-566`, S1 design | ~10-20 | **low**: one doc file outside the risk globs | CRP-1/CRP-2 answered (it describes the chosen behaviour) |

Requirement ids (the specifier writes them in the OpenSpec delta of `resolver-verifier`; proposed names):
`req~resolver-verifier-citation-no-invented-metadata~1` (doi/venue only from the recorded publication, otherwise null;
authors never made up), `req~resolver-verifier-citation-year~1`, `req~resolver-verifier-citation-url~1` (configured
frontend origin, live route). S1 implements all three on resolve and S2 on the verifier. Tags: `[impl->...]` in
`services/citations.py`, `[utest->...]` in the new tests.

Shared-file note: `tests/test_b2_resolve_urls.py` stays read-only for everyone. S1 imports its helpers instead
(F12). No other file is shared.

### Proposed checks (none registered; argv arrays, `cwd: openbinding-gateway`)

S1 and S2:

0. `["uv","sync","--locked","--extra","test"]`
1. Red-before (G3), S1: `{"argv":["uv","run","--locked","--extra","test","pytest","-q","tests/test_citations.py"],"type":"red_before","expect_exit":[1],"expect_pattern":"10\\.1109/OPENBINDING|AssertionError","overlay":["openbinding-gateway/tests/test_citations.py"]}`.
   S2: the same with `tests/test_verifier_citations.py`.
2. Focused (G5), S1: `["uv","run","--locked","--extra","test","pytest","-q","tests/test_citations.py","tests/test_resolve.py","tests/test_b2_resolve_urls.py","tests/test_architecture_layers.py"]`.
   S2: `[... "pytest","-q","tests/test_verifier_citations.py","tests/test_verifier.py","tests/test_b1_verifier.py","tests/test_citations.py"]`.
3. Full gateway suite (G5, `gateway-unit`): `["uv","run","--locked","--extra","test","pytest"]`, timeout 1800.
4. G7, schema unchanged: `["uv","run","--locked","python","tools/dump_openapi.py","--check"]`.
5. G9: `["uv","run","--locked","--extra","test","ruff","check","src","tests"]`.
6. Literal guard (G9 stand-in, `cwd: .`). It must print nothing and exit 0:
   `["bash","-c","set -euo pipefail; ! grep -rnE '10\\.1109/OPENBINDING|Canonical Provenance Registry|openbinding\\.score\\.us\\.es' openbinding-gateway/src/openbinding_gateway/routes openbinding-gateway/src/openbinding_gateway/services"]`.
   S1 runs it on `resolve.py` and `services/` only, and S2 on the whole path above.

S3: `["git","diff","--check"]` (`cwd: .`) and check 6 with `docs/RESOLVER_AND_VERIFIER.md` added to the path.

### What the S1 tests must prove (gateway tests, written first)

- For every one of the 10 kinds in `VALID_KINDS` (`resolve.py:55-66`): `doi` is null with no publication. No
  value starts with `10.1109/OPENBINDING`. `venue` is null. `year` equals the element's `created_at.year`. `authors`
  holds no "OpenBinding Research Group". The BibTeX entry has no `doi =` line.
- A report edition or library version published with `{"doi": "10.5281/zenodo.123", "venue": "V", "year": 2025}` →
  those exact values. A malformed DOI (`"not-a-doi"`) gives `doi: null`.
- With `FRONTEND_URL` set to `https://ob.example` (settings override), every citation `url` and the badge link start
  with it. Once the origin is removed, the path passes `assert_is_a_frontend_screen` (live routes only, not the
  redirecting list).
- Unit tests of the builder in `services/citations.py`: BibTeX escaping of `{`/`}` in titles, and no mutable module
  state (F13).

S2 adds: a `computed` document, an `inspect-file`, a case, a report and a collection give the same assertions, and
`test_b1_verifier.py` still passes unchanged except, if needed, its `normalized` helper (F11).

## 5. Gates per slice

| Gate | S1 | S2 | S3 |
|---|---|---|---|
| G1 spec | yes: `openspec validate --strict` on the change. The check is `todo: true` (`project.yaml:34`), so it is reported NOT EXECUTED until it is registered | yes (same change) | yes (same change) |
| G2 EPIC | yes, spec-auditor ≥ 2/3 | same change | same change |
| G3 red-before | yes, check 1 | yes, check 1 | n/a (no test) |
| G4 acceptance frozen | n/a unless the coordinator adds a test-designer task. `acceptance/api/` has only a runner conftest and no app harness (`acceptance/api/conftest.py:1-13`) | same | n/a |
| G5 green-after | checks 2-3 | checks 2-3 | n/a |
| G6 trace | tags required; `oft-trace` is `todo: true` (`project.yaml:62`), reported NOT EXECUTED | same | n/a |
| G7 contracts | check 4 must pass with **no** diff (the schema is unchanged) | check 4 | n/a |
| G8 mutation | `todo: true` (`project.yaml:72`), NOT EXECUTED | same | n/a |
| G9 quality | checks 5-6 | checks 5-6 | `git diff --check` + check 6 |
| G10 secrets/ownership | no forbidden or R11 paths | same | same |
| G11 review | medium panel: reviewer + test-reviewer (`project.yaml:143`) | medium, + security-auditor if counted as external input (S2 row) | low: reviewer |
| G12 lab/UI | lab smoke: `GET /v1/resolve/case-revision/<seeded digest>` on `http://localhost:18100` shows `doi: null` and a `url` on `DEMO_PUBLIC_ORIGIN`. No UI change, so no ui-qa | lab: `POST /v1/verifier/inspect` as the seeded user | n/a |
| G13 review package | how-to-test with 2-3 verified API examples (resolve: case revision, published report) | how-to-test with 2 verified API examples (inspect a digest, inspect a file) | n/a with a `how_to_review` |

## 6. Feature flags

None. The schema is unchanged, each slice is independently correct, and nothing has to stay hidden until a later
slice lands (section 4).

## 7. Open questions

Needs a CRP (they change public values beyond what the approved proposal spelled out):

- **CRP-1: citation link target and origin.** The proposal says to use `PUBLIC_BASE_URL`, project screens,
  `/publications` for reports and `/app/verifier?digest=` as the fallback. But `PUBLIC_BASE_URL` is the gateway's
  origin (F7), and `/app/*` and the verifier need an account, while journey 1 is "without an account" (F10).
  Options:
  (a) as proposed: `PUBLIC_BASE_URL` + project / publications screens, fallback `/app/verifier?digest=`;
  (b) `FRONTEND_URL` + the public permanent link `/resolve/<kind>/<digest>` for every resolvable element, as the
  frontend already does (`Verifier.tsx:134`), with `/app/verifier?digest=` only when no resolvable kind exists
  (e.g. a verifier `study_run` match);
  (c) (a)'s targets on `FRONTEND_URL`.
  Recommended: **(b)**. It is the only option whose link a reader without an account can open, and it is correct in
  dev, where the two origins differ.
- **CRP-2: citation when nothing visible matches, and the author when unknown.** Options:
  (a) keep a citation with a generic title, `authors: []`, `year` = year of `verified_at`, and the fallback URL;
  (b) `citation: null` when no visible element matches (schema-allowed, F9; the frontend already handles null,
  `Verifier.test.tsx:199`), and `authors: []` whenever no author is recorded.
  Recommended: **(b)**: an unregistered digest has nothing to cite. Hidden and unknown digests stay
  indistinguishable either way, because both get the same answer.

For the coordinator (no owner decision needed):

- Q1: is a recorded publication citation "external input" for the review panel (security-auditor on S1/S2)? It is
  publisher-written free JSON (F8) that is copied into BibTeX. Recommended: yes for S1. BibTeX escaping is in the
  test list.
- Q2: should acceptance tests be added (test-designer, `acceptance/api/`)? There is no harness there yet. The
  recommendation is gateway tests written first (G3) in S1 and S2.
