# Binding decision workspace

The integrated `/app/analysis` workspace compares stored evidence, makes a recommendation under explicit priorities, and saves a reproducible draft decision. It never launches a solver or evaluates new bindings. Playground, project Jobs, Account execution history and project Analytics expose the same **Open analysis** action.

## Evidence and ranking contract

The backend owns eligibility, normalization, ranking, geometry and explanations. Every source is owner checked, including cached reads, exports and background results. API keys must also have the relevant engine and organization/project grants. Pooling requires matching verified model and evaluator identities; the pinned model includes objective identities and directions. Legacy evidence lacking those identities remains inspectable individually.

Identical assignments and evaluations share one stable binding identity and retain every occurrence. Distinct assignments at the same objective vector remain distinct. Contradictory evaluations are rejected. Malformed, incomplete, hard-infeasible and unknown-feasibility evidence remains inspectable with exclusion reasons. Complete, known-feasible evaluations alone enter recommendations. Varying soft penalties participate in quality without independently excluding a binding.

For each nonconstant canonical loss dimension, the complete known-feasible archive fixes its minimum and maximum. Its normalized loss is `z = (loss − minimum)/(maximum − minimum)`. Filtering, brushing and requirements do not change these anchors. Priorities are normalized to sum to one; all-zero priorities reset to equal priorities. The default balanced rule minimizes `(max(w*z), sum(w*z))` lexicographically. Exact ties share a rank and co-winner status; the next alternative is the next distinct score group and can be dominated. Stable IDs only order equal rows for display. Near ties use the disclosed `1e-10` numerical tolerance and never become exact ties.

Advanced rules include weighted sum, weighted ideal distance, Chebyshev distance, reference distance, TOPSIS and original scalar/lexicographic model ordering when available. Model scores remain separately inspectable. Zero weights can permit dominated ties. Explanations expose canonical and raw values, anchors, weighted contributions, comparison deltas, assignments, eligibility and provenance. Requirements are inclusive and compare stored raw values directly when raw units are selected.

The versioned receipt contains source identities, archive revision, preferences, requirements, shortlist and authoritative explanations. PostgreSQL sources identify result JSON with SHA-256 of its stored JSON text (`resultDigestKind: stored-json`); the fallback uses canonical JSON (`canonical-json`). These are explicitly different digest formats. Analysis version 3 includes this identity contract. Reopening a report revalidates access and source identities. A stale or unavailable archive leaves the recorded snapshot readable with a stale-evidence notice.

## Views and geometric meaning

| View | What to inspect | Evidence boundary |
|---|---|---|
| Decision | Balanced recommendation, co-winners, next score group, editable priorities/requirements, four-binding shortlist | Best under the stated rule within this archive |
| Budgets | Two-dimensional attainment staircase, hidden requirements, witnesses, analytic exclusions | One stored binding must satisfy every requirement; uncovered means unknown |
| Pareto | Exact full-dimensional dominance, fronts/layers, linked projections, parallel coordinates, Voronoi and 2D hypervolume | Projections can have different dominance; cell area is coverage under a metric |
| Preferences | Exact weighted-sum winner intervals/power slices; finite scenario sweep for other rules | Weight slices retain fixed hidden priorities; scenario counts are not probabilities |
| Evidence | Every included/excluded record, full evaluation, provenance, violations and recorded trajectories | Neighborhood evidence describes stored alternatives, not global robustness |

A budget location is attained only when the same feasible binding meets displayed and hidden requirements simultaneously. Its staircase ignores its own plotted requirements while constructing the view, so clicking changes eligibility without prematurely deleting witnesses. A necessary lower bound `a·f >= L`, with nonnegative coefficients in minimized budget coordinates, can prove budgets with `a·b < L` impossible. Ordinary outcome constraints are separate: an actual-cost upper bound of 100 does not exclude a budget of 150. Unsupported, hidden-dimensional and nonlinear implications are disclosed rather than shaded speculatively.

Voronoi cells describe proximity in the selected normalized objective projection. Supported affine hard constraints can clip cells; soft constraints are shown separately. Areas are geometric coverage, never a quality ranking or probability. Exact two-dimensional hypervolume uses the disclosed fixed normalized reference `(1.1, 1.1)` only when exactly two comparison dimensions vary.

Power cells use affine weighted-sum score functions and half-plane clipping. Three selected weights form a triangle with their total mass fixed; all other objectives contribute a fixed affine offset. Two weights produce exact intervals. Shared winners and empty cells are retained: an empty cell means that binding never wins in this slice. The displayed power sites are transformed score coefficients, not objective-space bindings. Entering the power map explicitly switches to weighted sum.

## Computational limits

All operations are polynomial in the supplied archive size `N`, objective count `m`, and stored assignment size. No claim is made to enumerate or solve the unexplored combinatorial space.

| Operation | Cost / explicit bound |
|---|---|
| Preference ranking | Full scan and sort, `O(Nm + N log N)` |
| Selected dominance / objective neighbors | Full archive scan; at most 50 returned neighbors |
| Assignment neighbors | Full archive scan using declared Hamming/Gower distance |
| 2D attainment and fast fronts in 1–3 varying dimensions | Sorting/sweeps, including compressed coordinates in 3D |
| General Pareto layers | Exact pairwise comparisons, worst case `O(N²m)`; no dense pairwise matrix |
| Foreground general layers | At most 2,000 candidates |
| Background general fronts/layers | Separate durable task table and analysis queue; cancellable, leased, atomic completion |
| Complete preference tessellation | At most 300 distinct affine functions |
| Larger preference map | Selected binding against all competitors, maximum 2,000,000 clipping-vertex operations; otherwise explicitly unavailable |
| Voronoi | At most 300 distinct sites, disclosed work budget |
| Dense overview | Canvas density bins with total counts; SVG highlights/boundaries; complete-archive brushing and paginated ranking |

Canonical matrices and interned assignment references occupy a bounded two-archive process cache. Project Jobs loads metadata summaries and hydrates only the selected job, so opening that entry point does not download every archive. Selected evaluation details are hydrated on demand; complete exports stream rows. Source metadata and result checksums are revalidated on every request, including cache hits. Backend CPU work runs outside the shared async event loop with bounded concurrency. Dramatiq uses a separate single-thread analysis worker. Expired leases are requeued, duplicate delivery cannot overwrite completion, cancellation publishes no partial front, and the source revision is checked again before final publication.

Large exact quadratic layers remain expensive despite being polynomial. The 100,000-binding scenario tests exact rankings, pagination, dense rendering and the fast front; it does not require quadratic layers to finish. The UI always labels pending or unavailable results.

## Population and reproducible checks

Start the development gateway, solver worker and analysis worker with the existing development Compose profile. Apply database migrations using the project's normal startup workflow. Then run:

```bash
# Normal bounded live jobs plus diagnostic gallery
./tools/seed_dev.sh
# Additive diagnostic gallery; no engine calls
./tools/seed_dev.sh --analysis-only
# Opt-in genuine live jobs, background lifecycle and unique 1k/10k/100k archives
./tools/seed_dev.sh --analysis-full

cd openbinding-gateway
.venv/bin/python tools/verify_analysis.py --scale --docker-memory
.venv/bin/pytest tests/test_archive_analysis.py tests/test_seed_analysis.py tests/test_studies_platform.py tests/test_api_keys.py -q
.venv/bin/python tools/dump_openapi.py --check
cd ../frontend
ANALYSIS_LIVE=1 pnpm exec playwright test e2e/analysis-live.spec.ts
pnpm test --run
pnpm build
```

The wrapper also supports Docker execution directly. The live browser suite uses `http://localhost:5173` and gateway port 8000, real authentication and the generated manifest; it does not mock analysis responses. It intentionally creates a draft Report and one genuine Playground job. Use a development database, as for population itself.

Diagnostic jobs contain explicit generated assignments evaluated by the canonical evaluator, with separately recorded evaluated/retained counts. They are labeled **not solver benchmarks**, carry `UNKNOWN` solver termination, and contain no invented solve timings. Live MiniZinc and Random Search jobs use normal job creation and execution and retain genuine termination, traces and reevaluation. Random Search records 128 evaluations and one retained binding; MiniZinc retains one binding and leaves the unreported evaluation count null. A failed engine or background check is a manifest coverage gap. Scenario identities include inputs, engine/evaluator identity, generator version and parameters; unchanged sources are reused and changed semantics create new immutable versions. Study execution delegates subsequent cells exclusively to the production worker, avoiding competing coordinators.

## Feature-to-scenario coverage

The generated [scenario manifest](../../openbinding-gateway/tools/analysis-manifest.json) contains actual job IDs, archive revisions, analysis URLs, draft Report URLs, observed timings and background task identities. IDs are local deployment artifacts and will differ after a fresh population.

| Feature / edge case | Persisted scenario or independent check |
|---|---|
| Canonical evaluations, mixed directions, penalties, infeasibility | `tradeoffs`, `constraints`, `power-slice`; canonical reevaluation oracle |
| Unsupported balanced compromise, exact co-winners, dominated runner-up | `decision-rules` |
| Shared hidden budget witness, achieved/unknown/proved exclusion | `decision-rules`, `constraints`; independent budget inequalities |
| Equal vectors, distinct assignments, overlapping compatible runs | `tradeoffs`, `pooled-overlap`, `compatible-pool` |
| Incompatible/legacy evidence, contradictory evaluations, missing values | API and canonical archive regression tests |
| Empty, constant and degenerate geometry | `empty`, `singleton`, `collinear` |
| Recorded trajectories | `journey`; canonical incumbent trace oracle |
| Three-weight power slice plus fixed hidden priority | `power-slice`; direct-score inequality oracle |
| More than 300 distinct score functions | `geometry-limit` (350), exact selected cell against every competitor |
| Exact fronts and layers | Exhaustive small oracles, 1D/2D/3D randomized fronts, `background` (3,000 bindings) |
| Actual running cancellation | `cancel-background` (10,000 bindings), manifest `observedRunning: true` |
| Worker failure/retry, duplicate delivery and expired lease | Durable worker regression test |
| Unique scale evidence, complete pagination and density rendering | `scale-1000`, `scale-10000`, `scale-100000`; 500-binding immutable batches |
| Genuine solver outcomes | Live MiniZinc `OPTIMAL`, Random Search `FEASIBLE`; exact IDs in manifest |
| Ownership, engine grants, project boundaries and stale requests | API security regressions and real HTTP ownership/pooling/staleness checks |
| Draft save/reopen, exports, all views and entry points, keyboard/mobile | `e2e/analysis-live.spec.ts` against persisted sources |
| Unchanged reseeding and semantic upgrades | Count comparison artifact; generator-version upgrade test preserves previous jobs |

[HTTP verification](../../openbinding-gateway/tools/analysis-verification.json), [reseed counts](../../openbinding-gateway/tools/analysis-reseed-verification.json), and [browser benchmark](../../openbinding-gateway/tools/analysis-browser-benchmark.json) hold machine-readable observations. A gap remains a gap until its corresponding check runs successfully; unit fixtures are not substitutes for engine or browser execution.

## Measured performance

Measured September 14, 2026 on an Intel Core i9-9880H at 2.30 GHz, 16 GiB host RAM, macOS Docker Desktop, 12 Docker logical CPUs, Linux 7.0.12 linuxkit, Python 3.11 gateway and local Chromium. This is a shared development stack rather than an isolated production capacity test.

| Unique bindings | Initial HTTP query | Next two pages | Query payload | Exact front |
|---:|---:|---:|---:|---|
| 1,000 | 0.222 s | 0.094 / 0.079 s | 196,857 bytes | Complete |
| 10,000 | 2.151 s | 0.729 / 0.470 s | 38,494 bytes | Complete |
| 100,000 | 28.578 s | 6.419 / 4.870 s | 138,174 bytes | Complete |

Initial timings include source loading for the requested archive; subsequent pages reuse canonical cache state. Payloads contain requested rows, highlights and density counts, not full assignments for every binding. The full population process peaked at 853,454,848 bytes (about 814 MiB RSS), including generation and analysis; this is not a per-query memory measurement. Browser interaction timings are recorded separately in the linked artifact. At 100,000 bindings pagination is exact but takes seconds on this machine; loading states and cancellation are necessary parts of the experience.

The unchanged full reseed preserved **292 jobs, 13 study runs, 33 reports and 4 analysis tasks**. Historical runs from earlier generator semantics remain intact. The normal build retains existing pricing-library `eval` and large-bundle warnings; no new dependency was added for the analysis workspace.

## Verification status

The backend analysis, seed, study and API-key suite passed 79 tests; the project CRUD suite passed another 5, including metadata-only job loading and selected result retrieval. The full frontend suite passed 158 tests across 30 files, and the affected Jobs tests were rerun after the summary-loading change. TypeScript, ESLint, Ruff, OpenAPI snapshot verification and production bundling passed. The final HTTP verifier passed 20 checks with no recorded gaps, including all 19 manifested scenarios and ownership, compatible pooling, staleness and draft visibility.

Persisted background analysis completed on 3,000 candidates. Cancellation interrupted an observed running 10,000-candidate task and returned no completed front. Both current live studies completed. Full-scale quadratic layers were deliberately not executed on 100,000 bindings; this is the disclosed computational limit, not a passing substitute for such a run.

All five final live-browser tests passed, covering the five views, pooling, preference geometry, exports, draft saving/reopening, all entry points and keyboard/mobile layouts. The 100,000-binding browser view opened in 26.365 s and paginated in 9.409 s on the measured run, with no page errors. These are end-to-end browser timings and include application/authentication work and detail requests.

Gateway RSS after the three benchmark sizes was 498.2 / 497.2 / 845.3 MiB. Its process lifetime high-water mark was 877.5 MiB; this is explicitly not a per-query allocation peak. Memory and timing samples come from a reused development process, so allocator retention and previous archive loads affect the measurements. The full machine-readable artifacts retain each sample.
