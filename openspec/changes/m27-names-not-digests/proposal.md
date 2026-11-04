# Change: m27-names-not-digests

## Why

ROADMAP M2.7: "Names, not digests (INTENT principle 13, ARCHITECTURE §5.4): identity labels in `shared/lib`; digests,
fingerprints and UUIDs removed from cards, lists, headers and badges; `CitationPanel` and `VerifyResult`", accepted
when "the hygiene test finds no digest-shaped text or UUID outside the allowed components".

INTENT principle 13: "People read names, machines read digests. Screens identify things by name, version number and
date (`checkout-flow` v3, sealed 20 Aug 2026). SHAs, digests, hashes and fingerprints stay in the data and the API and
appear only where verifying is the task: the Verify page, citation panels and export manifests, as one copyable value,
never as a label, a card line or a column." Constitution 15.5 says the same and marks its enforcement as a GAP.
ARCHITECTURE §5.3 lists `CitationPanel` ("permanent link, citation (BibTeX, CSL-JSON) and the one copyable digest")
and `VerifyResult` ("what a permanent link, a digest or a file resolves to, and whether it matches"). §5.4 gives the
label of each thing and says that the hygiene test "fails on a digest-shaped string (`sha256-` or 40/64 hexadecimal
characters) or a UUID rendered anywhere else".

The coordinator splits M2.7 into two changes. This first change builds the parts that the screens will use and the
test that holds the line. A second change, after M2.6 merges, moves the screens onto them.

The change was specified in parallel with the code. It now describes the code as built: the spec follows the code
(design.md §6 lists the files and tests).

## What Changes

- Identity labels: `frontend/src/shared/lib/identity.ts` exports six pure functions, one per row of ARCHITECTURE §5.4
  (problem version, collection version, run, study run, published result, engine). They return
  `checkout-flow v3 · sealed 20 Aug 2026`, `QACOBench icws v2 · 12 problems`,
  `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026`, `engines-vs-suite run 3 · 21 Oct 2026`,
  `<title> · published 22 Oct 2026` and `minizinc-csp 1.1.1 · mode exact`. A missing part drops out of the label and
  is never replaced by an identifier. A text that contains `sha256-`, a run of 40 or more hexadecimal characters or a
  UUID counts as missing. Dates are read and written in UTC, including a date-time without an offset written with
  `T` or with a space (`2026-08-20 23:30:00`), and the tests run them under `Pacific/Kiritimati` and
  `America/Los_Angeles` too.
- `CitationPanel` (`frontend/src/components/CitationPanel`): a region `Cite and link` with the permanent link as a
  copyable value, the citation text with `Copy citation`, `Copy BibTeX` and `Copy CSL-JSON`, and, when given, the one
  digest with `Copy digest`. No citation format carries the digest. One status announces only the latest copy
  outcome (`BibTeX copied`, `CSL-JSON copied`, `Citation text copied`, or `Could not copy the <name>`).
  `buildPanelCitation` and `escapeBibtex` are exported for reuse.
- `VerifyResult` (`frontend/src/components/VerifyResult`): the verifier's verdict (`verified`, `computed`,
  `mismatch`, `not_found`) as words in an element with role `status` named `Verdict`, a warning when the browser and
  the server disagree, and the fingerprints being compared, each shown once:
  - a verified result shows the digest once, with one copy button; a given or computed side that holds the same
    digest reads `Matches the recorded fingerprint` (`Matches the expected fingerprint` for a mismatch) instead;
  - with nothing given or computed, only the recorded side shows;
  - two different digests show one copy button each;
  - copy buttons have explicit names: `Copy recorded fingerprint`, `Copy fingerprint you gave`,
    `Copy computed fingerprint` and `Copy expected fingerprint`.

  Then the matches by name and kind (never by id; long names wrap) and a slot for a citation panel.
- Hygiene test `frontend/src/test/digestHygiene.test.ts`: the suite fails on a digest literal (`sha256-` with 8 or
  more hexadecimal characters, or a bare 40- or 64-hexadecimal run), a UUID, or the name `shortDigest` or
  `digestPrefix` in a shipped `.ts`, `.tsx` or `.css` file outside the allowed set. The files the allowed set
  exempts are pinned in an explicit list of 39, and self-tests prove the scan pipeline reports findings. Part 1 also
  held a pending clean-up list; part 2 emptied and deleted it. The file carries both the `[impl->…]` and the
  `[utest->…]` tag.
- Part 2 (screens): the pages and components that called `shortDigest`/`digestPrefix` or carried digest-shaped text
  were cleaned. Review round 1 also cleaned AppHome, OrgAudit, Examples and Schemas (the Schemas protocol digest
  becomes a copy-only button). `VerifyResult` and `CitationPanel` are mounted on the Verify page. The hygiene test has
  no pending list. `shortDigest`, `digestPrefix` and `utils/citation.ts` are retired.

## Impact

- Capability: `frontend-rendering`. Four ADDED requirements, all `~1`: `identity-labels`, `citation-panel`,
  `verify-result` and `digest-hygiene` (ids as the coordinator set them).
- Code, frontend only:
  - new `frontend/src/shared/lib/identity.ts` and its test (the first files under `shared/`, ARCHITECTURE §5.1);
  - new `frontend/src/components/CitationPanel/**` and `frontend/src/components/VerifyResult/**`;
  - new `frontend/src/test/digestHygiene.test.ts`;
  - part 2: edits to the call sites in `pages/**` and `components/**`, including the Verify page wiring
    (`pages/Verify/VerifierResult.tsx`, `ResolveResult.tsx`), and deletion of the shorteners in `utils/digest.ts` and of
    `utils/citation.ts` with its test;
  - one line in the root `.gitignore`, `!/frontend/src/shared/lib/`, because the template rule `lib/` would ignore the
    new directory.
- Untouched by part 1: `utils/digest.ts` (`shortDigest`, `digestPrefix`), `utils/citation.ts`,
  `components/ui/CopyField` and `useCopy`, every page, and the raw-rendering allow-list and its hygiene test. Part 2
  edited the pages and deleted `shortDigest`, `digestPrefix`, `utils/citation.ts` and its test (design.md §8,
  question 2).
- No HTTP API, OpenAPI, gateway, worker, engine or database change. The API keeps every digest (ARCHITECTURE §5.4).
  No `package.json` or lockfile change, so no property-testing library: the exhaustive sample table of design.md §2.6
  replaces one. No feature flag: the screens change directly.
- Tests: Vitest (component tests per screen and the hygiene test) and, in part 2, 11 mocked Playwright specs under
  `frontend/e2e/**`: `pricing`, `s1a-public`, `s1b-language`, `s3-account`, `s5a-cases`, `s5d-workbench`, `s6a-jobs`,
  `s7a-studies`, `s7b-reports`, `s8a-engines` and `s9b-admin`. They assert the new names and labels and add negative
  checks: no `sha256-` text, no 12-hexadecimal run and no fingerprint text on the screen. No spec is deleted or
  weakened; `playwright.config` and the e2e helpers are untouched. The touch-target check and ui-qa screenshots stay
  open (tasks.md F.3, F.6).
- Traceability: `[impl->…]` and `[utest->…]` tags exist for all four requirements, at `~1` (design.md §6).
- Risks (design.md §7):
  - the detector is static and line based. Short forms (`sha256-…`) and identifiers from runtime data are not caught;
  - the components show their inputs as given, so callers must pass names and slug links; the gateway's
    `Snapshot <id[:8]>` name fallback is one such input today;
  - whether two different digests side by side meet constitution 15.5 is the owner's reading (design.md §8,
    question 5);
  - ui-qa screenshots of the changed screens are still to be taken.

## Out of scope

- Done in part 2 (history, not out of scope any more): the call-site clean-up of the 40 files under `pages/**` and
  `components/**` that called `shortDigest`/`digestPrefix` or carried digest-shaped text, which emptied the pending list
  and retired `shortDigest`, `digestPrefix` and `utils/citation.ts`; and the mounting of `VerifyResult` and
  `CitationPanel` on the Verify page.
- Still out of scope: mounting `CitationPanel` on the problem, collection and published-result pages (the panel is
  mounted only on the Verify page).
- Permanent links built from permanent ids or slugs (ARCHITECTURE §5.4: "URLs use permanent ids or slugs"). The
  `/resolve/<kind>/<digest>` links stay as they are, and `CitationPanel` does not refuse them; the Verify permanent
  link still embeds the digest and needs a gateway route (design.md §8, question 1).
- Deferred leftovers: Admin short UUIDs (`adminModel.shortId`); the Workbench registered-reference digest input
  (an authoring field); the gateway snapshot `version_or_revision`, a 12-hexadecimal digest prefix from `resolve.py`;
  and question 5 (constitution 15.5, two different digests side by side), awaiting the owner.
- Behaviour drafted earlier but not built (Download buttons, a digest `note` in the citation formats, identifier
  guards in the components, comment skipping, a ceiling and a stale check in the hygiene test, a 44 px touch-target
  check): design.md §8, items 6 and 7, and tasks.md section F.
- Export manifests (the third place §5.4 allows a digest).
- The living requirement of `frontend-catalog-pricing` that engine cards show the digest
  (`openspec/specs/frontend-catalog-pricing/spec.md`, "exact identity (namespace, name, version, digest)"): part 2
  MODIFIES it in this change's delta `specs/frontend-catalog-pricing/spec.md`, which moves the engine-card requirement
  to the engine label. Part 1 did not touch it.
- Editing INTENT, the constitution (15.5's "Enforced: GAP" line names `frontend/src/hygiene.test.ts`), ARCHITECTURE
  or ROADMAP. Those are follow-ups for their owners.
- Archiving this change into `openspec/specs/frontend-rendering/`. That is a separate, explicit archive task.
