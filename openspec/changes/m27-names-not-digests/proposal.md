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

At the base commit `1c31b9d4`, 40 shipped files outside the helpers import `shortDigest` or `digestPrefix`, and 5 more
have digest-shaped text or a UUID in their source (design.md §5).

## What Changes

- Identity labels: `frontend/src/shared/lib/identity.ts` gets six pure functions, one per row of ARCHITECTURE §5.4
  (problem version, collection version, run, study run, published result, engine). They return
  `checkout-flow v3 · sealed 20 Aug 2026`, `QACOBench icws v2 · 12 problems`,
  `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026`, `engines-vs-suite run 3 · 21 Oct 2026`,
  `<title> · published 22 Oct 2026` and `minizinc-csp 1.1.1 · mode exact`. A missing field drops out of the label. It
  is never replaced by an identifier, and a value shaped like a digest or a UUID counts as missing.
- `CitationPanel` (`frontend/src/components/CitationPanel`): the permanent link, the citation text, Copy and Download
  for BibTeX and CSL-JSON, and the one digest, shown once in full with one `Copy digest` button.
- `VerifyResult` (`frontend/src/components/VerifyResult`): the verdict (`verified`, `computed`, `mismatch`,
  `not_found`) as text, what the link, digest or file resolves to (as an identity label), and two sides, each with
  one full digest and its own copy button.
- Hygiene test `frontend/src/test/digestHygiene.test.ts`: the suite fails on `sha256-`, on a run of exactly 40 or 64
  hexadecimal characters, on a UUID, or on the name `shortDigest` or `digestPrefix`, in a non-comment line of a
  shipped source outside the allowed paths. Its fixed pending list of 45 files may only shrink.
- No screen changes in this change. The new components are not mounted on any page yet.

## Impact

- Capability: `frontend-rendering`. Four ADDED requirements, all `~1`: `identity-labels`, `citation-panel`,
  `verify-result` and `digest-hygiene` (ids as the coordinator set them).
- Code, frontend only:
  - new files `frontend/src/shared/lib/identity.ts` and its test (the first file under `shared/`, ARCHITECTURE §5.1);
  - `frontend/src/components/CitationPanel/**` and `frontend/src/components/VerifyResult/**`, new;
  - `frontend/src/test/digestHygiene.test.ts`, new;
  - one addition to `frontend/src/utils/digest.ts`: `containsIdentifier(text)`, the runtime check shared by the three
    modules (design.md §2.4).
- Untouched: `shortDigest`, `digestPrefix`, `utils/citation.ts`, every page, and the raw-rendering allow-list and its
  hygiene test.
- No HTTP API, OpenAPI, gateway, worker, engine or database change. The API keeps every digest (ARCHITECTURE §5.4).
  No `package.json` or lockfile change, so no property-testing library: the exhaustive sample table of design.md §2.5
  replaces one. No feature flag: nothing is mounted.
- Tests: Vitest only. No Playwright spec changes, because no route or screen changes.
- Order: B (labels and `containsIdentifier`), then C1 (`CitationPanel`) and C2 (`VerifyResult`) in parallel, then D
  (hygiene test). See tasks.md.
- Risks (design.md §7):
  - the pending list overlaps files that M2.6 is editing (the Verify page, `Resolve.tsx` and `Verifier.tsx`), so
    merge order matters;
  - the detector is static and line based, so a UUID rendered from API data at runtime is not caught;
  - ui-qa has no mounted screen to capture until the second change.

## Out of scope

- The call-site clean-up: the 45 pending files under `pages/**`, `components/**` and `utils/citation.ts` that call
  `shortDigest`/`digestPrefix` or carry digest-shaped text. That is the second M2.7 change, after M2.6 merges, and it
  empties the pending list. It also retires or keeps `shortDigest`/`digestPrefix` and `utils/citation.ts`.
- Wiring the Verify page to `VerifyResult`, and the problem, collection and published-result pages to
  `CitationPanel`. M2.6 owns the Verify page now, and the second M2.7 change does the wiring.
- Permanent links built from permanent ids or slugs (ARCHITECTURE §5.4: "URLs use permanent ids or slugs"). The
  `/resolve/<kind>/<digest>` links stay as they are. `CitationPanel` refuses to show one of them as a permanent link
  (design.md §3.4).
- Export manifests (the third place §5.4 allows a digest).
- The living requirement of `frontend-catalog-pricing` that engine cards show the digest (`openspec/specs/frontend-catalog-pricing/spec.md`, "exact identity (namespace, name, version, digest)"):
  the second change MODIFIES it when it changes the engine cards.
- Editing INTENT, the constitution (15.5's "Enforced: GAP" line names `frontend/src/hygiene.test.ts`), ARCHITECTURE
  or ROADMAP. Those are follow-ups for their owners.
- Archiving this change into `openspec/specs/frontend-rendering/`. That is a separate, explicit archive task.
