package es.us.isa.qosawarewsbinding.bimstar;

import static es.us.isa.qosawarewsbinding.bimstar.BimStarModels.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Seeded uniform random search over the binding space of a BIM' instance.
 *
 * <p>Each iteration draws one candidate per task uniformly at random and
 * evaluates the canonical MONO objective. Best-so-far improvements are traced
 * with their evaluation index and wall-clock offset, enabling offline
 * convergence and time-budget analyses.
 */
public final class BimStarRandomSearch {

  private static final double SOFT_PENALTY = 10.0;

  public static final class Result {
    public Map<String, String> binding = new LinkedHashMap<>();
    public Map<String, Double> aggregated = new LinkedHashMap<>();
    public List<ViolationDto> violations = new ArrayList<>();
    public double objective;
    public boolean feasible;
    public long evaluations;
    public List<Map<String, Object>> trace = new ArrayList<>();
  }

  private BimStarRandomSearch() {}

  public static Result run(Instance instance, Placement placement, int iterations, long seed) {
    return run(instance, placement, iterations, null, seed);
  }

  /**
   * @param minIterations minimum number of evaluations (always honoured)
   * @param timeBudgetMs wall-clock budget; when null, exactly minIterations
   *     evaluations are performed
   */
  public static Result run(
      Instance instance, Placement placement, int minIterations, Long timeBudgetMs, long seed) {
    PlacementEvaluator placementEvaluator =
        placement != null ? new PlacementEvaluator(placement) : null;
    BindingEvaluator evaluator = new BindingEvaluator(instance, placementEvaluator);
    Random random = new Random(seed);

    int taskCount = evaluator.taskIds().size();
    Result result = new Result();
    BindingEvaluator.Evaluation best = null;
    double bestObjective = Double.POSITIVE_INFINITY;
    boolean bestFeasible = false;
    double bestHardViolation = Double.POSITIVE_INFINITY;

    long startNanos = System.nanoTime();
    for (long i = 1; shouldContinue(i, minIterations, timeBudgetMs, startNanos); i++) {
      List<Integer> chromosome = new ArrayList<>(taskCount);
      for (int t = 0; t < taskCount; t++) {
        chromosome.add(random.nextInt(evaluator.candidateCount(t)));
      }
      BindingEvaluator.Evaluation evaluation = evaluator.evaluate(chromosome);
      double objective = evaluator.monoObjective(evaluation, SOFT_PENALTY);
      double hardViolation = evaluation.constraints().hardViolation();
      boolean feasible = hardViolation <= 0.0;
      long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;

      boolean improved;
      if (feasible) {
        improved = !bestFeasible || objective < bestObjective - 1e-12;
      } else {
        improved = !bestFeasible && hardViolation < bestHardViolation - 1e-12;
      }
      if (improved) {
        best = evaluation;
        bestObjective = objective;
        bestFeasible = feasible;
        bestHardViolation = hardViolation;

        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("eval_index", i);
        entry.put("elapsed_ms", elapsedMs);
        entry.put("best_objective", objective);
        entry.put("feasible", feasible);
        entry.put("hard_violation", feasible ? 0.0 : hardViolation);
        result.trace.add(entry);
      }
      result.evaluations = i;
    }

    if (best != null) {
      result.binding.putAll(best.binding());
      result.aggregated.putAll(best.aggregated());
      result.violations.addAll(best.constraints().violations());
      result.objective = bestObjective;
      result.feasible = bestFeasible;
    }
    return result;
  }

  private static boolean shouldContinue(
      long iteration, int minIterations, Long timeBudgetMs, long startNanos) {
    if (iteration <= minIterations) {
      return true;
    }
    if (timeBudgetMs == null) {
      return false;
    }
    long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;
    return elapsedMs < timeBudgetMs.longValue();
  }
}
