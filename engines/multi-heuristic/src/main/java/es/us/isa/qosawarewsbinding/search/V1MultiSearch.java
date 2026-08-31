package es.us.isa.qosawarewsbinding.search;

import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.CanonicalEvaluator;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/** Seeded two/three-objective sampler with a bounded non-dominated archive. */
public final class V1MultiSearch {
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

  private V1MultiSearch() {}

  public static Result run(BindingProblem problem, int iterations, Long timeBudgetMs,
      int archiveSize, long seed) {
    if (iterations < 1 || archiveSize < 1) {
      throw new IllegalArgumentException("Search budgets must be positive");
    }
    if (!"pareto".equals(problem.optimization().get("mode").getAsString())) {
      throw new IllegalArgumentException("pareto-sampling requires optimization.mode pareto");
    }
    if (!"MULTI".equals(problem.optimization().get("type").getAsString())) {
      throw new IllegalArgumentException("pareto-sampling requires optimization.type MULTI");
    }
    int objectives = problem.optimization().getAsJsonArray("terms").size();
    if (objectives < 2 || objectives > 3) {
      throw new IllegalArgumentException("MULTI optimization requires two or three terms");
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
      CanonicalEvaluator.Evaluation evaluation = evaluator.evaluate(decision);
      completed++;
      if (evaluation.feasible()) updateArchive(archive, evaluation, evaluator, archiveSize);
    }
    return new Result(archive, completed, (System.nanoTime() - started) / 1000000L);
  }

  private static void updateArchive(List<CanonicalEvaluator.Evaluation> archive,
      CanonicalEvaluator.Evaluation candidate, CanonicalEvaluator evaluator, int limit) {
    for (CanonicalEvaluator.Evaluation member : archive) {
      if (member.binding().equals(candidate.binding()) || evaluator.dominates(member, candidate)) return;
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
}
