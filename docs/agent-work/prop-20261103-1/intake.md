# Intake: P-20261103-1, neutralise spreadsheet formulas in the browser's CSV exports

- Kind: security, size S, owner-approved · Base: `task/3ff31895e8934d39` at `b8067258`
- INTENT objective: **O8, Security**. The proposal says the fix closes an open item before O8 is counted at R1. This
  intake did not check the O8 row of `INTENT.md` for that claim.
- Source: security-auditor followup `0f0f4b0e6f8946fe` (named in the proposal; not read here).

## 1. Objective

The two CSV files the browser builds must not run a formula when a researcher or an organization admin opens them in
Excel, LibreOffice or Sheets. These are the cells CSV of a study run and the organization audit CSV. The two private
escapers become one shared, pure `csvCell` helper. The helper quotes on `"`, `,`, `\r` and `\n`, and prefixes `'` to
any text value that starts with a formula trigger. Values of type number are left as they are.

## 2. Evidence checked against the code at `b8067258`

| # | Fact | Evidence |
|---|---|---|
| F1 | The study escaper `quote` quotes only on `"`, `,` and `\n`. It does nothing about a leading `=`, `+`, `-`, `@`, tab or CR, and a bare `\r` is not quoted | `frontend/src/pages/Studies/analyticsModel.ts:170-173` |
| F2 | `cellsCsv` passes every field through `quote`: the revision label, `engine_ref.name`, `engine_ref.version`, `mode`, `describeParameters(...)`, seed, state, metrics, `job_id` and `fingerprint` | `analyticsModel.ts:176-187` (fields at `:182-183`, `.map(quote)` at `:184`) |
| F3 | **The revision label starts with the case name**, and the case name is free text: `min_length=1, max_length=160` with no pattern. This is the strongest vector, stronger than the engine name | `frontend/src/pages/Studies/studiesModel.ts:231-235` (`${found.caseName} · revision …`), `:216` (`caseName: entry.item.name`); `openbinding-gateway/src/openbinding_gateway/models/platform.py:148-151` |
| F4 | `describeParameters` begins a cell with a parameter key and its value, or with `Engine defaults` | `studiesModel.ts:133-140` |
| F5 | **The engine name is less open than the proposal says.** In the registration schema, `engine` is a `registeredResource` whose `name` has only `minLength: 1` (no pattern). The other name definition in the same file (the manifest metadata, `:84-87`) pins `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, which does not allow a leading `=`. Whether the gateway requires the two names to match is **not verified**. The registration route takes a JSON document from any `solve_caller` | `schemas/bim/v1/engine-registration.schema.json:14,84-87,99-106`; `routes/v1.py:792-806` |
| F6 | The cells CSV is saved as `text/csv` | `frontend/src/pages/Studies/StudyAnalytics.tsx:158-159` |
| F7 | The audit escaper `cell` has the same gap. It is used by `toCsv`, whose fields are all strings: `id`, `createdAt`, `actorId`, `action`, `targetType`, `targetId`, and `detail` as JSON | `frontend/src/pages/Organization/auditModel.ts:109-111,114-120` |
| F8 | The audit CSV is downloaded as `text/csv` | `OrgAudit.tsx:38` (Blob type), `:167` (`toCsv(visible)`) |
| F9 | These are the only CSV producers in `frontend/src`. A search for `text/csv`, `cellsCsv`, `toCsv` and `.join(',')` outside tests finds no third exporter. The gateway source has no CSV writer (its only `csv` match is the model name `AnalyticsView`) | grep over `frontend/src` and `openbinding-gateway/src` |
| F10 | Current tests fix today's output. Studies: header, the row text and `"note a ""b"", c"`. Audit: `e,now,,a,t,,"{""k"":1}"` and `"{""changes"":`. None of their values starts with a trigger, so **no current assertion changes** | `analyticsModel.test.ts:92-102`; `auditModel.test.ts:48-54`; `orgModel.test.ts:127-133` |
| F11 | An active, unarchived change fixes the audit CSV scenario: header `id,createdAt,…,detail`, with the `detail` cell the JSON `{"quota":{"limit":5}}`, CSV-quoted. JSON starts with `{`, so the fix keeps it | `openspec/changes/m25-studies-engines/specs/frontend-rendering/spec.md:180-184`; `auditModel.test.ts:49` (`[utest->req~frontend-audit-detail-rendered~1]`) |
| F12 | No living spec mentions CSV. `frontend-workspace` covers "cross-cutting UI quality rules" | grep `csv` over `openspec/specs` (no match); `openspec/specs/frontend-workspace/spec.md:8-11` |
| F13 | `shared/lib` is the architecture's home for formatters, and it exists and is tracked. Its first file is `identity.ts` | `docs/ARCHITECTURE.md:208-209`; `.gitignore:18` (`!/frontend/src/shared/lib/`); `frontend/src/shared/lib/identity.ts:1-4` |
| F14 | `docs/qa/SECURITY_REVIEW.md` has no CSV, formula or injection entry. Its sections are "Fixed in this SHA" (table `Id | Finding | Fix`), "Pending", "Residual risks", "Related" and "Not covered" | grep (no match); `SECURITY_REVIEW.md:1,11-13,37,53,65,69` |
| F15 | Risk areas: R9 covers only `frontend/src/**/*.{tsx,css}`. `*.ts` model files, `shared/lib/*.ts`, their tests and `docs/qa/**` match no risk glob, so they are **R0 (low)**. Low panel: reviewer only | `REVIEW.md:22,25,27,33`; `.agentic/project.yaml:131-133` |
| F16 | Frontend gates: `frontend-unit` (`pnpm test` = `vitest run`), `eslint` (`pnpm lint`), `typecheck-build` (`pnpm build` = `tsc -b && vite build`), `bim-guard`, `changelog` | `project.yaml:52,58,78-79,83`; `frontend/package.json:12-15` |
| F17 | Any `frontend/` path runs the e2e and gateway CI areas. The changelog file is `frontend/src/content/changelog.generated.json` | `tools/ci_changes.py:20,43-47` |

External fact (lookup, OWASP community page on CSV Injection, `https://community.owasp.org/attacks/CSV_Injection`; read
through a summarising fetch, **confidence medium**, not quoted verbatim). The leading characters to neutralise are `=`,
`+`, `-`, `@`, tab (0x09), CR (0x0D), **LF (0x0A)** and **full-width forms (＝ ＋ － ＠)**. The page recommends three
things for each field: wrap it in double quotes, prefix `'`, and double every embedded `"`. It warns that Excel may
strip the quotes, and for Excel it suggests a tab inside the quoted field instead.

### Deviations from the proposal

1. **The main vector is the case name** (F3), not the engine name (F5). The fix is the same. The tests should cover
   both, and the `SECURITY_REVIEW.md` entry should name the case name.
2. **The trigger set is not settled.** The proposal lists `=`, `+`, `-`, `@`, tab and CR. OWASP also lists LF and the
   full-width forms (lookup, medium confidence). See CRP-1.
3. **Values that are quoted and also prefixed.** A value with a trigger and a `,` or `"` gets both treatments, in this
   order: prefix `'`, then quote (`"'=a,b"`). This follows the OWASP order, and it must be written into the
   requirement.

## 3. Scope

In scope:
- New `frontend/src/shared/lib/csv.ts`, which exports `csvCell(value: unknown): string`. `null`/`undefined` → `''`.
  A value of `typeof value === 'number'` (and `boolean`) is converted with `String` and never prefixed, so `-3.5` stays
  `-3.5`. For any other value, `text = String(value)`: when the first character is a trigger (CRP-1), prefix `'`. Then
  quote with `"…"` and doubled `"` when the result contains `"`, `,`, `\r` or `\n`. The helper is pure, with no locale
  and no clock (the same rules as `identity.ts:2-4`).
- New `frontend/src/shared/lib/csv.test.ts`: the trigger table, numbers left alone, bare `\r` quoted, `"` doubled,
  prefix and quote together, empty and `null`.
- `analyticsModel.ts`: delete `quote` (`:170-173`) and use `.map(csvCell)` at `:184`.
- `auditModel.ts`: delete `cell` (`:109-111`) and use `.map(csvCell)` at `:118`.
- `analyticsModel.test.ts`: a run whose case name is `=HYPERLINK("http://x","y")`, an engine name with the same text,
  and a parameter value containing `\r`, in one new `it`. Keep the current assertions (F10).
- `auditModel.test.ts`: an event whose `action` is `@SUM(1)` and whose `targetId` is `-1+2`, plus a `\r` value. The
  `detail` JSON cell stays as it is (F11).
- `docs/qa/SECURITY_REVIEW.md`: one dated row in "Fixed in this SHA" (F14), with its own id (for example `CSV1`).
  The row covers the finding, the helper, the tests, and the limits in §7 (Excel tab advice, readers that keep the `'`).

Non-goals:
- Server-side exports. There are none in the gateway source (F9). The analysis export route with a CSV format is
  covered by the m24 sunset change (`openspec/changes/m24-sunset/specs/gateway-api/spec.md:101`), not by the browser.
- Any change to the CSV columns, header, line ending (`\n`), BOM or file names.
- Warning text on the export buttons (proposal alternative 2). That would touch `*.tsx` (R9).
- Tightening the case-name or engine-name validation in the gateway (R3, high). If wanted, that is a separate
  proposal.
- `acceptance/**` (test-designer), `openspec/specs/**` (archive task), `INTENT.md` (R11).

## 4. Slices

One slice. There is one capability, and the estimated non-test diff is about 40-60 lines: about 20 helper lines, 6
lines removed and 2 changed per call site, and about 10-20 lines for the SECURITY_REVIEW row. Splitting the two
exporters would leave two escapers with different behaviour for the time between merges. That is the result the
proposal rejects (alternative 1).

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff (non-test) | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | `csv-formula-neutralise`: shared `csvCell`, both exporters use it, unit tests, SECURITY_REVIEW row | implementer, default model, medium effort, about 30 turns | `frontend/src/shared/lib/csv.ts` (new), `frontend/src/shared/lib/csv.test.ts` (new), `frontend/src/pages/Studies/analyticsModel.ts`, `frontend/src/pages/Studies/analyticsModel.test.ts`, `frontend/src/pages/Organization/auditModel.ts`, `frontend/src/pages/Organization/auditModel.test.ts`, `docs/qa/SECURITY_REVIEW.md` | F1-F17; `studiesModel.ts:133-140,231-235`; `orgModel.test.ts:127-133` (must stay green, not edited); `shared/lib/identity.ts` (style); the m25 scenario (F11) | about 40-60 lines | **low** (R0, F15). Kind security: see Q5 for the panel | OpenSpec change validated (G1) and EPIC-reviewed (G2); CRP-1 answered or its default accepted |

No other slice runs in parallel, so there is no ownership overlap. `orgModel.test.ts`, `OrgAudit.tsx` and
`StudyAnalytics.tsx` are not edited.

Suggested requirement (capability `frontend-workspace`, F12; Q4):
`req~frontend-csv-export-neutralised~1`. "WHEN the browser writes a CSV export, the client SHALL prefix `'` to every
text cell whose first character is a formula trigger, SHALL quote every cell that contains `"`, `,`, CR or LF (with
`"` doubled), and SHALL leave numeric cells unchanged." Scenarios:
- the case name `=HYPERLINK(…)` in the cells CSV;
- `@…` as an action in the audit CSV;
- a bare CR quoted;
- a negative objective `-3.5` unchanged;
- the audit `detail` JSON cell unchanged (keeps F11).

### Proposed checks (none are registered for this proposal)

All with `cwd: frontend` unless stated.
1. G3 red-before: `{"cwd":"frontend","argv":["pnpm","exec","vitest","run","src/shared/lib/csv.test.ts","src/pages/Studies/analyticsModel.test.ts","src/pages/Organization/auditModel.test.ts"],"type":"red_before","expect_exit":[1]}`.
   On the base it fails because `csv.ts` is missing and because of the new trigger assertions in the two model tests.
2. Targeted green-after: the same argv as a plain check.
3. G5 `frontend-unit`: `{"cwd":"frontend","argv":["pnpm","test"]}` (`project.yaml:58`). It also covers
   `orgModel.test.ts`, `OrgAudit.test.tsx` and `StudyAnalytics.test.tsx`.
4. G9 `eslint`: `{"cwd":"frontend","argv":["pnpm","lint"]}` (boundaries: pages may import `shared/lib`, ARCHITECTURE
   §5.1).
5. G9 `typecheck-build`: `{"cwd":"frontend","argv":["pnpm","build"]}`.
6. `bim-guard`: `{"cwd":".","argv":["python3","tools/check_bim_guard.py"]}` (lesson 1).
7. `changelog`: `{"cwd":".","argv":["python3","tools/generate_changelog.py","--check"]}`. Run it only after the
   pr-steward's final `chore(changelog)` commit (lesson 2).

## 5. Gates for S1

| Gate | S1 |
|---|---|
| G1 spec | `openspec validate <id> --strict`. It is `todo: true` (`project.yaml:34`), so it is NOT EXECUTED locally; CI job `openspec` reports it |
| G2 EPIC | spec-auditor on the change (threshold 2, `project.yaml:38`) |
| G3 red-before | check 1 |
| G4 acceptance frozen | no `acceptance/**` in scope |
| G5 green-after | checks 2-3, then PR CI (frontend, e2e and gateway areas, F17) |
| G6 trace | `[impl->req~frontend-csv-export-neutralised~1]` in `csv.ts` and `[utest->…]` in the three tests. `oft-trace` is `todo: true` (`project.yaml:62`); CI `trace` covers `frontend/src` |
| G7 contracts | n/a: no API, OpenAPI or schema change |
| G8 mutation | `stryker-frontend` is `todo: true` (`project.yaml:73`), so it is NOT EXECUTED. The trigger table in `csv.test.ts` must kill the obvious mutants by hand: each trigger, the number branch, and each quote character |
| G9 quality | checks 4, 5, 7 |
| G10 secrets/ownership | synthetic values only. No R11 path. `docs/qa/SECURITY_REVIEW.md` is R0 |
| G11 review | low: reviewer (`REVIEW.md:33`). Focus: the trigger set, the order of prefix and quote, numbers left alone, the `detail` JSON column, and that no third escaper remains. See Q5 |
| G12 lab/UI | n/a: no screen changes. The download buttons are untouched, and `StudyAnalytics.test.tsx:155` still checks `text/csv` |
| G13 review package | `how_to_test` with no API and no UI steps: open the run's cells CSV and the audit CSV of a seeded case named `=HYPERLINK(...)` in LibreOffice, and see text, not a link. In the lab this needs a synthetic case with that name. Otherwise n/a with `how_to_review`: read the `csv.test.ts` trigger table. The coordinator chooses |

## 6. Feature flags

None. There is one slice, and the change is a pure output transform behind two existing buttons.

## 7. Open questions

Need a CRP (owner):
- **CRP-1: the trigger set.** Evidence: the proposal's list against the OWASP lookup in §2 (medium confidence).
  - A (recommended): `=`, `+`, `-`, `@`, tab, CR, LF, and the full-width `＝`, `＋`, `－`, `＠`. LF and CR then trigger
    both the prefix and the quoting.
  - B: the proposal's list exactly (`=`, `+`, `-`, `@`, tab, CR).
  - C: B plus LF only.
  - Default if not answered: A, since it is a superset and costs one regex.
- **CRP-2: the visible `'` in non-spreadsheet readers.** The cells CSV is meant "for a spreadsheet or a notebook"
  (`analyticsModel.ts:175`). pandas and similar readers keep the `'`, so a case named `-baseline` reads as
  `'-baseline`. Excel may also strip quotes (OWASP note in §2).
  - A (recommended): accept it and state it in the SECURITY_REVIEW row.
  - B: prefix only `=`, `@`, `+` and tab/CR/LF, and leave a leading `-` alone. This is weaker, because `-1+1` runs.
  - C: offer a "raw" export as well (UI, R9, out of scope here).

For the coordinator (no CRP):
- **Q3: helper location.** Recommended: `frontend/src/shared/lib/csv.ts` (F13, ARCHITECTURE §5.1 "lib
  (formatters)"). The alternative, `frontend/src/utils/`, is the older layout.
- **Q4: capability.** Recommended: `frontend-workspace` (cross-cutting rule, F12). The audit half also touches the
  active `m25-studies-engines` change (F11), but it does not change it.
- **Q5: review panel.** By globs the panel is the reviewer alone (F15). The kind is security, so adding a
  security-auditor pass on the diff is cheap. Recommended: reviewer plus security-auditor, still within two rounds.
- **Q6: the engine-name claim (F5).** Whether the gateway forces the registered `engine.name` to match the manifest
  pattern was not verified. It does not change S1. It only changes how the SECURITY_REVIEW row words the exposure.

## 8. Followups (outside this scope)

- Gateway: should `BindingCaseCreate.name` (`platform.py:151`) and the registration `engine.name`
  (`engine-registration.schema.json:103`) reject a leading formula trigger? That is R3 (public schema, high if
  breaking), so it needs a separate proposal.
- Verify the O8 "open item" claim against `INTENT.md` and update its "Today" cell after merge. INTENT is R11, so this
  is the owner's.
