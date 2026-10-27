# CRP draft: retired endpoints get `Deprecation` and `Sunset` (M2.4, final step)

Draft for the coordinator to open as two owner decision requests (one decision each). Proposed ids:
`crp-ob-m24-sunset-scope` and `crp-ob-m24-sunset-date`. Owner request: own-f2201fb4bca74fb2ab472d3334323acf.
Evidence: `docs/agent-work/m24-sunset/intake.md` (code at `00f653ef`).

## Context (for both requests)

On 2026-10-22 you decided to retire five areas: the decision-space workspace, the report editor, the library
catalogue and project resources, the composer, and sponsorship (ADR-0020, INTENT D8). Their screens are gone (PR
#51, #53, #55, #65, #66). ADR-0020 decision 5 orders what follows: "Screens go first, then endpoints, after one
minor release with `Deprecation` and `Sunset` headers (CRP). Code goes next." This step only **announces** the
removal. Nothing is removed, and every endpoint keeps working exactly as today. The removal is M9.6 and has its own
CRP.

There are 48 API operations behind the five areas:

- **36 have no caller left in the platform**: all 8 of `/v1/analysis/*`; 7 report-editor operations (report
  read/create/edit/freeze/draft/delete and publish-a-report); 13 library operations (catalogue writes, drafts, seal,
  publish, withdraw, project library); 6 project-resource operations (create, edit, delete, add a revision, read one resource, read one revision); 2
  sponsorship operations (the administrator's sponsor transfer, and reading one sponsor proposal).
- **12 are still called by screens that stay**: the project's report list (project overview, settings, package,
  publications); four library reads that the study builder, the version picker and the case revision page still use
  (list, versions, version content, resolve); two resource reads that the collection page uses to pin resources; and
  five organization-level sponsor-proposal operations (list, accept, decline, cancel) that the organization settings,
  the account page and the notification menu use.
- The composer had no endpoint of its own.

## What API clients will see

On every response of an operation in scope, for success and for refusals alike (401, 403, 404, 409, 422):

```
Deprecation: @1792627200
Sunset: Fri, 30 Apr 2027 23:59:59 GMT
```

- `Deprecation` (RFC 9745) says the operation has been deprecated since 2026-10-22 00:00 UTC, the date of your
  decision. `Sunset` (RFC 8594) says when it may stop answering. RFC 9745 §4 requires the Sunset to be no earlier
  than the Deprecation date.
- Status codes, bodies, authentication, API-key permissions and rate limits do not change. Existing data is not
  touched.
- `docs/openapi.json` marks these operations `deprecated: true` and documents both headers. Generated clients show
  them as deprecated.
- Browser clients can read both headers, because they are added to the CORS exposed headers.
- A short page, `docs/API_DEPRECATIONS.md`, lists the operations, the two dates and what replaces each area in the
  platform. Where nothing replaces an area, the page says so.
- QACOBench uses none of these operations. Two developer tools of the gateway (`tools/verify_analysis.py` and a hint
  printed by `tools/seed_dev.py`) do, and they leave with M9.6.

## Request 1: which operations get the headers

Question: Do the headers go only on the 36 operations that no screen uses any more?

Why now: the endpoint step of M2.4 cannot be specified without the list. 12 of the 48 operations behind the retired
areas are still called by kept screens (`intake.md` §2, rows B1–B12, for example
`frontend/src/pages/Resources/resourceData.ts:7` and `frontend/src/pages/Organization/OrgSettings.tsx:61`).

Options:

- **A) Headers only on the 36 operations with no caller left.** The other 12 stay unmarked until the change that moves
  their last screen off them marks them: M3 (repository) for the library and resource reads, M6.5 (published results)
  for the report list, M4.3 (plans) for the organization sponsor proposals. Cost S, risk low, reversible yes.
- **B) Headers, with the same Sunset date, on all 48.** The platform's own screens would call operations announced for
  removal. M9.6 could not honour the date unless M3, M4.3 and M6.5 had replaced those calls first, so the date
  would probably be a broken promise. Cost S, risk high, reversible yes.
- **C) `Deprecation` on all 48, `Sunset` only on the 36.** The 12 are announced as "going away, no date yet". This
  warns API-key clients early, but they have nothing to move to yet, and the platform itself calls them. Cost S, risk
  medium, reversible yes.
- **D) Defer: no headers now.** M2.4 stays open. Since ADR-0020 requires one minor release of notice before removal,
  M9.6 then slips by at least one release. Cost none now, risk low, reversible yes.

Recommended: **A**. ADR-0020 retires endpoints only after their screens, and only the 36 have lost every screen. A
Sunset date is a promise to clients, and the factory can keep it for these 36 without waiting on other milestones.

Blocked meanwhile: the spec, the tests and the implementation of the endpoint step (one PR). Continuing: nothing
else depends on it. The M2.5–M2.8 work goes on.

## Request 2: the Sunset date

Question: Which date goes in the `Sunset` header?

Why now: `Sunset` takes one fixed HTTP date (RFC 8594 §3). ADR-0020 requires the headers to ship for one minor
release before removal, but R1, the release that will carry them (`ROADMAP.md:196`), has no date yet.

Options:

- **A) Fri, 30 Apr 2027 23:59:59 GMT** (about six months from today). This gives at least 90 days of notice if R1
  ships by 30 Jan 2027. Cost S, risk low, reversible yes: the date can move later as a compatible change, but never
  earlier.
- **B) Wed, 31 Mar 2027 23:59:59 GMT.** M9.6 may start a month sooner. Notice reaches 90 days only if R1 ships by
  31 Dec 2026. Cost S, risk medium (a short notice if R1 slips), reversible yes.
- **C) Thu, 30 Sep 2027 23:59:59 GMT.** More notice for unknown API-key clients. The retired code, the `analysis`
  queue and its worker stay five months longer. Cost S, risk low, reversible yes.
- **D) No date in the code: the R1 release PR sets "R1 date + 90 days".** The most exact notice, but the release PR
  (which only you merge) would carry a code change. Until then the endpoints send `Deprecation` alone. Cost M, risk
  medium, reversible yes.

Recommended: **A**. It gives one minor release of real notice under a realistic R1 date, it can only move later, and
removal still needs a separate CRP (M9.6). M9.6 will check two conditions: the date has passed, **and** a release that
carried the headers has shipped.

Blocked meanwhile: the same PR as request 1 (the tests pin the exact header value). Continuing: specifying the rest
of the change.

## Risks

- **A screen breaks.** Nothing breaks: the headers are additive and the operations keep their behaviour. Under
  option 1-A, no kept screen calls a marked operation, and a test pins that.
- **Unknown API-key clients.** They get notice through the headers and `docs/openapi.json`. They lose access only in
  M9.6, after the Sunset and after your approval of the removal.
- **The Sunset passes before a release carries the headers.** M9.6 does not start until both conditions hold
  (request 2).
- **A middleware on every response.** It costs one lookup in a small table per response. It runs only after a route
  has matched, and it never buffers bodies, so the streaming analysis export is unaffected.
- **Earlier specs.** The screen slices required "no `Deprecation` or `Sunset`" for their own diffs
  (`req~frontend-retire-gateway-untouched~1`). This step ends that requirement, which is reconciled when those
  changes are archived.

## After the answers

The factory specifies the step as one OpenSpec change (`m24-deprecate-retired-endpoints`), writes the failing tests
first, implements them in one pull request into `develop` (about 170 changed lines plus the regenerated OpenAPI
snapshot, medium risk), then records M2.4 as complete in the roadmap's status.
