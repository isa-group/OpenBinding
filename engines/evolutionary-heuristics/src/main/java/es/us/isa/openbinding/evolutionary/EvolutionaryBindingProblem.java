package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.uma.jmetal.problem.integerproblem.impl.AbstractIntegerProblem;
import org.uma.jmetal.solution.integersolution.IntegerSolution;

final class EvolutionaryBindingProblem extends AbstractIntegerProblem {
  static final String EVALUATION_ATTRIBUTE = "openbinding.evaluation";
  // Strictly above any feasible MONO objective (weighted losses in [0,1] plus
  // bounded soft penalties), so feasible always dominates infeasible.
  static final double INFEASIBLE_OFFSET = 1000.0;

  /** Thrown from evaluate() when the wall-clock budget is exhausted. */
  static final class BudgetExhaustedException extends RuntimeException {
    BudgetExhaustedException(String message) {
      super(message);
    }
  }

  private final BindingEvaluator evaluator;
  private final Instance instance;
  private final Options options;
  private final boolean hasSoftConstraints;

  // Per-evaluation trace (MONO objective only): best-so-far improvements with
  // evaluation index and wall-clock offset, enabling offline convergence and
  // time-budget analyses.
  private final List<Map<String, Object>> trace = new ArrayList<>();
  private long evaluationCount = 0;
  private long startNanos = System.nanoTime();
  private double bestFeasible = Double.POSITIVE_INFINITY;
  private double bestHardViolation = Double.POSITIVE_INFINITY;
  // Best individuals ever evaluated (MONO): survive generation boundaries and
  // budget-exhaustion interruptions.
  private IntegerSolution bestFeasibleSolution;
  private IntegerSolution bestInfeasibleSolution;
  // Wall-clock stopping criterion; min evaluations are always honoured.
  private Long timeBudgetMs;
  private long minEvaluations = 0;

  EvolutionaryBindingProblem(Instance instance, Options options) {
    this(instance, options, null);
  }

  EvolutionaryBindingProblem(Instance instance, Options options, ApiModels.Placement placement) {
    this.instance = instance;
    this.options = options;
    this.evaluator = new BindingEvaluator(
        instance, placement != null ? new PlacementEvaluator(placement) : null);
    this.hasSoftConstraints = instance.constraints.stream().anyMatch(c -> !c.isHard());

    name("OpenBindingEvolutionaryProblem");
    numberOfObjectives(baseObjectiveCount() + (appendSoftObjective() ? 1 : 0));
    numberOfConstraints(1);

    List<Integer> lowerBounds = new ArrayList<>();
    List<Integer> upperBounds = new ArrayList<>();
    for (int i = 0; i < evaluator.taskIds().size(); i++) {
      lowerBounds.add(0);
      upperBounds.add(evaluator.candidateCount(i) - 1);
    }
    variableBounds(lowerBounds, upperBounds);
  }

  @Override
  public IntegerSolution evaluate(IntegerSolution solution) {
    BindingEvaluator.Evaluation evaluation = evaluator.evaluate(solution.variables());
    solution.attributes().put(EVALUATION_ATTRIBUTE, evaluation);

    if ("MONO".equalsIgnoreCase(instance.objective.type)) {
      double weightedLoss = 0.0;
      double totalWeight = 0.0;
      for (String target : instance.objective.targets) {
        double weight = instance.objective.weights.getOrDefault(target, 1.0);
        weightedLoss += weight * evaluation.losses().getOrDefault(target, 1.0);
        totalWeight += weight;
      }
      double objective = (totalWeight > 0.0 ? weightedLoss / totalWeight : weightedLoss)
          + options.soft_penalty * evaluation.constraints().softViolation();
      // Deb's feasibility rules folded into the scalar objective: any feasible
      // solution beats any infeasible one, and infeasible solutions are ranked
      // by their hard-constraint violation. Without this, algorithms whose
      // dominance comparator ignores jMetal constraints() converge to the
      // unconstrained optimum.
      double hardViolation = evaluation.constraints().hardViolation();
      if (hardViolation > 0.0) {
        objective = INFEASIBLE_OFFSET + hardViolation;
      }
      solution.objectives()[0] = objective;
    } else {
      int index = 0;
      for (String target : instance.objective.targets) {
        solution.objectives()[index++] = evaluation.losses().getOrDefault(target, 1.0);
      }
      if (appendSoftObjective()) {
        solution.objectives()[index] = evaluation.constraints().softViolation();
      }
    }

    solution.constraints()[0] = -evaluation.constraints().hardViolation();
    recordTrace(solution, evaluation);
    return solution;
  }

  private synchronized void recordTrace(
      IntegerSolution solution, BindingEvaluator.Evaluation evaluation) {
    evaluationCount++;
    if (!"MONO".equalsIgnoreCase(instance.objective.type)) {
      return;
    }
    long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;
    double hardViolation = evaluation.constraints().hardViolation();
    boolean feasible = hardViolation <= 0.0;
    double objective = solution.objectives()[0];

    if (feasible && objective < bestFeasible - 1e-12) {
      bestFeasible = objective;
      bestFeasibleSolution = (IntegerSolution) solution.copy();
      bestFeasibleSolution.attributes().put(EVALUATION_ATTRIBUTE, evaluation);
      trace.add(traceEntry(evaluationCount, elapsedMs, objective, true, 0.0));
    } else if (!feasible
        && bestFeasible == Double.POSITIVE_INFINITY
        && hardViolation < bestHardViolation - 1e-12) {
      // No feasible solution yet: track progress towards feasibility.
      bestHardViolation = hardViolation;
      bestInfeasibleSolution = (IntegerSolution) solution.copy();
      bestInfeasibleSolution.attributes().put(EVALUATION_ATTRIBUTE, evaluation);
      trace.add(traceEntry(evaluationCount, elapsedMs, objective, false, hardViolation));
    }

    if (timeBudgetMs != null
        && evaluationCount >= minEvaluations
        && elapsedMs >= timeBudgetMs.longValue()) {
      throw new BudgetExhaustedException(
          "Time budget of " + timeBudgetMs + " ms exhausted after "
              + evaluationCount + " evaluations");
    }
  }

  synchronized void configureBudget(Long budgetMs, long minEvals) {
    this.timeBudgetMs = budgetMs;
    this.minEvaluations = minEvals;
  }

  synchronized IntegerSolution bestTrackedSolution() {
    return bestFeasibleSolution != null ? bestFeasibleSolution : bestInfeasibleSolution;
  }

  private static Map<String, Object> traceEntry(
      long evalIndex, long elapsedMs, double objective, boolean feasible, double hardViolation) {
    Map<String, Object> entry = new LinkedHashMap<>();
    entry.put("eval_index", evalIndex);
    entry.put("elapsed_ms", elapsedMs);
    entry.put("best_objective", objective);
    entry.put("feasible", feasible);
    entry.put("hard_violation", hardViolation);
    return entry;
  }

  synchronized void resetTrace() {
    trace.clear();
    evaluationCount = 0;
    bestFeasible = Double.POSITIVE_INFINITY;
    bestHardViolation = Double.POSITIVE_INFINITY;
    bestFeasibleSolution = null;
    bestInfeasibleSolution = null;
    startNanos = System.nanoTime();
  }

  synchronized List<Map<String, Object>> traceSnapshot() {
    return new ArrayList<>(trace);
  }

  synchronized long evaluationCount() {
    return evaluationCount;
  }

  BindingEvaluator evaluator() {
    return evaluator;
  }

  private int baseObjectiveCount() {
    return "MONO".equalsIgnoreCase(instance.objective.type) ? 1 : instance.objective.targets.size();
  }

  private boolean appendSoftObjective() {
    return hasSoftConstraints && !"MONO".equalsIgnoreCase(instance.objective.type);
  }
}
