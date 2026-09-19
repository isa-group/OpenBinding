package es.us.isa.qosawarewsbinding.search;

import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.CanonicalEvaluator;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/** Seeded many-objective sampler with a bounded non-dominated archive. */
public final class V1ManySearch {
  public static final class Result {
    private final List<CanonicalEvaluator.Evaluation> solutions;
    private final long evaluations;
    private final long elapsedMs;
    Result(List<CanonicalEvaluator.Evaluation> solutions, long evaluations, long elapsedMs) {
      this.solutions = solutions;
      this.evaluations = evaluations;
      this.elapsedMs = elapsedMs;
    }
    public List<CanonicalEvaluator.Evaluation> solutions() { return solutions; }
    public long evaluations() { return evaluations; }
    public long elapsedMs() { return elapsedMs; }
  }

  private V1ManySearch() {}

  /** Compatibility for library callers; engine requests use the explicit overload below. */
  public static Result run(BindingProblem problem, int iterations, Long timeBudgetMs,
      int archiveSize, long seed) {
    JsonObject execution = new JsonObject();
    execution.addProperty("type", "MANY");
    execution.addProperty("scalarization", "pareto-front");
    execution.add("weights", new com.google.gson.JsonArray());
    return run(problem, execution, iterations, timeBudgetMs, archiveSize, seed);
  }

  public static Result run(BindingProblem problem, JsonObject optimization, int iterations, Long timeBudgetMs,
      int archiveSize, long seed) {
    if (iterations < 1 || archiveSize < 1) throw new IllegalArgumentException("Search budgets must be positive");
    if (!"pareto-front".equals(optimization.get("scalarization").getAsString())) {
      throw new IllegalArgumentException("pareto-sampling requires scalarization pareto-front");
    }
    if (!"MANY".equals(optimization.get("type").getAsString())) {
      throw new IllegalArgumentException("pareto-sampling requires optimization.type MANY");
    }
    CanonicalEvaluator evaluator = new CanonicalEvaluator(problem);
    Random random = new Random(seed);
    List<CanonicalEvaluator.Evaluation> archive = new ArrayList<CanonicalEvaluator.Evaluation>();
    long started = System.nanoTime();
    long completed = 0;

    for (int iteration = 0; iteration < iterations; iteration++) {
      if (iteration > 0 && timeBudgetMs != null
          && (System.nanoTime() - started) / 1000000L >= timeBudgetMs.longValue()) break;
      Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
      int taskIndex = 0;
      for (String task : problem.serviceTasks()) {
        List<BindingProblem.Ref> eligible = problem.eligible(task);
        int choice = iteration < eligible.size() && taskIndex == 0
            ? iteration : random.nextInt(eligible.size());
        decision.put(task, eligible.get(choice));
        taskIndex++;
      }
      CanonicalEvaluator.Evaluation evaluation = evaluator.evaluate(decision, optimization);
      completed++;
      if (!evaluation.feasible()) continue;
      updateArchive(archive, evaluation, evaluator, archiveSize);
    }
    return new Result(archive, completed, (System.nanoTime() - started) / 1000000L);
  }

  private static void updateArchive(List<CanonicalEvaluator.Evaluation> archive,
      CanonicalEvaluator.Evaluation candidate, CanonicalEvaluator evaluator, int limit) {
    for (CanonicalEvaluator.Evaluation member : archive) {
      if (sameDecision(member, candidate) || evaluator.dominates(member, candidate)) return;
    }
    List<CanonicalEvaluator.Evaluation> kept = new ArrayList<CanonicalEvaluator.Evaluation>();
    for (CanonicalEvaluator.Evaluation member : archive) {
      if (!evaluator.dominates(candidate, member)) kept.add(member);
    }
    kept.add(candidate);
    kept.sort(evaluator.comparator());
    archive.clear();
    archive.addAll(kept.subList(0, Math.min(limit, kept.size())));
  }

  private static boolean sameDecision(CanonicalEvaluator.Evaluation left,
      CanonicalEvaluator.Evaluation right) {
    return left.binding().equals(right.binding());
  }
}
