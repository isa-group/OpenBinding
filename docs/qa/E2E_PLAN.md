# End-to-end plan: API smoke test of the lab demo

> **Browser specs (`frontend/e2e/live/*.spec.ts`) and the `e2e` service that runs them in the lab: WRITTEN, NOT EXECUTED.**
> They were produced where there is no browser, no Docker and no lab. They are checked for TypeScript errors
> (`src/test/e2eSpecs.test.ts`, inside `pnpm test`), against the source of the frontend (selectors and texts were read in
> `frontend/src`, and corrected where they did not match) and statically against `compose.lab.json`; no selector has been
> run against a real page, `playwright test --list` has not been run, and the image `frontend/Dockerfile.e2e` has not been
> built. Expect to correct selectors on the first run. See
> [Browser specs of the `live` project](#browser-specs-of-the-live-project-written-not-executed).

**Status: at SHA `5aebc7c8` (2026-10-13), with `DEMO_SPACE_ENABLED=false`, `tools/smoke_lab.py` gave 9/9 steps in 24.4 s
against the lab; `plan_usage` (step 10, needs `--with-space`) was omitted and is not executed.**
It was written without a Docker daemon and tested against a simulated gateway
(`tools/tests/test_smoke_lab.py`, `httpx.MockTransport`). The first real run passed `proxy_and_spa`, `cors`,
`body_limit` and `login_throttle` and failed the rest, for two reasons, both since handled:

- **`GET /v1/users/me` answered 503 for all five users.** The profile reads the plan through
  `get_gate().caps()` (`routes/users.py`); `SpacePricingGate.caps()` raises `PricingUnavailable` when SPACE gives
  no entitlements token or no contract, and the route turns it into `503 pricing_unavailable`. This is the
  intended fail-closed behaviour (`space_client/gate.py`), not a bug, and the real SPACE had no service or
  contract for the synthetic users. The smoke now reports such a step as `ok: false, blockedByRemote: true`
  (reason: "SPACE has no service/contract for the synthetic users; run seed_lab --space-contracts after
  remote_provision --apply") and counts it under `blocked`, apart from `failed`; exit code 3.
- **`POST /v1/jobs` answered 422 `optimization_required` and the study creation 422 `validation_error`.** The
  package `examples/demo/01_simple_seq` is fine (its `optimization.json` declares the criterion `latency`). What
  was missing is the *execution-time* selection the request must carry: `"mode": "seeded"` and
  `"optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}` (equal weights are filled in by the
  toolchain). A study needs the same two fields inside every `definition.engines[]` item. The smoke sends them.
  The gateway resolves the optimization before it reads the plan, so once the 422 was fixed the next answer for
  a user without a contract is the 503 above.

## What the smoke covers

One run goes through the nginx proxy (`web`, port 8080 inside the lab network) the way the browser does,
using only the users `tools/seed_lab.py` created (names and roles in `docs/DEMO.md`). It prints **one JSON
document** with `{name, ok, blockedByRemote, detail}` per step and exits 0 (all passed), 1 (a step failed),
2 (configuration: no `DEMO_SEED_PASSWORD`) or 3 (nothing failed, but at least one step was blocked by the
remote, see below). A failing step never stops the next one. It prints no password, token or header.

`blockedByRemote: true` means the step met `503 pricing_unavailable` (the gateway could not read the account's
plan) and could not be judged; `ok` stays `false`. The summary has `failed` (real failures), `blocked` and
`blockedSteps`. Steps that need a plan (2 `login`, 3, 4, 5, 6 and 10) are the ones that can be blocked; what in
them does not depend on the plan is still checked, and a real failure in the same step makes it a failure, not a
block. The 503 text cannot tell "no contract" from "SPACE unreachable" (`SpacePricingGate._call` wraps both), so
the detail carries the server's message and `remote_probe.py` settles it.

| # | Step | What is asserted |
| --- | --- | --- |
| 1 | `proxy_and_spa` | `GET /healthz` is `ok`; `GET /` is the SPA's HTML; a made-up deep route returns the same index (SPA fallback); `GET /api/health/ready` is 200 `ready` |
| 2 | `login` | `POST /api/v1/auth/login` for admin, owner, member, viewer, outsider returns a Bearer token; `GET /api/v1/users/me` shows the username and the platform role (`admin` / `user`) |
| 3 | `owner_job` | owner profile; `lab-main` shows `OWNER`; project `bim-demo` visible; a `random-search` job (`mode: seeded`, `optimization` SINGLE / weighted-sum, 10 iterations, seed 1) on the **seeded** snapshot of case `simple-seq` reaches `completed` within 120 s; result has `termination`, and per solution `decision.binding`, `features`, `objectives`, `penalties`, `violations`; the provenance names `bim-reference-evaluator` with its digest and pins compiler and IR; `engineReported` is kept apart from the authoritative values; if the provenance has a field with "toolchain" in its name it is reported |
| 4 | `idempotency` | same `Idempotency-Key` and body: 202 with the same id and `idempotent: true`; same key, other body: 409 `idempotency_conflict`; the same key from `lab-member` (with the member's own snapshot): a different job, not marked idempotent, and the member cannot read the owner's job |
| 5 | `authorization` | no token: 401 on profile, organizations, job read, launch, project jobs and admin; the viewer **can** launch a personal job (202) on a snapshot they uploaded themselves (`POST /v1/jobs` is personal work and stores no project, so the organization role does not gate it; the job is cancelled afterwards; whether the backend should require MEMBER for an organization-shared snapshot is an open decision, M1 in [SECURITY_REVIEW.md](SECURITY_REVIEW.md)) but **cannot** start a study run in the organization project (403/404); the viewer **does** read the project's job (state and result) and its `options`, `original_request` and provenance are redacted (allow-listed option names only, no credential- or address-like keys, registration only as a pinned reference); the outsider cannot read organization, project, project jobs (403/404) or the owner's job (404); owner, member, viewer and outsider get 403 on `/api/v1/admin/overview`, the admin gets 200 |
| 6 | `concurrency_limit` (optional) | 5 simultaneous launches with different keys and slow options (1,000,000 iterations, 20 s budget): at most `--max-concurrent` (3) are accepted, at least one is a 429 `concurrency_limit_exceeded` with `Retry-After`; the accepted jobs are cancelled and awaited, and a new launch is accepted again |
| 7 | `cors` (optional) | preflight from `http://localhost:18100` is allowed (`Access-Control-Allow-Origin` echoes it); from `http://evil.example` no allow-origin is returned, for the preflight and for a simple request |
| 8 | `body_limit` (optional) | a JSON body of 16 MiB + 1 KiB is answered **413** `application/problem+json` (`payload_too_large`) within 30 s, without hanging |
| 9 | `login_throttle` (optional) | up to 12 failed logins of `lab-throttle-probe` (never seeded): 401 until the limit, then 429 with `Retry-After` |
| 10 | `plan_usage` (`--with-space`) | `GET /api/v1/users/me/usage` of the owner returns a plan name, `features` and `capabilities` (numbers or null) and no key that looks like a usage counter |

Order of execution: 1 to 8, then 10, then 9. The login throttle runs last on purpose: it counts per client
address **and** identifier (`authrl:login:id:<address>:<hash of the identifier>`) and, with a ten times larger
budget, per address alone (`core/ratelimit.py`; defaults: 10 attempts per identifier per 300 s window). It uses
an identifier no other step uses, so the users of the other steps are not the ones blocked, but it still
spends part of the per-address budget until the window ends; running the smoke again within five minutes
makes step 9 answer 429 from the first attempt (it still passes).

Steps 6 to 9 are dropped with `--skip` (numbers or names: `--skip 6,7` or `--skip concurrency_limit,cors`).
Steps 1 to 5 cannot be skipped. Step 10 only runs with `--with-space`.

### What the smoke changes in the lab

- It launches jobs for `lab-owner` (steps 3, 4, 6) and `lab-member` (step 4) and uploads the example package
  `demo/01_simple_seq` as the member's snapshot (`POST /api/v1/instances`).
- Jobs that belong to a project only come from study runs (`POST /v1/jobs` stores no project). If the project
  has no completed job, step 5 creates the study `smoke-lab` in `lab-main/bim-demo` (one case revision, one
  engine, one parameter set, one seed) and runs it once. Later runs reuse that job and create nothing.
- It does **not** register users, does not call SPACE or SPHERE, and does not delete anything.

## What it does not cover

- **Anything in a browser.** No rendering, no JavaScript errors, no routing in the SPA beyond "the proxy
  serves the index". The Playwright specs in `frontend/e2e` (`s1a`..`s9b`, `routes-smoke`, `responsive`,
  `visual-*`, `qa-gallery`, `analysis-live`, `pricing`) need a browser; most of them run against the Vite dev
  server with mocked API (`helpers/mockApi.ts`), and `analysis-live.spec.ts` with `ANALYSIS_LIVE=1` against
  a live frontend. They stay for an execution with a browser and the SSH tunnel to `127.0.0.1:18100`. The
  specs written for the lab are described [below](#browser-specs-of-the-live-project-written-not-executed);
  they are **not executed**.
- **Mobile and desktop visual checks** (390 x 844 and 1440 x 900 in `docs/DEMO.md`) and the **screenshot
  plan**: the capture specs (`visual-foundations`, `visual-shell`, `responsive`, `qa-gallery`) produce images
  and are judged by eye.
- Token refresh, logout, password reset, registration, CAS, API keys, notifications, organization invitations,
  artifacts/library, reports and publications, the other three engines, `many-heuristic`, `minizinc`,
  `evolutionary-heuristics`, engine registration, public (anonymous) pages.
- Load and timing: step 6 proves the limit, not throughput; step 8 proves the refusal, not the latency.
- The SPACE/SPHERE side: step 10 only reads what the gateway reports for the owner.

## Running it with lab_compose

Preconditions: the stack is up and healthy, and the users exist (`seed_lab.py` ran; see `docs/DEMO.md`). With
`SPACE_ENABLED=true` the gateway asks SPACE for the plan of every account, so the synthetic users need a
contract on the development service (`seed_lab.py --space-contracts`, see `docs/qa/REMOTE_TOOLS.md`; the
`seed` service gets the service, plan and version from `DEMO_SPACE_DEV_SERVICE`, `DEMO_SPACE_DEV_PLAN` and
`DEMO_SPACE_PRICING_VERSION`). Without one the gateway answers 503 `pricing_unavailable` and the steps that
need a plan (2, 3, 4, 5, 6, 10) are reported as blocked by the remote, not as failures. The gateway, the worker
and `seed` all name the same development service (`DEMO_SPACE_DEV_SERVICE`, passed as `SPACE_SERVICE_NAME`), so
the seeded contracts are the ones the gateway reads and the production service `openbinding` is never
touched; see `docs/DEMO.md`.

**Current state.** SPACE rejected the development pricing (HTTP 400 on `createdAt`, see `docs/qa/REMOTE_TOOLS.md`,
"Primera aplicación real"), so there is no SPACE service and no contract. Until that is resolved run the lab
with `DEMO_SPACE_ENABLED=false` (open development gate, no real entitlements) and the smoke **without**
`--with-space`: step 10 `plan_usage` runs only with that flag, and the other steps complete against the open
gate. With `DEMO_SPACE_ENABLED=true` the steps that need a plan stay blocked by the remote (503
`pricing_unavailable`). The open gate does not exercise SPACE plans or capabilities, so those stay unverified.

The smoke is a seed tool: it runs in the `seed` service, inside the lab network, so `web` resolves.

```sh
# 1. users (once; idempotent)
DEMO_SEED_TOOL=seed_lab.py DEMO_SEED_ARGS='--space-contracts' docker compose run --rm --no-deps seed
# 2. the smoke
DEMO_SEED_TOOL=smoke_lab.py DEMO_SEED_ARGS='--with-space' docker compose run --rm --no-deps seed
# without SPACE, and without the optional steps
DEMO_SEED_TOOL=smoke_lab.py DEMO_SEED_ARGS='--skip 6,7,8,9' docker compose run --rm --no-deps seed
```

With `lab_compose` the same two `seed` runs are made by setting `DEMO_SEED_TOOL` / `DEMO_SEED_ARGS` as in
`docs/DEMO.md`. The password must be the same `DEMO_SEED_PASSWORD` value for both runs. The smoke reads it
from the environment only (never from the command line) and the base URL from `SMOKE_BASE_URL` or
`--base-url` (default `http://web:8080`).

Options: `--base-url`, `--skip`, `--with-space`, `--origin` (default `http://localhost:18100`),
`--evil-origin` (default `http://evil.example`), `--job-timeout` (default 120), `--max-concurrent` (default 3,
the lab's `MAX_CONCURRENT_JOBS_PER_USER`).

Reading the result: `ok` and the exit code are the verdict; `steps[].detail` says `N checks passed [notes]`
or `FAILED k/n: <the failed expectations>` or `BLOCKED BY REMOTE: <reason>. Cause: <server message>. Blocked
at: <requests>`, at most 500 characters, with every secret and token-shaped string replaced by `***`. Run the unit tests with `cd openbinding-gateway && uv run pytest tools/tests/test_smoke_lab.py`.

## Browser specs of the `live` project (written, NOT executed)

**None of these specs has been run.** The environment that wrote them had no browser, no Docker daemon and no lab. What was
done, and what was not:

| Check | Result |
| --- | --- |
| `tsc` over `frontend/e2e/**`, `playwright.config.ts` and `playwright.live.config.ts` | Done, as the test `src/test/e2eSpecs.test.ts` (TypeScript API, strict, same rules as `src`) inside `pnpm test`: no diagnostics |
| Selectors, texts and routes against `frontend/src` | Read by hand against the components (not rendered); the corrections are listed under "What was corrected before the first run" |
| `compose.lab.json` (`e2e`, volumes `lab-pg-2` and `lab-artifacts-2`), `Dockerfile.e2e` against `pnpm-lock.yaml` | Static tests only (`lab/tests`, `test_container_hardening.py`): the Playwright image is `v1.62.1-jammy`, the version the lock resolves |
| `playwright test --list` | **Not run** (only the registered checks can be run here; `pnpm exec playwright` is not one of them) |
| `docker build` of `Dockerfile.e2e`, `up`, the run against the lab | **Not run** |
| Screenshots (`<results>/screenshots/<desktop\|mobile>-<screen>.png`) | **None exist**: the specs take them when they run, in a volume the controller cannot open |

The same test also asserts that the specs read the password only from the environment (`LAB_SEED_PASSWORD`, or `DEMO_SEED_PASSWORD`
inside the lab; no literal, no other fallback, no `.env`), that the two viewport sizes are in the capture helper, that the visual QA
measures what it says it measures, and that the lab configuration `playwright.live.config.ts` has no web server, one worker and a
`desktop` and a `mobile` project.

### What they cover

Two ways to run the same specs (`frontend/e2e/live/*.spec.ts`), always with the synthetic users of `docs/DEMO.md`:

- **Inside the lab** (the way the controller runs them): the `e2e` service of `compose.lab.json` runs `frontend/playwright.live.config.ts`
  against `BASE_URL=http://web:8080`. Projects `desktop` (1280x800, every spec) and `mobile` (390x844, `hasTouch`, only
  `visual-qa.spec.ts`); one worker; `trace: 'retain-on-failure'`; Chromium with `--no-sandbox --disable-dev-shm-usage`. The
  password arrives as `DEMO_SEED_PASSWORD`. Results go to `/results` (the volume `lab-e2e`). See [Inside the lab](#inside-the-lab-the-e2e-service).
- **From a workstation**, through the tunnel: the project `live` of `frontend/playwright.config.ts`, against `PLAYWRIGHT_BASE_URL`
  (default `http://localhost:18100`), password in `LAB_SEED_PASSWORD`.

The password is the one the lab was seeded with and reaches the specs **only** through the environment. Each spec but the login ones
signs in through `POST /api/v1/auth/login` and hands the session to the page, so the throttled login form is used once per user; a
`429` from the login makes the helper wait for the `Retry-After` instead of failing. Specs are independent: each signs in on its own
and needs only the seed (the visual QA opens "a result" if the owner has a finished job, and says `SKIPPED` if not).

| Spec | What it asserts |
| --- | --- |
| `01-login` | each of `lab-owner`, `lab-member`, `lab-viewer`, `lab-outsider` signs in through the form and lands on Home; a wrong password (unknown account `lab-login-probe`, so no real user is throttled) gets the neutral refusal; an anonymous visit to `/app` goes to `/login` |
| `02-navigation` | owner: Home → organization `lab-main` (role `OWNER`) → project `bim-demo` → its sections; member: sees `MEMBER`, opens the case list |
| `03-case-simple-seq` | owner and member open the case `simple-seq`: slug, revisions, `New revision` and `Run latest`; no read-only note; no `Delete case` for the member |
| `04-job-random-search` | owner walks the four steps of a run (case, engine `random-search`, 50 iterations, review), checks that `POST /v1/jobs` answers 202 **and carries `optimization`**, follows the run and waits for a result heading (`Best combination found`, `Solution n of m` or the infeasibility explanation) |
| `05-viewer-read-only` | `lab-viewer`: the case list and the case say `VIEWER` and offer no `New case`, `New revision`, `Delete`; the run launch says starting a run needs MEMBER and has no enabled `Send run`; no `New study`; project settings read-only; no `New project` |
| `06-outsider-no-access` | `lab-outsider`: Home lists only `lab-other`; `/app/lab-main` shows `Organization not available` and the project `Project not found`; every call the interface makes about `lab-main` answers 403 or 404; cases, launch and studies are as hidden |
| `07-plan-and-consoles` | for the four users: `/app/account/usage` ("Plan & permissions") shows the plan block **or** the 503 explanation, links `Open SPACE console` / `Open SPHERE console` (`https://space.score.us.es`, `https://sphere.score.us.es`, `target=_blank`, `rel=noopener`), no meter, no monthly counter, no credits, no control that changes a price, version or contract; Home carries a plan block with the same links; the public `/pricing` page sells nothing |
| `visual-qa` | per project (desktop and mobile): the login page; the owner walks Home, the organization `lab-main` (its projects), the project, the cases, the case `simple-seq`, the jobs, **a finished job's result**, "Plan & permissions" and the organization's members (team); `lab-viewer` walks the cases, the jobs and the launch page. On each screen: no horizontal overflow (`scrollWidth <= innerWidth`), no `console.error`, no `pageerror`, no 5xx answer, a visible `main`, on mobile no visible button/link/field under 24 px high (a link inside a line of text is exempt), no clipped text without an ellipsis, no broken image; a screenshot per screen and size. The viewer has no `New case`, no `New run`/`Start a run` and no enabled `Send run`, and the launch page says starting a run needs MEMBER |

Every spec that opens a page of the application watches `pageerror` and fails on any. Screenshots (`capture` in `e2e/live/support.ts`) are taken at **1440x900** and
**390x844** for each key screen and saved with `testInfo.outputPath` (`<results>/test-output/<spec>/<name>-desktop.png` and
`-mobile.png`), also attached to the Playwright report. The visual QA keeps its own pictures in `<results>/screenshots`.

**What the visual QA does not count as a failure:** 4xx answers (listed as `VQA_HTTP4XX`; Chromium also logs each as a console error,
and those log lines are set aside so the real errors stay visible); a link inside a sentence shorter than 24 px; anything that needs
an eye (spacing, colour, hierarchy, contrast beyond what `helpers/pageChecks.ts` measures in the gallery spec). A screen that never
leaves its skeleton or spinner within 30 s is reported (`still waiting after 30 s`).

### What was corrected before the first run

The specs had never run; reading them against `frontend/src` showed these, and they were changed:

- `support.ts`: the password also comes from `DEMO_SEED_PASSWORD` (the lab's name for it; compose passes no other variable into the
  service); a `429` on the login waits and retries; `signInByApi` returns the token; `RESULTS_DIR` and `API` are shared.
- `02-navigation`: the project card and the `Cases` tab are looked up inside `#platform-main` and the `Project sections` navigation (the
  header carries project links too, in a menu that can be closed, and `.first()` could have picked one of those).
- `04-job-random-search`: `.first()` over `random-search` radios could pick a disabled mode (a mode that cannot run the problem is a
  disabled radio); it now picks an enabled one. The `Settings` heading is matched exactly at level 2 (the step list has a `Settings`
  label too). Timeout raised to 300 s.
- `05-viewer-read-only`: new test that the jobs list has no `New run`/`Start a run` for a viewer. `Run latest` and `Run` links **are**
  shown to a viewer (they open the launch page read-only, where `Send run` is disabled); the spec records that as an annotation instead
  of asserting it away. The backend refuses the launch below MEMBER.
- `07-plan-and-consoles`: `plan.or(alert)` matched more than one element in strict mode (`.first()`); and, with `DEMO_SPACE_ENABLED=false`, the
  page is the open gate's: the plan name is empty and the features read `Enabled` or `Can’t confirm` (the pricing token of the open gate
  carries no entitlements). The frontend has **no dedicated "local trial without remote entitlements" notice**; the spec checks the plan
  block and the `Features` section, and annotates the empty plan name.
- `01` (a comment only), `03` and `06`: selectors and texts match the components; nothing to change. The outsider spec relies on
  the gateway answering 403 or 404 for a private project, which the interface shows as `Project not found` either way.

### First real run in the lab (Chromium in the container, `DEMO_SPACE_ENABLED=false`): 26 passed, 4 failed

The failures were: `04` (desktop) `page.waitForResponse: Timeout 30000ms exceeded`, and the mobile visual QA of the login page, of the
owner's walk and of the viewer's walk (`Error: mobile login` / `mobile panel` / `mobile viewer-cases`: only the label of an
`expect.soft` reached the summary, not the findings). Analysed by reading, without the rendered pages:

- **`04`: the matcher was right, the page never sent.** `jobsApi.launch` does `POST ${apiBaseUrl}/v1/jobs` (`/api/v1/jobs`, status 202),
  so `url().endsWith('/v1/jobs')` and the method matched. What prevents the request is `sendable` in `JobLaunch.tsx`: `Send run` is
  disabled while any settings field is `invalid`, and `parseAmount` (`launchModel.ts`) accepts only values `> 0`. The manifest of
  `random-search` (`schemas/bim/v1/manifests/random-search.json`) declares `seed` with `"default": 0`, a numeric option, so
  `optionInputs` offers it with `0` and `planOptions` marks it invalid: **the launch screen cannot send random-search with the engine's own
  defaults** (a product defect in `frontend/src`; fixed afterwards, see "Second real run" below). The click on a disabled button waited 30 s and the unhandled `waitForResponse`
  promise, started just before it, was what the report showed. The spec then (a) typed `1` into any field marked invalid, as a
  person had to (removed once the defect was fixed); (b) asserts that `Send run` is enabled, with the text of the review in the message; (c) starts `waitForResponse` and the click together
  (`Promise.all`) and matches on the path of the URL. The assertions on the result (202, `optimization`, the result heading) are as they
  were. If the next run still fails there, the message now says which of the two it is.
- **The three visual QA failures** are failures of the programmatic checks (`VQA_PROBLEM`). Not knowing which one, **no criterion was
  relaxed**. By reading, the ones that could be too strict are:
  - *touch targets (24 px high, mobile):* WCAG 2.5.8 also exempts a target whose 24 px circle meets no other target (spacing) and a
    link inside a sentence (the check does exempt the second, not the first). A 20 px icon with a larger clickable area still measures
    its own box, which includes padding, so it is judged by the area that clicks. Kept: without the rendered page there is no evidence
    that a finding is only a spacing case, and implementing the spacing exception blind could hide a real one. Each finding now names
    the element's class and its parent's, so it can be judged from the log.
  - *clipped text:* already accepts `text-overflow: ellipsis`; a clip with `overflow: hidden` and no ellipsis is a real cut.
  - *horizontal overflow:* the page's `scrollWidth` against `innerWidth`. Strict on purpose (a wide table must sit in its own scroll
    container). The finding now lists the elements that stick out (`measurePage().offenders`).
  If the next run shows a finding that is a legitimate pattern, the criterion is to be changed in `visual-qa.spec.ts` with the reason
  written beside it and here.

### Second real run in the lab: 27 passed, 3 failed (before the change below)

Same lab, Chromium in the container (27 passed / 3 failed, as reported by the controller). The visual QA reported 131 `VQA_PROBLEM`;
the ones that were visible were all `touch target under 24px` on mobile: `a.app-brand "OpenBinding home"` 123x22 (in
`.app-header-start`), the `Home` link 34x19, `+ Add` 37x20 (in `.org-card-head`), and a list of links 358x22 (`Explore`, `Engines`,
`Pricing`, `Status`, `Profiles & dialects`, `Schemas`, `Examples`, `Workbench`: navigation and footer). The other 121 were not seen,
because the summary cut the list at 35 lines. The settings defect of `04` described above is confirmed by spec 04 (it needed the
workaround). No criterion was relaxed. What changed (not yet run in the lab):

- **`summary.mjs` groups the findings.** Between `VQA_PROBLEMS_BEGIN` and `VQA_PROBLEMS_END` it prints `VQA_TOTAL problems=N groups=N` and
  one line per (viewport, page, kind of problem), the biggest first and at most 40:
  `VQA_GROUP viewport=mobile page=panel kind="touch target under 24px" count=12 examples=["a.app-brand \"OpenBinding home\" 123x22 …", …]`
  (the kind is the text before the first `: ` of the finding; at most 3 examples of 110 characters). A kind with many findings can no
  longer hide another; if there are more than 40 groups, `VQA_GROUPS_OMITTED groups=N problems=N` counts what is left out. The raw
  `VQA_PROBLEM` lines are still in the log above. `E2E_SUMMARY` stays the last line.
- **Touch targets on a phone** (`frontend/src/styles/globals.css`, `@media (max-width: 640px)`): buttons, summaries, selects, `role`
  buttons/tabs and text fields get `min-height: 24px`; links inside `nav`, `header`, `footer`, `aside` or an element whose class
  contains `crumb`, `-head`, `-nav`, `-actions` or `-brand` become `inline-flex` with `align-items: center` and `min-height: 24px`,
  except those inside a paragraph, heading, `dd` or `small` (a link in a sentence is exempt, as in the check). The link rule is inside
  `:where()`, so it has no specificity: a component that sets its own `display` keeps it and the desktop layout is untouched (the rule
  only exists under 640 px). The criterion in `visual-qa.spec.ts` is unchanged. Whether it clears all 131 findings is for the next run
  to say; a link outside those contexts that is shorter than 24 px will still be reported, by name.
- **Product defect fixed: `Send run` was disabled with the engine's own defaults.** `parseAmount` accepted only values `> 0`, and
  `random-search` declares `seed` with default `0`. Now a budget (`time_budget_ms`, `iterations`, `max_evaluations`) must still be
  above 0, while any other numeric option accepts `0` (and must be a whole number, `0` or more, when its schema type is `integer`); the
  message reads `A whole number, 0 or more` for those and `A positive number` for a budget. Unit tests in `launchModel.test.ts`.
  Spec `04` no longer types over any field except `Iterations`: it asserts that no field is invalid and that `Send run` is enabled with
  the defaults, and keeps the assertions on the 202, `optimization` and the result.

### Third real run in the lab: 28 passed, 2 failed (131 -> 15 problems)

The second change worked: 131 findings fell to 15, all `touch target under 24px` on mobile (390x844):

- `[case] 6`: `Open` 34x20, `Run` 24x20, `Add to study` 77x20 in `.case-rev-links`.
- `[plan-permissions] 5`: `Open SPACE console` 140x22, `Open SPHERE console` 149x22, `See the published plans` 162x22 in `.usage-consoles`.
- `[job-result] 2`: `Snapshot 23d976b7…` 133x16 and `Sequential Service Workflow …` 244x16. Markup: `Fact` in `pages/Jobs/JobFacts.tsx`, a `div.job-fact` (not a `dd`).
- `[project] 1`: `Open random-search job from Oc…` 30x19 in `.proj-job`.
- `[viewer-job-launch] 1`: `a.ui-action.is-link` `Upload a new package in the Wo…` 324x20 in `.job-wizard`.

What changed (`globals.css`, `@media (max-width: 640px)` only; desktop untouched; not yet run in the lab):

- The link rule is now global: every `a[href]` that is not inside `p`, `h1`-`h6`, `dd`, `small`, `label` or a `prose` container is
  `inline-flex`, `align-items: center`, `min-height: 24px`, inside `:where()` (zero specificity).
- An explicit rule, also zero specificity, names `.ui-action`, `.ui-action.is-link`, `.case-rev-links a`, `.usage-consoles a`,
  `.proj-job a`, `.job-wizard a` and `.job-fact a` (the job-result links).
- The nav/header/footer/crumb rule stays. The criterion in `visual-qa.spec.ts` is unchanged.
- `src/test/mobileTouchTargets.test.ts` reads the CSS and checks that these selectors are in the phone block (jsdom cannot measure pixels).

### Fourth real run in the lab: 29 passed, 1 failed (131 -> 1 problem)

One finding is left, `touch target under 24px` on mobile (390x844): `[viewer-job-launch]` `a.ui-action.is-link` `Upload a new package in the Wo…`
324x20 in `.job-wizard` (the link `Upload a new package in the Workbench`, step 1 of the launch wizard). The screenshots
`mobile-plan-permissions` and `mobile-job-result` were opened and reviewed: `.inf` now reads `No limit` and the tables scroll
(see the visual review below).

Cause: `components/ui/Action.css` has `.ui-action.is-link { min-height: 0; padding: 0; ... }` (specificity 0,2,0). The phone rules of
`globals.css` are inside `:where()` (specificity 0), so they lost against it. `.ui-action` in general is not affected: `is-sm` and
`is-md` already set 2rem and 2.5rem.

Fix (`globals.css`, `@media (max-width: 640px)` only; desktop untouched; not yet run in the lab): `:is(a, button).ui-action.is-link`
(specificity 0,2,1) gets `min-height: 24px`, `align-items: center` and `vertical-align: middle`. The criterion in `visual-qa.spec.ts` is
unchanged. `mobileTouchTargets.test.ts` checks the rule is in the phone block, not outside it, and that `Action.css` still sets `min-height: 0`.

### Visual review of the real screenshots (opened through the lab MCP): findings the assertions did not catch

The programmatic checks above passed on these screens, yet looking at the pictures showed defects that no assertion measured. This
review is manual (the screenshots were opened, not inferred from the log), so its findings are recorded here with the fix. None of
the fixes has been run in the lab yet; the unit tests and the build are the only evidence so far.

1. **`.inf` on Plan & permissions.** In `Per-request ceilings`, the `Exact value` column showed the YAML artefact `.inf` for a limit
   with no ceiling, next to `Unlimited` in `Your limit`. Cause: `AccountUsage.tsx` fell back to the literal `'.inf'` when
   `describeLimit` had no exact figure and the limit was `null`. Fix: `exactValueText()` in `usageModel.ts` returns `No limit` for
   `null` or a non-finite value and the exact figure otherwise; the table uses it. The `All entitlement values` list (a technical view
   by the gateway's own names, e.g. `maxTimeoutSeconds`) kept raw figures for finite limits but now also says `No limit` instead of
   `Unlimited`, so the same limit has the same words on the whole page; it never showed `.inf` and no raw `null` is shown either,
   because a technical view that is only labelled "technical" still reads better with one phrase per meaning. Tests:
   `AccountUsage.test.tsx` (table and technical list, no `.inf`/`Infinity` anywhere in the page) and `accountModels.test.ts`.
2. **Wide tables cut on the right at 390 px, with no hint that they scroll.** Seen in `Per-request ceilings` (`Exact value`),
   `Settings: asked vs used` of a job (`Used` cut as `Us`, `50` half drawn) and the project's job list (`Outcome` cut). The tables
   were already inside a keyboard-focusable scroll region (`role="region"`, `aria-label`, `tabindex="0"`), so the content was reachable,
   but nothing showed it: a touch screen has no visible scrollbar and the picture looked like a truncated table. Fix: one shared
   component, `components/ui/DataTable` (it already existed and the job list used it), now draws a fading shadow at the side where
   more columns wait (`background-attachment: local` gradients: no JavaScript, it disappears at the edge). `Per-request ceilings` and
   `Settings: asked vs used` moved from their own wrappers (`.usage-table-wrap`, `.job-table`) to it, and their duplicated CSS was
   removed. `Settings against your plan` in the launch wizard already stacks its columns on phones and was left alone.
   Not verified: the real pixels at 390 px. If the next capture still shows a table cut with no shadow, the cause is an ancestor and
   not the table, and finding 3 will name it.
3. **New criterion in `visual-qa.spec.ts`: `clipped content`.** Per screen and size, every visible element (not fixed/absolute, not
   `.sr-only`/`aria-hidden`, not in a closed `details`) is checked against its nearest ancestor with `overflow-x` other than `visible`.
   If that ancestor scrolls (`auto`/`scroll`) the content is reachable and fine; if it shows an ellipsis it is fine; if it is
   `hidden`/`clip` (or `html`/`body`, measured against the window) and the element sticks out by more than 1 px while the container
   has `scrollWidth > clientWidth + 1`, it is a finding: `clipped content: <container> cuts Npx off: <selectors of the first three cut elements>`.
   The log line of the screen gains `clipped_content=N` and each `VQA_PROBLEM` gains `kind="..."` (the text before the first colon,
   so `clipped content`, `clipped text without ellipsis`, `touch target under 24px`, ...). No existing criterion was relaxed. The new one
   has not run yet; a first run may report legitimate patterns, which are to be handled here with the reason, not silenced.

### Inside the lab (the `e2e` service)

Nothing is needed on a workstation or through a tunnel. Sequence with `lab_compose` (variables in `docs/DEMO.md`):

1. `down` if the checkout (the SHA) changed. It keeps the volumes.
2. `up` with `DEMO_E2E=0`: builds the images (`frontend/Dockerfile.e2e` is the Playwright image `v1.62.1-jammy` with
   `pnpm install --frozen-lockfile` and `frontend/` copied in) and starts everything. The volumes `lab-pg-2` and `lab-artifacts-2` are new, so the database starts empty and
   `seed` populates it. `e2e` creates `/results/done` and sleeps, so `--wait` returns.
3. `seed` (`DEMO_SEED_TOOL=seed_lab.py`, `DEMO_SEED_ARGS=--verbose`, a `DEMO_SEED_PASSWORD`).
4. `up` with `DEMO_E2E=1` and the same `DEMO_SEED_PASSWORD`: `e2e` is recreated and runs `playwright test -c playwright.live.config.ts`;
   `--wait` returns when it finished (its health is "`/results/done` exists"). Repeating a run needs `DEMO_E2E=0` and `1` again, or a `down`.
5. `logs e2e`.

What `logs e2e` contains: the `list` reporter, then (from `e2e/live/summary.mjs`, in the last lines, which are the ones the controller
sees; at most about 70 lines in all) `E2E_FAILED project=… spec=… title="…" error="<first line>"` and, right after it,
`E2E_FAILED_DETAIL project=… title="…" error="<every error of the test, one line, at most 1200 characters>"` for each failure (at most 10),
`E2E_ERROR …` for errors of the run itself, every finding of the visual QA again, grouped, between `VQA_PROBLEMS_BEGIN` and
`VQA_PROBLEMS_END` (`VQA_TOTAL`, then one `VQA_GROUP …` per viewport, page and kind, at most 40; see the second run above), and the
parseable verdict, always the last of them

```
E2E_SUMMARY passed=N failed=N skipped=N
```

A failed `expect.soft` of the visual QA has the label (`mobile login`) as the first line of its message and the findings in the lines
below it; `E2E_FAILED_DETAIL` joins all of them. A spec may also print `E2E_FINDING …` for a defect of the product it worked around.

plus, from the visual QA, one line per screen and size and one per finding:

```
VQA viewport=mobile page=jobs result=FAIL overflow_px=0 http4xx=0 problems=1
VQA_PROBLEM viewport=mobile page=jobs "touch target under 24px: a \"Open\" 31x20"
```

`result=SKIPPED` appears for `job-result` when the owner has no finished job. With `DEMO_E2E` not `1` the log only says
`E2E_SKIPPED reason=DEMO_E2E_is_not_1`.

**What cannot be verified from here:** the screenshots, `report.json`, `visual-qa-*.json` and the traces of failures are in the volume
`lab-e2e`, which the controller cannot open (no access to volumes, only to logs): of the visual QA only the numbers above are
visible, never the pictures, and nothing that needs an eye. Neither has any of this been executed: the image build (the Playwright
image tag, `npm install -g pnpm`, the user `pwuser`), the ownership of the new volumes (`lab-artifacts-2` inherits 10001 from the image directory because the
container has no `CAP_CHOWN`, see `docs/DEMO.md`), `up --wait` with a container that exits, Chromium inside 576 MiB with one worker, and every selector.

### From a workstation

```sh
# once, the lab up and the users seeded (docs/DEMO.md); the tunnel: ssh -L 18100:127.0.0.1:18100 <host-lab>
cd frontend
PLAYWRIGHT_BASE_URL=http://localhost:18100 LAB_SEED_PASSWORD="$LAB_SEED_PASSWORD" \
  pnpm exec playwright test --project=live --workers=1 --reporter=line
pnpm exec playwright test --list --project=live      # lists the specs without a browser
```

`LAB_SEED_PASSWORD` must be exported by whoever runs them (the same value as the seed's `DEMO_SEED_PASSWORD`); it is never written in
the repository and no spec reads `/workspace/.env`. Setting `PLAYWRIGHT_BASE_URL` also stops the local Vite server from starting.
`PLAYWRIGHT_API_URL` names the API when it is not `<base>/api`; `PLAYWRIGHT_SPACE_URL` / `PLAYWRIGHT_SPHERE_URL` name the console
addresses when the build overrides `VITE_SPACE_FRONTEND_URL` / `VITE_SPHERE_URL`.

### What to expect on the first run

- **`04` depends on the plan being readable.** With `SPACE_ENABLED=true` and no contract for the synthetic users the gateway answers
  503 `pricing_unavailable` (see "Current state" below); the spec then fails at `Send run` with that status in its message. Run the
  lab with `DEMO_SPACE_ENABLED=false` (open gate) or seed the contracts first.
- **`04` needs the launch to send `optimization`.** The gateway answers 422 `optimization_required` otherwise (first real run of the
  smoke, above). The run screen now derives it (`SINGLE` for one criterion, `MULTI` for two or three, `MANY` beyond; the first
  scalarization the engine mode declares for that type; `feasibility` for no criterion) and sends none when the mode declares no
  fitting one. This is covered by unit tests only.
- **The study builder does not send it yet.** A study definition needs the same two fields in every `definition.engines[]` item (422
  `validation_error` in the smoke). `frontend/src/pages/Studies/StudyBuilder.tsx` does not add them; no live spec creates a study.
- Selectors were written from the components and their unit tests, not from a rendered page. The most likely to need a touch are the
  engine radio name (`/^random-search/`), the `Iterations` field and the result heading of a run.

## Assumptions not verified

1. **Compose environment.** *Resolved:* `compose.lab.json` passes `DEMO_SEED_PASSWORD`, `SMOKE_BASE_URL` and
   the three `SPACE_DEV_*` variables to `seed` only, as references to `DEMO_*` variables the supervisor supplies.
2. **`httpx` in the gateway image.** It is a runtime dependency in `pyproject.toml`; not confirmed inside the
   built image. `tools/` is bind-mounted, so the script runs from the checkout.
3. **Example package.** Members upload the package served by `GET /api/v1/examples/demo/01_simple_seq`. It
   assumes `examples/` is inside the image (the endpoint reads it from the source tree).
4. **Seeded snapshot.** The owner's job uses `source_snapshot_id` of the latest revision of `simple-seq`; if
   that snapshot cannot be read it falls back to uploading the example package.
5. **Study entitlement.** The viewer's read needs a project job, which needs the `studies` feature on the
   owner's plan (and on the sponsor's capacity). If the plan refuses it, step 5 fails with "no project job to
   read as viewer" and the code of the refusal; nothing else in the step is skipped. A study run is accepted
   (202) even when the plan cannot be read and then stays queued, so step 5 reads the owner's profile first and
   reports the block at once instead of waiting `--job-timeout`.
6. **Slow options.** Step 6 assumes the plan's caps do not clamp `iterations`/`time_budget_ms` so far that a
   job ends before the five launches have arrived. If it does, no 429 appears and the step fails; lower
   `--max-concurrent` does not help, raise the budget in `SLOW_OPTIONS`.
7. **Status codes.** Where the matrix is ambiguous the smoke accepts 403 or 404 (viewer study run, outsider reads).
   Anonymous requests must be 401 and non-admins 403 on `/api/v1/admin/*`; the outsider reading the owner's
   job through `/api/v1/jobs/{id}` must be 404.
8. **BIM provenance.** The smoke checks the reevaluation by `evaluator`/`evaluatorDigest`/`compilerDigest` in the
   provenance and only *reports* a toolchain field if one exists; it cannot prove that the request went to
   `bim-service` (the gateway does read `BIM_MODE=http`, see `docs/DEMO.md`). Check `logs bim-service` once for that.
9. **CORS preflight.** Expected 200 with an echoed origin for the allowed one and no allow-origin header for
   the other (Starlette answers 400). `Access-Control-Allow-Methods` must contain `GET`.
10. **413 through nginx.** `client_max_body_size` is 512m, so the gateway's `BodyLimitMiddleware` (16 MiB
    JSON) answers. The oversized request goes to `/api/v1/auth/login`, which is refused before the password
    or the throttle are looked at, so it spends no login attempt.
11. **Usage counters.** Step 10 flags any key under `/v1/users/me/usage` containing `used`, `usage`,
    `consumed`, `counter`, `remaining` or `spent`; a capability legitimately named like that would fail it.

## Procedimiento en el lab

Secuencia exacta con `lab_compose` (variables en `docs/DEMO.md`):

1. `down` si cambia el SHA del checkout (conserva los volúmenes).
2. `up` con `DEMO_E2E=0`: construye las imágenes y arranca todo; los volúmenes `lab-pg-2` y `lab-artifacts-2` son nuevos (sin `CAP_CHOWN` no se puede cambiar el propietario de los antiguos), así que la base empieza vacía y `seed` la puebla; `e2e` crea `/results/done` y espera.
3. `seed` (`DEMO_SEED_TOOL=seed_lab.py`, `DEMO_SEED_ARGS=--verbose`, con `DEMO_SEED_PASSWORD`).
4. `up` con `DEMO_E2E=1` y el mismo `DEMO_SEED_PASSWORD`: `e2e` se recrea y ejecuta `playwright test -c playwright.live.config.ts`.
5. `logs e2e` y buscar `E2E_SUMMARY`, `E2E_FAILED` y `VQA_PROBLEM`.

### No verificable

- Las capturas, `report.json`, `visual-qa-*.json` y las trazas están en el volumen `lab-e2e`, inaccesible al controlador (solo logs).
- El build y el `up` de `e2e` y de los volúmenes nuevos no se han ejecutado.

Estado: infraestructura validada estaticamente (lint, vitest, tests de lab); build/up de e2e y de los volúmenes nuevos pendientes de ejecucion en el lab.
