package es.us.isa.qosawarewsbinding.search;

import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.CanonicalEvaluator;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/** Seeded random search over the canonical BIM v1 eligibility matrix. */
public final class V1RandomSearch {
  public static final class Result {
    private final CanonicalEvaluator.Evaluation best;
    private final long evaluations;
    private final long elapsedMs;

    Result(CanonicalEvaluator.Evaluation best, long evaluations, long elapsedMs) {
      this.best = best;
      this.evaluations = evaluations;
      this.elapsedMs = elapsedMs;
    }
    public CanonicalEvaluator.Evaluation best() { return best; }
    public long evaluations() { return evaluations; }
    public long elapsedMs() { return elapsedMs; }
  }

  private V1RandomSearch() {}

  public static Result run(BindingProblem problem, int iterations, Long timeBudgetMs, long seed) {
    if (iterations < 1) throw new IllegalArgumentException("iterations must be positive");
    CanonicalEvaluator evaluator = new CanonicalEvaluator(problem);
    Random random = new Random(seed);
    CanonicalEvaluator.Evaluation best = null;
    long started = System.nanoTime();
    long completed = 0;

    for (int iteration = 0; iteration < iterations; iteration++) {
      if (iteration > 0 && expired(started, timeBudgetMs)) break;
      Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
      for (String task : problem.serviceTasks()) {
        List<BindingProblem.Ref> eligible = problem.eligible(task);
        decision.put(task, eligible.get(random.nextInt(eligible.size())));
      }
      CanonicalEvaluator.Evaluation evaluation = evaluator.evaluate(decision);
      if (best == null || evaluator.comparator().compare(evaluation, best) < 0) best = evaluation;
      completed++;
    }
    long elapsed = (System.nanoTime() - started) / 1000000L;
    return new Result(best, completed, elapsed);
  }

  private static boolean expired(long started, Long budgetMs) {
    return budgetMs != null && (System.nanoTime() - started) / 1000000L >= budgetMs.longValue();
  }
}
