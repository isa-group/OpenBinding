# Design: m27-names-not-digests

Status: specified, not built. Fixed inputs:
- ROADMAP M2.7;
- INTENT principle 13;
- constitution 15.5 and 11.1;
- ARCHITECTURE §5.1 (`shared/lib` holds "the identity labels of §5.4"), §5.3 (the `CitationPanel` and `VerifyResult`
  rows) and §5.4;
- the coordinator's split of M2.7 into this change and a second, call-site change after M2.6 merges.

The base commit for every count below is `1c31b9d4`.

## 1. Scope and ownership

| In this change | Owner afterwards |
|---|---|
| `frontend/src/shared/lib/identity.ts` (new) | screens, through the second M2.7 change |
| `containsIdentifier` in `frontend/src/utils/digest.ts` (one new export) | the three modules below |
| `frontend/src/components/CitationPanel/**` (new) | problem, collection and published-result pages (second change) |
| `frontend/src/components/VerifyResult/**` (new) | the Verify page (M2.6 builds the page; the second change mounts the component) |
| `frontend/src/test/digestHygiene.test.ts` (new) | every change; the second change empties its pending list |

Nothing here edits a page, `shortDigest`, `digestPrefix`, `utils/citation.ts`, `rawRenderingAllowList.ts` or
`rawRenderingHygiene.test.ts`. The new components contain no `<pre>` and render no `JSON.stringify` output, so the
raw-rendering hygiene test needs no entry for them.

Placement: the coordinator fixed the component paths at `components/CitationPanel` and `components/VerifyResult`, not
`components/rendering/**`. The two are the only components allowed to show a digest, and a directory of their own
lets the hygiene test exempt them by path prefix.

## 2. Identity labels

### 2.1 Functions

All six are pure. They read no clock, no locale and no time zone, and each returns a non-empty string.

| Function | Input | Full label |
|---|---|---|
| `problemVersionLabel` | `{ name?, version?, sealedAt? }` | `checkout-flow v3 · sealed 20 Aug 2026` |
| `collectionVersionLabel` | `{ name?, version?, problemCount? }` | `QACOBench icws v2 · 12 problems` |
| `runLabel` | `{ number?, problem?: { name?, version? }, engine?: { name?, version?, mode? }, createdAt? }` | `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026` |
| `studyRunLabel` | `{ study?, number?, createdAt? }` | `engines-vs-suite run 3 · 21 Oct 2026` |
| `publishedResultLabel` | `{ title?, publishedAt? }` | `Engines versus the ICWS suite · published 22 Oct 2026` |
| `engineLabel` | `{ name?, version?, mode? }` | `minizinc-csp 1.1.1 · mode exact` |

Every field is optional and may be `null`. The inputs have no id, digest or fingerprint field, so a caller cannot
pass one by name. §2.3 covers a value that is shaped like one.

Considered: returning parts (`{ name, version, date }`) so that pages could put the name in `<code>`. Rejected: the
labels are plain text in cards, headers and options. One string keeps call sites trivial, and a later revision can
add a parts variant. The backticks in ARCHITECTURE §5.4 are Markdown, not output.

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

A field is missing when it is any of these:
- `undefined` or `null`;
- a string that is empty after trimming;
- a version or a run or study-run number that is not a positive integer;
- a problem count that is not a non-negative integer;
- a date that `Date` cannot parse;
- a text with an identifier in it (§2.3).

Strings are trimmed. Engine versions and modes are strings shown as given (`1.0.0+builtin.a`). Counts use en-US
grouping (`1,200 problems`). Version and run numbers use none (`run 1014`).

### 2.3 Identifier-shaped values

A text field whose value contains `sha256-` (any case), a run of exactly 40 or exactly 64 hexadecimal characters not
touching `[0-9A-Za-z_]`, or a UUID (`8-4-4-4-12` hexadecimal, any case) counts as missing, as a whole. This covers:
- API fallbacks that put an id where a name should be (`title_or_name ?? id`);
- today's short forms (`sha256-e5f6…0718` contains `sha256-`);
- git SHAs (40 hex).

### 2.4 The shared predicate

`containsIdentifier(text: string): boolean` is added to `frontend/src/utils/digest.ts`, next to `DIGEST_PATTERN`. The
patterns live there because `utils/digest.ts` is an allowed path of the hygiene test (§5.2), while
`shared/lib/identity.ts` is not and must pass the detector. If identity.ts held the patterns, it would be a finding.
Building the pattern from pieces (`'sha' + '256-'`) to slip past the detector is not acceptable.

`CitationPanel` and `VerifyResult` use the same predicate (§3.4, §4.3). The hygiene detector (§5.3) keeps its own
line-based patterns. The B and D tests both run the sample table of §2.5, so the two definitions agree.

### 2.5 Dates and the sample table

Dates are formatted in UTC as `<day> <Mon> <year>`. The day has no leading zero, and the month comes from the fixed
table `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`. `Intl` `en-GB` is not used, because current ICU data writes
September as `Sept`. The existing `utils/format.ts` `formatDate` (`Aug 20, 2026`) is not changed. Its callers stay
as they are, and the second change decides whether the rest of the UI follows the §5.4 form (open question 3).

Sample table for the exhaustive scenario. Each field is drawn from these seven values:
1. a valid value;
2. missing (`undefined`);
3. `sha256-` + 64 × `a`;
4. `sha256-e5f6…0718`;
5. 40 × `e`;
6. 64 × `0`;
7. `3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f`.

These seven values are for text fields. Numeric fields take the valid value, missing, `0` and `-1`, and date fields
take a valid ISO date, missing and `'soon'`. The test enumerates every combination. `runLabel` is the largest, with
four text, two numeric and one date field: 7⁴ × 4² × 3 = 115,248 calls of a pure function, well within a unit test.

## 3. CitationPanel

### 3.1 Props

```ts
type CitationKind = 'problem version' | 'collection version' | 'published result';
interface CitationPanelProps {
  kind: CitationKind;
  title: string;
  /** Display names, in order. */
  authors?: string[];
  year?: number | null;
  /** Problem and collection versions. */
  version?: number | null;
  /** A permanent link built from permanent ids or slugs (ARCHITECTURE §5.4). */
  permanentUrl: string;
  /** The one digest: `sha256-` + 64 hexadecimal characters. */
  digest: string;
  headingLevel?: 2 | 3 | 4; // default 2
}
```

The spec fixtures are:
- `D`: `sha256-` followed by `e5f6` sixteen times;
- `CITE`: `{ kind: 'problem version', title: 'checkout-flow', version: 3, authors: ['F. J. Cavero López', 'A. Ruiz-Cortés'], year: 2026, permanentUrl: 'https://openbinding.example/isa/qos/problems/checkout-flow/v3', digest: D }`.

### 3.2 Layout

The panel is a `<section>` named by its heading `Cite this <kind>`. It has four rows, then a status region:

1. `Permanent link`: the URL as a link (its name and `href` are the URL) and `Copy permanent link`.
2. `Cite as`: the citation text and `Copy citation`.
3. `Reference manager`: `Copy BibTeX`, `Download BibTeX`, `Copy CSL-JSON` and `Download CSL-JSON`. BibTeX and CSL-JSON
   are not rendered as text. That keeps the panel light, and the digest in their `note` is not shown a second time.
4. `Digest`: the full digest in `<code>` and `Copy digest`. This is the only copy button whose name contains `digest`.
5. One status region (`role="status"`) for all copies. It reads `<thing> copied`, or `Could not copy the <thing>` when
   the clipboard refuses. The things are `Permanent link`, `Citation`, `BibTeX`, `CSL-JSON` and `Digest`. Copies go
   through `components/ui/useCopy`, and downloads through `components/rendering/download.ts` `saveText`.

The digest is shown in full. A shortened form would bring `shortDigest` back, and a digest is copied or compared,
not read. The CSS breaks it with `overflow-wrap: anywhere` so it fits 390 px, and the stylesheet uses design tokens
only.

### 3.3 Formats

Cite key: the last word of the first author, then the year (if any), then the first word of the title.
- Each part is folded with NFD, lower case and only `[a-z0-9]` kept.
- No author gives `openbinding`, and no usable title gives `untitled`.
- `CITE` gives `lopez2026checkoutflow`.
- The key never contains the digest. The key in `utils/citation.ts` carries 8 hexadecimal characters and is not
  reused.

| Format | Content |
|---|---|
| Text | `<authors joined by ", " or OpenBinding> (<year or n.d.>). <title>[ (version <v>)]. OpenBinding <kind>. <permanentUrl>` |
| BibTeX | `@misc{<key>,` then `title`, `author` (names joined by ` and `, or `OpenBinding`), `year` (if any), `version` (if any), `howpublished = {OpenBinding <kind>}`, `url`, `note = {SHA-256 digest <digest>}` (only with a full digest), aligned as in the spec scenario. The values are escaped with the existing BibTeX rules (`\ { } & % $ # _ ^ ~`). Saved as `<key>.bib`, `application/x-bibtex` |
| CSL-JSON | `JSON.stringify([item], null, 2)`. `item` holds `id` (key), `type: 'dataset'`, `title`, `author` (`[{ literal }]`, omitted without authors), `issued` (`date-parts`, omitted without a year), `version` (string, if any), `genre` (the kind), `publisher: 'OpenBinding'`, `URL` and `note` (only with a full digest). Saved as `<key>.csl.json`, `application/vnd.citationstyles.csl+json` |

The formats come from a pure module `components/CitationPanel/citationFormats.ts`, tested on its own. It lives
inside the exempt directory because it writes the digest into `note`.

### 3.4 Keeping the digest single

The panel's text content contains the full digest exactly once and no other identifier-shaped text:
- a `digest` that is not a full digest (`DIGEST_PATTERN`) shows `No digest recorded`, with no copy button and no
  `note`;
- a title or an author for which `containsIdentifier` is true is treated as missing. The title becomes
  `Untitled <kind>` and the author drops out of the list;
- a `permanentUrl` for which `containsIdentifier` is true (today's `/resolve/<kind>/<digest>`) is not a permanent link
  in the sense of §5.4. The panel shows the notice `This item has no permanent link yet` instead of the link, the
  citation text and the reference-manager actions, and keeps the digest row.

Considered:
- showing the digest-bearing URL anyway, which puts the digest on screen twice;
- masking the URL in the visible text only, so that the shown citation and the copied one differ.

Both rejected. The cost of the chosen rule is that no page can mount the panel until it has a slug or id link
(open question 1).

## 4. VerifyResult

### 4.1 Props

```ts
type VerifyInput = 'link' | 'digest' | 'file';
type VerifyVerdict = 'verified' | 'computed' | 'mismatch' | 'not_found';
interface VerifyResultProps {
  input: VerifyInput;
  verdict: VerifyVerdict;
  /** What the input resolves to, as an identity label (§2), with a link when the viewer may open it. */
  resolvesTo: { label: string; href?: string } | null;
  /** The input's digest: the one given, or the one computed from the file or the linked content. */
  inputDigest: string | null;
  /** The other side: the digest OpenBinding recorded, or the one the person expected. */
  otherDigest: string | null;
  /** Default `recorded`. */
  against?: 'recorded' | 'expected';
}
```

The spec fixtures are:
- `D1` and `D2`: two different full digests;
- `PV`: `{ label: 'checkout-flow v3 · sealed 20 Aug 2026', href: '/app/isa/qos/problems/checkout-flow/v3' }`.

The component renders. It does not fetch, compute or compare. The page (M2.6, then the second change) maps the
gateway's verifier and resolver answers onto these props, and `verdict` is the gateway's word.

### 4.2 Labels and wording

| `verdict` | Title | Text |
|---|---|---|
| `verified` | `Verified` | `The digest matches what OpenBinding recorded.` |
| `computed` | `Computed, not on record` | `The digest was computed, but OpenBinding has no record with it.` |
| `mismatch` | `Doesn’t match` | `The two digests differ: the content was changed.` |
| `not_found` | `Nothing found` | `OpenBinding has no record with this digest that you can see.` |

The four statuses come from today's `pages/Reports/Verifier.tsx`. The words "fingerprint" become "digest", the
glossary term (INTENT §5). The title and text sit in a `role="status"` element. The glyph is `aria-hidden="true"`,
and tone classes use tokens only, so meaning never rests on colour (constitution 11.1).

| Side | Label | Copy button | Without a full digest |
|---|---|---|---|
| input, `digest` | `Digest you gave` | `Copy your digest` | `Not computed` |
| input, `file` | `Computed from your file` | `Copy your digest` | `Not computed` |
| input, `link` | `Computed from the linked content` | `Copy your digest` | `Not computed` |
| other, `recorded` | `Recorded by OpenBinding` | `Copy the recorded digest` | `Nothing recorded` |
| other, `expected` | `Digest you expected` | `Copy the expected digest` | `Nothing recorded` |

`Resolves to <label>`, a link when `href` is given, or `Resolves to nothing on record` when `resolvesTo` is `null`.
Copy outcomes go to one status region: `Your digest copied` / `Could not copy your digest`, and
`Recorded digest copied` / `Expected digest copied` / `Could not copy the recorded digest` / `Could not copy the
expected digest`.

### 4.3 Keeping the digests to one per side

A side shows its value only when it is a full digest (`DIGEST_PATTERN`). Anything else shows the "without" text of
§4.2, which covers a short form like `sha256-e5f6…0718`. A `resolvesTo.label` for which `containsIdentifier` is true
reads `Resolves to a record`, and keeps its `href`. The region therefore holds at most two digest values, one per
side, and no other identifier-shaped text. The digest `<code>` uses `overflow-wrap: anywhere`.

Not here: the matches list, the citation card and the normalised-document source of today's Verifier. They stay on
the page. The page can render `CitationPanel` beside `VerifyResult` once it has a permanent link.

## 5. Digest hygiene test

### 5.1 Scanned set

The scan uses the same collection as `rawRenderingHygiene.test.ts`:
- every `.ts` and `.tsx` under `frontend/src`, through `import.meta.glob(..., { query: '?raw' })`;
- without `*.test.*`, `src/test/**` and test kits (`[Tt]estKit.tsx?`, `[Tt]estUtils.tsx?`).

Paths are relative to `frontend/src`.

### 5.2 Allowed paths

| Path | Why |
|---|---|
| `components/CitationPanel/` (prefix, with the slash) | the one copyable digest (§5.4) |
| `components/VerifyResult/` | one digest per side (§5.4) |
| `components/rendering/SourceView.tsx`, `components/rendering/LogPanel.tsx` | files and logs as they are (§5.4) |
| `utils/digest.ts`, `utils/uuid.ts`, `utils/canonicalDigest.ts` | the digest and UUID utilities |
| `api/` | the API layer keeps every digest |
| a path with a `fixtures/` segment, or a file name ending in `fixture.ts(x)`, `Fixture.ts(x)`, `fixtures.ts(x)` or `Fixtures.ts(x)` | fixtures. At `1c31b9d4` they are imported only by tests: `pages/Cases/fixtures.ts`, `pages/Pricing/pricingFixture.ts`, `pages/Project/packageFixture.ts` |

`utils/citation.ts` is not a digest utility. It writes the digest into the citation text, so it is pending.

### 5.3 Detector

The detector is line based, like `findRawRendering`, and exported from the test file as `findDigestText(text)`. It
skips comment lines: a trimmed line that starts with `//`, `/*` or `*`, or that is wholly `{/* … */}`. Each remaining
line gives at most one finding, of the first kind that matches, in this order:

| Kind | Pattern (case-insensitive) |
|---|---|
| `digest` | `sha256-` |
| `uuid` | `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` |
| `hex` | `(?<![0-9A-Za-z_])([0-9a-f]{64}\|[0-9a-f]{40})(?![0-9A-Za-z_])` |
| `helper` | `\b(shortDigest\|digestPrefix)\b` |

`helper` matches any non-comment line that names either function: import specifiers on their own lines, `as` aliases,
re-exports and calls. That is a superset of "imports". Per-line detection needs no import parser, and the pending
check works per file either way.

Known limits, pinned by tests named `known limit: …`:
- a trailing comment on a code line is read as code (reported);
- a block comment whose inner lines do not start with `*` is read as code (reported);
- a digest assembled from pieces is not reported;
- an identifier that reaches the screen from data at runtime is not reported. ui-qa (G12) covers that in the second
  change.

### 5.4 Checks and messages

- `unlistedFindings(sources, pending)` returns one line per finding in a file that is neither allowed nor pending:
  `<file>:<line>  <trimmed text>  — show a name (shared/lib/identity.ts), or the digest in CitationPanel or VerifyResult, instead of adding the file to the pending list`.
- `stalePendingFiles(sources, pending)` returns one line per pending file with no finding, including a file that is no
  longer in the sources:
  `<file>  — no digest-shaped text or digest helper left: remove it from the pending list`.
- `PENDING_FILES` (a sorted `readonly string[]`) and `MAX_PENDING_FILES = 45` are exported from the test file. The
  coordinator asked for the list to live in the test, so there is no second module. The assertions:
  - `PENDING_FILES.length <= MAX_PENDING_FILES`;
  - no duplicates;
  - no allowed path;
  - the list equals the 45 paths below, an exact-list assertion that the second change rewrites as it removes
    entries.

### 5.5 The pending list at `1c31b9d4`

Each file is marked with the reason it is listed: H (names `shortDigest`/`digestPrefix`) or T (digest-shaped text or
a UUID only).

| # | File (under `frontend/src`) | | # | File | |
|---|---|---|---|---|---|
| 1 | `components/Artifacts/ArtifactVersionPicker.tsx` | H | 24 | `pages/Profiles/Profiles.tsx` | H |
| 2 | `pages/Account/AccountKeyNew.tsx` | H | 25 | `pages/Project/ProjectOverview.tsx` | H |
| 3 | `pages/Account/keysModel.ts` | H | 26 | `pages/Project/ProjectPackage.tsx` | H |
| 4 | `pages/Admin/AdminEngineReview.tsx` | H | 27 | `pages/Project/packageModel.ts` | H |
| 5 | `pages/Admin/AdminModeration.tsx` | T | 28 | `pages/Public/PublicPages.tsx` | H |
| 6 | `pages/Admin/AdminUserDetail.tsx` | T (UUID placeholder) | 29 | `pages/Public/exploreModel.ts` | H |
| 7 | `pages/Cases/CaseDetail.tsx` | H | 30 | `pages/RegisterEngine/DeploymentForm.tsx` | H, T |
| 8 | `pages/Cases/CaseList.tsx` | H | 31 | `pages/RegisterEngine/RegisterEngine.tsx` | H |
| 9 | `pages/Cases/CaseRevision.tsx` | H | 32 | `pages/Reports/ProjPublications.tsx` | H |
| 10 | `pages/Cases/SnapshotDetail.tsx` | H | 33 | `pages/Reports/Verifier.tsx` | T |
| 11 | `pages/Cases/casesModel.ts` | H | 34 | `pages/Resolve/Resolve.tsx` | H, T |
| 12 | `pages/EngineDetail/EngineDetail.tsx` | H | 35 | `pages/Resources/CollDetail.tsx` | H |
| 13 | `pages/Engines/EngRegistrationDetail.tsx` | H | 36 | `pages/Resources/ProjFiles.tsx` | H |
| 14 | `pages/Engines/EngRegistrations.tsx` | H | 37 | `pages/Resources/collectionModel.ts` | H |
| 15 | `pages/Engines/Engines.tsx` | H | 38 | `pages/Resources/resourceModel.ts` | H |
| 16 | `pages/Engines/LangExtensions.tsx` | H | 39 | `pages/Studies/BuilderFields.tsx` | H |
| 17 | `pages/Engines/MyDeployments.tsx` | H | 40 | `pages/Studies/StudyAnalytics.tsx` | H |
| 18 | `pages/Engines/enginesModel.ts` | H | 41 | `pages/Studies/StudyRun.tsx` | H |
| 19 | `pages/Examples/Examples.tsx` | T | 42 | `pages/Workbench/CheckResult.tsx` | H |
| 20 | `pages/Generator/LabAside.tsx` | H | 43 | `pages/Workbench/WorkbenchResult.tsx` | H |
| 21 | `pages/Jobs/JobFacts.tsx` | H | 44 | `pages/Workbench/resourceForms.tsx` | T |
| 22 | `pages/Jobs/launchModel.ts` | H | 45 | `utils/citation.ts` | H, T |
| 23 | `pages/Pricing/Pricing.tsx` | H | | | |

How the list was found: every file of §5.1 matched against the four patterns of §5.3, at `1c31b9d4`.
- 40 files name the helpers: every non-test importer of `utils/digest.ts`'s `shortDigest`/`digestPrefix`.
- 5 more files have only digest-shaped text or a UUID.
- Fixtures, test kits, tests and the allowed paths are left out.
- The comment-only mention in `pages/Jobs/launchModel.ts:151` is skipped. The file is listed for its import.

Group D re-derives the list on its base. If the base has moved, the list may only lose entries, or follow a rename
made by a merged change. A new offender in a merged change is not added here. It goes to the coordinator (§7).

## 6. Requirements, tests and tags

| Requirement | Tests | `[impl->…]` |
|---|---|---|
| `identity-labels` | `shared/lib/identity.test.ts` (new); `utils/digest.test.ts` (`containsIdentifier`, on the §2.5 table) | `shared/lib/identity.ts`, `utils/digest.ts` (`containsIdentifier`) |
| `citation-panel` | `components/CitationPanel/CitationPanel.test.tsx`, `components/CitationPanel/citationFormats.test.ts` (new) | `CitationPanel.tsx`, `citationFormats.ts` |
| `verify-result` | `components/VerifyResult/VerifyResult.test.tsx` (new) | `VerifyResult.tsx` |
| `digest-hygiene` | `test/digestHygiene.test.ts` (the detector and checks are in the test file, as in M2.2) | `test/digestHygiene.test.ts` (`PENDING_FILES`, `findDigestText`) |

Tests carry `[utest->req~<name>~1]`. CSS scenarios read the stylesheet as raw text (the M2.1 "tokens only" pattern).

## 7. Risks

- **Merge order with M2.6.** M2.6 is rebuilding the Verify page (`pages/Resolve/Resolve.tsx`, `pages/Reports/Verifier.tsx`,
  pending entries 33 and 34) and may move or delete those files.
  - If M2.6 merges first, group D rebases and follows the renames. Deleted files leave the list, which lowers
    `MAX_PENDING_FILES`.
  - If M2.6 adds a new file with a digest helper or digest text, that file is unlisted. Growing the ceiling is not
    this change's call: the lead asks the coordinator, and the options are that M2.6 drops it or that the
    coordinator accepts one more pending entry.
  - If this change merges first, M2.6 must keep the test green. That means no new helper call or digest text, and
    removing an entry when it deletes a listed file.
- **Static detection.** UUIDs and digests rendered from data are not caught. The second change adds ui-qa
  screenshots (G12) and DOM assertions per screen.
- **No mounted screen.** ui-qa reviews the components' DOM structure, focus order and stylesheet from tests and code.
  Screenshots at 1440×900 and 390×844 wait for the second change, which mounts the components.
- **A strict permanent-link rule** (§3.4). No page can show a citation until it has a slug or id link. Today every
  link is `/resolve/<kind>/<digest>`.
- **Size.** About 260 diff lines with tests for B, 290 for C1, 220 for C2 and 280 for D: four slices under the ~300
  line guideline (constitution 14.1).

## 8. Open questions

1. Coordinator: permanent links. ARCHITECTURE §5.4 says "URLs use permanent ids or slugs", but every link today is
   `/resolve/<kind>/<digest>`. This change makes `CitationPanel` refuse such a link (§3.4). The second change needs a
   slug or id permanent link for problem versions, collection versions and published results, which may need a
   gateway route and therefore a CRP. Alternatively the coordinator accepts the resolve URL, and §3.4 changes in a
   `~2` revision.
2. Coordinator: whether `shortDigest`/`digestPrefix` survive the second change, for export manifests and file names,
   or are deleted. The hygiene `helper` rule then follows.
3. Coordinator, for the second change: whether the rest of the UI moves from `Aug 20, 2026` (`utils/format.ts`) to the
   §5.4 form `20 Aug 2026`, so one screen does not show both forms.

## 9. Rollback

Reverting the PR removes the new files and `containsIdentifier`. No screen uses them, so nothing else changes. No
data, API or stored state is touched.
