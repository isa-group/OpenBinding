# Change: prop-20261026-1

## Why

INTENT objective **O4, reproducibility inside the platform** (`INTENT.md:165`), journey 1: "A paper's reader opens a
problem, a collection or a published result from its permanent link and verifies it by digest, without an account"
(`INTENT.md:48-49`), and principle 9, evidence honesty (`INTENT.md:92`).

Today the `citation` object of `GET /v1/resolve/{kind}/{digest}` and `POST /v1/verifier/inspect[-file]` contains
values nobody recorded (intake `docs/agent-work/prop-20261026-1/intake.md`, facts F1-F14, verified at `212b9662`):

- a made-up DOI `10.1109/OPENBINDING.<digest[7:19]>`, the made-up venue "OpenBinding Canonical Provenance Registry",
  a fixed `year = 2026` and the made-up author "OpenBinding Research Group" (`routes/resolve.py:168-206`,
  `routes/verifier.py:50-98`; F1, F5);
- a `url` on the hard-coded origin `https://openbinding.score.us.es`, with a fallback `/verifier?digest=` that matches
  no frontend route and a verifier target `/reports/<slug>` that is a retired route (F1-F3);
- a citation for a digest that matches nothing visible (F6).

A reader who copies such a citation into a paper cites a DOI that does not exist. The living spec
`openspec/specs/resolver-verifier/spec.md` has no citation requirement; its TODO lists "Citation metadata
(BibTeX/DOI) generation as a requirement". This change adds it.

Owner decisions (intake section 7): **CRP-1 (b)**, the citation links to the public permanent link
`/resolve/<kind>/<digest>` on the configured `FRONTEND_URL` origin, with `/app/verifier?digest=<digest>` only when no
resolvable kind exists; **CRP-2 (b)**, `citation` is `null` when no visible item matches the digest in the verifier,
and `authors` is `[]` when no author is recorded.

## What Changes

- `doi` and `venue` come only from the recorded, not withdrawn, publication citation of the exact version, and `doi`
  only when it is a well-formed DOI; otherwise both are `null` and the BibTeX entry leaves those fields out.
- `authors` holds only recorded author or owner usernames, or is `[]`; publisher-written values are escaped in BibTeX.
- `year` is the year of the recorded citation, else of the publication date, else of the element's sealed or created
  date; never a constant.
- `url` and the badge link use the configured `FRONTEND_URL` origin and the public permanent link
  `/resolve/<kind>/<digest>`; `/app/verifier?digest=<digest>` only when the element has no resolvable kind.
- The verifier returns `citation: null` when no visible item matches the digest; hidden and unknown digests stay
  indistinguishable (`req~resolver-verifier-inspect-indistinguishable~1`, unchanged).

New requirements (delta `specs/resolver-verifier/spec.md`):
`req~resolver-verifier-citation-no-invented-metadata~1`, `req~resolver-verifier-citation-year~1`,
`req~resolver-verifier-citation-url~1`.

## Impact

- Capability: `resolver-verifier` only.
- API: **the response schema does not change** and `docs/openapi.json` stays byte-identical. `doi`, `venue` and `url`
  are already `Optional[str]`, `authors` already defaults to `[]`, and `ResolveResponse.citation` and
  `VerifierInspectResponse.citation` are already `Optional` (`models/platform.py:558-566,595,648`). Only the values
  change: clients that relied on a non-null `doi` or `venue` now receive `null`. The model default `year: int = 2026`
  stays (changing it changes the OpenAPI document); the builder always sets `year` explicitly.
- Code: a new shared builder `openbinding-gateway/src/openbinding_gateway/services/citations.py` replaces the two
  private `_build_citation` functions in `routes/resolve.py` (11 call sites) and `routes/verifier.py` (2 call sites).
  Tests: `openbinding-gateway/tests/test_citations.py`, `openbinding-gateway/tests/test_verifier_citations.py` (new),
  and small adjustments in `tests/test_verifier.py`.
- Docs: `docs/RESOLVER_AND_VERIFIER.md` (citation section and the example response, which shows a made-up Zenodo DOI).
- Data: no migration. Stored publication citations are read, never rewritten.
- Risk: medium. Every citation value of a public anonymous endpoint changes, and the verifier change touches the
  hidden/unknown indistinguishability rule. See `design.md`.

## Out of scope

- Any schema or OpenAPI change, including removing the `year` default of 2026 (followup, owner decision).
- `locations[].web_url` of reports, which still points at the retired `/reports/` route
  (`KNOWN_REDIRECTING_WEB_URLS`, `tests/test_b2_resolve_urls.py:63`): separate followup.
- Validating or migrating stored publication citations; DOI minting or Zenodo deposit (M6.5).
- Frontend changes: the verifier screen already builds its own citation and handles `citation: null`.
- `markdown_badge` stays a shields.io image; only its link target changes.
