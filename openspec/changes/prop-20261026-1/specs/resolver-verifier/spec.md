## ADDED Requirements

### Requirement: Citation contains no invented metadata
WHEN the resolver or the verifier returns a `citation`, THE gateway SHALL fill its `doi`, `venue`, `authors` and `bibtex` only with recorded facts of the cited element.

`req~resolver-verifier-citation-no-invented-metadata~1`

Needs: impl, utest

Evidence: `openbinding-gateway/src/openbinding_gateway/services/citations.py`; `openbinding-gateway/tests/test_citations.py`; `openbinding-gateway/tests/test_verifier_citations.py`

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
- **AND** `citation.bibtex` contains a `howpublished` field with value `V`

#### Scenario: DOI with a resolver prefix is returned without it
- **GIVEN** a library version published with citation `{"doi": "https://doi.org/10.5281/zenodo.456"}`
- **WHEN** a client resolves the version's digest
- **THEN** `citation.doi` is `10.5281/zenodo.456`

#### Scenario: Malformed DOI is dropped
- **GIVEN** a library version published with citation `{"doi": "not-a-doi", "venue": "V"}`
- **WHEN** a client resolves the version's digest
- **THEN** `citation.doi` is `null` and `citation.venue` is `V`
- **AND** `citation.bibtex` contains no `doi =` line

#### Scenario: DOI that is not a string or has a wrong shape is dropped
- **GIVEN** library versions published with citations `{"doi": 1234}`, `{"doi": "10.12/x"}`, `{"doi": "10.1234567890/x"}`, `{"doi": "10.5281/"}` and `{"doi": "10.5281/zen odo"}`
- **WHEN** a client resolves each version's digest
- **THEN** every answer has `citation.doi` `null`
- **AND** no `citation.bibtex` contains a `doi =` line

#### Scenario: Empty or non-string venue is dropped
- **GIVEN** library versions published with citations `{"venue": ""}` and `{"venue": 7}`
- **WHEN** a client resolves each version's digest
- **THEN** every answer has `citation.venue` `null`
- **AND** no `citation.bibtex` contains a `howpublished =` line

#### Scenario: Withdrawn publication is not cited
- **GIVEN** a report edition whose only publication, with citation `{"doi": "10.5281/zenodo.789"}`, is withdrawn
- **WHEN** a client resolves the report's digest
- **THEN** `citation.doi` is `null` and `citation.venue` is `null`

#### Scenario: Publication of another version is not cited
- **GIVEN** a library with versions 1 and 2, where only version 1 is published, with citation `{"doi": "10.5281/zenodo.321", "venue": "V"}`
- **WHEN** a client resolves the digest of version 2
- **THEN** `citation.doi` is `null` and `citation.venue` is `null`

#### Scenario: Authors fall back to the recorded username
- **GIVEN** a public case revision created by the user `alice`, with no publication record
- **WHEN** a client resolves its digest
- **THEN** `citation.authors` is `["alice"]`
- **AND** `citation.bibtex` names `alice` as the only author

#### Scenario: Authors are empty when no author is recorded
- **GIVEN** a public element with no publication record and no recorded author or owner username
- **WHEN** a client resolves its digest
- **THEN** `citation.authors` is `[]`
- **AND** no field of `citation` contains `OpenBinding Research Group`

#### Scenario: Publisher-written braces cannot break out of a BibTeX field
- **GIVEN** a published element whose recorded citation has `"venue": "Proc. }, title = {X"`
- **WHEN** a client resolves its digest
- **THEN** `citation.bibtex` is one single BibTeX entry whose fields are the builder's fields only
- **AND** the `howpublished` value inside `citation.bibtex` is the venue with every `{` and `}` removed (`Proc. , title = X`)

#### Scenario: Backslash in a user-written value is escaped in BibTeX
- **GIVEN** a published element whose recorded citation has `"authors": ["A. \\ Researcher"]` (the name `A. \ Researcher`)
- **WHEN** a client resolves its digest
- **THEN** `citation.bibtex` is one single BibTeX entry whose fields are the builder's fields only
- **AND** `citation.bibtex` does not contain the unescaped text `A. \ Researcher`

#### Scenario: Verifier digest without a visible match has no citation
- **GIVEN** an authenticated caller and a digest `sha256-<d>` that matches a private `acme` file the caller cannot see, and a digest `sha256-<u>` that matches nothing
- **WHEN** the caller posts each document to `POST /v1/verifier/inspect`
- **THEN** both answers have `citation: null`
- **AND** the two answers are identical apart from the digest

#### Scenario: Hidden and unknown files both get no citation in inspect-file
- **GIVEN** an authenticated caller, a file whose digest matches a private `acme` file the caller cannot see, and a file whose digest matches nothing
- **WHEN** the caller uploads each file to `POST /v1/verifier/inspect-file`
- **THEN** both answers have `citation: null`
- **AND** the two answers are identical apart from the digest

### Requirement: Citation year comes from a recorded date
WHEN the resolver or the verifier returns a `citation`, THE gateway SHALL set `year` to the first available of: the recorded citation's integer `year`, the year of `published_at`, the year of the element's `created_at`.

`req~resolver-verifier-citation-year~1`

Needs: impl, utest

Evidence: `openbinding-gateway/src/openbinding_gateway/services/citations.py`; `openbinding-gateway/tests/test_citations.py`; `openbinding-gateway/tests/test_verifier_citations.py`

#### Scenario: Year from the recorded citation
- **GIVEN** a report edition published on 2026-03-01 with citation `{"year": 2025}`
- **WHEN** a client resolves the report's digest
- **THEN** `citation.year` is `2025`
- **AND** `citation.bibtex` contains `year = {2025}`

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
- **GIVEN** library versions published on 2024-11-30 with citations `{"year": "2025"}` and `{"year": true}`
- **WHEN** a client resolves each version's digest
- **THEN** every answer has `citation.year` `2024`

#### Scenario: Withdrawn publication gives no year
- **GIVEN** a report edition created on 2022-02-02 whose only publication, published on 2024-11-30 with citation `{"year": 2025}`, is withdrawn
- **WHEN** a client resolves the report's digest
- **THEN** `citation.year` is `2022`

#### Scenario: Verifier year from the matched item
- **GIVEN** an authenticated member of `acme` and an `acme` case revision created on 2023-05-10 with no publication record
- **WHEN** the member posts its document to `POST /v1/verifier/inspect`
- **THEN** `citation.year` is `2023`

### Requirement: Citation URL is a live public link on the frontend origin
WHEN the resolver or the verifier returns a `citation`, THE gateway SHALL set `url` and the `markdown_badge` link to `FRONTEND_URL` + `/resolve/<kind>/<digest>`, or + `/app/verifier?digest=<digest>` only without a resolvable kind.

`req~resolver-verifier-citation-url~1`

Needs: impl, utest

Evidence: `openbinding-gateway/src/openbinding_gateway/services/citations.py`; `openbinding-gateway/tests/test_citations.py`; `openbinding-gateway/tests/test_verifier_citations.py`

#### Scenario: Resolver citation on the configured frontend origin
- **GIVEN** `FRONTEND_URL=https://ob.example` and `PUBLIC_BASE_URL=https://api.ob.example`
- **AND** a public case revision with digest `sha256-<d>`
- **WHEN** an anonymous client calls `GET /v1/resolve/case-revision/sha256-<d>`
- **THEN** `citation.url` is `https://ob.example/resolve/case-revision/sha256-<d>`
- **AND** `citation.markdown_badge` links to the same URL
- **AND** no field of `citation` contains `https://api.ob.example`

#### Scenario: Trailing slash of the frontend origin is removed
- **GIVEN** `FRONTEND_URL=https://ob.example/` and a public case revision with digest `sha256-<d>`
- **WHEN** a client calls `GET /v1/resolve/case-revision/<d>` with the digest given without its `sha256-` prefix
- **THEN** `citation.url` is `https://ob.example/resolve/case-revision/sha256-<d>`

#### Scenario: Every resolvable kind links to a live route
- **GIVEN** `FRONTEND_URL=https://ob.example` and one public element of each resolvable kind (`case-revision`, `resource-revision`, `collection-revision`, `report`, `artifact`, `engine`, `dialect`, `registered-resource`, `instance-snapshot`, `binding-ir`)
- **WHEN** a client resolves each element's digest
- **THEN** each `citation.url` is `https://ob.example/resolve/<kind>/<digest>` for that element's kind and digest
- **AND** its path, without the origin, matches a live route of the frontend route table and is not a redirecting route

#### Scenario: Report citation does not use a retired route
- **GIVEN** `FRONTEND_URL=https://ob.example` and a public report with slug `r1` and digest `sha256-<d>`
- **WHEN** a client resolves the report's digest
- **THEN** `citation.url` is `https://ob.example/resolve/report/sha256-<d>`
- **AND** no field of `citation` contains `/reports/`

#### Scenario: Verifier match of a resolvable kind
- **GIVEN** `FRONTEND_URL=https://ob.example` and an authenticated member of `acme` who inspects the document of an `acme` case revision with digest `sha256-<d>`
- **WHEN** the caller posts it to `POST /v1/verifier/inspect`
- **THEN** `citation.url` is `https://ob.example/resolve/case-revision/sha256-<d>`

#### Scenario: Verifier match without a resolvable kind
- **GIVEN** `FRONTEND_URL=https://ob.example` and a visible study run whose matrix digest is `sha256-<d>`
- **WHEN** a member posts a document with that digest to `POST /v1/verifier/inspect`
- **THEN** `citation.url` is `https://ob.example/app/verifier?digest=sha256-<d>`
- **AND** `citation.markdown_badge` links to the same URL
