# Tasks: m27-names-not-digests

ROADMAP M2.7, first of two changes: the parts and the test. The groups are:
- A: the spec;
- B: identity labels;
- C1 and C2: `CitationPanel` and `VerifyResult`;
- D: the hygiene test;
- then the review panel.

Tests carry `[utest->req~<name>~1]` and code carries `[impl->…]` (design.md §6). B, C1 and C2 own disjoint files.
D needs B, C1 and C2, because the exempt directories must exist and `shared/lib/identity.ts` must pass the detector.

Checks the groups register. Each is a `bash -c 'set -euo pipefail; cd frontend; …'` argv:
- FI: `pnpm install --frozen-lockfile`, first.
- RED (G3), `red_before`: FI, then `pnpm exec vitest run <the group's test files>`.
  - `expect_exit [1]`;
  - `expect_pattern` `AssertionError|TestingLibraryElementError|Unable to find`;
  - `reject_pattern` `Failed to resolve import|Cannot find module|Transform failed|SyntaxError`.
- V: `pnpm exec vitest run <the group's test files> src/test/rawRenderingHygiene.test.ts`. The raw-rendering test
  proves the new components add no `<pre>`.
- LINT: `pnpm exec eslint .`. TSC: `pnpm exec tsc -b`.
- VALL (G5), timeout 900: `pnpm exec vitest run`, in group D.
- G1: `["openspec", "validate", "m27-names-not-digests", "--strict"]`.

## A. Spec
- [x] A.1 proposal.md, design.md, this file and the `frontend-rendering` delta with four ADDED requirements:
  `req~identity-labels~1`, `req~citation-panel~1`, `req~verify-result~1` and `req~digest-hygiene~1`.
- [x] A.2 G1 (`openspec validate m27-names-not-digests --strict`): valid.
- [x] A.3 Spec follows code: the change is rewritten to describe the built code and tests (design.md, Status:
  built), and G1 is valid again.
- [ ] A.3b Spec follows code again after the review fixes: one value per fingerprint in `VerifyResult`, the verdict
  as role `status`, explicit copy names, wrapping match names, the latest-only copy announcement of
  `CitationPanel`, UTC dates under other time zones and space-separated date-times, and the hygiene test's impl
  tag, pinned exempt list and pipeline self-test. G1 to be run again.
- [ ] A.4 G2 (epic review) on the rewritten change.

## B. Identity labels
Owns `frontend/src/shared/lib/identity.ts`, `frontend/src/shared/lib/identity.test.ts` (both new) and the root
`.gitignore` line `!/frontend/src/shared/lib/`. `utils/digest.ts` is not edited: the identifier guard is private to
`identity.ts` (design.md §2.4).

- [x] B.1 `identity.test.ts`:
  - the six full labels, and the grouped count `1,200 problems`;
  - the dates (UTC, `2 Sep 2026`, `5 Dec 2026`, `31 Jan 2026`, `1 Oct 2026`, `'soon'` dropped), and a date-time
    without an offset read as UTC;
  - the same dates under `process.env.TZ` `Pacific/Kiritimati` and `America/Los_Angeles`, after checking the zone
    applies: offset-bearing, `Z`, offset-less (`T`) and date-only values, and space-separated values with and
    without an offset (design.md §2.5);
  - the missing-part table of design.md §2.2, function by function;
  - versions `'3'` and `'v3'`, `2.5` dropped, engine versions as given, `run 1014`;
  - identifier-shaped values as missing, including `SHA256-…`, a hex run glued to letters, an upper-case UUID, and
    39 hexadecimal characters kept;
  - the exhaustive sample table of design.md §2.6 (no identifier in any result, no empty result).
- [x] B.2 `shared/lib/identity.ts`: the six functions, their private helpers and the date formatter (design.md §2).
- [x] B.3 `.gitignore`: the `!/frontend/src/shared/lib/` exception, so the root `lib/` rule does not ignore the
  directory.
- [ ] B.4 Evidence on the PR: RED (G3), FI, V, LINT, TSC. Review: reviewer and test-reviewer.

## C1. CitationPanel
Owns `frontend/src/components/CitationPanel/{CitationPanel.tsx,CitationPanel.css,citationModel.ts,index.ts,CitationPanel.test.tsx}`
(new).

- [x] C1.1 `CitationPanel.test.tsx`:
  - the digest exactly once, one `Copy digest`, and the citation sentence;
  - copies of the permanent link, the digest, BibTeX, CSL-JSON and the citation text;
  - the region `Cite and link` without a digest, and no `Copy digest`;
  - the announcements `BibTeX copied`, `CSL-JSON copied` and `Citation text copied`, and only the latest outcome
    (`Could not copy the citation text` replaces `BibTeX copied`);
  - no hexadecimal colour in the stylesheet;
  - `buildPanelCitation`: no digest in any format, BibTeX escaping, CSL-JSON `dataset` and `document`, and the
    `OpenBinding` / `n.d.` fallbacks.
- [x] C1.2 `citationModel.ts`, `CitationPanel.tsx`, `CitationPanel.css` and `index.ts` (design.md §3).
- [ ] C1.3 Evidence on the PR: RED (G3), FI, V, LINT, TSC. Review: reviewer and test-reviewer.

## C2. VerifyResult
Owns `frontend/src/components/VerifyResult/{VerifyResult.tsx,VerifyResult.css,verifyModel.ts,index.ts,VerifyResult.test.tsx}`
(new). Not `pages/Reports/Verifier.tsx` or `pages/Resolve/**`: M2.6 owns them.

- [x] C2.1 `VerifyResult.test.tsx`:
  - the four verdicts with their titles, texts and detail in the element with role `status` named `Verdict`;
  - a verified digest shown once with one `Copy recorded fingerprint` button, the given or computed side reading
    `Matches the recorded fingerprint`; a given digest equal to the expected one reading
    `Matches the expected fingerprint`; only the recorded side when nothing is given or computed;
  - two different given and recorded digests, `Copy fingerprint you gave` and `Copy recorded fingerprint`;
  - the computed and expected sides of a mismatch, two copy buttons;
  - `nothing recorded` without a copy button;
  - the disagreement warning, and no warning when the two agree or nothing was computed;
  - matches by name and kind chip, the slug and `unnamed element` fallbacks, and no entity id;
  - links through `renderLink` or `hrefOf`, and the name alone otherwise;
  - the citation slot;
  - no hexadecimal colour in the stylesheet, and the wrap rule for long match names.
- [x] C2.2 `verifyModel.ts`, `VerifyResult.tsx`, `VerifyResult.css` and `index.ts` (design.md §4).
- [ ] C2.3 Evidence on the PR: RED (G3), FI, V, LINT, TSC. Review: reviewer and test-reviewer.

## D. Digest hygiene test (risk medium: it can block other changes; after B, C1 and C2)
Owns `frontend/src/test/digestHygiene.test.ts` (new).

- [x] D.1 Tests: the scanned set and the stylesheets with content, the pinned `EXEMPT_FILES`, the application
  sources (digest literal, UUID and helper), the pending list (sorted, no duplicates, existing files, no allowed
  path), the scan-pipeline self-test, and the detector controls (caught, not caught, whole words). No test asserts
  that the pending list shrinks.
- [x] D.2 Source: the allowed set, `EXEMPT_FILES` (39 paths, design.md §5.2), the three detectors and
  `PENDING_CLEANUP` with the 40 paths of design.md §5.5.
- [x] D.3 The `[impl->req~digest-hygiene~1]` tag, next to `[utest->req~digest-hygiene~1]` in the test file header
  (design.md §6).
- [ ] D.4 Evidence on the PR: FI, VALL (G5), LINT, TSC, G1.

## Review panel
- [ ] R.1 reviewer: all groups. Check the spec↔code match, the `[impl->…]` and `[utest->…]` tags, that no page is
  edited, and that `identity.ts` holds no detector-shaped literal.
- [ ] R.2 test-reviewer: G3 evidence per group, the exhaustive table, the hygiene detector controls and the known
  limits (design.md §5.3), and that no test pins behaviour the spec does not state.
- [ ] R.3 ui-qa: `CitationPanel` and `VerifyResult` from their test DOM and stylesheets:
  - accessible names, including the copy buttons whose names change to `… copied` for two seconds;
  - focus order of the copy buttons;
  - status announcements;
  - value wrapping at 390 px through `CopyField`;
  - tokens only;
  - verdicts not by colour alone.

  No routed screen exists yet, so the 1440×900 and 390×844 screenshots (G12) move to the second change (design.md
  §7).
- [ ] R.4 Open the PR into `develop`.

## Archive (later)
- [ ] After `m21-rendering-catalogue` is archived, archive this change in an explicit archive task:
  `["openspec", "archive", "m27-names-not-digests", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## F. Follow-ups for the second change (after M2.6)
`pages/**` and the gateway are untouched by this change. The second M2.7 change, after M2.6 merges, owns these. A
behaviour change to a requirement of this change is a `~2` revision, with its code and test tags re-tagged.
- [ ] F.1 Guard identifier-shaped entity names in `VerifyResult` (an entity name that is or contains a digest, a hex
  run or a UUID, or a short id, reads as missing), and remove the gateway verifier's `Snapshot <id[:8]>` fallback
  for an unnamed snapshot (`openbinding-gateway/src/openbinding_gateway/routes/verifier.py`, line 253; design.md §7).
  The gateway part is an API-visible text change, through a gateway task.
- [ ] F.2 Pending-list ceiling and stale check in `digestHygiene.test.ts`: a `MAX_PENDING_FILES` (or exact-list)
  assertion so the list cannot grow, and a check that every listed file still offends, so a cleaned file must
  leave the list (design.md §5.4).
- [ ] F.3 Touch-target check with Playwright: every copy button of `CitationPanel` and `VerifyResult` has a hit
  area of at least 44×44 px, at 1440×900 and 390×844, on the mounted screens.
- [ ] F.4 Owner reading of constitution 15.5 ("one copyable value") for two different digests side by side in
  `VerifyResult` (design.md §8, question 5); a `~2` revision of `req~verify-result` if the owner reads it otherwise.
- [ ] F.5 Page clean-up and wiring: move the 40 pending files onto identity labels, `CitationPanel` and
  `VerifyResult` and remove their digest text, emptying `PENDING_CLEANUP`; wire the Verify page (M2.6's) to
  `VerifyResult` and the problem, collection and published-result pages to `CitationPanel`. With it:
  - MODIFY `frontend-catalog-pricing`'s engine-card requirement ("exact identity (namespace, name, version,
    digest)") to the engine label;
  - decide `shortDigest`/`digestPrefix` and `utils/citation.ts` (design.md §8, question 2);
  - add permanent links by permanent id or slug, or a refusal of digest-bearing links in `CitationPanel`
    (design.md §8, question 1);
  - decide the other drafted, unbuilt behaviour of design.md §8 item 7 and "fingerprint" versus "digest"
    (question 4);
  - ui-qa screenshots (G12) of every screen that changed, desktop and mobile.
- Outside both changes:
  - constitution 15.5's "Enforced: GAP" line names `frontend/src/hygiene.test.ts`. The owner updates it to the
    hygiene tests;
  - `docs/qa/RENDERING_CATALOGUE.md` lists `CitationPanel` and `VerifyResult` (doc owner).
