# resolver-verifier Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 — reverse-engineered, spec-anchored.

## Purpose

Content-digest resolution and provenance verification: `GET /v1/resolve/{kind}/{digest}[/content]` and
`POST /v1/verifier/inspect[-file]` (`routes/resolve.py`, `routes/verifier.py`), and the `/app/verifier` screen.
Normative source: `docs/RESOLVER_AND_VERIFIER.md`. A digest proves content equality, not authorship or numerical
reproducibility.

## Requirements

### Requirement: Resolution without leakage
WHEN a caller resolves a digest, THE gateway SHALL answer 200 with provenance and only the locations the caller may see if at least one location is public or accessible, and SHALL answer 404 otherwise, identically for a private element and an unknown digest.

`req~resolver-verifier-no-leakage~1`

Evidence: `openbinding-gateway/tests/test_resolve.py::test_resolve_public_and_private_case_revisions`; `openbinding-gateway/tests/test_resolve.py::test_resolve_multi_location_and_pagination`; `docs/RESOLVER_AND_VERIFIER.md`

#### Scenario: Digest of a private case revision
- **GIVEN** a case revision in a private project of `acme`
- **WHEN** a non-member resolves its digest
- **THEN** the gateway answers 404 exactly as for a digest that matches nothing

### Requirement: Tolerant digest input
WHEN a digest is given with or without the `sha256-` prefix or as a raw hexadecimal hash, THE gateway SHALL normalise it, and IF the `kind` is unknown, THEN THE gateway SHALL answer 422.

`req~resolver-verifier-digest-input~1`

Evidence: `openbinding-gateway/tests/test_resolve.py::test_resolve_digest_tolerance_and_invalid_kind`

#### Scenario: Unknown kind
- **GIVEN** a valid digest
- **WHEN** a client calls `GET /v1/resolve/spaceship/{digest}`
- **THEN** the gateway answers 422

### Requirement: Verifier requires an account and filters by visibility
IF an anonymous caller uses the verifier, THEN THE gateway SHALL answer 401; WHEN an authenticated caller inspects a document or file, THE gateway SHALL list only registered elements the caller may see, so that a hidden element is indistinguishable from an unregistered digest (same status, fields, text and query work).

`req~resolver-verifier-inspect-visibility~1`

Evidence: `openbinding-gateway/tests/test_b1_verifier.py::test_anonymous_callers_are_still_refused`; `openbinding-gateway/tests/test_b1_verifier.py::test_members_see_a_private_case_and_everyone_else_sees_nothing`; `openbinding-gateway/tests/test_b1_verifier.py::test_a_hidden_digest_runs_the_same_queries_as_an_unknown_one`

#### Scenario: Platform administrator inspects a private file
- **GIVEN** a platform ADMIN with no role in `acme`
- **WHEN** the admin inspects a file whose digest matches a private `acme` file
- **THEN** the answer is `computed` with no organization, project or title, as for an unregistered file

## Out of scope

- Artifact library resolution by exact reference (`POST /v1/artifacts/resolve`, `collaboration-artifacts`).
- The visual design of the verifier screen (`frontend-workspace`).

## TODO

- Add 404 (and 401 for `/content` where applicable) to the OpenAPI responses of `/v1/resolve/*` (today only 200/422 are documented: contract drift).
- Citation metadata (BibTeX/DOI) generation as a requirement.
- `docs/RESOLVER_AND_VERIFIER.md` §4 describes UI features ("holographic seal") that are not verified by tests.
