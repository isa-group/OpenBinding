Status: PROPOSED for owner review (2026-10-22, revision 2: smaller scope, plans topology, Docker Compose). Replaces the
2026-10-21 draft.

# INTENT — OpenBinding

Owner: Francisco Javier Cavero López (`@javiercavlop`), ISA Research Group / SCORE Lab, Universidad de Sevilla.
This is the owner's document. Agents propose edits by PR; they never change it on their own. It says **why**
OpenBinding exists and **what** it must be; [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) says how it is built,
[`ROADMAP.md`](ROADMAP.md) says in which order, and [`constitution.md`](constitution.md) says which rules no change may
break. Section 12 lists the few decisions this version asks the owner to confirm.

## 1. Purpose

OpenBinding is to **QoS-aware service binding and composition problems** what SPHERE is to SaaS pricings.

It is the place where binding problems live as **versioned, citable artifacts** (a repository) and where they are
**solved with interchangeable engines and compared through reproducible experiments** (a laboratory), by groups
that work together on them. One canonical, extensible problem
language — BIM, the *Binding Instance Model* — describes every problem once. The gateway compiles it, sends it
only to engines whose declared capabilities cover it, and re-evaluates every answer itself, so results are
comparable across engines and verifiable by digest.

OpenBinding is a platform built for research, not a research script with a web front: the repository and the
laboratory carry the group's papers (OpenBinding at ICWS 2026, QACOBench, CLASP/OpenBinding4Placement, quantum
resource selection), and the collaboration features let groups work on them together. The SPHERE SoftwareX paper
already names OpenBinding as a project built on SPHERE's modular, versioned-artifact architecture; this document
makes that the explicit product model.

## 2. Four pillars, two enablers and six journeys

Four pillars answer a research need each; two enablers make them usable by groups and sustainable. A feature that
serves none of the journeys at the end of this section is not built (principle 12).

| # | Pillar | What it means | SPHERE analogue | Where it stands (code at 912648c) |
|---|---|---|---|---|
| P1 | **Repository** | Binding problems (BIM packages) as first-class artifacts: permanent link per problem, immutable versions with content digests, public or private, provenance (source paper, transformation, generator configuration and seed), citation, collections (suites such as the QACOBench ones), import/export, a public read API, and the metrics of each version (tasks, candidates, binding-space size, constraints, objectives) shown at a glance and compared between versions | Pricings, immutable versions, permanent links, collections, per-version analytics | Cases with sealed revisions, collections, resolver. Problems are not the centre of Explore, carry no metrics and are called "cases"; an organization library of components duplicates versioning |
| P2 | **Laboratory** | Runs (problem version × engine mode × budget) with the result rendered and, when there are several objectives, the trade-off set; studies (problems or a collection × engines × budgets × seeds) with the QACOBench protocol metrics (coverage, conditional binding yield, gap to the certified optimum, verdict reconciliation); a solver-aware generator that writes collections; frozen, citable results | Automated analysis of pricings (configuration space, PRIME); SPHERE has no counterpart for comparing solvers | Jobs, studies with runs, cells and analytics, generator; a separate decision-space workspace and a report editor with editions and publications duplicate what a run or a study shows |
| P3 | **Engines** | Engines declare capabilities in manifests; built-in and federated (remote) engines behind one protocol; conformance verification before activation; `INCOMPATIBLE` is a first-class, reasoned outcome; the gateway re-evaluates every binding and cross-checks termination claims | — | Registry, federation with destination policy, conformance probe, canonical re-evaluation all exist |
| P4 | **Language** | BIM core plus **Profiles** (problem families; a profile may extend another one and change how an instance is compiled, e.g. placement) and **Dialects** (alternative concrete syntaxes that can be developed and installed, e.g. BPMN), behind one language API and a developer kit | Pricing2Yaml syntax versions and upgrades | Profiles and dialects exist (qos-binding, placement, BPMN), with dialect submission and approval. Profiles cannot extend profiles; placement is special-cased inside the core profile; adapters must be deployed code; the API is scattered |

| # | Enabler | What it means | Where it stands |
|---|---|---|---|
| E1 | **Collaboration and administration** | Organizations, projects, members with roles, API keys, notifications and audit; administration of users, queues, engine health, storage and public content, on real data | Complete and audited; sponsorship and several dashboards add weight without a journey |
| E2 | **Plans** | OpenBinding's pricing lives in **SPHERE** (`sphere.score.us.es`); **SPACE** operates it (contracts, feature evaluation, usage limits) after linking its service to the pricing's permanent link; OpenBinding talks to both only through their **real clients** and renders the pricing with the group's **pricing-renderer** | The official `space-python-client` is wired but SPACE is on hold (zero calls); SPHERE is read through a home-made client with a private key; the pricing page is a custom component |

The journeys, in order of importance:

1. A paper's reader opens a problem, a collection or a published result from its permanent link and verifies it by
   digest, without an account (P1, P2).
2. A researcher imports or writes a problem, validates it live, seals a version and runs it on the compatible
   engines (P1, P2, P3).
3. A benchmark experimenter runs a study over a collection and several engines, reads the protocol metrics, exports
   them and publishes a frozen, citable result (P2).
4. An engine author registers a federated engine, passes conformance and receives the problems it can solve (P3).
5. A language extension author develops, tests and submits a profile or a dialect with the kit (P4).
6. A group creates an organization and its projects, invites members and works through API keys within its plan
   (E1, E2).

## 3. Users

| User | Needs |
|---|---|
| Researchers in service composition (primary) | find, author or import problems; validate them; run engines; compare and publish results with citations |
| Benchmark curators | publish suites (e.g. QACOBench) as public collections with provenance; keep them reproducible |
| Engine authors | register a solver once (built-in or federated), prove conformance, reach users |
| Language extension authors | develop a dialect or profile with a kit, test it locally, submit and install it |
| Experimenters and automation (QACOBench, scripts, MCP clients) | a stable public API, idempotent runs, resumable campaigns |
| Universidad de Sevilla members and students | sign in with CAS; the RESEARCH plan at no cost |
| Readers of a paper, reviewers | open a public problem, collection or published result, or verify a digest, without an account |
| Platform administrator (the owner) | accounts, moderation, queues, errors, storage, audit; plans are administered in SPHERE/SPACE |

The platform is open to any researcher. Universidad de Sevilla members obtain RESEARCH through CAS; other
institutions obtain larger plans by agreement (no checkout).

## 4. Principles

1. **Render, never dump.** No screen presents raw JSON, YAML, XML or an API response as its main content. Data is
   shown as SPHERE shows pricings: tables, cards, matrices and charts, informative but not overloaded. A source
   view is a secondary tab or an explicit download (constitution, Article 15).
2. **Describe once, solve anywhere.** One problem, compiled once, sent only to compatible engines; an engine that
   cannot take it yields a reasoned `INCOMPATIBLE`, never a silent failure.
3. **The gateway evaluates every binding.** Engine numbers are never trusted; termination claims are downgraded unless
   the engine mode guarantees them; proofs are cross-checked across engines.
4. **Problem identity is not execution identity.** Budgets, seeds and scalarization weights belong to the run, not to
   the problem.
5. **Everything citable is immutable and digest-addressed.** Permanent links survive renames and moves.
6. **Reuse the group's real clients.** SPACE through `space-python-client` and `space-react-client`, pricings through
   `pricing-renderer`, SPHERE through its public permanent-link API. Nothing of SPACE or SPHERE is re-implemented.
7. **Few concepts, one vocabulary.** The glossary (section 5) is the vocabulary of the UI, the docs and the specs.
8. **Extensible by contract, never by fork.** Profiles and dialects are versioned, pinned by digest, deterministic and
   reviewed; packages never carry executable code.
9. **Evidence honesty.** A check that did not run is reported as `NOT EXECUTED`; reports cite the SHA they ran on.
10. **Preview before merge.** Every change that affects the UI or the runtime is demonstrated in the NiPoGi lab before
    it reaches `develop`, and `develop` is always previewable before a release reaches `main`.
11. **Lean storage.** Nothing is kept without a retention rule; previews and work trees expire.
12. **Small surface.** A screen, an endpoint or a concept exists only if a journey of section 2 needs it; what no
    journey needs is retired, not polished (ADR-0020). Information is layered: the first view answers the journey's
    question, details are one step away.
13. **People read names, machines read digests.** Screens identify things by name, version number and date
    (`checkout-flow` v3, sealed 20 Aug 2026). SHAs, digests, hashes and fingerprints stay in the data and the API and
    appear only where verifying is the task: the Verify page, citation panels and export manifests, as one copyable
    value, never as a label, a card line or a column.

## 5. Glossary

The UI, the documentation and new specs use the left column. The HTTP API `v1` keeps its current resource names
(right column) until a `v2` is decided (owner decision); the API documentation shows both.

| Term | Meaning | API `v1` resource |
|---|---|---|
| Problem | a binding problem: a BIM package with a stable identity inside a project | `cases` |
| Problem version | an immutable, sealed version of a problem, with its compiled form | `cases/{case}/revisions` (+ snapshot) |
| Collection | an ordered, versioned set of exact problem versions (a suite) | `collections` |
| Run | one execution of a problem version by one engine mode with one configuration | `jobs` |
| Study | an experiment over problems × engines × parameter sets × seeds; each execution of it is a study run made of cells | `studies`, `runs`, `cells` |
| Published result | a frozen, public snapshot of a study run or a collection, with a permanent link, a digest and a citation | `publications` (simplified) |
| Engine | an exact engine revision with modes and declared capabilities | `engines` |
| Engine deployment | a registered, verified remote (federated) engine endpoint | `engine-registrations` |
| Profile | a problem family: roles, compiled output, capability vocabulary; may extend another profile | `profiles` |
| Dialect | a concrete syntax for resources of a profile (e.g. BPMN for the workflow) | `dialects` |
| Plan | the SPACE subscription of an account under OpenBinding's SPHERE pricing | `users/me/usage`, `pricing-token` |

A problem version's resources (application, candidate catalog, constraints, optimization, workflow) are
content-addressed inside it; they are not a catalogue of their own (ADR-0020).

## 6. Scope: what stays, changes, merges and goes

Derived from the audit of the 86 screens and the 208 API operations at 912648c, and revised on 2026-10-22 at the
owner's request to keep only what is practically useful for the pillars (ADR-0020). `ROADMAP.md` schedules it.

| Area | Decision | How |
|---|---|---|
| Public home and Explore | change | Centred on the repository: Problems, Collections, Published results and Engines, as cards with metrics |
| Cases | rename to **Problems**, rebuild the page | Header with metrics and version selector; tabs Overview (rendered workflow, candidate × feature matrix, constraints, objective), Runs (by engine, comparison), Versions (history; compare shows changed resources and metric deltas), Source (files, editor, compiled form), Settings |
| Workbench (public and project) and composer | merge into the **problem editor** | One editor with form and source modes, live validation and compatible engines; "Try it" without an account; the composer retires |
| Organization library, project resources, project library | **retire** as catalogues | Resources stay content-addressed inside each problem version; reuse means duplicating a problem or generating a collection |
| Snapshots and project files | hide | The compiled form is in the Source tab; blobs stay internal; no Files page |
| Collections | keep, promote | Suites with aggregate metrics; the QACOBench suites become public collections |
| Jobs | rename to **Runs**, render | Binding table, QoS against bounds, objective breakdown, engine-claimed versus gateway-evaluated, logs in a collapsible panel; with several objectives, the trade-off set as a table and a two-axis chart |
| Studies | keep, simplify | Builder (problems or a collection × engines × budgets × seeds), progress, and one results view with the QACOBench protocol metrics, verdicts, gaps and times; CSV/JSON export; a cell is a run |
| Decision-space workspace (Analysis area) | **retire** | Its useful part, the trade-off set of a multi-objective run, moves to the run and study pages. Weights, influence cells, duals, hulls, hypervolume, journey replay and shortlists go |
| Reports, editions and publications | replace with **published results** | "Publish" freezes a study run or a collection into a public, citable record (permanent link, digest, citation) with a Zenodo-ready export; no document editor |
| Resolve and verifier | merge into **Verify** | One page: open a permanent link or a digest, or check a file |
| Generator | keep, move to the laboratory | Writes problems into a collection with provenance; solver-aware option |
| Engines catalogue, detail, registration | keep | Manifests as capability matrices; conformance report rendered; onboarding wizard for federated engines |
| Language pages and extensions | keep | One Language hub: profiles with the `extends` graph, dialects, the extension lifecycle; schemas as secondary |
| Examples | merge | Into Explore as the public "BIM examples" collection |
| Pricing page and account usage | replace | `pricing-renderer` with the SPHERE pricing; the account Plan page shows the subscription and its usage from the SPACE pricing token |
| Organization sponsorship | **retire** | Plans are per-account SPACE contracts; an administrator assigns RESEARCH or LAB by agreement (D3) |
| Administration | keep, focus | Users, queues and engine health, storage and retention, audit, moderation of public content, on real data |
| System states screen (`/app/system/states`) | development only | Not in production builds |
| Legacy pricing code (`sphere_client.py`, `pricing_catalog.py`, deprecated `/v1/pricing`, admin pricing validation, SPACE deployment client, contract-renewal sweeps) | remove | Replaced by the plans module over the official clients (ADR-0015) |
| Kubernetes manifests (`deploy/kubernetes/`) | remove | Docker Compose deploys every environment, production included (ADR-0021) |
| SHAs, digests, hashes and fingerprints in the interface | **reduce** | Today they label cards, lists, versions, runs, studies and reports (`sha256-2222…2222`, "content", "version", "matrix", "edition fingerprint"). They give way to names, version numbers and dates; a digest appears only on Verify, in citation panels and in export manifests, as one copy button (principle 13) |

## 7. Measurable objectives

Targets are proposals; the owner may change them (section 12).

| Id | Objective | Metric and target | Today |
|---|---|---|---|
| O1 | Language stability | 100 % of the checked-in corpus compiles; IR identical across directory, ZIP and permutations | 82/82 |
| O2 | Verdict integrity | 0 contradicted verdicts per campaign (UNSAT versus validated binding; OPTIMAL beaten) | enforced in QACOBench 1.1.1 |
| O3 | Experiment reproducibility | a third party re-runs QACOBench 1.1.1 from Zenodo and a tag and obtains identical verdict counts and gaps within ±0.01 | reference recorded |
| O4 | Reproducibility inside the platform | the seven QACOBench suites are public collections and the reference protocol runs as a study with the paper's verdict counts | not possible yet |
| O5 | Rendering | 0 screens whose main content is raw JSON/YAML/XML or an API response (hygiene test plus ui-qa) | 15 offenders listed in `ROADMAP.md`; 3 of them go with retired screens |
| O6 | Platform reliability | `develop` CI green on ≥ 95 % of days; no flaky test older than 7 days | not measured |
| O7 | Delivery flow | median change ≤ 300 diff lines, merged into `develop` the day it is ready; every UI/runtime change previewed | not measured |
| O8 | Security | 0 open high or critical findings at each release to `main` | open items in `docs/qa/SECURITY_REVIEW.md` |
| O9 | Interactive latency | p95 of `POST /v1/jobs` (accept) ≤ 500 ms and of `POST /v1/validate` ≤ 2 s for corpus-size packages in the lab | not measured |
| O10 | Plans | 100 % of plan decisions go through the SPACE port; 0 SPACE/SPHERE logic re-implemented (architecture test) | SPACE on hold |
| O11 | Storage | lab disk below 70 % of its quota; previews expire after 7 idle days; merged work trees archived within 24 h | 47 GB lab directory, 70 stale work trees |
| O12 | Surface | at most 45 routed screens, and each journey of section 2 completes in at most 5 screens | 86 screens |

## 8. Non-goals

- Billing, payments, checkout, credits, compute units or invoices. SPACE may track usage limits that the pricing
  declares; OpenBinding never charges.
- Automatic engine selection (a separate, future research project).
- Hosting SPHERE or SPACE in production, editing the pricing in OpenBinding, or a contract console of its own.
  Until `space.score.us.es` runs the latest SPACE release, the lab and previews run a local SPACE of that release,
  linked to the pricing in `sphere.score.us.es` (ADR-0015).
- Kubernetes or any orchestrator other than Docker Compose (ADR-0021).
- A document editor, a multi-criteria decision workbench or a second versioned catalogue of problem parts (ADR-0020).
- Scheduling, probabilistic QoS, risk, telemetry or runtime adaptation in `qos-binding/v1` (a future profile may add
  them).
- Executing user-supplied code inside the gateway; extensions are declarative or run as separate, verified services.
- Distributed exactly-once execution (`docs/IDEMPOTENCY.md` states the real guarantees).
- Datasets, raw campaign results, QA screenshots or design prototypes in Git.

After the extraction, OpenBinding never edits BIM semantics directly; it bumps the pinned release of
`isa-group/bim-toolchain` and runs the consumer contracts (ADR-0004).

## 9. Hard constraints

- Repository `isa-group/OpenBinding` is public; licence CC BY 4.0 today (section 12).
- Data never in Git; tests, seeds, the lab and previews use synthetic data and synthetic accounts only.
- SPACE is the only source of plan decisions and is reached only through its official clients; SPHERE is read only
  through its public permanent-link API at `sphere.score.us.es`, in every environment; the pricing is changed only in
  SPHERE.
- Docker Compose deploys every environment: development, laboratory, previews and production.
- Resources: NiPoGi (14 GiB RAM, lab memory cap 9 GiB, lab disk quota 300 GB).
- Runtimes: Python ≥ 3.11, Node 22 for the frontend (jsdom 30 needs it) and Node 20 for `engines/minizinc-csp`, JDK 21
  in CI with `binding-core` targeting Java 8 bytecode, React 19.
- Only the owner merges into `main` and orders production deployments.

## 10. Signals the factory must watch

- CI and nightly gate failures; flaky tests (`docs/qa/FLAKY_TESTS.md`).
- Architecture ratchets (`ALLOWED_LEGACY`, `GATE_LIFECYCLE_LEGACY`, `MAX_LINES`) and module-boundary violations.
- Diffs of `docs/openapi.json`, `schemas/**`, `bim-toolchain/contracts/**` and language manifests (contract changes).
- `compilerDigest` changes and BIM consumer-contract failures.
- MiniZinc/Gecode drift between the image and the QACOBench run manifest.
- SPACE/SPHERE client and image versions; SPACE synchronization status and contract migrations; the pricing
  version that SPACE has activated.
- Raw-render hygiene violations and ui-qa findings.
- Lab memory and disk headroom, expired previews, archived work trees.
- Dependency advisories and unpinned GitHub Actions.
- Spec drift: code without `[impl->req~…]` tags, specs with `GAP` evidence.

## 11. Decisions agents may NOT take without a CRP (owner decision)

1. A breaking change to a public contract: `docs/openapi.json`, `schemas/bim/v1/**`, the engine protocol,
   `bim-service`, language manifests, the language API.
2. BIM semantics, IR digests, goldens, `compilerDigest` meaning, BIM MAJOR/MINOR bumps, the pinned BIM release.
3. Roles, permissions, API-key scopes, visibility rules, the mapping from operations to plan features and limits.
4. Any new external integration; any change of SPACE/SPHERE client versions, sync policy or pricing content.
5. Destructive migrations, data deletion, retention changes, rewriting stored evidence.
6. Licences, third-party redistribution (including the OMG BPMN XSDs), publishing (GitHub repos, Zenodo, PyPI,
   images).
7. The MiniZinc bundle version, engine default budgets, or anything that changes QACOBench reference results.
8. New runtime dependencies with network access; new third-party Actions, hooks, skills or MCP servers.
9. Installing, approving or retiring a language extension (profile, dialect, adapter service) in production.
10. Edits to `INTENT.md`, `constitution.md`, `REVIEW.md`, `ROADMAP.md` milestones, `CODEOWNERS`,
    `.agentic/project.yaml`, ADR status.
11. Production deployment, `main` merges or tags.

## 12. Decisions for the owner in this review

Each has a default that applies if the owner accepts this document as is. D5 and D8 were decided by the owner on
2026-10-22.

| # | Decision | Default |
|---|---|---|
| D1 | UI vocabulary Problem/Run instead of Case/Job (API `v1` unchanged) | yes |
| D2 | Licence: Apache-2.0 for code, CC BY 4.0 for documentation and data | keep CC BY 4.0 until the owner decides |
| D3 | Organization plans | retire sponsorship; plans are per-account SPACE contracts, RESEARCH and LAB assigned by agreement |
| D4 | Renewable usage limits enforced through SPACE when the pricing declares them | yes, only solver hours per month (pricing 0.2.0) |
| D5 | SPHERE and SPACE outside production | decided: SPHERE at `sphere.score.us.es` everywhere; a local SPACE of the latest release (1.7.1), linked to that pricing, until `space.score.us.es` runs it |
| D6 | SPACE synchronization policy for OpenBinding's service | `all_last` (every subscription follows the latest published pricing) |
| D7 | Targets of section 7 | as written |
| D8 | Retire the decision-space workspace, the report editor, the component library, the composer and sponsorship (ADR-0020) | decided: yes |
| D9 | Pricing 0.2.0, the result of the pricification cycle in `docs/pricing/`, published in SPHERE | yes |
