# Design: m27-names-not-digests

Status: built. The spec follows the code. This document describes the code and tests listed in §6, and every
requirement and scenario of the delta describes what they do. Fixed inputs:
- ROADMAP M2.7;
- INTENT principle 13;
- constitution 15.5 and 11.1;
- ARCHITECTURE §5.1 (`shared/lib` holds "the identity labels of §5.4"), §5.3 (the `CitationPanel` and `VerifyResult`
  rows) and §5.4;
- the coordinator's split of M2.7 into this change and a second, call-site change after M2.6 merges.

## 1. Scope and ownership

| In this change | Owner afterwards |
|---|---|
| `frontend/src/shared/lib/identity.ts` and `identity.test.ts` (new) | screens, through the second M2.7 change |
| `frontend/src/components/CitationPanel/**` (new: `CitationPanel.tsx`, `CitationPanel.css`, `citationModel.ts`, `index.ts`, `CitationPanel.test.tsx`) | problem, collection and published-result pages (second change) |
| `frontend/src/components/VerifyResult/**` (new: `VerifyResult.tsx`, `VerifyResult.css`, `verifyModel.ts`, `index.ts`, `VerifyResult.test.tsx`) | the Verify page (M2.6 builds the page; the second change mounts the component) |
| `frontend/src/test/digestHygiene.test.ts` (new) | every change; the second change empties its pending list |
| root `.gitignore`, one line: `!/frontend/src/shared/lib/` (line 18) | repository |

The `.gitignore` line is needed because the root file carries the Python template rule `lib/` (line 17), which would
ignore every directory named `lib`, `frontend/src/shared/lib/` included. The exception re-includes only that
directory.

Nothing here edits a page, `utils/digest.ts` (`shortDigest`, `digestPrefix`, `DIGEST_PATTERN`), `utils/citation.ts`,
the shared `components/ui/CopyField` and `useCopy`, `rawRenderingAllowList.ts` or `rawRenderingHygiene.test.ts`. The
new components contain no `<pre>` and render no `JSON.stringify` output on screen. No page imports them yet: the only
file outside the two directories that names them is the hygiene test.

Placement: the components live at `components/CitationPanel` and `components/VerifyResult`, each with an `index.ts`.
They are the only components allowed to show a digest, and a directory of their own lets the hygiene test exempt them
by path prefix.

## 2. Identity labels

### 2.1 Functions

All six are exported, pure, read no clock, locale or time zone, and return a non-empty string. The input types
`ProblemVersionInput`, `CollectionVersionInput`, `RunInput`, `StudyRunInput`, `PublishedResultInput` and
`EngineInput` are exported too. Every field is optional and may be `null`.

| Function | Input | Full label |
|---|---|---|
| `problemVersionLabel` | `{ name?, version?, sealedAt? }` | `checkout-flow v3 · sealed 20 Aug 2026` |
| `collectionVersionLabel` | `{ name?, version?, problemCount? }` | `QACOBench icws v2 · 12 problems` |
| `runLabel` | `{ number?, problem?: { name?, version? }, engine?: { name?, version?, mode? }, createdAt? }` | `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026` |
| `studyRunLabel` | `{ study?, number?, createdAt? }` | `engines-vs-suite run 3 · 21 Oct 2026` |
| `publishedResultLabel` | `{ title?, publishedAt? }` | `Engines versus the ICWS suite · published 22 Oct 2026` |
| `engineLabel` | `{ name?, version?, mode? }` | `minizinc-csp 1.1.1 · mode exact` |

Types: names, titles, studies, engine versions and modes are strings; problem and collection versions and run and
study-run numbers are `number | string`; `problemCount` is a number; dates are `string | number | Date`. The inputs
have no id, digest or fingerprint field, so a caller cannot pass one by name. §2.4 covers a value shaped like one.

The helpers `problemVersionParts`, `problemHead`, `text`, `positiveInteger`, `version`, `count`, `date`, `words`,
`join` and `containsIdentifier` are private to the module.

Considered: returning parts (`{ name, version, date }`) so that pages could put the name in `<code>`. Rejected: the
labels are plain text in cards, headers and options. One string keeps call sites trivial, and a later revision can
add a parts variant.

### 2.2 Shape and degradation

A label is a list of segments joined by ` · ` (space, U+00B7, space). The first segment, the head, is never empty.
Every other segment is dropped when all its fields are missing.

| Label | Head | Other segments |
|---|---|---|
| problem version | `<name> v<version>`; no name: `problem v<version>`; no version: `<name>`; neither: `problem version` | `sealed <date>` |
| collection version | `<name> v<version>`; no name: `collection v<version>`; no version: `<name>`; neither: `collection version` | `<n> problem` / `<n> problems` |
| run | `run <number> of <problem>`; no number: `run of <problem>`; no problem: `run <number>`; neither: `run`. `<problem>` is `<name> v<version>`, `problem v<version>` or `<name>` | engine `<name> <version> <mode>` (no name: `engine <version> <mode>`; a missing part is dropped); `<date>` |
| study run | `<study> run <number>`; no study: `study run <number>`; no number: `<study> run`; neither: `study run` | `<date>` |
| published result | `<title>`; no title: `published result` | `published <date>` |
| engine | `<name> <version>`; no name: `engine <version>`; no version: `<name>`; neither: `engine` | `mode <mode>` |

The run label writes the engine as `minizinc-csp 1.1.1 exact`, without the word `mode`. The engine label writes
`mode exact`. Both forms are as ARCHITECTURE §5.4 gives them.

### 2.3 Missing values, versions and counts

A field is missing when it is any of these:
- `undefined` or `null`;
- a text that is empty after trimming, or that contains an identifier (§2.4);
- a problem or collection version, or a run or study-run number, that is not a positive integer;
- a problem count that is not a non-negative integer number;
- a date that is `''` or that `Date` cannot parse.

Versions and run numbers accept a positive integer, or a string of digits with an optional leading `v` in any case
(`'3'`, `'v3'`). A version is written `v<n>` once (`'v3'` gives `v3`, not `vv3`); `2.5`, `0` and `-1` are missing.
Run and version numbers use no grouping (`run 1014`). Counts use en-US grouping (`1,200 problems`). Text fields are
trimmed. Engine versions and modes are text, shown as given (`1.0.0+builtin.a`).

### 2.4 Identifier-shaped values

A text field (name, title, study, engine name, engine version, engine mode) counts as missing, as a whole, when its
trimmed value contains any of:
- `sha256-` in any case;
- a run of 40 or more hexadecimal characters in any case, with no lookarounds, so `build<64 hex>` and `x_<40 hex>`
  are caught; a run of 39 is not;
- a UUID (`8-4-4-4-12` hexadecimal, any case).

This covers API fallbacks that put an id where a name should be (`title_or_name ?? id`), today's short forms
(`sha256-e5f6…0718` contains `sha256-`), git SHAs (40 hex) and full digests.

The predicate `containsIdentifier` is private to `identity.ts`; nothing else in this change uses it, and
`utils/digest.ts` is unchanged. `identity.ts` passes the hygiene detector of §5.3 because its regular-expression
sources contain no `sha256-` followed by eight hexadecimal characters, no literal 40- or 64-character hexadecimal run
and no literal UUID.

### 2.5 Dates

Dates are formatted in UTC as `<day> <Mon> <year>`. The day has no leading zero, and the month comes from the fixed
table `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`. `Intl` is not used, because current ICU data writes
September as `Sept` in `en-GB`. A string date-time without an offset (`YYYY-MM-DDTHH:MM`, optionally with seconds and
fractions) gets `Z` appended before parsing, so it is read as UTC rather than local time; a date-only string is read
as UTC by `Date` already. The existing `utils/format.ts` `formatDate` (`Aug 20, 2026`) is not changed (open
question 3).

### 2.6 The sample table

The exhaustive test draws each field from these values:
- text: `'valid'`, missing, `sha256-` + 64 × `a`, `sha256-e5f6…0718`, 40 × `e`, 64 × `0`,
  `3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f`;
- numbers: `3`, missing, `0`, `-1`;
- dates: `'2026-08-20T09:30:00Z'`, missing, `'soon'`.

`runLabel` alone takes 7⁴ × 4² × 3 = 115,248 combinations; the test asserts more than 115,000 calls in all, and that
no result is empty or matches `/sha256-/i`, `/[0-9a-f]{40}/i` or a UUID. It replaces a property-testing library,
because this change adds no dependency.

## 3. CitationPanel

### 3.1 Props and exports

```ts
interface CitationInput {            // citationModel.ts
  title: string;
  kindLabel: string;                 // the reader's word for the kind: 'problem', 'collection', ...
  url: string;                       // the permanent link, by slug or permanent id
  year?: number | null;
  author?: string | null;            // one display string
  version?: string | null;
  cslType?: 'dataset' | 'document';  // default 'dataset'
}
interface CitationPanelProps extends CitationInput {
  digest?: string | null;            // the one place the digest is shown; omitted when the record has none
}
```

`index.ts` exports `CitationPanel`, `CitationPanelProps`, `buildPanelCitation`, `escapeBibtex`, `BuiltCitation` and
`CitationInput`.

The test fixtures are:
- `DIGEST`: `sha256-` followed by `ab12` sixteen times;
- `BASE`: `{ title: 'Travel booking', kindLabel: 'problem', url: 'https://openbinding.example/p/travel', year: 2026, author: 'ISA Group', version: '1.2.0' }`.

### 3.2 Layout

The panel is a `<section>` labelled by its `<h2>` `Cite and link` (fixed text and level). It holds up to three fields:

1. `Permanent link`: the shared `CopyField` (`components/ui/CopyField`) with the URL in `<code>` and a button named
   `Copy permanent link`. The URL is text, not an anchor. CopyField has its own status (`permanent link copied` /
   `Could not copy the permanent link`).
2. `Cite as`: the citation text in a `<p>`, then three buttons `Copy citation`, `Copy BibTeX` and `Copy CSL-JSON`
   (through `components/ui/useCopy`). For two seconds after a successful copy, the pressed button's text, and so its
   accessible name, reads `Citation copied`, `BibTeX copied` or `CSL-JSON copied`. One visually hidden `role="status"`
   reads `Citation copied` after any of the three, or `Could not copy the citation` when the clipboard refuses.
3. `Digest`, only when `digest` is a non-empty string: a `CopyField` with the value in `<code>` and the button
   `Copy digest`, with its own status (`digest copied` / `Could not copy the digest`).

BibTeX and CSL-JSON are copied, not rendered and not downloaded: the panel has no Download buttons.

### 3.3 Formats (`buildPanelCitation`)

| Format | Content |
|---|---|
| Text | `<author or OpenBinding> (<year or n.d.>). <title>[ (version <v>)]. OpenBinding <kindLabel>.` The URL is not part of the text. |
| BibTeX | `@misc{<key>,` then `title`, `author` (`OpenBinding` without one), `year` (if any), `version` (if any), `howpublished = {OpenBinding <kindLabel>}` and `url`, names padded to 12 characters (`  title        = {…}`), joined by `,\n`, closed by `\n}`. Title, author, version and kind are escaped by `escapeBibtex`: `\` → `\textbackslash{}`, `^` → `\textasciicircum{}`, `~` → `\textasciitilde{}`, and `{ } & % $ # _` get a backslash. The URL is not escaped. |
| CSL-JSON | `JSON.stringify([item], null, 2)` with `item` = `id` (the key), `type` (`cslType`, default `dataset`), `title`, `author` (`[{ literal }]`, `OpenBinding` without one), `publisher: 'OpenBinding'`, `genre` (the kind label), `URL`, then `issued` (`date-parts`, only with a year) and `version` (only with a version). |

Cite key: the author lower-cased with every character outside `[a-z0-9]` removed (`openbinding` when none is left or
there is no author), then the year if any, then the first word of the lower-cased title after removing characters
outside `[a-z0-9 ]` (`record` when none). `BASE` gives `isagroup2026travel`. No format carries the digest: the panel
shows it once, in its own field.

### 3.4 Keeping the digest single, as built

The digest appears in the panel only in the `Digest` field, because none of the three citation formats includes it.
The panel does not check the shape of `digest` (any non-empty string is shown), and it does not inspect `url`,
`title` or `author` for identifiers. A caller that passes a `/resolve/<kind>/<digest>` URL, or an id as a title,
puts that identifier on screen. Hence the second change must pass slug or id links and names (§8, question 1).

### 3.5 Stylesheet

`CitationPanel.css` uses tokens and no hexadecimal colour (`var(--tp-spacing-md, 1rem)`,
`var(--color-text-secondary)`), with literal `rem` sizes for type and gaps. The citation text has
`overflow-wrap: anywhere`. The link and the digest wrap through the shared `CopyField.css`
(`.ui-copy-field code { overflow-wrap: anywhere }`), which this change does not edit. The test checks only the
absence of hexadecimal colours.

## 4. VerifyResult

### 4.1 Props and exports

```ts
interface VerifyResultVerdict {
  status: VerifierStatus;            // 'verified' | 'computed' | 'mismatch' | 'not_found' (api/platform)
  digest: string;                    // the fingerprint the server worked with
  detail?: string | null;
  entities?: VerifierEntity[];       // what the fingerprint resolves to (api/platform)
}
interface VerifyResultProps {
  verdict: VerifyResultVerdict;
  computed?: string | null;          // the fingerprint the browser computed from a document or file
  given?: string | null;             // the fingerprint the person typed
  kindLabels?: Record<string, string>;                                // entity_type → reader's word
  hrefOf?: (entity: VerifierEntity) => string | null | undefined;    // plain link address
  renderLink?: (entity: VerifierEntity, label: string) => ReactNode; // a router link; wins over hrefOf
  citation?: ReactNode;              // slot for the host's citation panel
}
```

`index.ts` exports `VerifyResult`, `VerifyResultProps`, `VerifyResultVerdict`, `VERDICTS` and `entityName`.
`verifyModel.ts` also holds `sidesOf`, `disagrees` and `kindLabelOf`. The component renders. It does not fetch,
compute or compare: the page maps the gateway's verifier answer (`VerifierVerdict`) onto the props.

The test fixtures are:
- `D1` = `sha256-` + `a1` × 32;
- `D2` = `sha256-` + `b2` × 32;
- `ID` = `3f2b8c1e-0000-4000-8000-123456789abc`;
- `entity(extra)` = `{ entity_type: 'study_run', id: ID, title_or_name: 'Travel run', ...extra }`.

### 4.2 Regions and wording

The root is a `<div class="verify-result">` holding, in order, these parts:

1. **Verdict**: a `<section aria-label="Verdict" aria-live="polite">` with a glyph (`aria-hidden="true"`, a lucide
   icon per status), the title in `<strong>`, the text in `<span>` and, when given, `detail` in `<small>`. The tone
   class is `is-ok`, `is-info`, `is-bad` or `is-plain`. The meaning is in the words, never only in the colour
   (constitution 11.1).

   | `status` | Title | Text |
   |---|---|---|
   | `verified` | `Verified` | `The fingerprint is what OpenBinding recorded.` |
   | `computed` | `Computed, not on record` | `We computed its fingerprint, but OpenBinding hasn’t recorded anything with it. That’s normal for drafts or local files.` |
   | `mismatch` | `Doesn’t match` | `The content you gave hashes differently from the fingerprint you expected. It was changed somewhere along the way.` |
   | `not_found` | `Nothing found` | `OpenBinding has no element recorded with this fingerprint that you can see. Someone else’s private item reads exactly like one that was never registered, so this doesn’t say which it is.` |

2. **Disagreement**: when `computed` is given, `status` is not `mismatch` and `computed` differs from
   `verdict.digest`, a warning `Notice` (role `status`) titled `Your browser and the server disagree`: "They computed
   different fingerprints for the same input. Don’t rely on either until that is explained."

3. **Two sides** (`sidesOf`):

   | Side | When | Label | Value |
   |---|---|---|---|
   | left | `computed` given | `Computed in your browser` | `computed` |
   | left | otherwise | `Fingerprint you gave` | `given`, else `verdict.digest` |
   | right | `status` is `mismatch` | `Fingerprint you expected` | `verdict.digest` |
   | right | otherwise | `Recorded by OpenBinding` | `verdict.digest` when `entities` is non-empty, else none |

   A side with a value shows a `CopyField` whose button is named `Copy <label in lower case>` (`Copy recorded by
   openbinding`, `Copy fingerprint you gave`, …), with its own status `<label in lower case> copied` / `Could not
   copy the <label in lower case>`. A side without a value reads `nothing recorded` and has no button. So the
   result shows at most two fingerprint values, one per side, and as many copy buttons. Values are shown as given;
   their shape is not checked.

4. **Matches**: when `entities` is non-empty, a `<section>` labelled by its `<h2>` `Matches`, with one item per
   entity: a `Chip` with the kind (`kindLabels[entity_type]`, or `entity_type` with `_` read as a space), then the
   name (`title_or_name` trimmed, else `slug` trimmed, else `unnamed element`) as `renderLink(entity, name)`, else an
   `<a href>` from `hrefOf`, else `<strong>`. `organization_slug / project_slug` follows in `<small>` when both are
   present. The entity `id` is never rendered.

5. **Citation**: the `citation` node, as given.

The wording keeps "fingerprint", the word of today's `pages/Reports/Verifier.tsx`, so the page reads the same when it
switches to the component (open question 4).

### 4.3 Stylesheet

`VerifyResult.css` uses tokens and no hexadecimal colour: the tones use `var(--color-success)` and
`var(--color-error)`, and labels use `var(--color-text-secondary)`. The sides sit in a grid of
`minmax(16rem, 1fr)` columns. The values wrap through the shared `CopyField.css` (`overflow-wrap: anywhere`). The
test checks only the absence of hexadecimal colours.

## 5. Digest hygiene test

Everything in this section is in `frontend/src/test/digestHygiene.test.ts`; nothing is exported from it.

### 5.1 Scanned set

- `.ts`, `.tsx` and `.css` files under `frontend/src`. The `.ts` and `.tsx` files come through
  `import.meta.glob(['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.*'], { query: '?raw', eager: true })`. The stylesheets
  are read from disk with `readdirSync`, because Vitest hands a `?raw` stylesheet over empty.
- Without `*.test.*`, `/src/test/setup.ts`, `testKit.ts(x)` and `testUtils.ts(x)` / `TestUtils.ts(x)`.
- Paths are the Vite keys, `/src/...`.

The test asserts that more than 100 files are read, and more than 50 are checked (outside the allowed set and the
pending list).

### 5.2 Allowed set

One regular expression, unanchored at the start:
`/\/src\/(components\/CitationPanel\/|components\/VerifyResult\/|components\/rendering\/(SourceView|LogPanel)|utils\/(digest|uuid|canonicalDigest|citation)|api\/|test\/)|[Ff]ixtures?\.ts$/`.

| Path | Why |
|---|---|
| `/src/components/CitationPanel/`, `/src/components/VerifyResult/` | the one copyable digest, and one per side (§5.4 of ARCHITECTURE) |
| `/src/components/rendering/SourceView…`, `/src/components/rendering/LogPanel…` (prefix) | files and logs as they are |
| `/src/utils/digest…`, `/src/utils/uuid…`, `/src/utils/canonicalDigest…` (prefix) | the digest and UUID utilities, including `shortDigest` and `digestPrefix` |
| `/src/utils/citation…` (prefix) | today's citation helper, which writes the digest into its citation text for the pages that the second change moves onto `CitationPanel`; the test treats it as a digest utility, not as a pending file (open question 2) |
| `/src/api/` | the API layer keeps every digest |
| `/src/test/` | test support |
| a file name ending in `fixture.ts`, `fixtures.ts`, `Fixture.ts` or `Fixtures.ts` | fixtures, imported only by tests (`pages/Cases/fixtures.ts`, `pages/Pricing/pricingFixture.ts`, `pages/Project/packageFixture.ts`); `.tsx` fixtures and `fixtures/` directories are not covered |

### 5.3 Detectors

The test greps each line of each checked file (comment lines included; there is no comment skipping) with three
patterns. A finding is reported as `<path>:<line>  <trimmed line>`.

| Detector | Pattern |
|---|---|
| digest literal | `sha256-` followed by 8 or more hexadecimal characters, or a run of exactly 40 or exactly 64 hexadecimal characters not touching another hexadecimal character: `/sha256-[0-9a-fA-F]{8,}\|(?<![0-9a-fA-F])(?:[0-9a-fA-F]{40}\|[0-9a-fA-F]{64})(?![0-9a-fA-F])/` |
| UUID | `8-4-4-4-12` hexadecimal, any case, not touching another hexadecimal character |
| helper | `\b(?:shortDigest\|digestPrefix)\b`: imports, aliases, re-exports and calls, whole words only |

The detector tests pin: a full digest, a bare 64-hex run, a 40-hex git SHA and a UUID are caught; an ordinary word, a
12-hex string, the prose `sha256- followed by` and a 65-hex run are not; `digestPrefixes` is not a helper.

Known limits, as built:
- `sha256-` followed by fewer than 8 hexadecimal characters is not caught: `sha256-…`, `sha256-${…}` and today's
  short form `sha256-e5f6…0718`;
- a 40- or 64-hex run glued to letters outside `a-f` (`x_<hex>`) is caught; one glued to more hexadecimal
  characters is not;
- a comment line is read as code, so a digest written in a comment fails the suite;
- an identifier that reaches the screen from data at runtime is not caught (ui-qa covers that in the second change);
- a file on the pending list is not checked at all, so a new offence inside a pending file is not caught.

### 5.4 Pending list semantics

`PENDING_CLEANUP` (a `readonly string[]` of `/src/...` paths) holds the pages and components that still offend.
Pending files are left out of the check as a whole. The test asserts:
- the list is sorted and has no duplicates;
- every entry is a key of the scanned glob, so a path that no longer exists fails the suite and must be removed;
- no entry matches the allowed set.

The test does not assert a ceiling (there is no `MAX_PENDING_FILES`), an exact list or a count, and an entry that no
longer offends does not fail the suite, because parallel changes may clean some files. "Entries are only removed,
never added" is the rule written in the test's header comment, and review enforces it.

### 5.5 The pending list as built

40 files, grouped as in the test (paths under `frontend/src`):

| # | File | | # | File |
|---|---|---|---|---|
| 1 | `components/Artifacts/ArtifactVersionPicker.tsx` | | 21 | `pages/Pricing/Pricing.tsx` |
| 2 | `pages/Account/AccountKeyNew.tsx` | | 22 | `pages/Profiles/Profiles.tsx` |
| 3 | `pages/Account/keysModel.ts` | | 23 | `pages/Project/ProjectOverview.tsx` |
| 4 | `pages/Admin/AdminEngineReview.tsx` | | 24 | `pages/Project/ProjectPackage.tsx` |
| 5 | `pages/Admin/AdminUserDetail.tsx` | | 25 | `pages/Project/packageModel.ts` |
| 6 | `pages/Cases/CaseDetail.tsx` | | 26 | `pages/Public/PublicPages.tsx` |
| 7 | `pages/Cases/CaseList.tsx` | | 27 | `pages/Public/exploreModel.ts` |
| 8 | `pages/Cases/CaseRevision.tsx` | | 28 | `pages/RegisterEngine/DeploymentForm.tsx` |
| 9 | `pages/Cases/SnapshotDetail.tsx` | | 29 | `pages/RegisterEngine/RegisterEngine.tsx` |
| 10 | `pages/Cases/casesModel.ts` | | 30 | `pages/Reports/ProjPublications.tsx` |
| 11 | `pages/EngineDetail/EngineDetail.tsx` | | 31 | `pages/Resolve/Resolve.tsx` |
| 12 | `pages/Engines/EngRegistrationDetail.tsx` | | 32 | `pages/Resources/CollDetail.tsx` |
| 13 | `pages/Engines/EngRegistrations.tsx` | | 33 | `pages/Resources/ProjFiles.tsx` |
| 14 | `pages/Engines/Engines.tsx` | | 34 | `pages/Resources/collectionModel.ts` |
| 15 | `pages/Engines/LangExtensions.tsx` | | 35 | `pages/Resources/resourceModel.ts` |
| 16 | `pages/Engines/MyDeployments.tsx` | | 36 | `pages/Studies/BuilderFields.tsx` |
| 17 | `pages/Engines/enginesModel.ts` | | 37 | `pages/Studies/StudyAnalytics.tsx` |
| 18 | `pages/Generator/LabAside.tsx` | | 38 | `pages/Studies/StudyRun.tsx` |
| 19 | `pages/Jobs/JobFacts.tsx` | | 39 | `pages/Workbench/CheckResult.tsx` |
| 20 | `pages/Jobs/launchModel.ts` | | 40 | `pages/Workbench/WorkbenchResult.tsx` |

Files that the first draft of this design listed and the test does not:
- `pages/Reports/Verifier.tsx`, `pages/Admin/AdminModeration.tsx`, `pages/Examples/Examples.tsx` and
  `pages/Workbench/resourceForms.tsx`. Their only digest-like text is `sha256-` followed by `…`, a space or a template
  `${…}` (a message, a placeholder, a computed value). The digest-literal detector needs eight hexadecimal characters
  after `sha256-`, and none of them names a helper, so they pass unlisted.
- `utils/citation.ts`, which is in the allowed set (§5.2).

## 6. Requirements, tests and tags

| Requirement | Tests (`[utest->…]`) | Code (`[impl->…]`) |
|---|---|---|
| `identity-labels` | `shared/lib/identity.test.ts`, every case | `shared/lib/identity.ts` (file header) |
| `citation-panel` | `components/CitationPanel/CitationPanel.test.tsx`, every case (the component and `buildPanelCitation`) | `CitationPanel.tsx` (`CitationPanel`), `citationModel.ts` (`buildPanelCitation`) |
| `verify-result` | `components/VerifyResult/VerifyResult.test.tsx`, every case | `VerifyResult.tsx` (`VerifyResult`) |
| `digest-hygiene` | `test/digestHygiene.test.ts` (file header) | none: no `[impl->req~digest-hygiene~1]` tag exists. The detectors and the pending list live in the test file, as in M2.2 |

The requirement keeps `Needs: impl, utest`. The missing `impl` tag for `digest-hygiene` is reported to the
coordinator: the trace (G6) shows it as uncovered until a code task adds the tag or the requirement's `Needs` is
changed. Stylesheet scenarios read the CSS as raw text from disk (the M2.1 "tokens only" pattern).

## 7. Risks

- **Merge order with M2.6.** M2.6 is rebuilding the Verify page (`pages/Resolve/Resolve.tsx` is pending entry 31;
  `pages/Reports/Verifier.tsx` passes unlisted).
  - If M2.6 deletes or renames a listed file, the "names a file that exists" assertion fails until the entry is
    removed or follows the rename.
  - If M2.6 adds a file with a helper call or a digest literal, that file fails the suite. Adding it to the list is
    not this change's call: the lead asks the coordinator.
  - If this change merges first, M2.6 must keep the test green.
- **Weak spots of the detector** (§5.3): short forms, runtime data and new offences inside pending files are not
  caught; there is no ceiling assertion. The second change empties the list and adds ui-qa screenshots (G12) and DOM
  assertions per screen.
- **Unguarded inputs.** `CitationPanel` shows `url`, `title`, `author` and `digest` as given, and `VerifyResult` shows
  side values and entity names as given. A caller can still put an identifier on screen; the second change passes
  slug links and names.
- **No mounted screen.** ui-qa reviews the components' DOM, focus order and stylesheets from tests and code.
  Screenshots at 1440×900 and 390×844 wait for the second change.

## 8. Open questions and follow-ups for the second change

1. Coordinator: permanent links. ARCHITECTURE §5.4 says "URLs use permanent ids or slugs", but every link today is
   `/resolve/<kind>/<digest>`. The first draft made `CitationPanel` refuse such a link (`This item has no permanent link
   yet`); that is not built. The second change needs slug or id links for problem versions, collection versions and
   published results (possibly a gateway route, so a CRP), or the panel gains the refusal in a `~2` revision.
2. Coordinator: whether `shortDigest`/`digestPrefix` and `utils/citation.ts` survive the second change, or are
   deleted. The allowed set and the helper detector then follow.
3. Coordinator: whether the rest of the UI moves from `Aug 20, 2026` (`utils/format.ts`) to the §5.4 form
   `20 Aug 2026`, so one screen does not show both forms.
4. Coordinator: `VerifyResult` says "fingerprint" while the glossary term is "digest" (INTENT §5). Rewording is a
   change of the component's text and of its scenarios.
5. Not built, drafted earlier, candidates for the second change:
   - `CitationPanel`: Download BibTeX and CSL-JSON buttons through `saveText`; the URL in the citation text; the
     digest in the BibTeX and CSL-JSON `note`; a fixed `kind` and an author list; the heading `Cite this <kind>` with
     a configurable level; showing `No digest recorded` for a value that is not a full digest; treating an
     identifier-shaped title or author as missing; refusing a digest-bearing link (question 1); a cite key with
     accent folding (`López` → `lopez`; today `lpez`).
   - `VerifyResult`: a region named `Verification result`, a `resolvesTo` identity label, `against: 'expected'`, a
     full-digest check per side (`Not computed`), a guard on identifier-shaped entity names, and copy outcomes in one
     shared status region.
   - Hygiene: comment skipping, a `MAX_PENDING_FILES` ceiling and an exact-list assertion, a stale-entry check, and
     exported `findDigestText` / `unlistedFindings` / `stalePendingFiles` helpers with fix-it messages.
   - An `[impl->req~digest-hygiene~1]` tag (§6).

## 9. Rollback

Reverting the PR removes the new files and the `.gitignore` exception. No screen uses them, so nothing else changes.
No data, API or stored state is touched.
