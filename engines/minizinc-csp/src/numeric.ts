/**
 * Numerical slack shared by the lowering (`dzn_builder.ts`) and the FlatZinc
 * post-processing (`minizinc_runner.ts`).
 *
 * Two sources of rounding sit between the exact data of a BindingProblem and
 * the propagators that finally reason about it:
 *
 * 1. MiniZinc prints float literals into the FlatZinc with 16 significant
 *    digits, one short of the 17 that round-trip a double. A bound such as
 *    `161.51470755605504` leaves the flattener as `161.514707556055`, a value
 *    smaller than the double it came from.
 * 2. Gecode keeps every float variable as an outward-rounded interval, so a
 *    value that is attainable exactly (the sum of the largest latency of every
 *    task, a product of candidate reliabilities) occupies a few ulps around the
 *    mathematical number.
 *
 * A bound that is tight to the data therefore excludes attainable values, and
 * because the excluded values are precisely the extreme ones (every task on its
 * slowest or cheapest candidate), the consequence is not noise but a false
 * `UNSATISFIABLE` or a false optimum. The first QACOBench campaign recorded two
 * such false optima, both caused by a technical metric bound that had been
 * printed with 16 digits and survived unwidened as an explicit `float_le`.
 *
 * The lowering therefore never emits a tight number: every technical bound is
 * widened by `slackOf`, every comparison literal of a non-strict constraint is
 * moved by `slackOf` in the direction that enlarges the feasible region, and
 * the post-processing widens the declared FlatZinc domains by the same amount.
 * The slack (relative 1e-9, absolute 1e-9 below magnitude 1) is orders of
 * magnitude above double rounding and orders of magnitude below any benchmark
 * tolerance; it only relaxes, so no solution is lost, and every returned
 * decision is re-evaluated exactly by the engine and again by the gateway,
 * which is the authority on feasibility and on the objective value.
 */
export const FLOAT_DOMAIN_SLACK = 1e-9;

/** Slack applied to a number of the given magnitude (relative, with an absolute floor below 1). */
export const slackOf = (value: number): number => Math.max(Math.abs(value), 1) * FLOAT_DOMAIN_SLACK;

/**
 * A technical bound `|x| <= bound`, widened so that rounding cannot exclude an attainable `x`.
 * Non-finite input is returned unchanged; the DZN formatter reports it with its usual error.
 */
export const widenBound = (bound: number): number =>
  Number.isFinite(bound) ? bound + slackOf(bound) : bound;

/**
 * A comparison literal moved by one slack in `direction` (+1 raises it, -1 lowers it).
 * Callers pick the direction that enlarges the feasible region of the comparison.
 * Non-finite input is returned unchanged; the DZN formatter reports it with its usual error.
 */
export const relaxLiteral = (value: number, direction: 1 | -1): number =>
  Number.isFinite(value) ? value + direction * slackOf(value) : value;
