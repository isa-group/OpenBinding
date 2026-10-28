# Tasks: m27-names-not-digests

ROADMAP M2.7, first of two changes: the parts and the test. The groups are:
- A: the spec;
- B: identity labels;
- C1 and C2: `CitationPanel` and `VerifyResult`;
- D: the hygiene test;
- then the review panel.

Tests carry `[utest->req~<name>~1]` and code carries `[impl->…]` (design.md §6). Each of B, C1, C2 and D is
test-first: a test-designer task writes the failing tests and proves them red (G3), then an implementer task builds
the code. C1 and C2 need B (`containsIdentifier`), and D needs B, C1 and C2, because the exempt directories must
exist and `shared/lib/identity.ts` must pass the detector. C1 and C2 own disjoint files and may run in parallel.

Checks the groups register. Each is a `bash -c 'set -euo pipefail; cd frontend; …'` argv:
- FI: `pnpm install --frozen-lockfile`, first.
- RED (G3), `red_before`: FI, then `pnpm exec vitest run <the group's test files>`.
  - `expect_exit [1]`;
  - `expect_pattern` `AssertionError|TestingLibraryElementError|Unable to find`;
  - `reject_pattern` `Failed to resolve import|Cannot find module|Transform failed|SyntaxError`.

  A new module's test therefore needs a stub of the module's exports, with empty or throwing bodies, in the
  test-designer task, so that red means "wrong behaviour", not "missing file". M2.1 recorded no G3 for this reason
  (its tasks.md, "Known deviations"), and this change does not repeat that.
- V: `pnpm exec vitest run <the group's test files> src/test/rawRenderingHygiene.test.ts`. The raw-rendering test
  proves the new components add no `<pre>`.
- LINT: `pnpm exec eslint .`. TSC: `pnpm exec tsc -b`.
- VALL (G5), timeout 900: `pnpm exec vitest run`, in group D.
- G1: `["openspec", "validate", "m27-names-not-digests", "--strict"]`.

## A. Spec
- [x] A.1 proposal.md, design.md, this file and the `frontend-rendering` delta with four ADDED requirements:
  `req~identity-labels~1`, `req~citation-panel~1`, `req~verify-result~1` and `req~digest-hygiene~1`.
- [x] A.2 G1 (`openspec validate m27-names-not-digests --strict`): valid.
- [ ] A.3 G2 (epic review).

## B. Identity labels (risk low)
Owns `frontend/src/shared/lib/identity.ts` and `frontend/src/shared/lib/identity.test.ts` (both new), and
`frontend/src/utils/digest.ts` and `frontend/src/utils/digest.test.ts` (the `containsIdentifier` export and its tests
only).

Tests first:
- [ ] B.1 `identity.test.ts`:
  - the six full labels;
  - the dates (UTC, `2 Sep 2026`, `5 Dec 2026`, `'soon'` dropped);
  - the missing-part table of design.md §2.2, function by function;
  - identifier-shaped values as missing;
  - the exhaustive sample table of design.md §2.5 (no identifier in any result, no empty result).
- [ ] B.2 `digest.test.ts`: `containsIdentifier` over the same sample table, true for each identifier form and false
  for valid names, 39, 41, 63 and 65 hexadecimal characters and `SHA-256`.
- [ ] B.3 RED (G3) on B.1–B.2, with stubs of `identity.ts` and `containsIdentifier`.

Source:
- [ ] B.4 `utils/digest.ts`: `containsIdentifier` (design.md §2.3, §2.4).
- [ ] B.5 `shared/lib/identity.ts`: the six functions and their date formatter (design.md §2). The file has no
  `sha256-`, hexadecimal run or UUID, and imports only `containsIdentifier`.
- [ ] B.6 FI, V, LINT, TSC. Review: reviewer and test-reviewer.

## C1. CitationPanel (risk low)
Owns `frontend/src/components/CitationPanel/{CitationPanel.tsx,CitationPanel.css,citationFormats.ts,CitationPanel.test.tsx,citationFormats.test.ts}`
(new). Needs B.4.

Tests first:
- [ ] C1.1 `citationFormats.test.ts`:
  - text, BibTeX and CSL-JSON for `CITE`;
  - no authors, no year and no version;
  - BibTeX escaping;
  - the cite key folding (`López` → `lopez`, no author → `openbinding`, no title → `untitled`);
  - no `note` without a full digest.
- [ ] C1.2 `CitationPanel.test.tsx`:
  - the region `Cite this problem version`;
  - the link and `Copy permanent link`;
  - the citation text and `Copy citation`;
  - Copy and Download of BibTeX and CSL-JSON (file names, media types, `saveText`);
  - `D` exactly once and the one `Copy digest`;
  - the refused clipboard;
  - `No digest recorded`;
  - the identifier-bearing permanent link, title and author;
  - no `<pre>`;
  - the stylesheet (`overflow-wrap: anywhere`, no hex colour).
- [ ] C1.3 RED (G3) on C1.1–C1.2, with stubs.

Source:
- [ ] C1.4 `citationFormats.ts`, `CitationPanel.tsx` and `CitationPanel.css` (design.md §3).
- [ ] C1.5 FI, V, LINT, TSC. Review: reviewer and test-reviewer.

## C2. VerifyResult (risk low)
Owns `frontend/src/components/VerifyResult/{VerifyResult.tsx,VerifyResult.css,VerifyResult.test.tsx}` (new). Needs
B.4. Not `pages/Reports/Verifier.tsx` or `pages/Resolve/**`: M2.6 owns them.

Tests first:
- [ ] C2.1 `VerifyResult.test.tsx`:
  - the four verdicts with their titles and texts;
  - `Resolves to` with and without a record, and an identifier-shaped label;
  - the side labels for `digest`, `file` and `link`, and `against="expected"`;
  - one digest per side with its copy button;
  - `D1` exactly twice when verified;
  - `Not computed` and `Nothing recorded`;
  - the copy outcomes;
  - the glyph `aria-hidden`;
  - no `<pre>`;
  - the stylesheet.
- [ ] C2.2 RED (G3) on C2.1, with a stub.

Source:
- [ ] C2.3 `VerifyResult.tsx` and `VerifyResult.css` (design.md §4).
- [ ] C2.4 FI, V, LINT, TSC. Review: reviewer and test-reviewer.

## D. Digest hygiene test (risk medium: it can block other changes; after B, C1 and C2)
Owns `frontend/src/test/digestHygiene.test.ts` (new).

- [ ] D.1 Test first (test-designer):
  - the detector scenarios (the four kinds, the boundaries, comment lines, line and text, `known limit: …`);
  - the allowed paths, on synthetic sources;
  - the scanned set;
  - `unlistedFindings` and `stalePendingFiles` on synthetic sources;
  - the exact-list and ceiling assertions for the 45 paths of design.md §5.5;
  - the application sources pass.

  `PENDING_FILES` is left empty and `MAX_PENDING_FILES` at 45. RED (G3): the exact-list assertion and "the
  application sources pass" fail with the 45 unlisted files.
- [ ] D.2 Implementer: fill `PENDING_FILES`, re-derived on the rebased branch (design.md §5.5, last paragraph).
  Removals and followed renames only. Anything else goes to the coordinator, not into the list.
- [ ] D.3 FI, VALL (G5), LINT, TSC, G1.

## Review panel
- [ ] R.1 reviewer: all groups. Check the spec↔code match, the `[impl->…]` and `[utest->…]` tags, that no page is
  edited, and that `identity.ts` holds no digest pattern.
- [ ] R.2 test-reviewer: G3 evidence per group, the exhaustive table, the hygiene detector controls and the known
  limits, and that no test pins behaviour the spec does not state.
- [ ] R.3 ui-qa: `CitationPanel` and `VerifyResult` from their test DOM and stylesheets:
  - accessible names;
  - focus order of the copy buttons;
  - status announcements;
  - the digest wrapping at 390 px;
  - tokens only;
  - verdicts not by colour alone.

  No routed screen exists yet, so the 1440×900 and 390×844 screenshots (G12) move to the second change (design.md
  §7).
- [ ] R.4 Open the PR into `develop`: one PR for B–D, or one per group in the order B, C1/C2, D, as the coordinator
  chooses (design.md §7, size).

## Archive (later)
- [ ] After `m21-rendering-catalogue` is archived, archive this change in an explicit archive task:
  `["openspec", "archive", "m27-names-not-digests", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## Follow-up: the second M2.7 change (after M2.6 merges)
- [ ] F.1 Move the 45 pending files onto identity labels, `CitationPanel` and `VerifyResult`, and remove their digest
  text, emptying `PENDING_FILES` (`MAX_PENDING_FILES` 0). This includes wiring the Verify page (M2.6's) to
  `VerifyResult` and the problem, collection and published-result pages to `CitationPanel`.
- [ ] F.2 MODIFY `frontend-catalog-pricing`'s engine-card requirement ("exact identity (namespace, name, version,
  digest)") to the engine label.
- [ ] F.3 Decide `shortDigest`/`digestPrefix` and `utils/citation.ts` (design.md §8 question 2).
- [ ] F.4 Permanent links by permanent id or slug (design.md §8 question 1), so `CitationPanel` can be mounted.
- [ ] F.5 ui-qa screenshots (G12) of every screen that changed, desktop and mobile.
- Outside both changes:
  - constitution 15.5's "Enforced: GAP" line names `frontend/src/hygiene.test.ts`. The owner updates it to the two
    hygiene tests;
  - `docs/qa/RENDERING_CATALOGUE.md` lists `CitationPanel` and `VerifyResult` (doc owner).
