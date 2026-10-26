# Tasks: prop-20261026-1

Capability: `resolver-verifier`. Requirements: `req~resolver-verifier-citation-no-invented-metadata~1`,
`req~resolver-verifier-citation-year~1`, `req~resolver-verifier-citation-url~1`.
No feature flag. Order: S1, then S2; S3 can run in parallel with S1 and S2 (disjoint files).

## S1. Shared citation builder, used by `/v1/resolve` (implementer, medium risk)

- [ ] S1.1 Write failing tests first in `openbinding-gateway/tests/test_citations.py`, tagged
      `[utest->req~resolver-verifier-citation-...~1]`: for each kind of `VALID_KINDS`, no made-up DOI, venue or author,
      `year` from the element's created date, `url` on `FRONTEND_URL` and a live route (reuse
      `assert_is_a_frontend_screen` from `tests/test_b2_resolve_urls.py` by import); recorded, prefixed, malformed and
      withdrawn publication citations; BibTeX escaping; builder holds no module state.
- [ ] S1.2 Add `openbinding-gateway/src/openbinding_gateway/services/citations.py`, tagged `[impl->...]` for the three
      requirements; replace `_build_citation` and its 11 call sites in `routes/resolve.py`, with the publication lookup
      for the exact version.
- Files: `services/citations.py` (new), `routes/resolve.py`, `tests/test_citations.py` (new).
- Checks: red-before of `tests/test_citations.py`; focused tests (`test_citations.py`, `test_resolve.py`,
  `test_b2_resolve_urls.py`, `test_architecture_layers.py`); full gateway suite; OpenAPI snapshot unchanged
  (`tools/dump_openapi.py --check`); ruff; literal guard on `resolve.py` and `services/`.
- Size: about 200-230 source lines.

## S2. `/v1/verifier` uses the shared builder (implementer, medium risk), after S1

- [ ] S2.1 Write failing tests first in `openbinding-gateway/tests/test_verifier_citations.py`: `computed` document,
      `inspect-file`, case, report and collection matches, a `study_run` match (fallback URL), `citation: null`
      without a visible match; hidden and unknown digests identical apart from the digest.
- [ ] S2.2 Replace `_build_citation` and its 2 call sites in `routes/verifier.py`; confirm the match-to-kind mapping of
      `design.md`; adjust `tests/test_verifier.py` (lines 65-67, 137-139) and, only if it breaks, the `normalized`
      helper of `tests/test_b1_verifier.py`.
- Files: `routes/verifier.py`, `tests/test_verifier_citations.py` (new), `tests/test_verifier.py`,
  `tests/test_b1_verifier.py` (helper only).
- Checks: as S1 with the verifier tests; literal guard on all of `routes/` and `services/`.
- Size: about 75-90 source lines.

## S3. Normative doc (doc-steward, low risk)

- [ ] S3.1 Make the `citation` description and the example response of `docs/RESOLVER_AND_VERIFIER.md` match the
      three requirements (no made-up DOI, `FRONTEND_URL` permanent link, `citation: null` without a visible match).
- Files: `docs/RESOLVER_AND_VERIFIER.md`.
- Checks: `git diff --check`; literal guard including the doc.

## Changelog

- [ ] C.1 Final commit `chore(changelog)`: add an entry under `Unreleased` (Fixed) describing that citations no longer
      contain made-up DOIs, venues, years, authors or dead links.

## Archive (after merge)

- [ ] A.1 `openspec archive prop-20261026-1 --yes` in an archive task, remove the "Citation metadata (BibTeX/DOI)"
      TODO from `openspec/specs/resolver-verifier/spec.md`, then `openspec validate --all --strict` and the trace.
