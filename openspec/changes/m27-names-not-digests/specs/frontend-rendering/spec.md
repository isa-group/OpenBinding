## ADDED Requirements

### Requirement: Identity labels name things without identifiers
`req~identity-labels~1`
The label functions of `frontend/src/shared/lib/identity.ts` SHALL return, for each row of ARCHITECTURE §5.4, a non-empty label in that row's form, made only of names, version numbers, counts, engine modes and dates, without each missing part, and never with a digest, fingerprint or UUID.

Needs: impl, utest

Rules: design.md §2.

#### Scenario: Problem version
- **GIVEN** `problemVersionLabel({ name: 'checkout-flow', version: 3, sealedAt: '2026-08-20T09:30:00Z' })`
- **WHEN** it is called
- **THEN** it returns exactly `checkout-flow v3 · sealed 20 Aug 2026`

#### Scenario: Collection version, singular, plural and grouped counts
- **GIVEN** `collectionVersionLabel({ name: 'QACOBench icws', version: 2, problemCount: 12 })`, then the same with `problemCount` 1, 0 and 1200
- **WHEN** each is called
- **THEN** they return exactly `QACOBench icws v2 · 12 problems`, `QACOBench icws v2 · 1 problem`, `QACOBench icws v2 · 0 problems` and `QACOBench icws v2 · 1,200 problems`

#### Scenario: Run, study run, published result and engine
- **GIVEN** `runLabel({ number: 14, problem: { name: 'checkout-flow', version: 3 }, engine: { name: 'minizinc-csp', version: '1.1.1', mode: 'exact' }, createdAt: '2026-10-21T16:05:00Z' })`, `studyRunLabel({ study: 'engines-vs-suite', number: 3, createdAt: '2026-10-21T08:00:00Z' })`, `publishedResultLabel({ title: 'Engines versus the ICWS suite', publishedAt: '2026-10-22T12:00:00Z' })` and `engineLabel({ name: 'minizinc-csp', version: '1.1.1', mode: 'exact' })`
- **WHEN** each is called
- **THEN** they return exactly `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026`, `engines-vs-suite run 3 · 21 Oct 2026`, `Engines versus the ICWS suite · published 22 Oct 2026` and `minizinc-csp 1.1.1 · mode exact`

#### Scenario: Dates in UTC with fixed month names
- **GIVEN** `problemVersionLabel` with `name: 'checkout-flow'`, `version: 3` and, in turn, `sealedAt` `'2026-09-01T23:30:00-02:00'`, `'2026-12-05T00:00:00Z'`, `'soon'`, `'2026-01-31T23:59:59Z'` and `'2026-09-30T23:30:00-02:00'`
- **WHEN** each is called
- **THEN** they return `checkout-flow v3 · sealed 2 Sep 2026`, `checkout-flow v3 · sealed 5 Dec 2026`, `checkout-flow v3`, `checkout-flow v3 · sealed 31 Jan 2026` and `checkout-flow v3 · sealed 1 Oct 2026`
- **AND** the day has no leading zero and the month is one of `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`

#### Scenario: A date-time without an offset is read as UTC
- **GIVEN** `problemVersionLabel({ name: 'p', version: 1, sealedAt })` with `sealedAt` `'2026-08-20T23:30:00'`, then `'2026-08-20'`
- **WHEN** each is called
- **THEN** both return `p v1 · sealed 20 Aug 2026`

#### Scenario: Missing parts of a problem version
- **GIVEN** `problemVersionLabel` with the problem version input above changed, in turn, to: no `sealedAt`; `version: null`; `name: '  '`; `version: 0`; `{}`; and `{ sealedAt: '2026-08-20T09:30:00Z' }`
- **WHEN** each is called
- **THEN** they return `checkout-flow v3`, `checkout-flow · sealed 20 Aug 2026`, `problem v3 · sealed 20 Aug 2026`, `checkout-flow · sealed 20 Aug 2026`, `problem version` and `problem version · sealed 20 Aug 2026`

#### Scenario: Missing parts of the other labels
- **GIVEN** the inputs of the scenarios above with these changes
- **WHEN** each function is called
- **THEN** `collectionVersionLabel` without `problemCount` returns `QACOBench icws v2`, and with `{}` returns `collection version`
- **AND** `runLabel` without `number` returns `run of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026`, without `problem` and without `engine.mode` returns `run 14 · minizinc-csp 1.1.1 · 21 Oct 2026`, and with `{}` returns `run`
- **AND** `studyRunLabel` without `study` returns `study run 3 · 21 Oct 2026`, without `number` returns `engines-vs-suite run · 21 Oct 2026`, and with `{}` returns `study run`
- **AND** `publishedResultLabel` without `publishedAt` returns `Engines versus the ICWS suite`, without `title` returns `published result · published 22 Oct 2026`, and with `{}` returns `published result`
- **AND** `engineLabel` without `mode` returns `minizinc-csp 1.1.1`, without `name` returns `engine 1.1.1 · mode exact`, and with `{}` returns `engine`

#### Scenario: Versions and numbers
- **GIVEN** `problemVersionLabel({ name: 'p', version })` with `version` `'v3'`, `'3'` and `2.5`, `engineLabel({ name: 'e', version: '1.0.0+builtin.a' })` and `runLabel({ number: 1014 })`
- **WHEN** each is called
- **THEN** they return `p v3`, `p v3`, `p`, `e 1.0.0+builtin.a` and `run 1014`

#### Scenario: An identifier-shaped value counts as missing
- **GIVEN** `problemVersionLabel` with `name: '3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f'`, `engineLabel` with `version: 'sha256-' + 'a'.repeat(64)`, `publishedResultLabel` with `title: 'Edition ' + 'e5f6'.repeat(10)` and `studyRunLabel` with `study: 'sha256-e5f6…0718'`, the other fields as in the scenarios above
- **WHEN** each is called
- **THEN** they return `problem v3 · sealed 20 Aug 2026`, `minizinc-csp · mode exact`, `published result · published 22 Oct 2026` and `study run 3 · 21 Oct 2026`

#### Scenario: Identifier forms that are caught, and a run that is not
- **GIVEN** `engineLabel({ name, version: '1' })` with `name` `'SHA256-ABCDEF0123456789'`, `'build' + '0'.repeat(64)`, `'x_' + 'e'.repeat(40)`, `'3F2B9C1E-8A4D-4F6B-9C2E-1A2B3C4D5E6F'` and `'e'.repeat(39)`
- **WHEN** each is called
- **THEN** the first four return `engine 1`
- **AND** the fifth returns the 39 characters followed by ` 1`

#### Scenario: No label ever carries an identifier
- **GIVEN** every combination, for each function, of its fields taken from the sample table of design.md §2.6 (text: a valid value, missing, a full digest, a short digest, 40 and 64 hexadecimal characters, a UUID; numbers: 3, missing, 0, -1; dates: a valid date-time, missing, `'soon'`)
- **WHEN** each combination is called, more than 115,000 calls in all
- **THEN** no result matches `sha256-` (any case), a run of 40 hexadecimal characters or a UUID
- **AND** no result is empty

### Requirement: Citation panel with the digest outside the citation
`req~citation-panel~1`
The `CitationPanel` component SHALL show, in a region named `Cite and link`, a copyable permanent link, the citation text with copy actions for the text, BibTeX and CSL-JSON, and the digest, when one is given, exactly once as a copyable value outside the citation text, BibTeX and CSL-JSON.

Needs: impl, utest

Props, formats and the fixtures `DIGEST` and `BASE`: design.md §3.

#### Scenario: The digest appears once, not in the citation sentence
- **GIVEN** `<CitationPanel {...BASE} digest={DIGEST} />`
- **WHEN** it is rendered
- **THEN** the rendered text contains `DIGEST` exactly once
- **AND** exactly one button is named `Copy digest`
- **AND** the citation sentence starting `ISA Group (2026). Travel booking (version 1.2.0).` is shown

#### Scenario: Copy actions
- **GIVEN** `<CitationPanel {...BASE} digest={DIGEST} />` and a clipboard that accepts writes
- **WHEN** the buttons `Copy permanent link`, `Copy digest`, `Copy BibTeX`, `Copy CSL-JSON` and `Copy citation` are pressed in turn
- **THEN** the clipboard receives, in turn, `BASE.url`, `DIGEST`, and the `bibtex`, `cslJson` and `text` that `buildPanelCitation(BASE)` returns

#### Scenario: No digest given
- **GIVEN** `<CitationPanel {...BASE} />`
- **WHEN** it is rendered
- **THEN** a region named `Cite and link` is shown
- **AND** there is no button named `Copy digest`

#### Scenario: A copy is announced
- **GIVEN** `<CitationPanel {...BASE} />` and a clipboard that accepts writes
- **WHEN** `Copy BibTeX` is pressed
- **THEN** an element with role `status` reads `Citation copied`

#### Scenario: No digest in any citation format
- **GIVEN** `buildPanelCitation(BASE)`
- **WHEN** it is called
- **THEN** none of its `text`, `bibtex` and `cslJson` matches `sha256` or `digest` (any case)

#### Scenario: BibTeX escaping
- **GIVEN** `buildPanelCitation` with `title: 'A_B & 50% {x} #1 $ ^ ~ \'`, `author: 'R&D'`, `version: 'v_1'` and `kindLabel: 'a_b'`
- **WHEN** it is called
- **THEN** the BibTeX holds `title        = {A\_B \& 50\% \{x\} \#1 \$ \textasciicircum{} \textasciitilde{} \textbackslash{}}`, `author       = {R\&D}`, `version      = {v\_1}` and `howpublished = {OpenBinding a\_b}`

#### Scenario: CSL-JSON
- **GIVEN** `buildPanelCitation(BASE)`, then the same with `cslType: 'document'`
- **WHEN** each `cslJson` is parsed
- **THEN** the first is an array of one item with `type: 'dataset'`, `title: 'Travel booking'`, `URL: BASE.url`, `version: '1.2.0'`, `issued: { 'date-parts': [[2026]] }` and `author: [{ literal: 'ISA Group' }]`
- **AND** the item of the second has `type: 'document'`

#### Scenario: Fallbacks for missing fields
- **GIVEN** `buildPanelCitation({ title: 'T', kindLabel: 'collection', url: 'https://x.example/c' })`
- **WHEN** it is called
- **THEN** the text is exactly `OpenBinding (n.d.). T. OpenBinding collection.`
- **AND** the BibTeX has no `year` and no `version`
- **AND** the CSL-JSON item has no `issued` and no `version`

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/CitationPanel/CitationPanel.css`
- **WHEN** it is read
- **THEN** it contains no hexadecimal colour (`#` followed by 3 to 8 hexadecimal characters)

### Requirement: Verify result with one value per side
`req~verify-result~1`
The `VerifyResult` component SHALL show the verifier's verdict as text in a region named `Verdict`, and the two fingerprints being compared as two labelled sides, each holding either one copyable value or the words `nothing recorded`.

Needs: impl, utest

Props, wording and the fixtures `D1`, `D2`, `ID` and `entity`: design.md §4.

#### Scenario: The four verdicts
- **GIVEN** `<VerifyResult verdict={{ status, digest: D1, detail: 'because' }} />` for each `status` of `verified`, `computed`, `mismatch` and `not_found`
- **WHEN** it is rendered
- **THEN** the region named `Verdict` holds that status's title and text from design.md §4.2 (`Verified`, `Computed, not on record`, `Doesn’t match`, `Nothing found`)
- **AND** it holds the detail `because`

#### Scenario: A verified fingerprint that was given
- **GIVEN** `<VerifyResult verdict={{ status: 'verified', digest: D1, entities: [entity()] }} given={D1} />` and a clipboard that accepts writes
- **WHEN** it is rendered
- **THEN** the sides are labelled `Fingerprint you gave` and `Recorded by OpenBinding`
- **AND** `D1` is shown exactly twice, once per side
- **AND** exactly two buttons have a name starting `Copy `
- **AND** pressing `Copy recorded by openbinding` writes `D1` to the clipboard

#### Scenario: A mismatch computed in the browser
- **GIVEN** `<VerifyResult verdict={{ status: 'mismatch', digest: D2 }} computed={D1} />`
- **WHEN** it is rendered
- **THEN** the side `Computed in your browser` shows `D1` and the side `Fingerprint you expected` shows `D2`
- **AND** exactly two buttons have a name starting `Copy `
- **AND** the warning `Your browser and the server disagree` is not shown

#### Scenario: Nothing recorded
- **GIVEN** `<VerifyResult verdict={{ status: 'computed', digest: D1 }} computed={D1} />`
- **WHEN** it is rendered
- **THEN** the text `nothing recorded` is shown
- **AND** exactly one button has a name starting `Copy `

#### Scenario: The browser and the server disagree
- **GIVEN** `<VerifyResult verdict={{ status: 'computed', digest: D2 }} computed={D1} />`
- **WHEN** it is rendered
- **THEN** the warning `Your browser and the server disagree` is shown

#### Scenario: No warning when they agree or nothing was computed
- **GIVEN** `<VerifyResult verdict={{ status: 'verified', digest: D1 }} computed={D1} />`, then the same with `given={D1}` instead of `computed`
- **WHEN** each is rendered
- **THEN** neither shows the warning `Your browser and the server disagree`

#### Scenario: Matches by name, never by identifier
- **GIVEN** a verified verdict whose `entities` are `entity()`, `entity({ title_or_name: null, slug: 'travel-slug', entity_type: 'case' })` and `entity({ title_or_name: ' ', slug: null, entity_type: 'engine' })`, each with `id: ID`
- **WHEN** it is rendered
- **THEN** it shows `Travel run`, the kind `study run`, `travel-slug` and `unnamed element`
- **AND** the rendered text does not contain `ID`

#### Scenario: Links of matches
- **GIVEN** a verified verdict with `entities: [entity()]`, rendered with `hrefOf={() => '/runs/travel'}`, then with `hrefOf={() => '/ignored'}` and `renderLink` returning `<a href="/routed">{label}</a>`, then with neither
- **WHEN** each is rendered
- **THEN** the first has a link named `Travel run` to `/runs/travel`
- **AND** the second has a link named `Travel run` to `/routed`
- **AND** the third has no link

#### Scenario: Citation slot
- **GIVEN** `<VerifyResult verdict={{ status: 'verified', digest: D1 }} citation={<p>citation here</p>} />`
- **WHEN** it is rendered
- **THEN** the text `citation here` is shown

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/VerifyResult/VerifyResult.css`
- **WHEN** it is read
- **THEN** it contains no hexadecimal colour (`#` followed by 3 to 8 hexadecimal characters)

### Requirement: Digest and UUID hygiene with a pending clean-up list
`req~digest-hygiene~1`
IF a shipped frontend source that is neither in the allowed set nor on the pending clean-up list has a line with a digest-shaped literal, a UUID or the name `shortDigest` or `digestPrefix`, or the pending list is unsorted, holds a duplicate, names a missing file or names an allowed path, THEN the frontend test suite SHALL fail.

Needs: impl, utest

Scanned set, allowed set, detectors and the pending list: design.md §5.

#### Scenario: The sources are read
- **GIVEN** the `.ts`, `.tsx` and `.css` files under `frontend/src`, without tests, `src/test/setup.ts` and test kits
- **WHEN** the hygiene test collects them
- **THEN** it reads more than 100 shipped files
- **AND** more than 50 of them are outside the allowed set and the pending list

#### Scenario: The application sources pass
- **GIVEN** the shipped sources outside the allowed set and the pending list
- **WHEN** the hygiene test reads them line by line
- **THEN** no line matches the digest-literal detector or the UUID detector
- **AND** no line names `shortDigest` or `digestPrefix`

#### Scenario: The detectors catch digests, git SHAs and UUIDs
- **GIVEN** the texts `'sha256-` + `'a1b2c3d4'.repeat(8)` + `'`, `"` + `'a1b2c3d4'.repeat(8)` + `"`, `commit 0123456789abcdef0123456789abcdef01234567` and `id: 123e4567-e89b-12d3-a456-426614174000`
- **WHEN** the detectors read them
- **THEN** the digest-literal detector flags the first three
- **AND** the UUID detector flags the fourth

#### Scenario: The detectors leave ordinary text alone
- **GIVEN** the texts `the quick brown fox`, `abcdef012345`, `Shown as sha256- followed by a prefix` and `'a1b2c3d4'.repeat(8)` followed by `0` (65 hexadecimal characters)
- **WHEN** the digest-literal and UUID detectors read them
- **THEN** neither flags any of them

#### Scenario: The helper detector matches whole words only
- **GIVEN** the texts `import { shortDigest } from "../utils/digest"`, `digestPrefix(x)` and `digestPrefixes`
- **WHEN** the helper detector reads them
- **THEN** it flags the first two
- **AND** it does not flag the third

#### Scenario: The pending list only shrinks
- **GIVEN** `PENDING_CLEANUP` of `frontend/src/test/digestHygiene.test.ts` as this change leaves it: the 40 paths of design.md §5.5
- **WHEN** the hygiene test reads it
- **THEN** it is sorted and has no duplicates
- **AND** every entry names a file of the scanned glob
- **AND** no entry is in the allowed set
- **AND** a listed file that no longer offends does not fail the suite: the rule that entries are only removed, never added, is kept by review, because the test has no ceiling assertion (design.md §5.4)
