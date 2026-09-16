# Binding analysis upgrade

## A. Audit (2026-09-08)

### Surfaces and limitations

- `frontend/src/pages/Platform/PlatformPages.tsx`, AnalyticsPage: anonymous two-axis Recharts scatter from `analytics.pareto`, axes chosen from first object, hard-coded minimization and “exact cell results”; no selections, decomposition or retained binding identity. Studies can contain different case revisions, so pooled objective points need not be mathematically comparable. Runtime bars, repeatability ledger, combinatorial binding-space badge and cell provenance ledger remain useful but measure different things.
- `frontend/src/pages/Playground/InstanceWorkspace.tsx`: Authoritative result renders every decision, objective JSON and expandable evaluation. Instance configuration edits optimization terms, normalization, constraints and task eligibility, but had no coordinated result geometry.
- `frontend/src/pages/Account/Account.tsx`, SolutionPanel: only first solution rendered, remaining alternatives relegated to downloads; metrics pills and task assignment table.
- `frontend/src/pages/Platform/JobsPage.tsx`: first solution JSON preview and execution metadata.
- `frontend/src/components/TraceChart`: unmounted legacy convergence component accepting improvement/incumbent events; log evaluation axis allowed zero, non-finite values accepted, no playback.
- `frontend/src/components/EngineReportView`: engine/reference disagreement counts, objective deltas and raw claims; valuable provenance inspection, not an objective-space visualization.
- `BindingSpaceBadge`: exact combinatorial size and breakdown, not sampled feasible volume.
- `Platform/AppEngines`: engine telemetry charts; `Admin/AdminUsageDashboard` and `AdminErrorDiagnostics`: usage/error telemetry rather than solution geometry. `ReportDetailPage`, SnapshotPage, EntityDrawer and verifier expose frozen documents, identity and evidence. They should not independently recompute optimization semantics.
- `experimentation/icsoc/analysis.py`: offline experimental aggregation; separate from interactive canonical job results.

### Contracts and semantics

`api/client.ts` JobStatus contains solutions with task→(resource,id) binding decisions, numeric evaluated metrics, objective components `{metric,value,loss,weight}`, aggregate soft penalty, scalar/vector score, penalties and constraint violations. Reference evaluation is in gateway `v1/compiler.py` BindingProblem.evaluate_objectives; Java parity is in `binding-core/CanonicalEvaluator.java`.

Loss includes objective direction (negative raw value for unnormalized maximization, or one minus normalized value) and declared normalization/clamping. A weighted score sums weight×loss plus soft penalty. Lexicographic/Pareto vectors append soft penalty as a final dimension. Satisfy uses penalty alone. Raw metrics must not be assumed to be minimization objectives. A metric is an evaluated aggregate, not necessarily an individual candidate attribute; units are not present in the result contract and must not be invented.

StudyCell retains case revision, engine reference, parameters, seed, fingerprint, job ID and summary metrics. `studies.aggregate_metrics` currently loses identity and objective metadata; its legacy `nondominated` helper assumes minimization, admits non-finite numeric values, and aggregate points may include infeasible/cross-instance results. The upgraded UI stops consuming this legacy Pareto summary and fetches a canonical job selected by cell. Backend aggregate semantics remain a separately documented limitation for API consumers.

Bindings are categorical task choices. Hamming distance counts changed tasks using resource plus ID, not numeric IDs. Missing dimensions are not zeros. Absence of violations is only known feasibility when a violations array is present. Unknown enforcement remains unknown feasibility.

### Engine capabilities

Inspected implementation sources and manifests:

| Engine | Returned evidence | Analytical constraint |
|---|---|---|
| minizinc-csp | exact supported modes; returned canonical bindings and termination/provenance | Do not infer full Pareto or iteration history from exact termination |
| random-search | seeded bounded random search, best feasible binding, evaluations/time/seed | A single incumbent is not the sampled landscape |
| multi-heuristic / many-heuristic | bounded Pareto sampling archive, evaluations/time/seed | Not NSGA-II, not complete Pareto fronts; rejected samples not retained |
| evolutionary-heuristics elitist-genetic | categorical crossover/mutation, final best, evaluations/time | Previously no history; this upgrade emits sampled scalar incumbent checkpoints with generation/evaluation/time, not paths |
| evolutionary-heuristics pareto-genetic | bounded non-dominated archive | Current archive pruning is lexicographic truncation, not diversity-preserving NSGA survival; may bias coverage |
| remote engines | declared compatible modes plus validated canonical returned solutions | Trace shapes are optional; capability must follow evidence, not engine name |

No current shared contract guarantees gradients, Hessians, uncertainty, evaluated perturbations, full populations or rejected/dominated history. The explorer can classify dominance among returned candidates, but cannot recover candidates discarded by engines. Do not animate movement between final archive members.

## B. Research and prioritization

Primary references: [pymoo indicators](https://pymoo.org/misc/indicators.html), [pymoo convergence](https://pymoo.org/getting_started/part_4.html), [rank and crowding](https://pymoo.org/operators/survival.html), [SciPy Voronoi](https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Voronoi.html), [Qhull](https://www.qhull.org/), [scikit-learn clustering](https://scikit-learn.org/stable/modules/clustering.html), [t-SNE API](https://scikit-learn.org/stable/modules/generated/sklearn.manifold.TSNE.html). Complexity below is implementation-dependent, with n candidates, d dimensions, k neighbors/clusters, I iterations and T perturbations.

| Priority / method | Question; appropriate inputs | Encoding | Cost / placement | Value and decision |
|---|---|---|---|---|
| P0 dominance/front/layers | Which feasible returned vectors are strictly better in all losses? Same instance/schema and canonical losses | Linked points, rank and dominator list | O(n²d), client ≤2k; server beyond | High, exact and interpretable; implemented |
| P0 observed min–max, ideal/nadir | How do dimensions compare? Finite comparable numeric vectors; constant dimensions contribute zero | Labeled normalized axes and component bars | O(nd), client | High; distinguish observed bounds, canonical normalization, front nadir and anti-ideal; implemented |
| P0 bounded Voronoi | Which returned site is nearest to a location in a chosen 2D normalized space? Finite sites and explicit clipping box | Selectable cells, area and duplicate membership | Half-plane clipping O(n²) comparisons with polygon factor; client ≤300 | High, precise regional interpretation; implemented without perturbing duplicates |
| P0 Euclidean/Manhattan kNN | Closest loss trade-offs? Normalized numeric losses | Selected-star graph and ranked neighbors | O(nd+n log n), client | High; implemented full-set query |
| P0 Hamming/Gower | How many task assignments differ; how similar are mixed vectors? Resource-qualified categories and normalized numeric columns | Linked neighbors and assignments | O(nd+n log n), client | High; implemented with explicit missing-data exclusion |
| P0 weighted sum, ideal distance, TOPSIS, Chebyshev, reference distance | Preferred under explicit priorities? Finite normalized feasible losses, nonnegative weights, optional reference | Sliders, ranked table, reason | O(nd+n log n), client | High; implemented; weights affect preference, never canonical solver score |
| P0 contribution decomposition | Why this score? Canonical raw/loss/weight and soft penalties | Table and normalized fingerprint | O(d), client | High; implemented, weighted sums labeled by mode |
| P1 crowding | Is the point in a sparse part of its Pareto layer? Layered objective vectors | Ranking column and boundary marker | O(d n log n), client after ranks | Interpretable local gap proxy, not feasible volume; implemented |
| P1 weight perturbation | Does a small preference change switch winner? Fixed evaluated candidate matrix | One-at-a-time ±0.10 winner table | O(Tnd), client | High, implemented; not physical robustness |
| P1 parallel coordinates / pairwise projections | What higher-dimensional trade-offs are hidden? Comparable vectors | Axis selectors, linked profiles and comparison matrix | O(nd), client | High and interpretable; implemented selected profiles and selectable pairs, no inferred surfaces |
| P1 actual event replay | How did incumbent quality change? Recorded evaluation/time/value events | Fixed-axis step convergence, play/pause/scrub | O(n), client, no invented interpolation of solver states | Implemented legacy trace reader and playback; evolutionary scalar modes now emit bounded sampled checkpoints; other engines may emit no trace |
| P1 Delaunay/hull | Which projected sites share a region / bound coverage? Nondegenerate 2D sites | Edges / outline | Hull O(n log n); clipped-cell dual O(n²v²), client ≤300 sites | Implemented hull and clipped Voronoi edge dual; hull is not feasibility boundary |
| P1 exact 2D hypervolume contribution | Which point uniquely expands dominated volume? Feasible losses plus explicit worse reference | Area and contribution ranking | O(n log n) area; naive leave-one-out O(n² log n), server for large sets | Implemented ≤300 points for two objectives with constant penalty; explicit adjustable reference defaults to (1.1,1.1) |
| P2 knee / extreme points | Where are endpoints or strong trade-off bends? Ordered 2D front with meaningful normalization | Markers and chord distance | O(n log n), client | Extremes meaningful; knee definition is not unique and fails on flat/concave fronts; deferred |
| P2 epsilon, achievement scalarizing | Approximation quality / aspiration compromise? Reference front or aspiration and augmentation parameters | Reference overlay, ranking | O(nmd) epsilon; O(nd) ASF, server/client | Useful when reference exists; deferred |
| P2 PCA | Which linear combinations explain variance? Scaled numeric matrix with adequate samples | Projection, loadings and explained variance | O(nd²) typical, worker/server | First choice if axis selectors insufficient; not yet implemented |
| P2 MDS / UMAP / t-SNE / RadViz | Similarity structure / compact display? Chosen distance graph and parameters | Explicitly labeled embedding or weighted radial projection | MDS O(n²) storage; graph embedding often O(n log n), offline/worker | Not exact original distances; less interpretable; deferred |
| P2 k-means / hierarchical | Are there compact families? Scaled Euclidean vectors or specified dissimilarity | Cluster colors and representatives | O(nkdI) / O(n²), worker/server | Validate stability and representatives first; no automatic family claims |
| P2 DBSCAN / HDBSCAN | Dense families and outliers? Distance, density parameters, adequate samples | Cluster/noise overlays | indexed often O(n log n), worst O(n²), server | Better irregular shapes, parameter sensitive; bounded archives bias density; deferred |
| P3 spectral clustering | Nonconvex connected families? Affinity graph | Graph/color | dense eigensolve O(n³), offline | High cost and weak immediate justification |
| P2 cosine / Mahalanobis | Direction similarity / covariance-adjusted neighbors? Nonzero vectors / well-conditioned estimated covariance | Neighbor views | O(nd) / covariance O(nd²+d³), server | Not natural default for categorical decisions or sparse archives |
| P2 radius / KD-tree / ANN | Neighborhood coverage at scale? Metric-compatible index | Radius overlay and query | KD build O(n log n), high-d query can degenerate; ANN approximate | Add when measured scale requires; do not silently approximate dominance |
| P3 alpha shapes / KDE contours | Nonconvex coverage / sampled density? Enough representative samples, radius/bandwidth | Boundary / contours | O(n log n) geometry; KDE O(n×grid), server | Archive selection bias prevents density-as-probability claims |
| P2 finite differences / local perturbation / Monte Carlo | Objective sensitivity to decisions or uncertainty? Legal perturbations and actual evaluator or uncertainty model | Response curves, stability distribution | T evaluator runs, server/offline | Final result vectors alone cannot answer; deferred pending evaluation budget and trace contract |
| P3 3D surfaces/landscapes/gradients | Shape or descent? Three actual objectives / evaluated grid / actual gradients | Rotatable point cloud, contours or vectors | O(n) rendering; grid computation dominates, worker/WebGL | Never interpolate a feasible Pareto surface across categorical gaps; no synthetic landscape added |

## C. Design

Reuse existing paper/ink design tokens: background #fbfaf6, ink #17211d, teal #0e7b75 for non-dominance, orange #d75b35 for selection, gray #77827c for other points; dark theme uses existing overrides. Avenir body, condensed display headings and monospace quantitative tables stay consistent with the platform. The distinctive element is the shared selectable Voronoi field adjacent to a quantitative inspector.

Layout: controls → square geometric projection + binding inspector/nearest alternatives → preference laboratory + sensitivity/comparison → optional journey. Keep true Euclidean screen geometry by using a square plot; responsive single-column layout below 850px. Dropdown and table selection provide keyboard access to every candidate, including coincident points.

Data pipeline: unknown result → strict finite component adapter → comparable candidates → shared normalized losses → exact feasible ranks/crowding + full-set rankings/neighbors → shared selected candidate and up to four comparisons → independent rendering. Numeric functions are pure and independently tested; UI never mutates a solver score. Raw model normalization and observed min–max are separate operations.

## D. Implemented scope and explicit limits

New `analysis/math.ts`, `analysis/model.ts`, and reusable `BindingAnalysis` mounted in all four existing result entry points. Legacy study Pareto plot removed from the analysis page; selected cell fetch is stale-response guarded. The canonical result contract was sufficient for geometry. Evolutionary search now emits bounded generation-incumbent telemetry for scalar score modes; gateway engineReported provenance is consumed directly. No new dependencies added.

Sampling: at most 1,500 visible SVG sites, explicitly first returned sites rather than claimed representative sample. Full candidate set remains in ranking and neighbors. Exact Pareto is disabled above 2,000 feasible rows, not calculated on a sample. Voronoi is disabled above 300 visible sites, not sampled. These are honest bounded client features, not a claim of production 100k interactive rendering. Full-set normalization and neighbor functions are tested at 100k. At that scale use worker/server analysis, pagination and canvas/WebGL before claiming smooth interaction. No dense n×n matrix is allocated.

Deferred: full unbounded Delaunay triangulation, density/cluster discovery, PCA/embeddings, 3D clouds, lasso/zoom, higher-dimensional hypervolume, knee heuristics, evaluator-driven sensitivity, full backend population traces. Their required semantics, input and costs are documented above; they are not silently represented by decorative substitutes.

## E. Validation and reviewer checklist

Automated checks cover strict dominance, duplicate ranks, normalization and constants, ideal/nadir, numerical/categorical/mixed distances, missing inputs, exact nearest neighbors, ranking rules, Voronoi duplicates/invalid/collinear/nearly coincident/cocircular sites, clipping area, empty/singleton results and 100k numeric operations. UI checks exercise selection, feasibility filtering, geometry toggles, preference changes, evaluation-only traces and empty evidence.

Researcher review: comparisons use canonical losses and penalty, feasible-only recommendations, observed-front scope, explicit clipping box and metric, no gradient or population claims, no conflation of density and robustness. Designer review: coordinated point/cell/table selection, stable coordinates under preference changes, selectable overlapped candidates, quiet theme-compatible colors, responsive two-column layout, keyboard controls and reduced motion.

### Validation outcomes

- Full frontend run: 29 files / 160 tests passed before adding the two replay checks; focused final math/interaction/replay run: 16 tests passed.
- Production Vite build passed. Existing pricing4ts eval and large-chunk warnings remain.
- Targeted ESLint passed; TypeScript compilation passed before final telemetry integration, and the final check passed.
- Browser test passed through the authenticated instance solve route with mocked canonical jobs: linked selection, comparison, Voronoi toggles, 390px mobile layout without horizontal overflow, and reduced-motion mode. Desktop/mobile screenshots were visually reviewed. The check also caught and fixed long raw objective JSON overflowing the existing result header.
- Java reactor tests passed: 23 canonical conformance + 5 evolutionary tests. They validate emitted scalar checkpoint ordering, final-score agreement and absence of fabricated Pareto scalar traces.

The evolutionary checkpoint budget is bounded by approximately 514 small scalar records. It intentionally excludes per-candidate bindings/populations from telemetry payloads, retaining final solutions in the canonical result. Gateway provenance nests these records under `engineReported`; the adapter handles this as well as legacy flat provenance.

## Development gallery and how to try it

The normal seeder now adds a `binding-analysis-gallery` study to `score-ai/qos-placement`. For an already populated development database, run only the additive gallery step:

```sh
./tools/seed_dev.sh --analysis-only
```

Sign in as the existing development user `alice`, open `/app/score-ai/qos-placement/analytics`, choose **Binding Analysis Gallery · evaluated examples**, then select a study cell. The same archives appear in project Jobs and Alice's account results. This step does not call external engines, send notifications, adjust usage or reset users/projects. Repeating it reuses the existing content-identical run. Changed package content creates a new run and immutable case revisions.

| Cell | Evidence / things to try |
|---|---|
| tradeoffs | 36 actual bindings; Pareto layers, dominators, duplicates, cells/area, dual, hull, two-objective hypervolume, weight rankings, reference point, comparison |
| constraints | 36 bindings; three objectives including maximized quality, soft latency penalty and hard budget rejection; inspect feasibility and objective contributions |
| journey | 36 evaluations; actual deterministic enumeration improvement events; replay, pause and scrub; no invented elapsed time |
| collinear | Four categorical bindings, three collinear sites; duplicate membership and bounded geometry |
| singleton | One site owns the viewport; no alternative neighbors |
| empty | Empty returned subset; honest no-result state |
| large | 1,296 four-task bindings; full Pareto/rank/neighbor calculation, explicitly disabled Voronoi above 300 sites |

The archives retain evaluated rejected/dominated bindings on purpose. They have `UNKNOWN` optimization termination and prominent development-evidence labels; they are not solver benchmark runs, completed Pareto proofs or evolutionary trajectories. Source examples 17–19 are also available in Examples/Playground for running compatible real engines. The larger variant is generated deterministically from example 17.

Gallery validation: all seven datasets were regenerated deterministically and every retained binding was reevaluated in tests. Persistence tests verified seven cells, ownership, snapshots, released accounting and no duplicate runs. The gallery plus existing seeder tests passed (10 tests). The additive `--analysis-only` command also completed successfully against the running development database.

Live browser verification confirmed the seeded trade-off archive (36 bindings) and weighted journey (30 feasible bindings, six actual enumeration improvements) through the project analysis page. The old contradictory “trace not emitted” placeholder was removed, and multi-case search-space totals are labeled as the largest instance rather than naming the first case.

The evolutionary Docker image was rebuilt successfully after telemetry changes and the development service was recreated with a health-checked startup. New scalar evolutionary runs can therefore emit recorded checkpoints without a separate manual rebuild.

## F. Explainable decision support and actual counterfactuals (2026-09-09)

The next upgrade answers two different decision questions: which returned candidate fits the user's priorities, and whether changing a real task assignment produces a better canonical result. These evidence sources stay separate.

### Decision methodology

The preference laboratory now reports **every numerical co-winner**, using relative/absolute score tolerance `1e-10 * max(1, |a|, |b|)`. Archive order only determines which tied candidate is initially explained, never a claim of superiority. NSGA crowding is explicitly excluded as a tie-breaker because duplicate-value crowding can depend on archive order. A user can select another co-winner for the explanation.

Optional inclusive upper bounds on normalized losses define an acceptable subset. Normalization, ideal and anti-ideal remain anchored to the **full known-feasible returned population**, so filtering does not silently change scores. Empty acceptable sets produce no recommendation. Unknown feasibility and hard violations remain excluded. Chart visibility filters do not change decision eligibility. A selected feasible candidate outside the acceptability limits is explained as ineligible rather than preferred or inferior by score alone.

Each recommendation supplies its exact rule, formula, normalization bounds, effective priorities, individual arithmetic terms, canonical trade-offs against the selected alternative, changed task assignments, observed-set dominance status, and score gap to the next non-tied acceptable alternative. Squared-distance terms are explicitly not additive score contributions; TOPSIS also exposes the anti-ideal terms and both distances. Reference proximity can legitimately recommend dominated candidates, while zero weights and Chebyshev can produce dominated ties; the UI identifies these cases instead of calling them Pareto-optimal. The JSON decision receipt exports the candidate identities, bindings, losses, eligibility, settings, calculation, and any computed sensitivity evidence.

All implemented methods retain the established convention in `rankScores`: normalized priorities multiply axes before Euclidean distance is calculated (hence squared priority in squared-distance terms). TOPSIS uses observed min–max scaling, and reports `1 − closeness`, with 0.5 for completely indistinguishable ideal/anti-ideal data. No model weight is overwritten.

Sources supporting the choice of explicit preference/decomposition methods: [pymoo decision making](https://pymoo.org/mcdm/index.html), [pymoo objective-space normalization and compromise selection](https://pymoo.org/getting_started/part_3.html), and [pymoo decomposition definitions](https://pymoo.org/misc/decomposition.html). These methods require a declared preference rather than establishing a unique best Pareto solution. The implementation's formulas and boundary conventions are stated above and tested directly, rather than claiming every convention is interchangeable.

### Continuous and sampled priority sensitivity

For weighted sum, the tool computes an **exact continuous winner interval** along `w(t) = (1−t) w + t e_j`, for `t ∈ [0,1]`. For each acceptable competitor it intersects the affine inequality `w(t)·(z_selected−z_competitor) ≤ 0`. Cost is O(nd), without a distance matrix. Closed interval boundaries include ties. This is an analytic result in floating-point arithmetic, with no sampled winner extrapolation.

For all five rules, a user-triggered 21-point grid shows co-winners as priority shifts toward one objective. The legend distinguishes retaining the explained candidate from a changed recommendation. Counts are descriptive scenario counts, not probabilities or robustness certificates. At most two million candidate-objective evaluations are admitted on the client; exceeding this budget disables the sweep explicitly. Changing priorities, limits, reference, axis or data invalidates old scenario evidence. Actual perturbation robustness requires separate evaluation evidence below.

### Backend evaluator and UI

`GET /v1/jobs/{job_id}/analysis/neighborhood?solution_index=0&limit=64&task=...` uses the existing authenticated job-owner and engine-access checks (`jobs:read` for API keys). It loads the pinned BindingProblem from the job request, falling back to the persisted snapshot IR for seeded archives; conflicting recorded identities are refused. The response reports the actual pinned digest. The OpenAPI contract is generated into `docs/openapi.json`.

The endpoint re-evaluates the base and distinct eligible **Hamming-distance-one service-task substitutions**, with an optional task scope, using `BindingProblem.evaluate`. It returns evaluated objectives, constraint violations, feasibility, canonical comparison, component/raw-value changes and soft-penalty changes. Weighted, Pareto, lexicographic and satisfy comparisons follow their own canonical semantics. A feasible alternative to an infeasible base is labeled a feasibility repair. No engine, solve job, model edit or stored-result mutation occurs.

Work runs in the thread pool, with two concurrent evaluator requests per gateway process, at most 128 substitutions, and a cooperative two-second budget checked between evaluations (an individual evaluation is not forcibly interrupted). Candidate order is deterministic, grouped by sorted task and resource/id. This is not a representative sample. Responses distinguish total eligible moves, attempts, successful evaluations, failures, budget stop and complete coverage. Failed evaluations prevent complete-coverage claims. No result claims global optimality or multi-task robustness. The UI scopes each request to the selected returned solution, cancels stale client requests, and shows explicit errors when evidence is unavailable.

The inspector includes this tool in the playground, job view, account history and study-cell explorer. Existing seeded trade-off/constraint/journey archives work through their pinned snapshots, so no reseeding is needed. The generic API client's caller cancellation is now propagated to fetch, and this endpoint rejects validation-problem bodies rather than treating them as analysis data.

### Validation and limits

Numerical tests reconstruct all five recommendation scores, check constant dimensions and zero priorities, numerical ties, inclusive limits, fixed scales, exact winner intervals against independently scored dense grids, and tied scenario counts. UI tests cover eligibility changes, empty recommendation sets, stale scenario invalidation, counterfactual requests and errors, and cancellation. Backend tests use real canonical models in all four objective modes, check actual single-task substitutions, feasibility repairs, no source mutation, duplicate/empty neighborhoods, evaluator failure, budget truncation, authentication, ownership, and snapshot fallback.

This adds decision evidence rather than a general-purpose optimization server. Large archive Pareto processing, full population telemetry, uncertainty models, multi-task search, and global robustness remain outside the implemented guarantees. The counterfactual evaluator cannot certify a landscape between categorical choices. All exports and explanations identify observed and evaluated scope.

Final validation for this increment: full frontend suite **32 files / 179 tests passed**; backend analysis, OpenAPI and API-key suites **86 tests passed**; analysis plus seeded-gallery checks **19 passed**. Desktop/mobile browser test passed at 390 px with no page overflow; the production build and targeted lint/type checks are also run. Live seeded-gallery validation evaluated **10/10 eligible substitutions** via the authenticated running gateway. Existing non-blocking build warnings about bundled pricing `eval` and chunk size remain separate from this change.

## G. Selected Voronoi cell area and decision significance (2026-09-09)

Selecting a Voronoi cell now highlights its polygon and displays a prominent area panel immediately below the geometry. It reports normalized area, percentage of the fixed unit-square analysis domain, area rank among distinct visible cells (including numerical ties), partition scope, coincident bindings sharing that cell, and boundary contact. Selecting a binding via its point or dropdown updates the same panel. If filters remove the selected site or geometry is unavailable, the panel explicitly withholds the area. Areas are computed from clipped polygon vertices with the shoelace formula; these are not screen-pixel estimates. The existing inspector percentage remains available alongside the binding decomposition.

### Mathematical interpretation and sources

The [CGAL Voronoi manual](https://doc.cgal.org/latest/Voronoi_diagram_2/index.html) defines cells by nearest-site comparisons under a chosen distance. Accordingly, for displayed sites pᵢ and the fixed domain B = [0,1]², this implementation computes Vᵢ = {q in B: ||q−pᵢ||₂ ≤ ||q−pⱼ||₂ for every j}, with Aᵢ = area(Vᵢ). Coincident sites share one region; otherwise bisectors have zero area. [SciPy's Voronoi documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Voronoi.html) distinguishes finite regions from regions extending to infinity. A finite displayed area therefore needs an explicit clipping domain. Contact with the viewport boundary is disclosed, without claiming every boundary-touching cell would be unbounded on the full plane.

**Largest area is not a quality ordering.** A directly verified counterexample, minimizing two objectives in the unit square, uses A=(0,0), B=(0.1,0.1), C=(1,1). The bisectors are x+y=0.1 and x+y=1.1. Their clipped cell areas are respectively 0.005, 0.590 and 0.405. B has the largest cell, yet A dominates B. This is a derivation from the geometry, not a claim extracted from a paper, and is now a regression test.

With all candidates present, large area can reflect sparse coverage, an isolated poor solution or a boundary effect. With **only feasible non-dominated candidates** present, it describes influence among the returned trade-offs and can support diversity retention or choosing representatives of sparsely represented regions. It still does not identify a unique compromise, a knee, local stability or true Pareto optimality. Rebuilding the tessellation using only non-dominated candidates is distinct from retaining the all-candidate tessellation and sorting just its non-dominated members. The existing toggle implements the former; full-dimensional canonical dominance determines membership, while the original full-population projection scales stay fixed. Removing competitors can only enlarge a retained cell under fixed coordinates and clipping, so before/after areas do not measure quality improvements.

Axis choice, coordinate scaling, bounding domain, filtering and archive sampling affect area. A 2D projection omits other objectives and can merge distinct solutions. Duplicates cannot each receive exclusive credit for the same cell. A large cell may support investigation of an underrepresented region, but its shape and distance to a relevant boundary matter for local switching; total area is not a stability radius.

**A precise conditional decision interpretation:** if target locations are distributed uniformly over this exact square, and the decision rule selects the nearest site under this exact metric, P(site i is nearest)=Aᵢ/area(B). For a coincident group this is group probability; any allocation among its members needs another tie rule. For a nonuniform target density p(q), the corresponding quantity is ∫ over Vᵢ p(q)dq, not plain area. This is a mathematical implication of the nearest-site definition, not evidence that real user preferences are uniform. Largest selection frequency also does not automatically minimize expected distance to targets.

Objective-space area is **not weight-space preference stability**. Under normalized weighted sum, candidate i wins for weights in {w≥0, Σw=1, w·zᵢ≤w·zⱼ for all acceptable j}. This is a different geometric region, in the weight simplex. Its volume or probability requires an explicit weighting distribution, and weighted sums may miss unsupported non-dominated solutions on nonconvex fronts. The implemented exact one-direction priority intervals and explicit scenario sweeps address this preference question without mislabeling Voronoi area.

For actual decisions, first establish feasibility and acceptability, then state priorities or reference targets and inspect trade-offs/sensitivity. [pymoo's MCDM documentation](https://pymoo.org/mcdm/index.html) describes preference-based selection from multi-objective results. If the question is exclusive contribution to dominated objective-space coverage, [hypervolume](https://pymoo.org/misc/indicators.html) is a different relevant indicator: it uses a declared worse reference point and dominance, not proximity. Hypervolume contribution is also reference/set-dependent and is not a universal utility score. No largest-area automatic recommendation was added.

Validation adds the dominated-largest-area numerical counterexample, clicks a cell and verifies its numeric area and polygon highlight, recomputes after Pareto filtering, and checks duplicate groups, equal-area ranks and unavailable selections.

## H. Constraint boundaries and restricted Voronoi areas

The geometry now loads the job's pinned BindingProblem. The existing owner-scoped job-IR endpoint also supports snapshot-backed seed archives, rejecting conflicting recorded IR identities. Solid red lines show hard boundaries; dashed amber lines show soft limits. Hard-excluded portions are shaded. “Clip cells to projected hard constraints” intersects each cell with the represented region and updates area ranks and shares. “Only non-dominated” rebuilds the sites from feasible, full-dimensional Pareto candidates; display bounds stay fixed.

Supported projections are canonical affine comparisons on the displayed metrics: constants, negation, addition/subtraction, multiplication by a constant, and division by a nonzero constant. These include diagonal boundaries. Objective axes respect declared direction and normalization. A simple metric threshold strictly inside a declared clamping interval has an equivalent loss-space boundary; other expressions involving saturated values are withheld. Conditional activation, hidden metrics, nonlinear/unsupported predicates, placement restrictions and collapsed axes are explicitly listed as unprojected. No fitting or hidden-value assumptions are used. Soft constraints never trim area. Equality or contradictory restrictions can produce zero area, for which the area share is undefined.

Research: Yan, Wang, Lévy and Liu's [Efficient Computation of Clipped Voronoi Diagram for Mesh Generation](https://www.microsoft.com/en-us/research/publication/efficient-computation-clipped-voronoi-diagram-mesh-generation/) (2011) describes retaining Voronoi cell portions inside compact domains. [Constrained centroidal Voronoi tessellations](https://epubs.siam.org/doi/10.1137/S1064827501391576) also place region geometry and prescribed densities at the center of the construction. These sources support the geometric operation, not a claim that cell area defines optimization quality.

For a Pareto-site set P and specified region R, the proposed indicator is:

`restricted_area_i = area(V_i(P) ∩ R)`

`coverage_share_i = restricted_area_i / area(R)`, for positive region area.

This is meaningful as **restricted target-space coverage**: portions outside represented hard constraints no longer contribute. Distinct cells partition R up to zero-area boundaries, while coincident bindings share a region. It is therefore more relevant to a constrained target-domain question than unconstrained-square coverage. The following conclusions are mathematical reasoning for this platform, not quality guarantees drawn from the geometry literature:

- The true feasible objective set is the image of feasible bindings. A budget line is a necessary condition, not a guarantee that every objective combination below it is attainable. Hidden constraints and relationships among metrics may exclude more. The UI calls the polygon a projected constraint region or continuous relaxation even when all declared constraints are drawn.
- Finitely many categorical bindings produce a finite attainable set with zero planar area. A Pareto curve may also have zero planar area. Dividing continuous cell-intersection area by the area of that actual set would be undefined. The displayed region does not purport to solve that problem.
- If targets are uniform over R and selection means the nearest Euclidean Pareto site, the share equals site/group selection probability. Nonuniform targets require integrating a stated density. This does not measure the probability of winning under different objective weights.
- A larger restricted area can still arise from sparse alternatives or the region's geometry. It does not prove better utility, a knee, local robustness or global optimality. Apply feasibility/acceptability and Pareto filtering first, and use the indicator alongside preferences and sensitivity.
- An empirical alternative for discrete results would count known-feasible observations assigned to their nearest Pareto site, with a stated sampling distribution and tie rule. Such counts describe only the archive unless exhaustive enumeration or a justified sampling model supports wider inference. This counting indicator is not implemented or silently substituted here.

Implementation uses convex polygon half-plane clipping and the shoelace area formula; the existing 300-site ceiling remains. Tests cover hard/soft distinctions, maximization and clamping, diagonal constraints, hidden/nonlinear/conditional exclusions, placement, strict/equality predicates, empty and zero-area regions, duplicate sites, conservation of area, linked controls and pinned-IR fetching.

Live seeded validation: the constraint example projects its hard budget and soft latency limit. The represented hard-constraint region has area 0.777778 in normalized units². With feasible Pareto sites only, S17's shared cell has restricted area 0.199068, or 25.59% of that region; the UI discloses its four coincident bindings.

Validation for this increment: 36 analysis/interaction tests and 11 backend analysis tests passed; desktop/mobile browser checks, ESLint, Ruff, diff whitespace checks and Vite production bundling passed. Full TypeScript validation currently reports only unused imports `Building2` in `frontend/src/pages/Auth/Login.tsx` and `Funding` in `frontend/src/pages/Public/PublicPages.test.tsx`, both separately modified files left untouched by this change. Existing pricing-library eval/chunk-size build warnings remain.
