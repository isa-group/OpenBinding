# Multiplicative aggregations in `minizinc-csp`

QoS composition models multiply per-service values whenever the quality of a
composition is the product of the qualities of its parts: availability,
reliability or successability over a sequence or a parallel block, the
probability-weighted product over an XOR (`Π_b x_b^{p_b}`), the power of a
loop body (`x^k`, with `k` the exact or expected iteration count) and the product
over the distinct candidates selected (`selection.product`). Until this
revision the exact engine rejected every one of them; the heuristic engines
were the only way to run RPRSR15, IoTS, BWS-SCP, most of the OpenBinding
scenarios and most of the quantum instances, so none of those suites had exact
labels. This note documents how the engine now supports them, why it is done
this way, and what the price is.

## 1. The classical trick and why it is not enough on its own

The logarithmic linearisation used in the ILP literature on QoS composition
(Zeng et al. 2004; Ardagna & Pernici 2007; Mahroo et al. 2026 in the BWS-SCP
model itself) replaces a product of decision-dependent factors by a sum of
constants:

```
Π_t v[t, x_t]            →  Σ_t ln v[t, x_t]
Π_b (branch_b)^{p_b}     →  Σ_b p_b · ln(branch_b)
(body)^k                 →  k · ln(body)
Π_{c selected} v_c       →  Σ_c sel_c · ln v_c
```

Because every `v` is a constant of the instance, each term is an element
constraint over a table of logarithms and the aggregate is a **linear**
expression of the selection variables. That is exactly what an integer
programme needs, and it is what makes the BWS-SCP MILP linear.

Applied naively to BIM it would change the problem, for two reasons.

1. **The objective is not linear in the logarithm.** BIM normalises every
   criterion as `(value − min) / (max − min)` on the *real* value and takes a
   weighted sum. `(e^L − min)/(max − min)` is convex in `L`, and a weighted sum
   of such terms with additive terms (time, cost) is not a monotone function of
   the log-sum. The ILP literature sidesteps this by normalising the
   logarithm itself (Zeng et al.), i.e. by solving a different objective. A
   benchmark engine cannot do that: the gateway re-evaluates every binding with
   the BIM objective, and an "optimal" label must be optimal for *that*
   objective. With a single multiplicative criterion the transform is monotone
   and harmless; with two or more criteria it is wrong.
2. **Gecode cannot undo the logarithm.** The bundled Gecode (6.3.0) has no
   `float_exp`, `float_ln` or `float_pow` propagators (they need MPFR, which the
   MiniZinc bundle does not link), so `value = exp(L)` cannot be posted. There
   is also no float element propagator, and no linear tolerance.

## 2. What the engine does

Every maximal pure-product subtree of a feature's workflow (nodes whose
operator for that feature is `product`, `weightedProduct`, `power` or
`identity`) is flattened by the TypeScript lowering into a **flat product**: a
set of per-task exponents `e_t` (1 for a plain product; multiplied by the
routing probability under a weighted-product XOR and by the iteration count
under a power) and a constant (the product of the neutral elements of empty or
local nodes). Two consistent representations are generated for each flat
product, both functions of the same selection variables:

* **Exact real value** `P = const · Π_t v[t, x_t]^{e_t}`. Unit exponents read
  the candidate table directly; other exponents read a table of powers computed
  by MiniZinc at flattening time (`pow` on parameters needs no solver support).
  The chain of `float_times` propagators is exact up to double rounding. It is
  used by the objective and by any comparison that mixes a product with an
  additive feature, so OPTIMAL means optimal for the BIM score.
* **Log-space value** `L = ln const + Σ_t e_t · ln v[t, x_t]`, a single linear
  constraint over tables of logarithms computed at flattening time. It is used
  for comparisons against literals and against other products: `P ≥ c` becomes
  `L ≥ ln c`, which is exact because the logarithm is monotone.

Mixed trees (for example the OpenBinding scenarios, where availability is a
product inside sequences and parallel blocks but a weighted *sum* over XORs)
keep their non-product nodes as ordinary tree nodes and flatten the product
subtrees below them; a weighted product or a fractional power whose child is
not a pure product cannot be represented exactly and is rejected with a 422
naming the feature.

Zero values are handled exactly in log space: `ln 0` is replaced by a constant
`−Z` chosen per feature so that any selection containing a zero factor is
separated from every all-positive selection by a gap of at least 10 log units;
literal thresholds are mapped accordingly (`P > 0` is "no zero factor",
`P == 0` is "a zero factor", a literal below every attainable positive product
behaves like 0). Negative values keep the feature out of log space (products of
negatives are still computed exactly in real space). Comparisons between two
products are done in log space only when neither can be zero.

Selected-candidate products use the same two representations over the selected
candidates; when every candidate is eligible for a single task (the common
case: BWS-SCP, IoTS) the sums and products run over the tasks instead of over
the whole catalog.

The per-task factors `v[t, x_t]` (and their powers and logarithms) are read
from the candidate tables through fixed-point integer element constraints
rather than through MiniZinc's reified decomposition of the float element (see
the README): the table of a task is as long as that task's eligibility list,
and the flattening cost is linear in the catalog size instead of in the
catalog size times the number of features.

## 3. Advantages

* **Exactness.** The objective is the BIM objective; constraints on products are
  equivalent to their real-space form. The engine's own evaluator and the
  gateway's evaluator agree with the solver's objective on every run of the
  validation below (score differences < 1e-9, feature differences at the level
  of double rounding).
* **Linear constraints where the literature has them.** A bound on a product
  becomes one `float_lin_le` over the selected logarithms, the strongest and
  cheapest propagator Gecode offers for this, instead of a chain of
  multiplications whose bounds must be propagated by repeated division.
* **No numerical overflow or underflow in the constraints.** Products of 240
  reliabilities (BWS-SCP) or powers from loops (RPRSR15 `LOOP(10)`) reach
  10^-168; their logarithms stay in a few hundred units.
* **Coverage.** Every multiplicative construct of the corpus is now executable:
  all 60 RPRSR15, 6 IoTS, 90 BWS-SCP, 46 quantum and 48 OpenBinding-scenario
  instances compile for the exact engine (the 24 scenarios with soft constraints
  needed only the constant-penalty soft constraints that were added at the same
  time). HSC remains heuristic-only because its sequence aggregations are
  custom expressions (means and geometric means over levels).

## 4. Disadvantages and limitations

* **Two encodings per product.** The real-space chain is still needed for the
  objective, so the log-space constraints are redundant from a modelling point
  of view; the model is larger (one extra linear constraint and one table of
  logarithms per product feature).
* **The objective bound is still propagated through the chain.** Gecode's
  `float_times` chain converges to the same bounds as the linear form, but
  through more propagator invocations; the log form does not accelerate
  branch-and-bound on the objective, only the feasibility reasoning.
* **Positivity.** Zero needs the gap construction, negative values disable the
  log form, and a weighted product or fractional power over a non-product
  subtree is rejected.
* **Boundary rounding.** `L ≥ ln c` and `P ≥ c` can disagree by one ulp when a
  binding sits exactly on the threshold. The lowering moves the literal of
  every non-strict comparison by the numeric slack towards feasibility
  (`numeric.ts`; in log space `ln c` moves by the slack of its own magnitude),
  so the solver never declares such a binding infeasible, and both the engine
  and the gateway re-evaluate the returned binding exactly: an incumbent that
  satisfies only the relaxed comparison is rejected (the latest exactly
  feasible incumbent is returned as FEASIBLE, or UNKNOWN when there is none).
  The domain-widening of the FlatZinc (see the README) covers the derived
  domains in the same way.
* **Not a substitute for `exp`.** A solver with transcendental propagators (or a
  MIP backend with a piecewise-linear `exp`) could link the two representations
  directly; here they are linked only through the selection variables.

## 5. Why this design (and not the alternatives)

* *Pure log objective* (the ILP way) was rejected because it solves a different
  problem whenever more than one criterion exists; the gateway would re-score the
  binding and the OPTIMAL label would be false.
* *Real-space products only* (no log form) would have been simplest and is
  exactly what the objective uses; the log form was added because it is the
  encoding that the composition literature and the BWS-SCP source model use for
  constraints, it is linear, and it is numerically safe for long chains.
  The engine keeps both and lets the user choose the constraint encoding
  (`product_constraints = log | real`) so that the choice can be measured
  instead of asserted.
* *Approximating `exp` piecewise-linearly* was rejected because a benchmark
  engine that claims OPTIMAL must not optimise an approximation.

## 6. Measurements

Local validation of this engine revision (MiniZinc 2.8.7 / Gecode 6.3.0, one
5 s run per instance, two concurrent workers on a two-core container, every
returned binding re-evaluated by the gateway's compiler):

| Suite | Instances | OPTIMAL | FEASIBLE | INFEASIBLE | Median engine ms | Notes |
|---|---:|---:|---:|---:|---:|---|
| OpenBinding scenarios | 48 | 48 | 0 | 0 | 217 | previously 24 incompatible (soft constraints), 2 timeouts |
| Quantum resource selection | 46 | 46 | 0 | 0 | 137 | previously 43 rejected (unused `product` operator) |
| IoTS | 6 | 6 | 0 | 0 | 626 | previously incompatible |
| RPRSR15 (regenerated, 9 criteria, loops) | 60 | 16 | 44 | 0 | 5,100 | previously incompatible; incumbents returned at the budget |
| BWS-SCP (regenerated sample) | 5 | 3 | 2 | 0 | 4,046 | placement capacities as bin packing |
| BWS-SCP (synthetic 240 tasks x 240 servers) | 1 | 0 | 1 | 0 | 5,379 | flattening 1.4 s (12 s before the fixed-point tables); capacity column covers the 240 checks |
| QFBS sample (120 of 5,200) | 120 | 91 | 3 | 26 | 271 | first campaign: 40 OPTIMAL on the same sample; 38 better scores, 0 contradictions |

Every returned binding matched the gateway's authoritative evaluation (score
difference below 1e-12, feature differences at the level of double rounding),
no returned binding violated a hard constraint, and no OPTIMAL label of any
revision was beaten by a binding of another revision or encoding.

Constraint-encoding ablation (`product_constraints = log` vs `real`, 60
regenerated RPRSR15 instances with two hard lower bounds on availability and
successability, one worker, 5 s): both encodings prove the same 20 instances
optimal with identical scores (median 346 ms vs 348 ms) and return incumbents
on the other 40 (12 incumbents differ, 4 in favour of `log`, 8 of `real`; all
within the time budget noise of branch-and-bound). On this corpus the log-space
constraints therefore buy numerical safety and linearity, not search speed:
Gecode's bounds reasoning on the real product chain is as strong as the linear
form for lower bounds on products of values in (0, 1]. The engine keeps `log`
as the default because the result is the same and the encoding does not
underflow for long chains (products of 240 reliabilities reach 1e-168).

## References

* L. Zeng et al., *QoS-aware middleware for Web services composition*, IEEE
  TSE 30(5), 2004 (logarithmic linearisation of multiplicative QoS in the ILP).
* D. Ardagna, B. Pernici, *Adaptive service composition in flexible processes*,
  IEEE TSE 33(6), 2007.
* F. Mahroo et al., *A novel integer linear model for reliability-centric
  service composition in cloud manufacturing*, CIE 211, 2026 (BWS-SCP MILP with
  `−W3 Σ log r`).
