## ADDED Requirements

### Requirement: Citation contains no invented metadata
WHEN the gateway returns a `citation` object from `GET /v1/resolve/{kind}/{digest}`, `POST /v1/verifier/inspect` or `POST /v1/verifier/inspect-file`, THE gateway SHALL fill its `doi`, `venue`, `authors` and `bibtex` fields only with recorded facts as defined below.

`req~resolver-verifier-citation-no-invented-metadata~1`

Needs: impl, utest

Evidence: `openbinding-gateway/src/openbinding_gateway/services/citations.py` (tagged `[impl->req~resolver-verifier-citation-no-invented-metadata~1]`); `openbinding-gateway/tests/test_citations.py` and `openbinding-gateway/tests/test_verifier_citations.py` (tagged `[utest->req~resolver-verifier-citation-no-invented-metadata~1]`)

The recorded publication citation of an element is the `citation` object of its live (not withdrawn) publication record for the exact version the digest identifies (`ArtifactPublication.citation` for an artifact version, `Publication.citation` for a report edition). A publication of another version, or a withdrawn one, is not a recorded publication citation of this element. Within this requirement:
1. `doi` is the `doi` value of the recorded publication citation when it is a well-formed DOI: `10.`, 4 to 9 ASCII digits, `/` and a non-empty suffix without whitespace, after removing an optional `https://doi.org/` prefix; the prefix-free form is returned. In every other case (no recorded publication citation, no `doi` key, a value that is not a string or not well-formed) `doi` is `null`.
2. `venue` is the `venue` string of the recorded publication citation when it is a non-empty string; otherwise `null`.
3. `authors` is the list of author strings of the recorded publication citation when it has one; otherwise the username of the element's recorded author or owner when one is recorded; otherwise `[]`. No constant author name is ever returned.
4. `bibtex` contains a `doi` field only when `doi` is not `null` and a `howpublished` (venue) field only when `venue` is not `null`. Every value taken from a recorded publication citation or from a user-written name is escaped so that it cannot close the BibTeX field or entry (`{`, `}` and `\` are escaped).
5. In the verifier, WHEN no item visible to the caller matches the digest (status `computed`, `mismatch` or `not_found`), `citation` is `null`. A hidden and an unknown digest therefore both get `citation: null`, as required by `req~resolver-verifier-inspect-indistinguishable~1` (living spec `openspec/specs/resolver-verifier/spec.md`, unchanged).

#### Scenario: Element without a publication has no DOI and no venue
- **GIVEN** a public case revision with digest `sha256-<d>` and no publication record
- **WHEN** an anonymous client calls `GET /v1/resolve/case-revision/sha256-<d>`
- **THEN** `citation.doi` is `null` and `citation.venue` is `null`
- **AND** `citation.bibtex` contains no `doi =` line and no `howpublished =` line
- **AND** no field of `citation` contains `10.1109/OPENBINDING`, `OpenBinding Canonical Provenance Registry` or `OpenBinding Research Group`

#### Scenario: Recorded publication citation is reproduced
- **GIVEN** a report edition published with citation `{"doi": "10.5281/zenodo.123", "venue": "V", "year": 2025, "authors": ["A. Researcher"]}`
- **WHEN** a client resolves the report's digest
- **THEN** `citation.doi` is `10.5281/zenodo.123`, `citation.venue` is `V` and `citation.authors` is `["A. Researcher"]`
- **AND** `citation.bibtex` contains a `doi` field with value `10.5281/zenodo.123`

#### Scenario: DOI with a resolver prefix is returned without it
- **GIVEN** a library version published with citation `{"doi": "https://doi.org/10.5281/zenodo.456"}`
- **WHEN** a client resolves the version's digest
- **THEN** `citation.doi` is `10.5281/zenodo.456`

#### Scenario: Malformed DOI is dropped
- **GIVEN** a library version published with citation `{"doi": "not-a-doi", "venue": "V"}`
- **WHEN** a client resolves the version's digest
- **THEN** `citation.doi` is `null` and `citation.venue` is `V`
- **AND** `citation.bibtex` contains no `doi =` line

#### Scenario: Withdrawn publication is not cited
- **GIVEN** a report edition whose only publication, with citation `{"doi": "10.5281/zenodo.789"}`, is withdrawn
- **WHEN** a client resolves the report's digest
- **THEN** `citation.doi` is `null` and `citation.venue` is `null`

#### Scenario: Publisher-written braces are escaped in BibTeX
- **GIVEN** a published element whose recorded citation has `"venue": "Proc. }, title = {X"`
- **WHEN** a client resolves its digest
- **THEN** `citation.bibtex` is one BibTeX entry whose fields are the builder's fields only
- **AND** the venue value inside `citation.bibtex` has every `{` and `}` escaped

#### Scenario: Verifier digest without a visible match has no citation
- **GIVEN** an authenticated caller and a digest `sha256-<d>` that matches a private `acme` file the caller cannot see, and a digest `sha256-<u>` that matches nothing
- **WHEN** the caller posts each document to `POST /v1/verifier/inspect`
- **THEN** both answers have `citation: null`
- **AND** the two answers are identical apart from the digest

### Requirement: Citation year comes from a recorded date
WHEN the gateway returns a `citation` object from `GET /v1/resolve/{kind}/{digest}`, `POST /v1/verifier/inspect` or `POST /v1/verifier/inspect-file`, THE gateway SHALL set `year` to the first available of: the integer `year` of the recorded publication citation, the calendar year of that publication's `published_at`, and the calendar year of the element's sealed or created date.

`req~resolver-verifier-citation-year~1`

Needs: impl, utest

Evidence: `openbinding-gateway/src/openbinding_gateway/services/citations.py` (tagged `[impl->req~resolver-verifier-citation-year~1]`); `openbinding-gateway/tests/test_citations.py` and `openbinding-gateway/tests/test_verifier_citations.py` (tagged `[utest->req~resolver-verifier-citation-year~1]`)

"Recorded publication citation" has the meaning given in `req~resolver-verifier-citation-no-invented-metadata~1`. A `year` value that is not an integer (for example the string `"2025"` or a boolean) counts as absent. The element's sealed or created date is the `created_at` of the revision or version the digest identifies (for the verifier, the matched item's `created_at`). The year is never a constant, and the `bibtex` entry carries the same year.

#### Scenario: Year from the recorded citation
- **GIVEN** a report edition published on 2026-03-01 with citation `{"year": 2025}`
- **WHEN** a client resolves the report's digest
- **THEN** `citation.year` is `2025`

#### Scenario: Year from the publication date
- **GIVEN** a library version published on 2024-11-30 with citation `{}`
- **WHEN** a client resolves the version's digest
- **THEN** `citation.year` is `2024`

#### Scenario: Year from the element's creation date
- **GIVEN** a public case revision created on 2023-05-10 with no publication record
- **WHEN** a client resolves its digest
- **THEN** `citation.year` is `2023`
- **AND** `citation.bibtex` contains `year = {2023}`

#### Scenario: Non-integer recorded year is ignored
- **GIVEN** a library version published on 2024-11-30 with citation `{"year": "2025"}`
- **WHEN** a client resolves the version's digest
- **THEN** `citation.year` is `2024`

### Requirement: Citation URL is a live public link on the frontend origin
WHEN the gateway returns a `citation` object from `GET /v1/resolve/{kind}/{digest}`, `POST /v1/verifier/inspect` or `POST /v1/verifier/inspect-file`, THE gateway SHALL set `url`, and the link target of `markdown_badge`, to the configured `FRONTEND_URL` origin followed by `/resolve/<kind>/<digest>` for an element of a resolvable kind, and by `/app/verifier?digest=<digest>` only when the element has no resolvable kind.

`req~resolver-verifier-citation-url~1`

Needs: impl, utest

Evidence: `openbinding-gateway/src/openbinding_gateway/services/citations.py` (tagged `[impl->req~resolver-verifier-citation-url~1]`); `openbinding-gateway/tests/test_citations.py` and `openbinding-gateway/tests/test_verifier_citations.py` (tagged `[utest->req~resolver-verifier-citation-url~1]`)

A resolvable kind is one of the `kind` values accepted by `GET /v1/resolve/{kind}/{digest}` (`case-revision`, `resource-revision`, `collection-revision`, `report`, `artifact`, `engine`, `dialect`, `registered-resource`, `instance-snapshot`, `binding-ir`). `<digest>` is the normalised digest with its `sha256-` prefix. The origin is `FRONTEND_URL` with any trailing `/` removed; `PUBLIC_BASE_URL` (the gateway's own origin) and any hard-coded host are never used. The path is always a live frontend route (`/resolve/:kind/:digest` or `/app/verifier`), never a retired, redirecting or non-existent one (for example `/verifier`, `/reports/<slug>`). An example of an element without a resolvable kind is a verifier `study_run` match.

#### Scenario: Resolver citation on the configured frontend origin
- **GIVEN** `FRONTEND_URL=https://ob.example` and `PUBLIC_BASE_URL=https://api.ob.example`
- **AND** a public case revision with digest `sha256-<d>`
- **WHEN** an anonymous client calls `GET /v1/resolve/case-revision/sha256-<d>`
- **THEN** `citation.url` is `https://ob.example/resolve/case-revision/sha256-<d>`
- **AND** `citation.markdown_badge` links to the same URL

#### Scenario: Every resolvable kind links to a live route
- **GIVEN** `FRONTEND_URL=https://ob.example` and one public element of each resolvable kind
- **WHEN** a client resolves each element's digest
- **THEN** each `citation.url` starts with `https://ob.example/`
- **AND** its path, without the origin, matches a live route of the frontend route table and is not a redirecting route

#### Scenario: Verifier match of a resolvable kind
- **GIVEN** `FRONTEND_URL=https://ob.example` and an authenticated member of `acme` who inspects the document of an `acme` case revision with digest `sha256-<d>`
- **WHEN** the caller posts it to `POST /v1/verifier/inspect`
- **THEN** `citation.url` is `https://ob.example/resolve/case-revision/sha256-<d>`

#### Scenario: Verifier match without a resolvable kind
- **GIVEN** `FRONTEND_URL=https://ob.example` and a visible study run whose matrix digest is `sha256-<d>`
- **WHEN** a member posts a document with that digest to `POST /v1/verifier/inspect`
- **THEN** `citation.url` is `https://ob.example/app/verifier?digest=sha256-<d>`
