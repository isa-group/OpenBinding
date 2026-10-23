Status: PROPOSED for owner review (2026-10-22, revision 2). Articles 6, 15–19 are new or amended in this version;
revision 2 adds 6.8, 6.9 and 15.5 and amends 15.1 and 16.6.

# Constitution — OpenBinding

Non-negotiable rules for every change to this repository, by agents or humans. MUST/MUST NOT are binding; a change
that breaks one is blocked (`REVIEW.md`). Only the owner amends this document. Each rule names how it is enforced
today (`Enforced:`) or that enforcement is still missing (`GAP`). Gates G1–G12 are those of the factory
(`docs/GATES.md` of `agentic-factory`).

## Article 1 — Spec first

1.1 Every behaviour change MUST start as an OpenSpec change (`openspec/changes/<id>/proposal.md`, `tasks.md`, delta
specs) with EARS requirements carrying OpenFastTrace ids `req~<capability>-<slug>~<rev>`, before production code.
1.2 Living specs (`openspec/specs/**`) MUST describe the system as it is after each merge (archive step).
1.3 A changed requirement MUST bump its revision (`~1` → `~2`); ids are never reused.
Enforced: G1 (`openspec validate --strict`), G2 (EPIC ≥ 2/3). GAP: OpenSpec CLI not yet installed in CI.

## Article 2 — Test first

2.1 A failing test (red) MUST exist before the fix or feature (green); the PR shows both runs (G3).
2.2 Acceptance tests live in `acceptance/` and are written only by the test-designer from the spec and public
interfaces; once frozen for a change they MUST NOT be edited by the implementer (G4).
2.3 A test MUST NOT be weakened, skipped or marked `xfail` to make a change pass; existing strict `xfail` stay
strict.
Enforced: G3/G4 by the gate runner. GAP: `acceptance/` does not exist yet.

## Article 3 — Traceability

3.1 Code and tests that implement a requirement MUST carry `[impl->req~x~N]` / `[utest->req~x~N]` tags when they are
created or changed; commits carry `Change:` and `Refs:` trailers.
3.2 Every requirement MUST state its evidence (tests/code) or `GAP`.
Enforced: G6 (OpenFastTrace). GAP: no tags exist yet in the code base.

## Article 4 — Contracts

4.1 `docs/openapi.json` is the HTTP contract of the gateway. It MUST be regenerated and committed in the same change
as any contract change (`python tools/dump_openapi.py --check` in CI).
4.2 `schemas/bim/v1/**`, `schemas/engine-contract.openapi.yaml` (`bim-engine/v1`) and the `bim-service` OpenAPI are
public contracts. A breaking change MUST go through a CRP and a version bump.
4.3 Every error body the gateway builds MUST be `application/problem+json` with a stable `code`; a 422 MUST carry
non-empty `diagnostics` (`docs/ERRORS.md`). Clients branch on `code`, never on message text.
4.4 Contract tests MUST cover each public operation (G7).
Enforced: CI `dump_openapi.py --check`, `tests/test_openapi_contract.py`, `tests/test_b4_problem_schema.py`.
GAP: Schemathesis/property-based contract fuzzing.

## Article 5 — BIM boundary

5.1 The platform MUST reach the language only through `bim_client.BimPort`, built in
`openbinding_gateway/integrations/bim.py`; no other module imports `bim_core`/`bim_client`.
5.2 After the extraction to `isa-group/bim-toolchain`, OpenBinding MUST depend on an exact released BIM version (a
tag/wheel pin), never on a path, editable install or vendored copy; upgrades are explicit changes that run the
consumer-contract tests on both sides.
5.3 BIM MUST NOT learn platform concepts (accounts, organizations, jobs, pricing, persistence).
5.4 An IR is valid only for the toolchain that produced it (`compilerDigest`); the platform MUST refuse a mismatching
IR with a stable error rather than reinterpret it.
Enforced: `tests/test_bim_boundary.py`, `tests/test_bim_consumer_contract.py`, `bim-toolchain/packages/bim-core/tests/test_boundary.py`.
GAP for 5.2: today `openbinding-gateway/pyproject.toml` uses editable path sources.

## Article 6 — Architecture

6.1 Dependencies point `routes → services → repositories/integrations → db`; `services/`, `domain/`, `jobs/` MUST NOT
import `routes`.
6.2 Legacy allow-lists and size ceilings MUST only shrink (`ALLOWED_LEGACY`, `GATE_LIFECYCLE_LEGACY`, `MAX_LINES`).
6.3 Plan capabilities MUST be read only through the plans port (today `services/entitlements.py`).
6.4 Engines MUST be separate services that receive only the IR (never source packages) over `bim-engine/v1`.
6.5 New backend code MUST live in a module of `docs/ARCHITECTURE.md` §4 (`modules/<context>/{domain,application,
adapters}`); a module MUST NOT import another module's `domain` internals or `adapters`, only its `application`
interface; `domain` MUST NOT import FastAPI, SQLAlchemy, HTTP clients or any adapter.
6.6 New frontend code MUST follow the feature-sliced layout of `docs/ARCHITECTURE.md` §5; a feature MUST NOT import
another feature; pages compose features; only `shared/api` talks HTTP.
6.7 Moving existing code into modules is a behaviour-preserving `refactor/<id>` change with characterization tests;
it MUST NOT be mixed with feature work.
6.8 A new routed screen, public endpoint or domain concept MUST name the journey of `INTENT.md` §2 it serves; the
number of routed screens MUST NOT exceed the budget of INTENT O12 (ADR-0020).
6.9 Every environment, production included, MUST be deployable with the Docker Compose files of the repository
(`docker-compose.yml`, `deploy/compose/`); no manifests of another orchestrator are kept (ADR-0021).
Enforced: `tests/test_architecture_layers.py`. GAP for 6.5–6.6: import-linter contracts for modules and an ESLint
boundaries rule for the frontend. GAP for 6.8: a route-registry count test. GAP for 6.9: `docker compose config` of
every environment in CI.

## Article 7 — Data

7.1 Datasets, raw experiment results, generated corpora, QA screenshots and design prototypes MUST NOT be committed.
They live in Zenodo deposits, the `data/icsoc-original-dataset` branch, or outside the repository.
7.2 Tests, seeds, fixtures, the lab and demos MUST use synthetic data and synthetic accounts only; no personal data,
no production data, no real credentials.
7.3 Third-party data MUST keep its attribution and licence notices.
Enforced: `.gitignore` (ignores `experimentation/icsoc/original_dataset/`, `docs/frontend-qa/`, `docs/design-handoff/`, generated
suites and `.artifacts/`); G10 file-ownership check. The source inputs under `datasets/sources/` stay versioned, as the
QACOBench 1.1.1 release decided; the ICSOC dataset lives on `data/icsoc-original-dataset`.

## Article 8 — Reproducibility of experiments

8.1 Every campaign MUST record a run manifest: image identities, solver versions, engine manifest digests, seeds,
budgets, configuration hashes, host information.
8.2 Solvers used in experiments MUST be pinned by version and checksum (e.g. the MiniZinc bundle in the
`minizinc-csp` image).
8.3 Reference results are versioned under `experimentation/qacobench/reference/<version>/` and MUST NOT be edited by
hand; they change only by re-running the campaign in an approved change.
8.4 Randomised engines and generators MUST be deterministic for a given seed and inputs.
Enforced: QACOBench `capture_run_manifest.py`, the `campaign.py` manifest-digest check, the pinned MiniZinc 2.8.7 bundle
in `engines/minizinc-csp/Dockerfile`, `evaluate_results.py` acceptance.

## Article 9 — Numeric semantics of engines

9.1 The gateway MUST NOT trust engine numbers: every returned binding is re-evaluated by the canonical evaluator and
only the decision survives.
9.2 A termination claim (`OPTIMAL`, `INFEASIBLE`) MUST be downgraded unless the engine mode declares that guarantee.
9.3 Heuristic engines MUST NOT claim `OPTIMAL` or `INFEASIBLE`.
9.4 Any change to evaluation, aggregation, normalisation or tolerance semantics is a BIM MAJOR change (Article 5).
Enforced: `tests/test_v1_job_guarantees.py`, `bim-core` goldens, `engines/binding-core` conformance tests.

## Article 10 — Security

10.1 Secrets MUST NOT appear in the repository, images, logs, problem documents, frontend bundles or agent output.
10.2 Every object access MUST be authorised server-side; a resource the caller may not see MUST be answered exactly
as a missing one (same status and body: 404 for snapshots, jobs, engines and digests; `403 organization_forbidden`
for organizations and projects), so that existence is never disclosed.
10.3 Outbound calls to user-supplied endpoints MUST pass the destination policy (HTTPS, public addresses only, pinned
resolution, no redirects).
10.4 `APP_ENV=prod` MUST refuse insecure configuration (wildcard/empty CORS, missing/short JWT secret, plain-HTTP
federation or BIM token).
10.5 Dependencies MUST be locked (`uv.lock`, `pnpm-lock.yaml`); images pinned by digest; GitHub Actions pinned by
commit SHA; no unaudited third-party hooks, skills, MCP servers or Actions.
10.6 Untrusted archives/XML MUST be parsed with bounded size, ratio and no external entities.
Enforced: `tests/test_prod_insecure_flags.py`, `tests/test_b2_cors.py`, `tests/test_engine_registry_service.py`,
`tests/test_package_bomb.py`, `tests/test_container_hardening.py`. GAP: Actions in `.github/workflows/ci.yml` are pinned
by major version; no secret scanning, Semgrep or dependency audit in CI.

## Article 11 — Accessibility

11.1 The frontend MUST meet WCAG 2.2 level AA for every shipped screen, at desktop (1440×900) and mobile (390×844).
11.2 Interactive controls MUST be keyboard operable, have accessible names, and a minimum 24 px target.
Enforced: `frontend/src/test/mobileTouchTargets.test.ts`, live Playwright screen checks (`frontend/e2e/`).
GAP: no automated axe/WCAG scan, no `eslint-plugin-jsx-a11y`.
WCAG 2.2 AA is the target level (owner may raise it).

## Article 12 — Internationalisation

12.1 The UI and documentation are English; no i18n framework exists. New UI text MUST be English and kept in
components so a later extraction is mechanical.
No Spanish UI is planned in `ROADMAP.md`; if one is, an i18n library is adopted before more screens are added.

## Article 13 — Performance and resource budgets

13.1 Existing technical limits MUST NOT be raised without a CRP: per-account concurrency (`MAX_CONCURRENT_JOBS_PER_USER`,
default 8), JSON body 16 MiB, generator ≤ 100 features and ≤ 1,000,000 candidate-feature values, `bim-service` 256 MiB in the lab.
13.2 Changes on hot paths (compile, job submission, re-evaluation, corpus-size uniqueItems) MUST include a measurement.
Latency targets are INTENT O9; they are measured in the lab before a release.

## Article 14 — Flow and integrity of history

14.1 Changes are small (≈ ≤ 300 diff lines excluding tests/generated), one capability, on `feat|fix|spec|refactor/<id>`.
14.2 Agents MUST NOT push, merge, approve, tag or retarget `main`, or force-push.
14.3 Commits follow Conventional Commits with `Change:`/`Refs:` trailers, no AI-assistance markers, no co-author trailers.
14.4 Reports MUST state only what was executed, with the SHA; unexecuted checks are `NOT EXECUTED`.
14.5 When local work conflicts with a commit of the owner, the owner's commit wins.

## Article 15 — Render, never dump

15.1 No screen MAY present raw JSON, YAML, XML or an unprocessed API response as its main content. Results,
study metrics, published results, manifests, logs and diagnostics MUST be rendered with the components of the rendering catalogue
(`docs/ARCHITECTURE.md` §5.3): tables, cards, matrices and charts.
15.2 A source view is allowed only as a secondary, labelled tab or an explicit download, never as the default view,
and it MUST use the read-only code viewer of the catalogue.
15.3 Engine logs MUST be shown as a collapsed, searchable panel below the rendered result; diagnostics MUST be
grouped by resource and pointer with their stable `code`.
15.4 Screens MUST stay informative without overloading: each screen has one primary question it answers, shows at
most one dense table above the fold and puts details behind tabs or disclosure.
15.5 Screens MUST identify problems, versions, collections, runs, studies and published results by name, version
number and date. SHAs, digests, hashes, fingerprints and UUIDs MUST NOT appear as labels, card lines or columns; a
digest MAY appear only on the Verify page, in citation panels and in export manifests, as one copyable value (INTENT
principle 13, `docs/ARCHITECTURE.md` §5.4).
Enforced: GAP — `frontend/src/hygiene.test.ts` rule that fails on `JSON.stringify` rendered in JSX or `<pre>`
outside the source-view components, and on digest-shaped strings or UUIDs outside the components of §5.4; ui-qa
screenshots in G12.

## Article 16 — External platforms through their real clients

16.1 SPACE MUST be reached only through its official clients: `space-python-client` in the gateway (plans module)
and `space-react-client` in the browser (token-only mode). No module MAY call SPACE's HTTP API directly.
16.2 SPHERE MUST be read only through its public permanent-link API; OpenBinding MUST NOT hold a SPHERE API key or
write to SPHERE. The pricing is changed only in SPHERE.
16.3 Pricings MUST be rendered with `pricing-renderer`; no custom pricing table MAY be added.
16.4 Client libraries and SPHERE/SPACE images MUST be pinned to exact versions; upgrading them is a change with
contract tests against the pinned images in the lab.
16.5 A SPACE API key MUST NEVER reach the browser; the browser receives only the user's pricing token.
16.6 Unit and CI tests MUST NOT reach SPACE or SPHERE over the network; they use a recorded pricing and a fake plans
port. The lab, previews and production read the pricing from SPHERE at `sphere.score.us.es` and MUST NOT write to
it; until the owner switches them to `space.score.us.es` (INTENT D5), they run their own pinned SPACE.
Enforced: GAP — architecture test forbidding HTTP clients aimed at SPACE/SPHERE outside the plans module; a test
that the unit suites open no connection to SPACE or SPHERE; lab `pricing` profile with a pinned SPACE image.

## Article 17 — Language extensions

17.1 A BIM package MUST NEVER carry executable code; extensions are installed contracts (profiles, dialects,
adapters) pinned by `{namespace,name,version,digest}`.
17.2 Lowering MUST be deterministic: the platform lowers twice and requires byte-identical RFC 8785 output before
installing or using an adapter.
17.3 A profile that extends another MUST declare the evaluation semantics of everything it adds, implemented in the
canonical evaluator, so that the gateway can re-evaluate every binding of that profile (Article 9).
17.4 The compiled IR MUST record the full profile chain, the dialects and every adapter digest; a snapshot MUST keep
what is needed to re-check a binding without re-running an adapter service.
17.5 Declarative (tier 1) adapters MUST be total and bounded in size and time; adapter services (tier 2) MUST pass
the destination policy of Article 10.3 and a determinism and conformance check before approval.
17.6 Installing, approving or retiring an extension in production is an owner decision (CRP).
Enforced: bim-core double-lowering check for installed dialects. GAP: `extends`, tiers 1–2 and the extension
lifecycle (`ROADMAP.md` M5).

## Article 18 — Storage and retention

18.1 Every class of stored data (database rows, blobs, run logs, previews, lab volumes, work trees, caches) MUST
have a retention rule in `docs/ARCHITECTURE.md` §10 before the code that creates it is merged.
18.2 Sealed, published or cited data MUST NOT be deleted by retention; it can only be withdrawn from discovery.
18.3 Deletion of anything else happens only through the documented maintenance operations (admin purge, factory
archive and retention jobs, `labctl destroy`), never ad hoc.
Enforced: `/v1/admin/maintenance/preview|purge`. GAP: retention table and lab/factory retention jobs (`ROADMAP.md` M0).

## Article 19 — Preview before merge

19.1 A change that affects the UI or the runtime MUST be deployed to a NiPoGi lab preview and pass G12 (Playwright
flows and ui-qa screenshots, desktop and mobile) on its head SHA before it is merged into `develop`.
19.2 `develop` MUST always be deployable to the develop preview; a release PR to `main` MUST name the preview and the
SHA the owner can review.
Enforced: G12. GAP: develop preview reachable from the owner's devices (`ROADMAP.md` M0).

## Amendments

Only the owner amends this constitution, by a PR that edits this file and records an ADR when the rule is architectural.
