## ADDED Requirements

### Requirement: Identity labels name things without identifiers
THE label functions of `frontend/src/shared/lib/identity.ts` SHALL return, for each row of ARCHITECTURE §5.4, a label in that row's form, made only of names, version numbers, counts, engine modes and dates, without each missing part, and never with a digest, fingerprint or UUID.

`req~identity-labels~1`

Needs: impl, utest

Rules: design.md §2.

#### Scenario: Problem version
- **GIVEN** `problemVersionLabel({ name: 'checkout-flow', version: 3, sealedAt: '2026-08-20T09:30:00Z' })`
- **WHEN** it is called
- **THEN** it returns exactly `checkout-flow v3 · sealed 20 Aug 2026`

#### Scenario: Collection version
- **GIVEN** `collectionVersionLabel({ name: 'QACOBench icws', version: 2, problemCount: 12 })`, then the same with `problemCount: 1`, then with `problemCount: 0`
- **WHEN** each is called
- **THEN** they return exactly `QACOBench icws v2 · 12 problems`, `QACOBench icws v2 · 1 problem` and `QACOBench icws v2 · 0 problems`

#### Scenario: Run
- **GIVEN** `runLabel({ number: 14, problem: { name: 'checkout-flow', version: 3 }, engine: { name: 'minizinc-csp', version: '1.1.1', mode: 'exact' }, createdAt: '2026-10-21T16:05:00Z' })`
- **WHEN** it is called
- **THEN** it returns exactly `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026`

#### Scenario: Study run
- **GIVEN** `studyRunLabel({ study: 'engines-vs-suite', number: 3, createdAt: '2026-10-21T08:00:00Z' })`
- **WHEN** it is called
- **THEN** it returns exactly `engines-vs-suite run 3 · 21 Oct 2026`

#### Scenario: Published result
- **GIVEN** `publishedResultLabel({ title: 'Engines versus the ICWS suite', publishedAt: '2026-10-22T12:00:00Z' })`
- **WHEN** it is called
- **THEN** it returns exactly `Engines versus the ICWS suite · published 22 Oct 2026`

#### Scenario: Engine
- **GIVEN** `engineLabel({ name: 'minizinc-csp', version: '1.1.1', mode: 'exact' })`
- **WHEN** it is called
- **THEN** it returns exactly `minizinc-csp 1.1.1 · mode exact`

#### Scenario: Dates in UTC with fixed month names
- **GIVEN** `problemVersionLabel` with `name: 'checkout-flow'`, `version: 3` and, in turn, `sealedAt` `'2026-09-01T23:30:00-02:00'`, `'2026-12-05T00:00:00Z'` and `'soon'`
- **WHEN** each is called
- **THEN** they return `checkout-flow v3 · sealed 2 Sep 2026`, `checkout-flow v3 · sealed 5 Dec 2026` and `checkout-flow v3`
- **AND** the day has no leading zero, the month is one of `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`, and the result does not depend on the time zone or the locale of the environment

#### Scenario: Missing parts of a problem version
- **GIVEN** `problemVersionLabel` with, in turn: no `sealedAt`; `version: null`; `name: '  '`; `version: 0`; and `{}`
- **WHEN** each is called (the other fields as in the problem version scenario)
- **THEN** they return `checkout-flow v3`, `checkout-flow · sealed 20 Aug 2026`, `problem v3 · sealed 20 Aug 2026`, `checkout-flow · sealed 20 Aug 2026` and `problem version`
- **AND** a missing name is replaced by `problem` when a version remains, the first part reads `problem version` when neither remains, so `{ sealedAt: '2026-08-20T09:30:00Z' }` returns `problem version · sealed 20 Aug 2026`

#### Scenario: Missing parts of the other labels
- **GIVEN** the inputs of the scenarios above with these changes
- **WHEN** each function is called
- **THEN** `collectionVersionLabel` without `problemCount` returns `QACOBench icws v2`, and with `{}` returns `collection version`
- **AND** `runLabel` without `number` returns `run of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026`, without `problem` and without `engine.mode` returns `run 14 · minizinc-csp 1.1.1 · 21 Oct 2026`, and with `{}` returns `run`
- **AND** `studyRunLabel` without `study` returns `study run 3 · 21 Oct 2026`, without `number` returns `engines-vs-suite run · 21 Oct 2026`, and with `{}` returns `study run`
- **AND** `publishedResultLabel` without `publishedAt` returns `Engines versus the ICWS suite`, without `title` returns `published result · published 22 Oct 2026`, and with `{}` returns `published result`
- **AND** `engineLabel` without `mode` returns `minizinc-csp 1.1.1`, without `name` returns `engine 1.1.1 · mode exact`, and with `{}` returns `engine`

#### Scenario: An identifier-shaped value counts as missing
- **GIVEN** `problemVersionLabel({ name: '3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f', version: 3, sealedAt: '2026-08-20T09:30:00Z' })`, `engineLabel({ name: 'minizinc-csp', version: 'sha256-' + 'a'.repeat(64), mode: 'exact' })`, `publishedResultLabel({ title: 'Edition ' + 'e5f6'.repeat(10), publishedAt: '2026-10-22T12:00:00Z' })` and `studyRunLabel({ study: 'sha256-e5f6…0718', number: 3, createdAt: '2026-10-21T08:00:00Z' })`
- **WHEN** each is called
- **THEN** they return `problem v3 · sealed 20 Aug 2026`, `minizinc-csp · mode exact`, `published result · published 22 Oct 2026` and `study run 3 · 21 Oct 2026`
- **AND** a field whose text contains `sha256-` (any case), a run of exactly 40 or exactly 64 hexadecimal characters, or a UUID is treated as missing as a whole

#### Scenario: No label ever carries an identifier
- **GIVEN** every combination, for each function, of its fields each taken from the sample table of design.md §2.5 (for text: a valid value, missing, a full digest, a short digest, 40 and 64 hexadecimal characters, a UUID)
- **WHEN** each combination is called
- **THEN** no result contains `sha256-`, a run of 40 or 64 hexadecimal characters, or a UUID
- **AND** no result is empty

### Requirement: Citation panel with one digest
THE `CitationPanel` component SHALL show, in a region named `Cite this <kind>`, the permanent link, the citation text, copy and download actions for BibTeX and CSL-JSON, and exactly one digest, shown once in full beside the single button `Copy digest`.

`req~citation-panel~1`

Needs: impl, utest

Props, formats and the fixtures `D` and `CITE`: design.md §3.

#### Scenario: Region and permanent link
- **GIVEN** `<CitationPanel {...CITE} />`
- **WHEN** it is rendered
- **THEN** a region named `Cite this problem version` holds a link whose name and `href` are `https://openbinding.example/isa/qos/problems/checkout-flow/v3`
- **AND** pressing the button `Copy permanent link` writes that URL to the clipboard and the status region reads `Permanent link copied`

#### Scenario: Citation text
- **GIVEN** `<CitationPanel {...CITE} />`, then the same with `authors: []` and `year: null`, then with `kind: 'published result'` and no `version`
- **WHEN** each is rendered
- **THEN** the citation text reads `F. J. Cavero López, A. Ruiz-Cortés (2026). checkout-flow (version 3). OpenBinding problem version. https://openbinding.example/isa/qos/problems/checkout-flow/v3`
- **AND** the second reads `OpenBinding (n.d.). checkout-flow (version 3). OpenBinding problem version. https://openbinding.example/isa/qos/problems/checkout-flow/v3`
- **AND** the third has no `(version …)` part and reads `OpenBinding published result.` before the URL
- **AND** pressing `Copy citation` writes the shown text to the clipboard and the status region reads `Citation copied`

#### Scenario: BibTeX
- **GIVEN** `<CitationPanel {...CITE} />`
- **WHEN** `Copy BibTeX` is pressed
- **THEN** the clipboard receives exactly `@misc{lopez2026checkoutflow,\n  title        = {checkout-flow},\n  author       = {F. J. Cavero López and A. Ruiz-Cortés},\n  year         = {2026},\n  version      = {3},\n  howpublished = {OpenBinding problem version},\n  url          = {https://openbinding.example/isa/qos/problems/checkout-flow/v3},\n  note         = {SHA-256 digest D}\n}` with `D` written out
- **AND** the status region reads `BibTeX copied`
- **AND** pressing `Download BibTeX` saves the same text as `lopez2026checkoutflow.bib` with type `application/x-bibtex` through the shared `saveText` helper
- **AND** a title `Cost & latency: 50% {all}` is written `Cost \& latency: 50\% \{all\}` in the BibTeX title

#### Scenario: CSL-JSON
- **GIVEN** `<CitationPanel {...CITE} />`
- **WHEN** `Copy CSL-JSON` is pressed
- **THEN** the clipboard receives `JSON.stringify([item], null, 2)` where `item` is `{ id: 'lopez2026checkoutflow', type: 'dataset', title: 'checkout-flow', author: [{ literal: 'F. J. Cavero López' }, { literal: 'A. Ruiz-Cortés' }], issued: { 'date-parts': [[2026]] }, version: '3', genre: 'problem version', publisher: 'OpenBinding', URL: 'https://openbinding.example/isa/qos/problems/checkout-flow/v3', note: 'SHA-256 digest D' }` with `D` written out
- **AND** the status region reads `CSL-JSON copied`
- **AND** pressing `Download CSL-JSON` saves the same text as `lopez2026checkoutflow.csl.json` with type `application/vnd.citationstyles.csl+json`

#### Scenario: Exactly one digest, shown once
- **GIVEN** `<CitationPanel {...CITE} />`
- **WHEN** it is rendered
- **THEN** the text content of the region contains `D` exactly once, in a `<code>` element after the label `Digest`, and no other `sha256-`, 40- or 64-character hexadecimal run or UUID
- **AND** exactly one button has a name containing `digest`, and it is `Copy digest`
- **AND** pressing it writes `D` to the clipboard and the status region reads `Digest copied`
- **AND** neither the BibTeX nor the CSL-JSON text is rendered, and the region has no `<pre>`

#### Scenario: A copy refused by the clipboard
- **GIVEN** `<CitationPanel {...CITE} />` and a clipboard that rejects writes
- **WHEN** `Copy digest` is pressed
- **THEN** the status region reads `Could not copy the digest`

#### Scenario: No full digest recorded
- **GIVEN** `<CitationPanel {...CITE} digest="" />`, then the same with `digest="sha256-e5f6…0718"`
- **WHEN** each is rendered
- **THEN** the digest row reads `No digest recorded`, there is no button `Copy digest`, and the region has no `sha256-` text
- **AND** the BibTeX and CSL-JSON have no `note`

#### Scenario: A permanent link that carries an identifier
- **GIVEN** `<CitationPanel {...CITE} permanentUrl={`https://openbinding.example/resolve/report/${D}`} />`
- **WHEN** it is rendered
- **THEN** the region shows the notice `This item has no permanent link yet` in place of the link and the citation text
- **AND** there is no button `Copy permanent link`, `Copy citation`, `Copy BibTeX`, `Download BibTeX`, `Copy CSL-JSON` or `Download CSL-JSON`
- **AND** the digest row and `Copy digest` stay, and the text content contains `D` exactly once

#### Scenario: A title or author that carries an identifier
- **GIVEN** `<CitationPanel {...CITE} title={'Edition ' + 'e5f6'.repeat(10)} authors={['3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f', 'A. Ruiz-Cortés']} />`
- **WHEN** it is rendered
- **THEN** the citation text reads `A. Ruiz-Cortés (2026). Untitled problem version (version 3). OpenBinding problem version. https://openbinding.example/isa/qos/problems/checkout-flow/v3`
- **AND** the text content of the region contains `D` exactly once and no other `sha256-`, 40- or 64-character hexadecimal run or UUID

#### Scenario: Digest wraps and tokens only
- **GIVEN** `frontend/src/components/CitationPanel/CitationPanel.css`
- **WHEN** it is read
- **THEN** the digest rule declares `overflow-wrap: anywhere` and the file contains no hex colour

### Requirement: Verify result with one digest per side
THE `VerifyResult` component SHALL show, in a region named `Verification result`, the verdict as text, what the link, digest or file resolves to, and two sides, the input's digest and the recorded or expected one, each with at most one full digest and its own copy button.

`req~verify-result~1`

Needs: impl, utest

Props, labels, verdicts and the fixtures `D1`, `D2`, `PV`: design.md §4.

#### Scenario: A verified digest
- **GIVEN** `<VerifyResult input="digest" verdict="verified" resolvesTo={PV} inputDigest={D1} otherDigest={D1} />`
- **WHEN** it is rendered
- **THEN** a region named `Verification result` holds a status element with the title `Verified` and the text `The digest matches what OpenBinding recorded.`
- **AND** it reads `Resolves to` followed by a link named `checkout-flow v3 · sealed 20 Aug 2026` with `href` `/app/isa/qos/problems/checkout-flow/v3`
- **AND** the side `Digest you gave` shows `D1` in `<code>` with the button `Copy your digest`, and the side `Recorded by OpenBinding` shows `D1` in `<code>` with the button `Copy the recorded digest`
- **AND** the text content of the region contains `D1` exactly twice, once per side

#### Scenario: Computed from a file, not on record
- **GIVEN** `<VerifyResult input="file" verdict="computed" resolvesTo={null} inputDigest={D1} otherDigest={null} />`
- **WHEN** it is rendered
- **THEN** the title reads `Computed, not on record` and the text `The digest was computed, but OpenBinding has no record with it.`
- **AND** it reads `Resolves to nothing on record`
- **AND** the side `Computed from your file` shows `D1` with `Copy your digest`, and the side `Recorded by OpenBinding` reads `Nothing recorded` with no copy button

#### Scenario: A link whose content does not match
- **GIVEN** `<VerifyResult input="link" verdict="mismatch" resolvesTo={PV} inputDigest={D1} otherDigest={D2} />`
- **WHEN** it is rendered
- **THEN** the title reads `Doesn’t match` and the text `The two digests differ: the content was changed.`
- **AND** the side `Computed from the linked content` shows `D1` and the side `Recorded by OpenBinding` shows `D2`, each with its own copy button

#### Scenario: Against an expected digest
- **GIVEN** `<VerifyResult input="file" verdict="mismatch" against="expected" resolvesTo={null} inputDigest={D1} otherDigest={D2} />`
- **WHEN** it is rendered
- **THEN** the second side is labelled `Digest you expected` and its button is `Copy the expected digest`

#### Scenario: Nothing found
- **GIVEN** `<VerifyResult input="digest" verdict="not_found" resolvesTo={null} inputDigest={D1} otherDigest={null} />`
- **WHEN** it is rendered
- **THEN** the title reads `Nothing found` and the text `OpenBinding has no record with this digest that you can see.`
- **AND** it reads `Resolves to nothing on record`, the side `Digest you gave` shows `D1`, and the side `Recorded by OpenBinding` reads `Nothing recorded`

#### Scenario: Copy outcome
- **GIVEN** the verified result above, first with a clipboard that accepts writes, then with one that rejects them
- **WHEN** `Copy your digest` is pressed
- **THEN** the clipboard receives `D1` and the status region reads `Your digest copied`
- **AND** with the rejecting clipboard it reads `Could not copy your digest`

#### Scenario: Values that are not full digests or carry identifiers
- **GIVEN** `<VerifyResult input="file" verdict="computed" resolvesTo={{ label: 'Edition 3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f' }} inputDigest="sha256-e5f6…0718" otherDigest={null} />`
- **WHEN** it is rendered
- **THEN** the side `Computed from your file` reads `Not computed` with no copy button
- **AND** it reads `Resolves to a record`
- **AND** the region has no `sha256-` text, no 40- or 64-character hexadecimal run and no UUID

#### Scenario: Verdict as text and nothing raw
- **GIVEN** each of the four verdicts
- **WHEN** it is rendered
- **THEN** the verdict title is visible text and the glyph next to it is `aria-hidden="true"` (constitution 11.1: never colour alone)
- **AND** the region has no `<pre>`

#### Scenario: Digest wraps and tokens only
- **GIVEN** `frontend/src/components/VerifyResult/VerifyResult.css`
- **WHEN** it is read
- **THEN** the digest rule declares `overflow-wrap: anywhere` and the file contains no hex colour

### Requirement: Digest and UUID hygiene with a shrinking pending list
IF a shipped source outside the allowed paths has a non-comment line with `sha256-`, a run of exactly 40 or 64 hex characters, a UUID or the name `shortDigest` or `digestPrefix`, and is not on the pending list, or a pending file has no such line left, THEN the frontend test suite SHALL fail.

`req~digest-hygiene~1`

Needs: impl, utest

Paths, detector and pending list: design.md §5.

#### Scenario: The detector reports digest-shaped text
- **GIVEN** the in-memory lines `const d = 'sha256-abc';`, `<code>sha256-e5f6…0718</code>`, ``return `sha256-${hex}`;`` and `title="SHA256-X"`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each, of kind `digest`

#### Scenario: The detector reports 40 and 64 hexadecimal characters
- **GIVEN** the in-memory lines `const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';` and `const h = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each, of kind `hex`
- **AND** it reports nothing for runs of 39, 41, 63 and 65 hexadecimal characters, for a 40-character run preceded or followed by a letter, a digit or `_`, and for `color: #ffffff`

#### Scenario: The detector reports a UUID
- **GIVEN** the in-memory lines `placeholder="00000000-0000-4000-8000-000000000000"` and `const id = '3F2B9C1E-8A4D-4F6B-9C2E-1A2B3C4D5E6F';`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each, of kind `uuid`

#### Scenario: The detector reports the digest helpers
- **GIVEN** the in-memory lines `import { shortDigest } from '../../utils/digest';`, `  digestPrefix,` (inside a multi-line import), `import { isDigest, shortDigest as short } from './digest';`, `export { digestPrefix } from './digest';` and `<code>{shortDigest(d)}</code>`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each, of kind `helper`
- **AND** it reports nothing for `import { isDigest, normalizeDigest } from '../../utils/digest';` and `const shortDigestLabel = 1;`

#### Scenario: The detector skips comment lines
- **GIVEN** the in-memory lines `// sha256-abc`, `/** sha256-… */`, ` * see shortDigest`, `{/* 00000000-0000-4000-8000-000000000000 */}` and `const a = 1; // sha256-abc`
- **WHEN** the detector reads each
- **THEN** it reports nothing for the first four and one finding for the fifth
- **AND** the detector is line based: a trailing comment on a code line is read as code, and the tests pinning this and the other limits of design.md §5 are named `known limit: …`

#### Scenario: Line number, text and kind
- **GIVEN** the text `const a = 1;\n    const d = 'sha256-x';`
- **WHEN** the detector reads it
- **THEN** it reports exactly `{ line: 2, text: "const d = 'sha256-x';", kind: 'digest' }`
- **AND** a line with several shapes is reported once, with the first kind of the order `digest`, `uuid`, `hex`, `helper`

#### Scenario: Allowed paths are exempt
- **GIVEN** the lines `const d = 'sha256-x';` and `import { shortDigest } from './digest';` placed, with an empty pending list, in `components/CitationPanel/CitationPanel.tsx`, `components/VerifyResult/VerifyResult.tsx`, `components/rendering/SourceView.tsx`, `components/rendering/LogPanel.tsx`, `utils/digest.ts`, `utils/uuid.ts`, `utils/canonicalDigest.ts`, `api/client.ts`, `pages/Cases/fixtures.ts`, `pages/Pricing/pricingFixture.ts` and `pages/Example/fixtures/runs.ts`
- **WHEN** the scan reads them
- **THEN** it reports nothing
- **AND** the same lines in `pages/Jobs/JobFacts.tsx`, `components/rendering/BindingTable.tsx`, `components/CitationPanelExtra.tsx`, `utils/citation.ts` and `shared/lib/identity.ts` are reported, two findings each

#### Scenario: The sources are read
- **GIVEN** the application sources
- **WHEN** the hygiene test collects them
- **THEN** it reads more than 100 files, none under `src/test/`, none named `*.test.*` and no test kit
- **AND** `components/CitationPanel/CitationPanel.tsx`, `components/VerifyResult/VerifyResult.tsx` and `shared/lib/identity.ts` are among them

#### Scenario: The application sources pass
- **GIVEN** the application sources and the pending list of this change
- **WHEN** `unlistedFindings` and `stalePendingFiles` read them
- **THEN** each returns an empty list
- **AND** `shared/lib/identity.ts` has no finding

#### Scenario: A new digest outside the allowed paths
- **GIVEN** the synthetic source `pages/New.tsx` with the lines `const a = 1;` and `const d = 'sha256-x';`, and an empty pending list
- **WHEN** `unlistedFindings` reads it
- **THEN** it returns exactly `pages/New.tsx:2  const d = 'sha256-x';  — show a name (shared/lib/identity.ts), or the digest in CitationPanel or VerifyResult, instead of adding the file to the pending list`

#### Scenario: A pending file passes
- **GIVEN** the synthetic source `pages/Old.tsx` with the line `import { shortDigest } from '../utils/digest';`, and a pending list that holds `pages/Old.tsx`
- **WHEN** `unlistedFindings` and `stalePendingFiles` read it
- **THEN** each returns an empty list

#### Scenario: A cleaned file leaves the pending list
- **GIVEN** the synthetic source `pages/Old.tsx` with the line `const a = 1;`, and a pending list that holds `pages/Old.tsx` and `pages/Gone.tsx`, which is not in the sources
- **WHEN** `stalePendingFiles` reads them
- **THEN** it returns exactly `pages/Old.tsx  — no digest-shaped text or digest helper left: remove it from the pending list` and `pages/Gone.tsx  — no digest-shaped text or digest helper left: remove it from the pending list`

#### Scenario: The pending list only shrinks
- **GIVEN** `PENDING_FILES` of `frontend/src/test/digestHygiene.test.ts`, as this change leaves it
- **WHEN** the hygiene test reads it
- **THEN** `MAX_PENDING_FILES` is 45 and the list has at most that many entries, without duplicates
- **AND** the list holds exactly the 45 paths of design.md §5, as relative paths under `frontend/src`
- **AND** no entry is under an allowed path
- **AND** a later change may only remove entries, or follow a rename made by a merged change, and lowers `MAX_PENDING_FILES` with each removal until the list is empty
