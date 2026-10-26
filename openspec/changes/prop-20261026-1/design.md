# Design: prop-20261026-1

## Context

Two private builders, `_build_citation` in `routes/resolve.py:168-206` (11 call sites) and in
`routes/verifier.py:50-98` (2 call sites, `:415`, `:455`), fill `CitationMetadata` (`models/platform.py:558-566`)
with a made-up DOI, venue, author and year and a URL on a hard-coded host (intake F1-F6). The only recorded citations
are the free-form JSON objects `ArtifactPublication.citation` (`db/artifact_models.py:81-87`, per artifact version)
and `Publication.citation` (`db/platform_models.py:559-583`, per report edition); both rows carry `withdrawn` and
`published_at` (F8). `PUBLIC_BASE_URL` is the gateway's origin and `FRONTEND_URL` the frontend's; they differ in
development (`:8000` and `:5173`) (F7). The public permanent link `/resolve/:kind/:digest` is a live route that needs no
account (`frontend/src/routes/d1.tsx:28`), and the frontend already cites it (F10).

## Definitions

These definitions give the full meaning of the three requirements of `specs/resolver-verifier/spec.md`; each rule
is also covered by at least one scenario there.

**Citation-returning endpoints.** "The resolver or the verifier returns a `citation`" means a `citation` object in the
answer of `GET /v1/resolve/{kind}/{digest}`, `POST /v1/verifier/inspect` or `POST /v1/verifier/inspect-file`.

**Recorded publication citation.** The recorded publication citation of an element is the `citation` object of its
live (not withdrawn) publication record for the exact version the digest identifies (`ArtifactPublication.citation`
for an artifact version, `Publication.citation` for a report edition). A publication of another version, or a
withdrawn one, is not a recorded publication citation of this element.

**Recorded facts** (`req~resolver-verifier-citation-no-invented-metadata~1`):

1. `doi` is the `doi` value of the recorded publication citation when it is a well-formed DOI: `10.`, 4 to 9 ASCII
   digits, `/` and a non-empty suffix without whitespace, after removing an optional `https://doi.org/` prefix; the
   prefix-free form is returned. In every other case (no recorded publication citation, no `doi` key, a value that is
   not a string or not well-formed) `doi` is `null`.
2. `venue` is the `venue` string of the recorded publication citation when it is a non-empty string; otherwise
   `null`.
3. `authors` is the list of author strings of the recorded publication citation when it has one; otherwise the
   username of the element's recorded author or owner when one is recorded; otherwise `[]`. No constant author name is
   ever returned.
4. `bibtex` contains a `doi` field only when `doi` is not `null` and a `howpublished` (venue) field only when `venue`
   is not `null`. Every value taken from a recorded publication citation or from a user-written name cannot close the
   BibTeX field or entry: its `{` and `}` are removed, and its other BibTeX special characters (`\` and the others the
   builder handles) are escaped. Braces are removed rather than escaped because classic BibTeX counts `\{` as a brace
   when it matches the delimiters of a field, so escaping cannot keep the field closed. The entry stays one single
   entry that contains only the builder's fields.
5. In the verifier, when no item visible to the caller matches the digest (status `computed`, `mismatch` or
   `not_found`), `citation` is `null`. A hidden and an unknown digest therefore both get `citation: null`, as
   required by `req~resolver-verifier-inspect-indistinguishable~1` (living spec
   `openspec/specs/resolver-verifier/spec.md`, unchanged).

**Year** (`req~resolver-verifier-citation-year~1`): the first available of the integer `year` of the recorded
publication citation, the calendar year of that publication's `published_at`, and the calendar year of the element's
sealed or created date. A `year` value that is not an integer (for example the string `"2025"` or a boolean) counts
as absent. The element's sealed or created date is the `created_at` of the revision or version the digest identifies
(for the verifier, the matched item's `created_at`). The year is never a constant, and the `bibtex` entry carries the
same year.

**URL** (`req~resolver-verifier-citation-url~1`): the rule applies to `url` and to the link target of
`markdown_badge`.

- A resolvable kind is one of the `kind` values accepted by `GET /v1/resolve/{kind}/{digest}` (`case-revision`,
  `resource-revision`, `collection-revision`, `report`, `artifact`, `engine`, `dialect`, `registered-resource`,
  `instance-snapshot`, `binding-ir`). An element of a resolvable kind gets `/resolve/<kind>/<digest>`; only an element
  without a resolvable kind (for example a verifier `study_run` match) gets `/app/verifier?digest=<digest>`.
- `<digest>` is the normalised digest with its `sha256-` prefix.
- The origin is the configured `FRONTEND_URL` with any trailing `/` removed; `PUBLIC_BASE_URL` (the gateway's own
  origin) and any hard-coded host are never used.
- The path is always a live frontend route (`/resolve/:kind/:digest` or `/app/verifier`), never a retired,
  redirecting or non-existent one (for example `/verifier`, `/reports/<slug>`).

**Traceability.** The Evidence lines of the three requirements name the files that carry the coverage tags:
`openbinding-gateway/src/openbinding_gateway/services/citations.py` is tagged `[impl->req~<name>~1]` for each of the
three requirements; `openbinding-gateway/tests/test_citations.py` and
`openbinding-gateway/tests/test_verifier_citations.py` are tagged `[utest->req~<name>~1]`.

## Decisions

1. **One shared builder in `services/citations.py`.** Both private builders are removed and all 13 call sites call
   it. Reason: one implementation of the rules, so the resolver and the verifier cannot drift; it lives in
   `services/` because the layering test forbids services importing routes and points shared code there
   (`tests/test_architecture_layers.py:415-427`, F13). The builder is a pure function of its inputs (title, digest,
   kind or `None`, recorded publication citation or `None`, `published_at`, created date, recorded usernames,
   frontend origin); it holds no module state and does no I/O. The routes look up the publication and pass it in.
2. **DOI and venue only from the recorded live publication citation of the exact version (CRP-2 (b), handoff D3).**
   Reason: it is the only place a publisher states a DOI. A publication of another version is not a citation of this
   content, and a withdrawn publication is no longer asserted by its publisher. The DOI is accepted only when
   well-formed (`10.<4-9 digits>/<non-empty suffix without whitespace>`, optional `https://doi.org/` prefix removed),
   so a typo or free text is not presented as a DOI.
3. **Authors: recorded citation list, else recorded author/owner username, else `[]` (CRP-2 (b)).** Reason: the
   constant "OpenBinding Research Group" is made up (F5). A username is a recorded fact of the element; an empty list
   is honest and already the schema default.
4. **Year fallback chain: recorded citation `year` (integer only) → `published_at` → sealed/created date.** Reason:
   every step is a recorded date; the model default `year: int = 2026` stays because changing it changes
   `docs/openapi.json` (handoff D4), so the builder always sets `year` explicitly.
5. **URL on `FRONTEND_URL`, public permanent link (CRP-1 (b)).** Reason: it is the only target a reader without an
   account can open (journey 1); `/app/*` and the verifier need an account (`req~resolver-verifier-inspect-auth~1`).
   `FRONTEND_URL` is correct in development, where `PUBLIC_BASE_URL` points at the gateway. The fallback
   `/app/verifier?digest=` is the live verifier route (`frontend/src/routes/d6.tsx:28`), used only when the element has
   no resolvable kind. `markdown_badge` keeps its shields.io image and links to the same `url`.
6. **Verifier: `citation: null` without a visible match (CRP-2 (b)).** Reason: an unregistered digest has nothing to
   cite. Hidden and unknown digests both have no visible match, so both get `null` and stay indistinguishable
   (`req~resolver-verifier-inspect-indistinguishable~1`); no data of a hidden element (its year, its title) can reach
   the answer.
7. **No feature flag; three slices** (`tasks.md`). Reason: the schema is unchanged and each slice only removes made-up
   values from one endpoint family, so each is safe to merge alone.
8. **URL tests reuse the route-table helper `assert_is_a_frontend_screen`** (`tests/test_b2_resolve_urls.py:44-111`,
   handoff D5) by import, without changing that file. Reason: one source of truth for the live route table.

## Mapping of verifier matches to resolve kinds (to be confirmed by the implementer of S2)

The verifier's `VerifierEntityMatch.entity_type` values (`routes/verifier.py:160-357`) map to resolve kinds as
follows. The implementer of S2 confirms each row against `routes/resolve.py` (that resolving the matched digest with
that kind returns the same element) and records any deviation in the PR; a row that cannot be confirmed falls back to
`/app/verifier?digest=`.

| `entity_type` | Source row | Resolve kind | Note |
|---|---|---|---|
| `case` | `BindingCaseRevision.digest` | `case-revision` | |
| `snapshot` | `InstanceSnapshot.instance_digest` or `package_digest` | `instance-snapshot` | confirm that resolve matches both digest columns |
| `collection` | `ArtifactVersion.content_digest` (kind `Collection`) or legacy `CollectionRevision.digest` | `collection-revision` | resolve covers both sources (`resolve.py:356-440`) |
| `report` | `ArtifactVersion.content_digest` of the report's artifact | `report` | |
| `artifact` | `Blob.digest` | `artifact` | confirm that resolve's `artifact` kind covers blobs |
| `engine` | `EngineRevision.digest` | `engine` | |
| `study_run` | `StudyRun.matrix_digest` | none | `/app/verifier?digest=<digest>` |

When several items match, the citation is built from the first visible match in the verifier's existing order, as
today; the recorded publication citation is looked up for that item only (report edition or artifact version).

## Risks

- **Free-form JSON copied into BibTeX.** The recorded citation is publisher-written JSON with no validated keys
  (`models/platform.py:450`). Without escaping, a value such as `}, title = {X` would close the field and inject
  fields into the BibTeX a reader pastes into a paper. Mitigation: every user-written value has its `{` and `}`
  removed and its other special characters (`\` and the like) escaped (Definitions, rule 4), and is typed (non-string `venue`/`doi`, non-integer `year`, non-list or non-string `authors` entries count as absent);
  unit tests cover both. The coordinator may count this as external input and add a security-auditor to S1/S2
  (intake Q1).
- **Indistinguishability in the verifier.** A citation computed from a hidden element (for example its year) would
  tell hidden from unknown digests. Mitigation: the citation is built only from visible matches and is `null`
  otherwise; `tests/test_b1_verifier.py` stays green, with at most its `normalized` helper adjusted.
- **Clients relying on a non-null `doi` or `venue`.** The schema already allows `null`; the PR body states the value
  change.
- **Extra queries.** Each resolve or inspect answer may need one publication lookup for the cited item, done after the
  existing visibility filter.

## Alternatives ruled out

- Removing `citation` or making `year` optional: a schema and OpenAPI change, out of scope (owner decision).
- CRP-1 (a), `PUBLIC_BASE_URL` with project and publication screens: wrong origin in development and targets that need
  an account. CRP-1 (c), those targets on `FRONTEND_URL`: still needs an account.
- CRP-2 (a), a generic citation for unmatched digests: cites nothing that exists.
- Taking a DOI from a publication of another version of the same element: the DOI would cite different content.
- Pydantic validation or migration of stored citations: changes stored data and publishing rules; out of scope.
- An acceptance-test slice under `acceptance/api/`: it has no app harness yet; gateway tests written first meet G3.

## Migration

None: no schema, OpenAPI or data change. The values of `citation` change on deploy.

## Open questions

None for the owner (CRP-1 and CRP-2 answered). The mapping table above is to be confirmed in S2.
