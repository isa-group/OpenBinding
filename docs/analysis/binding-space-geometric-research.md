# Geometric exploration of binding feasibility and preferences

**Recommendation.** Use a polynomial-time analysis layer over explicitly supplied candidates: objective-budget attainment maps, preference slices, exact candidate ranking, and linked inspection of actual bindings. Voronoi diagrams remain useful for proximity; power diagrams can represent some preference partitions exactly. The analysis must not depend on fresh NP-hard optimization, implicit solution enumeration, exact high-dimensional volume, or unrestricted symbolic projection. A timeout does not make an NP-hard algorithm a polynomial-time solution.

The agreed scope is a complete comparison of all returned/evaluated bindings, with unexplored space explicitly unknown. Runtime is measured against archive size N, objective count m, model size, and numerical precision. A complete generic map of an implicit combinatorial space cannot be promised with polynomial runtime: even testing whether it contains a feasible binding can encode an NP-complete decision problem. Whole-space guarantees require additional model structure; they are outside the selected scope.

**1. The specific limitation in OpenBinding**

The current analysis supports affine constraint boundaries on displayed metrics and clips Voronoi cells against their half-planes. Conditional predicates, hidden metrics, nonlinear expressions, some clamped transformations, and placement restrictions are withheld. This is documented in the existing [upgrade report](/Users/franciscojaviercaverolopez/Workspace/OpenBinding/docs/analysis/binding-analysis-upgrade.md) and implemented in [constraints.ts](/Users/franciscojaviercaverolopez/Workspace/OpenBinding/frontend/src/analysis/constraints.ts:52).

This is a valid necessary-condition picture when its transformations are sound. It is not generally the image of all feasible assignments. Even displaying every hard constraint would not establish that an arbitrary point inside the outline corresponds to a realizable binding: metric aggregation, task assignments, integrality, and dependencies still matter.

The present frontend already has canonical losses, known feasibility, Pareto layers, several preference scores, exact weighted-sum winner intervals along a selected direction, and evaluated one-task alternatives. It limits Voronoi geometry to 300 visible candidates, exact Pareto layers to 2,000 feasible candidates, and displayed points to the first 1,500. These are implementation limits, not mathematical thresholds or performance measurements for a future design. See [BindingAnalysis.tsx](/Users/franciscojaviercaverolopez/Workspace/OpenBinding/frontend/src/components/BindingAnalysis/BindingAnalysis.tsx:48) and [math.ts](/Users/franciscojaviercaverolopez/Workspace/OpenBinding/frontend/src/analysis/math.ts:1).

The proposed work is therefore an extension of the existing evaluator and decision support. Merely replacing the Voronoi library would improve rendering scale without solving the semantic limitation.

**2. Define what the picture represents**

Let X be the set of allowed assignments and F its feasible subset. Let f(x) be the m-dimensional objective vector, with every direction converted consistently to minimization:

\[
F=\{x\in X:g_\ell(x)\leq0\ \forall\ell,\ h_t(x)=0\ \forall t\},\qquad Y=f(F).
\]

Domain, categorical, conditional, and placement restrictions belong in F, even when they do not have convenient algebraic expressions. Soft constraints belong in the declared penalty or preference policy; they do not automatically exclude a binding.

| Space | A location means | Useful visual | Meaning of a region |
|---|---|---|---|
| Assignment space X | A specific assignment of services/resources to tasks | Assignment matrix, local move graph, decision diagram | A family of assignments |
| Attainable objective set Y | Objectives produced by at least one feasible binding | Actual points or a proven continuous patch | Realizable objective vectors |
| Objective-budget space | Maximum acceptable values for objectives | Attainment staircase, conditional budget map | Budgets that at least one binding meets |
| Preference space | Weights or another declared preference parameter | Weight interval, simplex, conditional slice | Parameters under which a candidate wins |
| Embedding space | Coordinates computed for visual organization | PCA or exploratory embedding | Layout structure, with distortion |

For a finite categorical problem, Y is finite. Its ordinary planar area is zero. Counting assignments, measuring an objective-space area, and measuring preference probability answer different questions. If multiple bindings have the same objective vector, group their point geometry while retaining their identities and assignment differences.

With three or more objectives, distinguish projection from a slice. A projection asks whether some hidden coordinates can make a displayed pair attainable. A slice fixes hidden values; a budget-conditioned view bounds them. Different hidden completions can have the same displayed coordinates but different feasibility. Consequently, a failed completion does not prove that its entire projected location is infeasible.

**3. A continuous feasibility picture that works for discrete bindings**

Use the set of achievable objective budgets, often formulated as an upper image or dominance extension:

\[
U=Y+\mathbb R_+^m
 =\{b:\exists x\in F,\ f_j(x)\leq b_j\text{ for every }j\}.
\]

A point b in this picture is a requirement, not an asserted solution. For example, “cost at most 0.7 and latency at most 0.7” can be achievable even if no binding has objectives exactly (0.7,0.7).

For a finite two-objective archive, each feasible vector contributes an upper-right rectangle inside a stated display domain. Their union forms a staircase. Its minimal corners are the nondominated vectors. Some other parts of its topological boundary extend along rays, so it would be inaccurate to identify every boundary point with an actual Pareto solution.

There is an established visual-decision tradition behind this approach. Lotov's Interactive Decision Maps explore a dominance extension of the feasible criterion set, including nonlinear and nonconvex cases, using linked sections and approximations. This is a closer match to inspecting feasible goals than coloring nearest-point cells. [Lotov, 2005](https://drops.dagstuhl.de/entities/document/10.4230/DagSemProc.04461.8)

For more objectives, show two budget axes and place visible upper bounds on the others. A point means that one binding meets *all* those bounds simultaneously. Do not combine separate pairwise successes: their witnesses might be different bindings.

For an archive A contained in F, its attained set U_A is an inner approximation to U. Every covered budget has a witness. An uncovered budget is only “not met by the archive” until a complete search or sound proof excludes all other bindings.

**4. Add feasibility evidence without introducing NP-hard solves**

The ideal budget question is:

\[
Q(b):\quad\text{find }x\in X\text{ such that all original hard constraints hold and }f(x)\leq b.
\]

For a general binding problem, evaluating Q(b) may be NP-hard and is excluded from the recommended analysis pipeline. The following implication rules remain cheap and useful when their evidence already exists:

| Result | What it proves | What may be shaded |
|---|---|---|
| Validated feasible witness x | Every budget b′ ≥ f(x) is achievable | Its upper-right orthant |
| Sound proof that Q(b) is infeasible | Every tighter budget b′ ≤ b is impossible | Its lower-left orthant |
| Unsupported formulation, incomplete archive, or no witness found | No conclusion about existence | Unknown region |

The witness need not be optimal to establish achievement. An already stored proof can also be displayed without rerunning its search. Conversely, heuristic failure is never an infeasibility proof. OR-Tools explicitly distinguishes FEASIBLE, INFEASIBLE, and UNKNOWN termination; preserve equivalent distinctions when consuming existing solver results. A solver's infeasibility report is not automatically an independently checkable formal certificate. [OR-Tools CP-SAT documentation](https://developers.google.com/optimization/cp/cp_solver)

For a budget box [l,u], an archived witness meeting l establishes achievement throughout the box; a sound exclusion at u excludes the entire box. Evidence only at u does not establish achievement throughout it. These implications require unchanged hidden-budget settings and the same pinned model. Computing membership against the archive is O(Nm), and a two-objective attainment staircase can be built with a sort and sweep.

Where a valid polynomial-size rational linear relaxation is available, a budget query against that relaxation is a linear program. Proven infeasibility of this outer relaxation excludes an original feasible binding. Feasibility of the relaxation leaves the original integer problem unknown; an archived integral witness establishes achievement. This gives a three-way picture using polynomial-time LP algorithms and archive checks, provided generating the relaxation is also polynomial and all translated constraints are sound. Linear programming has polynomial-time algorithms in the rational input encoding size; this does not imply that every practical LP algorithm has that worst-case bound. [Karmarkar, 1984](https://www.stat.uchicago.edu/~lekheng/courses/302/classics/karmarkar.pdf)

Do not construct a full projected polytope merely because membership is tractable: its explicit representation may be large. Use a declared number of sample budgets or adaptively refined cells with a fixed work budget. A center sample cannot certify an entire cell; corner propagation above can. If even a sound linear relaxation is unavailable, retain only directly justified exclusions and unknown regions.

Straightforward propagation of valid lower bounds can be cheaper still. If every feasible outcome obeys aᵀf(x) ≥ L with a ≥ 0, budgets with aᵀb < L are impossible. By contrast, an arbitrary hard inequality on actual outcomes cannot automatically be applied to budget coordinates. Every budget exclusion needs the correct quantified implication.

Epsilon-constraint and objective-space box algorithms are relevant research but do **not** meet the requirement for generic integer bindings: their subproblems can be NP-hard. Likewise, bounded-time MILP/CP-SAT queries remain outside the proposed analysis layer. These methods are documented as excluded alternatives, not future default increments. [Dächert, Fleuren and Klamroth, 2024](https://link.springer.com/article/10.1007/s00186-023-00841-0), [Mesquita-Cunha, Figueira and Barbosa-Póvoa, 2021 preprint](https://arxiv.org/abs/2109.02630)

**5. Make first, second, and the rest mathematically explicit**

Pareto dominance supplies a partial order. It does not totally order trade-offs. Under a declared scalar preference S, the rank of candidate i can instead be defined as

\[
\operatorname{rank}_i(\theta)
 =1+\#\{j:S_j(\theta)<S_i(\theta)\}.
\]

All co-winners should remain visible. “Second” must distinguish the second ordered candidate from the next strictly worse score group. Near-equality tolerances belong in the displayed decision contract; pairwise floating-point tolerance must not be used as a non-transitive sorting comparator.

Let z_i be fixed normalized minimization values and let the weight simplex be Δ = {w ≥ 0: Σw_j = 1}. For weighted sum,

\[
S_i(w)=w^\top z_i,\qquad
W_i=\{w\in\Delta:(z_i-z_j)^\top w\leq0\ \forall j\}.
\]

Thus each winner region is an intersection of half-spaces. For two objectives it is an interval; for three it is a polygon in the triangular simplex. These are the nonnegative weight slices of the normal cones of the lower convex hull. Unsupported nondominated candidates have no weighted-sum winning region. This geometric interpretation is consistent with research on weight-set decomposition. [Helfrich, Prinz and Ruzika, 2024](https://link.springer.com/article/10.1007/s10957-024-02481-8)

A more inclusive rule for ranking supplied discrete trade-offs is weighted Tchebycheff, also spelled Chebyshev. Computing it over an explicit archive is O(Nm); optimizing it over an implicit binding universe can still be NP-hard:

\[
T_i(w;r)=\max_j w_j(z_{ij}-r_j),\qquad w_j>0,
\]

where r is fixed and strictly better than every relevant objective vector. With that condition the deviations are positive. For a general aspiration point, the signed achievement function and an absolute-distance function have different meanings; the interface must state which it uses. The pymoo documentation illustrates weighted sum, Tchebycheff, and achievement scalarizations through their contours. [pymoo decomposition documentation](https://pymoo.org/misc/decomposition.html)

The most directly relevant paper is **Analysis of the weighted Tchebycheff weight set decomposition for multiobjective discrete optimization problems**. For finite objective sets and a strict utopia reference, it characterizes winner components as star-shaped sets represented by finite unions of polytopes. Every nondominated objective vector has a full-dimensional weight component. In the two-objective case these components are intervals; higher-dimensional components need not be convex. The result supports geometric preference exploration, but it does not give a generally cheap enumeration algorithm. [Helfrich, Perini, Halffmann and Ruzika, 2023](https://link.springer.com/article/10.1007/s10898-023-01284-x)

OpenBinding currently uses distance to the observed ideal in its Chebyshev rule, which can have zero deviations. A future implementation must introduce and disclose a strict reference before invoking that paper's strict-reference guarantees. Normalization and references must stay fixed as visible filters change. If new discoveries change the anchor bounds, create a new analysis version and make the change explicit.

Unaugmented Chebyshev can admit dominated ties because improving a nonmaximal component may leave the maximum unchanged. A transparent remedy is lexicographic scoring: first minimize T, then minimize a positive weighted sum among its exact minimizers. This preserves primary winners and removes dominated ties for strictly positive weights. A fixed positive augmentation also changes the trade-off rule; it should not be silently described as an infinitesimal tie-breaker.

**6. A small example that distinguishes these choices**

Consider this synthetic archive, minimizing two fixed normalized objectives:

| Binding | Cost | Latency | Status |
|---|---:|---:|---|
| A | 0 | 1 | Feasible, nondominated |
| B | 0.6 | 0.6 | Feasible, nondominated |
| C | 1 | 0 | Feasible, nondominated |
| D | 0.85 | 0.85 | Feasible, dominated by B |
| E | 0.2 | 0.2 | Infeasible due to an independent compatibility rule |

The following arithmetic is an independent worked example, not empirical OpenBinding data. With weights (w,1−w), the weighted-sum scores of A, B, C are 1−w, 0.6, w. B never wins: one of w and 1−w is always at most 0.5. At w=0.5, A and C tie first and B is next.

Using Tchebycheff with the ideal reference (0,0), those scores are 1−w, 0.6 max(w,1−w), w. B wins for 0.375 < w < 0.625, with co-winners at the endpoints. At equal weights, B scores 0.3, D scores 0.425, and A/C score 0.5. Therefore D is second even though it is dominated. Removing all dominated bindings would lose that runner-up.

The zero reference is used here for transparent arithmetic; it is not a strict utopia point for A and C. Taking the strict reference (−0.1,−0.1) gives B a winning interval from 7/18 to 11/18, with ties at the endpoints. The qualitative conclusion survives and the stricter theorem's reference condition holds.

Budgets (0.7,0.7) are achievable through B, although no archived binding has objectives exactly (0.7,0.7). Budgets (0.5,0.5) remain unknown beyond this archive, even though the visibly attractive E lies inside them: its hard incompatibility excludes it from every recommendation. If these five possibilities were independently known to exhaust the model, that same uncovered budget could be classified impossible; archive completeness cannot be inferred from the plot.

For the accompanying illustration, additionally assume a valid model lower bound cost + latency ≥ 1 for all feasible bindings. Budgets with a sum below 1 are then proven impossible without searching for assignments. Budgets (0.5,0.5) remain unknown because they satisfy the necessary bound but have no archived witness. The three visible states are therefore achieved, excluded by an analytic bound, and unknown. This illustrative bound is not asserted to hold for OpenBinding models generally.

**7. A precise role for Voronoi and power diagrams**

Ordinary Voronoi cells answer which site is closest to a reference location under a specified metric. If the reference is a target with symmetric squared-deviation loss, nearest-site selection is the intended decision rule. If cost and latency are upper limits, symmetric closeness is usually the wrong interpretation: being substantially under budget should not necessarily be penalized.

There is also an exact connection between affine preference scoring and generalized Voronoi geometry. A power diagram uses the site cost ||q−p_i||²−ω_i; its cells are dual to a regular triangulation. Geometric site weights ω_i are distinct from objective preference weights. [CGAL regular triangulations](https://doc.cgal.org/latest/Triangulation_2/index.html)

The following algebra supplies the connection. For any affine score S_i(q)=a_iᵀq+b_i, choose

\[
p_i=-a_i/2,\qquad\omega_i=\|p_i\|^2-b_i.
\]

Then

\[
\|q-p_i\|^2-\omega_i=\|q\|^2+S_i(q).
\]

The common term does not affect comparisons. Consequently, the clipped power cells reproduce the preference winners exactly. These sites are transformed score coefficients, not the original binding points.

For three objectives, write weights as (u,v,1−u−v), with u,v ≥ 0 and u+v ≤ 1. Candidate i then has a_i=(z_i1−z_i3,z_i2−z_i3) and b_i=z_i3. Its planar power cell clipped to this triangle is exactly its weighted-sum winner region. This is a useful way to make Voronoi-style geometry answer a preference question. It inherits weighted sum's missing unsupported solutions.

Tchebycheff scores are piecewise affine. One can subdivide by active maximum components and compare affine scores within each subdivision; the resulting winner cells can be nonconvex. A single ordinary Euclidean Voronoi tessellation does not reproduce them in general. Use exact one-dimensional slices or a fixed-resolution two-dimensional preference raster, with exact O(Nm) ranking on selection. Full high-dimensional subdivision is excluded. A raster's center winner is an estimate for the cell, not a claim that no small winner region was missed.

Exact slices need no NP-hard optimization. On an affine weight path w(t), each candidate's Chebyshev score is the maximum of m affine functions of t. Split at their intersections; within a segment, every active score is affine, so pairwise equalities and winner conditions reduce to linear comparisons. A finite arrangement of these lines gives a polynomial construction in N and m for a one-dimensional path, though constructing every rank change can still be too large for interactive use. Compute the selected candidate's winning intervals or a small visible comparison first. This is a direct algebraic construction, not an assertion that a sparse weight grid captures every interval.

An order-k Voronoi diagram identifies the *set* of k nearest sites, not their internal ordering. Showing first and second requires an ordered refinement or explicit score comparisons. Constructing all orders is unnecessary for most interactions; compute a small requested top-k at the selected preference or target. The geometric literature distinguishes the higher-order structures and their construction costs. [Banyassady et al., 2018 version](https://arxiv.org/abs/1708.00814)

**8. Put feasibility and ranking on the same budget map**

Fix the preference rule and weights. At each budget vector b, define

\[
A(b)=\{i:x_i\in F,\ f(x_i)\leq b\},\qquad
I(b)=\arg\min_{i\in A(b)} S_i.
\]

Color each achieved region by its preferred eligible binding, and return all tied winners and the next alternatives when selected. This answers a directly usable question: **Which binding should I choose if these are my limits?**

For a finite archive and fixed scores, eligibility changes only at candidate objective thresholds. Two-objective cells are orthogonal regions. For a strict total score order, the winner region of i is its achievement orthant with the achievement orthants of all better candidates removed. With ties, retain a co-winner membership label instead of assigning the overlap arbitrarily. This construction is a proposed combination of the definitions above, not a claimed new published algorithm.

If only the archive is searched, say “best returned binding meeting these budgets.” Under the no-NP-hard requirement, do not launch a generic integer optimization to establish a global winner. Use an existing certificate or a proven tractable model class when available. An achievement witness certifies existence; it does not certify that the witness is the best eligible binding.

If proximity is used after budget eligibility, competitors change as b moves. Simply clipping the original all-site Voronoi cell to each site's eligible region is not generally correct: a formerly closer competitor may become ineligible, allowing another cell to expand.

The display domain for budgets also differs from a hard constraint region on actual outcomes. A model requiring actual cost ≤ 100 does not make the aspiration “cost at most 150” infeasible; it is a loose request. Reusing actual-outcome constraint clipping on budget coordinates would therefore be a semantic error.

**9. Give area, probability, and robustness different labels**

| Quantity | Defensible interpretation | Required qualification |
|---|---|---|
| Objective Voronoi area | Nearest-site coverage in the selected coordinates | Metric, scales, clipping domain, competing sites |
| Restricted Voronoi area | Nearest-site coverage inside a declared target domain | Domain need not be attainable |
| Number of assignments in a discrete cell | Binding-family size | Complete counting or explicitly empirical sample |
| Preference-region measure | Range of priorities for which the binding wins | Rule, parameterization, distribution, ties |
| Budget winner-region measure | Range of requests served preferentially by the binding | Request domain and distribution |
| Hypervolume contribution | Unique dominated-objective coverage contributed to a set | Reference point, other candidates, dimensions |
| Distance to a preference switch | Local stability under a specified weight perturbation | Perturbation norm and simplex restrictions |
| Performance under resource perturbations | Operational robustness | Actual scenario or uncertainty model |

For a probability density p over preference parameters, selection probability is the integral of p over the winner region, with an explicit rule for ties. Uniform area is one modeling assumption; it is not an absence of assumptions. Reparameterizing weights can change what “uniform” means. Normalizing independent uniform random coordinates also does not generate a uniform simplex distribution.

SMAA-2 is particularly relevant to showing all ranks: its rank acceptability analysis explores the preferences under which an alternative obtains each position. A rank-by-candidate heatmap can summarize this for a declared weight distribution. Report sample size, uncertainty, and tie treatment when estimated; a heatmap of a chosen scenario grid is not automatically a probability estimate. [Lahdelma and Salminen, 2001](https://pubsonline.informs.org/doi/abs/10.1287/opre.49.3.444.11220)

A large preference region can still place the current choice close to a switching boundary. Calculate local stability separately. For weighted sum, the pairwise score difference is affine in weights; intersect the tie boundary with the feasible preference domain before measuring distance. Dividing a margin by a coefficient norm measures distance to an unconstrained hyperplane and may not describe an attainable simplex perturbation.

If the user wants a robust recommendation over a preference set Ω, one possible declared rule is minimax regret:

\[
\arg\min_i\max_{w\in\Omega}\left[S_i(w)-\min_j S_j(w)\right].
\]

For explicit candidates, weighted-sum scores, and a polynomial-size polyhedral preference domain Ω, this can be evaluated using polynomially many linear optimizations: interchange the finite competitor maximum with the maximum over w. With arbitrary utility functions or an implicit set of alternatives, no general tractability claim follows; such variants are excluded. Minimax regret is not interchangeable with choosing the candidate that wins most often. Resource failures and uncertain metric measurements require a different scenario model; varying weights alone does not assess those risks.

Hypervolume is valuable for set coverage, but exact computation becomes #P-hard when dimension varies. Exact arbitrary-dimensional hypervolume and contributions are excluded. Use exact two-dimensional coverage when useful, or a fixed number of bounded-domain Monte Carlo membership checks for an additive-error estimate. The latter must not claim a useful relative error for tiny volumes without further analysis. Neither quantity represents personal preference. [Bringmann and Friedrich research overview](https://hpi.de/friedrich/research/the-hypervolume-indicator.html)

For an actual one-dimensional continuous front, arc length or another intrinsic measure is mathematically possible, but still depends on scaling and parameterization. For a finite binding set, a discrete counting or probability measure is more natural. Neither choice creates a preference ordering by itself.

**10. Inspect every binding without demanding one point per binding**

If task t has d_t choices, the unrestricted assignment count is the product of the d_t. Fifty binary choices already produce 2⁵⁰ possibilities. Even writing one record per solution can be prohibitive before optimization or drawing begins. An exponential Pareto front is also possible.

Exact multivalued decision diagrams are a useful alternative when the problem has reusable states. A path describes a binding; shared subpaths compress equivalent future decisions. Exact diagrams may still grow exponentially. Restricted diagrams represent a subset of feasible assignments; relaxed diagrams include all feasible assignments and potentially infeasible ones, supplying bounds rather than unrestricted feasibility claims. [Bergman, Cire, van Hoeve and Hooker project overview](https://www.andrew.cmu.edu/user/vanhoeve/mdd/)

For OpenBinding, generic exact decision-diagram compilation is excluded because constructing the diagram can require exponential work. If a compact exact diagram is already supplied, path counting and additive shortest-path queries are polynomial in its size. A new diagram is acceptable only for a restricted model class with a proven polynomial state bound. “It often compresses well” does not meet the stated requirement.

For local inspection, the existing Hamming-distance-one evaluator is a better immediate fit. Show real alternatives and changed assignments; expand two-step neighborhoods only on demand. A feasible local-move graph can be disconnected, so a missing path through observed neighbors does not prove the absence of another feasible family. Geometric Delaunay adjacency is not evidence of a legal assignment move.

PCA, MDS, UMAP, and similar views can organize observed candidates, but cannot generally preserve feasibility, dominance, neighborhood distances, and volume simultaneously in two dimensions. The UMAP authors specifically note density distortion and possible artificial cluster separations. Use embeddings for discovery with linked original values, not for filling certified feasible regions or scoring cell areas. [UMAP documentation](https://umap-learn.readthedocs.io/en/latest/clustering.html)

**11. Scalability and polynomial-time policy**

There are separate costs for discovering solutions, analyzing a supplied archive, and rendering the result. A faster renderer only addresses the third. The recommended layer performs no generic solution discovery. The costs below are mathematical operation counts or design estimates, not measured OpenBinding throughput. Let N be evaluated candidates, m objectives, k requested alternatives, and M explicitly bounded preference scenarios. Numerical costs also depend on input precision.

| Operation | Representative cost | Execution recommendation |
|---|---|---|
| Compute one score per candidate | O(Nm) | Worker; server for large archives |
| Best and second for fixed preferences | O(Nm) using a scan, plus tie output | Immediate full-archive calculation |
| Full score ordering | O(Nm + N log N) | Worker/server; paginated display |
| Top-k scores | O(Nm + N log k) with a bounded heap | Avoid full ordering if k is small |
| Two-objective front / attainment staircase | O(N log N) sorting, O(N) sweep | Exact from archive, including duplicate handling |
| Current general Pareto layers | O(mN²) | Replace or restrict beyond the present ceiling |
| One weighted-sum winner interval on a line | O(Nm) inequalities | Exact sensitivity for selected binding |
| Preference-scenario top-k | O(M[Nm + N log k]) | Chunk, cancel, cache; disclose sampling |
| Two-dimensional Euclidean Voronoi | Standard O(N log N) construction, O(N) diagram size | Established geometry implementation if needed |
| Full higher-dimensional preference subdivision | Potentially very large output | Excluded; use fixed-dimensional slices |
| Generic integer achievement queries | Potentially NP-hard per query | Excluded, even with a timeout |
| Valid rational LP relaxation membership | Polynomial in explicit encoding size with an appropriate algorithm | Optional, only with sound polynomial-size translation |
| Complete implicit binding enumeration | Potentially exponentially many outputs | Excluded |

In a naive two-dimensional budget grid defined by all candidate thresholds, there can be O(N²) rectangles. Do not materialize all rectangles and full rankings in each. Use a staircase for achievement and query eligible top-k on demand, or rasterize a bounded visible resolution while retaining exact selection queries.

Maintain exact arithmetic or robust predicates where required for certificates and geometric boundaries. A raster cell containing both possible and impossible budgets must be shown as mixed/unknown or subdivided; a single center sample cannot certify it. Coordinates with strict inequalities and equality constraints need explicit boundary semantics.

Rendering should aggregate dense marks into tiles or bins, preserve extrema and selected candidates, and expand on zoom. Rankings must continue to use their advertised full candidate set. A representative display sample must carry its method and count; uniform random samples may miss rare trade-offs. Keep normalization fixed and avoid building a dense N-by-N distance matrix.

An epsilon archive gives an objective-resolution policy. For fixed normalized additive tolerances ε_j, coverage means that for every relevant feasible vector y there is a retained vector a with a_j ≤ y_j+ε_j in every coordinate. An archive can certify this relative to all evaluated candidates. Certifying it relative to every feasible binding needs stronger solver evidence. Keep the complete archive behind such a display summary, so exact ranking and candidate lookup still satisfy the agreed scope. Choosing any valid bounded-resolution representatives is different from finding a globally minimum-cardinality summary; the latter is not required.

Classical approximate-Pareto results show succinct multiplicative approximations under their positive-objective encoding assumptions, with dependence on the number of objectives; polynomial construction requires an appropriate tractable gap problem. They do not imply a universal polynomial-time approximation algorithm for arbitrary NP-hard bindings. Zero, negative, or clamped losses also prevent blindly importing relative-error guarantees. [Papadimitriou and Yannakakis, 2000](https://www.cs.purdue.edu/homes/yexiang/courses/18fall-cs590/papers/papadimitriou2000.pdf)

For many objectives, use linked pairwise views, parallel-coordinate comparison, and conditional preference slices. Disclose fixed hidden weights and budgets. Large Pareto membership alone can become uninformative; acceptability limits and user-selected trade-offs then do more explanatory work than adding more geometry. Polynomial runtime is necessary but insufficient for usability: O(N²m) can still be too slow at 100,000 candidates. Operation budgets, low-dimensional algorithms, pagination, and bounded-resolution rendering remain necessary.

**12. An implementation sequence suited to this platform**

**First increment: exact archive evidence.** Reuse canonical feasibility and losses to construct the achieved-budget staircase. Link a selected budget to all eligible candidates, winners, runners-up, and constraint explanations. Show “not met by returned candidates” outside the staircase. Add exact two-objective weighted-sum and Chebyshev winner intervals, retaining existing normalization and tie semantics explicitly. This increment does not require a new optimizer.

**Second increment: broader preference inspection.** Add three-objective weighted-sum simplex polygons and exact or clearly sampled Chebyshev slices. Add a rank-acceptability heatmap for stated scenarios or distributions. Retain dominated candidates for general top-k lists. Use sparse selection and comparison views, rather than placing a label on every point.

**Third increment: inexpensive model evidence.** Add sound analytic lower bounds and, only for supported model classes, polynomial-size LP relaxations. Combine their exclusions with archived witnesses; the remaining region stays unknown. Cache by model digest, objectives and transforms, hidden bounds, query, numerical policy, and analysis version. Include existing proof artifacts as separately identified evidence. Do not launch MILP, CP-SAT, SAT, generic nonlinear optimization, or exhaustive search from this view.

Each result should retain candidate identity, raw values, canonical losses, violated constraint identities, scope, witness, solver termination, model digest, and tolerance policy. The existing authenticated job-IR access and neighborhood evaluator offer useful integration patterns, but the current local evaluator cannot certify global absence of solutions.

**Fourth increment: specialized scale work.** Benchmark actual archives before changing rendering or geometry implementations. Add server/worker aggregation when needed. Support whole-space answers only for documented tractable families or already supplied compact exact representations. A general symbolic-projection engine and generic exact decision-diagram compilation are outside scope.

Selecting an excluded request should show the actual violated necessary bound or an already available conflict explanation. Generic minimum-cardinality repairs and MIP conflict searches are excluded. Linear slack minimization can be tractable for an explicit LP model, but relaxing that model does not automatically produce a feasible integer binding. IIS tools also distinguish irreducible from smallest inconsistent subsets; the UI should not blur these claims. [Gurobi infeasibility analysis](https://docs.gurobi.com/projects/optimizer/en/current/features/infeasibility.html)

**13. Usability, explainability, and acceptance criteria**

Use one dominant plot with linked selection and a compact comparison. Expose the axis meaning before advanced controls: actual outcomes, budgets, or priorities. Pair color with shapes and hatching. Keep feasibility, preference rank, observed Pareto status, and proof status separately readable; they are distinct attributes of the result.

Every recommendation should answer “under which rule, among which candidates, meeting which requirements?” Every negative region should identify whether it is a proof, a necessary-condition exclusion, or merely uncovered by current evidence. Selecting a region should expose a witness or the provenance of exclusion. Unknown regions should invite a bounded query, not an inferred answer.

Keep all co-winners accessible; preserve coincident binding groups. Show the next distinct score and the reason for the gap. Let the user inspect actual task changes and raw units alongside normalized contributions. Maintain keyboard controls, touch selection, readable mobile layout, and reduced motion. Animate only changes whose identity and semantics remain stable; do not animate a heuristic trace as gradient descent.

Before production use, validate these failure cases against exhaustive tiny models: hidden constraints at coincident projections; a dominated runner-up; unsupported Pareto points; tied scores; strict-reference versus ideal-reference Chebyshev; an empty eligible set; a zero-area actual objective set; strict and equality boundaries; conflicting requirements; timeout without proof; and objective normalization changes. Compare sampled displays with exact full-archive queries. Verify model-version invalidation and cancellation prevent stale proofs from being reused.

For scalability validation, measure interaction latency, memory, and cancellation on real 1k, 10k, and 100k archives. Report any optional LP-relaxation query time separately from chart response. Do not turn proposed size tiers or point-count limits into unmeasured performance promises.

The recommended direction is **polynomial-time archive attainment plus preference slices, linked to actual assignment evidence**. It exactly compares known bindings, shows proven existence and inexpensive exclusions, and preserves unknown space. A polynomial-time full exact global feasibility map for unrestricted models would imply P = NP when those models encode NP-complete feasibility. Explicitly listing every binding can also require exponentially large output. Neither global guarantee is needed for the agreed archive-analysis scope.

**Sources**

1. Lotov, A. (2005). [Approximation and Visualization of Pareto Frontier in the Framework of Classical Approach to Multi-Objective Optimization](https://drops.dagstuhl.de/entities/document/10.4230/DagSemProc.04461.8). Dagstuhl Seminar Proceedings 04461.8. Interactive Decision Maps and dominance-extension visualization.
2. Helfrich, S., Perini, T., Halffmann, P., and Ruzika, S. (2023). [Analysis of the weighted Tchebycheff weight set decomposition for multiobjective discrete optimization problems](https://link.springer.com/article/10.1007/s10898-023-01284-x). Journal of Global Optimization 86, 417–440. Strict-reference assumptions and winner-region structure.
3. Helfrich, S., Prinz, K., and Ruzika, S. (2024). [The Weighted p-Norm Weight Set Decomposition for Multiobjective Discrete Optimization Problems](https://link.springer.com/article/10.1007/s10957-024-02481-8). Journal of Optimization Theory and Applications 202, 1187–1216. Generalized norm-based weight regions and supportedness.
4. Dächert, K., Fleuren, T., and Klamroth, K. (2024). [A simple, efficient and versatile objective space algorithm for multiobjective integer programming](https://link.springer.com/article/10.1007/s00186-023-00841-0). Mathematical Methods of Operations Research 100, 351–384. Scalarization and objective-space refinement.
5. Mesquita-Cunha, M., Figueira, J. R., and Barbosa-Póvoa, A. P. (2021 preprint). [New epsilon-constraint methods for multi-objective integer linear programming: a Pareto front representation approach](https://arxiv.org/abs/2109.02630). Representation criteria and epsilon-constraint methods.
6. Lahdelma, R., and Salminen, P. (2001). [SMAA-2: Stochastic Multicriteria Acceptability Analysis for Group Decision Making](https://pubsonline.informs.org/doi/abs/10.1287/opre.49.3.444.11220). Operations Research 49(3), 444–454. Rank acceptability.
7. CGAL. [2D Triangulations: User Manual](https://doc.cgal.org/latest/Triangulation_2/index.html). Regular triangulations and power diagrams; documentation accessed September 2026.
8. Banyassady, B., et al. (2018 version). [Improved Time-Space Trade-offs for Computing Voronoi Diagrams](https://arxiv.org/abs/1708.00814). Higher-order Voronoi definitions and algorithmic costs.
9. Papadimitriou, C. H., and Yannakakis, M. (2000). [On the approximability of trade-offs and optimal access of web sources](https://www.cs.purdue.edu/homes/yexiang/courses/18fall-cs590/papers/papadimitriou2000.pdf). FOCS. Approximate Pareto sets and computational conditions.
10. Bringmann, K., and Friedrich, T. [The Hypervolume Indicator](https://hpi.de/friedrich/research/the-hypervolume-indicator.html). Author-maintained overview with original-paper references, including 2010 volume complexity and 2012 contribution complexity results.
11. Bergman, D., Cire, A. A., van Hoeve, W.-J., and Hooker, J. N. [Decision Diagrams for Optimization](https://www.andrew.cmu.edu/user/vanhoeve/mdd/). Research project overview; exact, restricted, and relaxed diagram semantics.
12. Google OR-Tools. [CP-SAT Solver](https://developers.google.com/optimization/cp/cp_solver). Status semantics; documentation accessed September 2026.
13. Gurobi. [Infeasibility Analysis](https://docs.gurobi.com/projects/optimizer/en/current/features/infeasibility.html). IIS and feasibility relaxation; documentation accessed September 2026.
14. pymoo. [Decomposition](https://pymoo.org/misc/decomposition.html). Scalarization contour examples; documentation accessed September 2026.
15. UMAP authors. [Using UMAP for Clustering](https://umap-learn.readthedocs.io/en/latest/clustering.html). Density distortion and artificial separations; documentation accessed September 2026.
16. Karmarkar, N. (1984). [A new polynomial-time algorithm for linear programming](https://www.stat.uchicago.edu/~lekheng/courses/302/classics/karmarkar.pdf). Combinatorica 4(4), 373–395. Polynomial complexity with rational input bit length.

The formulas connecting affine scores to power cells, the budget-conditioned ranking construction, monotonic query propagation, and the numerical toy example are derived explicitly in this report. They are proposed applications of the cited concepts, not claims of measured platform performance or new algorithmic complexity guarantees.
