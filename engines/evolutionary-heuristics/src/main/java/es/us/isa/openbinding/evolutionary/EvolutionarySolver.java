package es.us.isa.openbinding.evolutionary;

import com.google.gson.JsonObject;
import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.CanonicalEvaluator;
import es.us.isa.openbinding.core.EngineContract;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Elitist categorical genetic search over BIM v1 bindings.
 *
 * <p>Candidate ids are categorical, so crossover exchanges complete genes and
 * mutation resamples from the task's eligibility set.  Feasibility and every
 * optimization strategy are ranked by the canonical evaluator; Pareto mode
 * additionally maintains a non-dominated archive.</p>
 */
final class EvolutionarySolver {
  static final class Result {
    final List<CanonicalEvaluator.Evaluation> solutions;
    final long evaluations;
    final long elapsedMs;
    Result(List<CanonicalEvaluator.Evaluation> solutions, long evaluations, long elapsedMs) {
      this.solutions = solutions;
      this.evaluations = evaluations;
      this.elapsedMs = elapsedMs;
    }
  }

  Result evaluate(EngineContract.Request request) {
    JsonObject options = request.options();
    EngineContract.validateOptions(options, "algorithm", "population_size", "max_evaluations",
        "archive_size", "seed", "time_budget_ms", "crossover_probability", "mutation_probability");
    String algorithm = EngineContract.stringOption(options, "algorithm", "elitist-genetic");
    if (!"elitist-genetic".equals(algorithm) && !"pareto-genetic".equals(algorithm)) {
      throw new IllegalArgumentException("options.algorithm must be elitist-genetic or pareto-genetic");
    }
    String mode = request.problem().optimization().get("mode").getAsString();
    if ("pareto-genetic".equals(algorithm) && !"pareto".equals(mode)) {
      throw new IllegalArgumentException("pareto-genetic requires optimization.mode pareto");
    }
    if ("elitist-genetic".equals(algorithm) && "pareto".equals(mode)) {
      throw new IllegalArgumentException("elitist-genetic does not implement Pareto archive semantics");
    }
    int populationSize = EngineContract.integerOption(options, "population_size", 100, 2, 10000);
    // The public options schema permits a budget smaller than the population.
    // In that case the first generation is deliberately only partially scored.
    int maxEvaluations = EngineContract.integerOption(options, "max_evaluations", 10000, 2, 10000000);
    int archiveSize = EngineContract.integerOption(options, "archive_size", 100, 1, 10000);
    long seed = EngineContract.longOption(options, "seed", 0L);
    Long timeBudget = EngineContract.optionalPositiveLong(options, "time_budget_ms");
    double crossover = probability(options, "crossover_probability", 0.9);
    double mutation = probability(options, "mutation_probability",
        1.0 / Math.max(1, request.problem().serviceTasks().size()));
    return search(request.problem(), algorithm, populationSize, maxEvaluations, archiveSize,
        seed, timeBudget, crossover, mutation);
  }

  private Result search(BindingProblem problem, String algorithm, int populationSize,
      int maxEvaluations, int archiveSize, long seed, Long timeBudgetMs,
      double crossoverProbability, double mutationProbability) {
    CanonicalEvaluator evaluator = new CanonicalEvaluator(problem);
    Random random = new Random(seed);
    List<Map<String, BindingProblem.Ref>> population = new ArrayList<Map<String, BindingProblem.Ref>>();
    for (int index = 0; index < populationSize; index++) population.add(randomDecision(problem, random, index));

    List<CanonicalEvaluator.Evaluation> archive = new ArrayList<CanonicalEvaluator.Evaluation>();
    CanonicalEvaluator.Evaluation best = null;
    long evaluations = 0;
    long started = System.nanoTime();
    while (evaluations < maxEvaluations && !expired(started, timeBudgetMs, evaluations)) {
      List<CanonicalEvaluator.Evaluation> scored = new ArrayList<CanonicalEvaluator.Evaluation>();
      for (Map<String, BindingProblem.Ref> chromosome : population) {
        if (evaluations >= maxEvaluations || expired(started, timeBudgetMs, evaluations)) break;
        CanonicalEvaluator.Evaluation evaluation = evaluator.evaluate(chromosome);
        scored.add(evaluation);
        evaluations++;
        if (evaluation.feasible()) {
          if (best == null || evaluator.comparator().compare(evaluation, best) < 0) best = evaluation;
          if ("pareto-genetic".equals(algorithm)) updateArchive(archive, evaluation, evaluator, archiveSize);
        }
      }
      if (scored.isEmpty()) break;
      scored.sort(evaluator.comparator());
      List<Map<String, BindingProblem.Ref>> next = new ArrayList<Map<String, BindingProblem.Ref>>();
      // Elitism keeps the best ten percent.  Remaining children come from
      // tournament selection followed by categorical uniform crossover.
      int elites = Math.max(1, populationSize / 10);
      for (int index = 0; index < Math.min(elites, scored.size()); index++) {
        next.add(new LinkedHashMap<String, BindingProblem.Ref>(scored.get(index).binding()));
      }
      while (next.size() < populationSize) {
        CanonicalEvaluator.Evaluation first = tournament(scored, evaluator, random);
        CanonicalEvaluator.Evaluation second = tournament(scored, evaluator, random);
        Map<String, BindingProblem.Ref> child = new LinkedHashMap<String, BindingProblem.Ref>();
        for (String task : problem.serviceTasks()) {
          BindingProblem.Ref gene = random.nextDouble() < crossoverProbability
              ? (random.nextBoolean() ? first.binding().get(task) : second.binding().get(task))
              : first.binding().get(task);
          if (random.nextDouble() < mutationProbability) {
            List<BindingProblem.Ref> eligible = problem.eligible(task);
            gene = eligible.get(random.nextInt(eligible.size()));
          }
          child.put(task, gene);
        }
        next.add(child);
      }
      population = next;
    }
    if (!"pareto-genetic".equals(algorithm) && best != null) archive.add(best);
    return new Result(archive, evaluations, (System.nanoTime() - started) / 1000000L);
  }

  private static Map<String, BindingProblem.Ref> randomDecision(BindingProblem problem,
      Random random, int populationIndex) {
    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    int taskIndex = 0;
    for (String task : problem.serviceTasks()) {
      List<BindingProblem.Ref> eligible = problem.eligible(task);
      int selected = taskIndex == 0 && populationIndex < eligible.size()
          ? populationIndex : random.nextInt(eligible.size());
      decision.put(task, eligible.get(selected));
      taskIndex++;
    }
    return decision;
  }

  private static CanonicalEvaluator.Evaluation tournament(
      List<CanonicalEvaluator.Evaluation> population, CanonicalEvaluator evaluator, Random random) {
    CanonicalEvaluator.Evaluation first = population.get(random.nextInt(population.size()));
    CanonicalEvaluator.Evaluation second = population.get(random.nextInt(population.size()));
    return evaluator.comparator().compare(first, second) <= 0 ? first : second;
  }

  private static void updateArchive(List<CanonicalEvaluator.Evaluation> archive,
      CanonicalEvaluator.Evaluation candidate, CanonicalEvaluator evaluator, int limit) {
    for (CanonicalEvaluator.Evaluation member : archive) {
      if (member.binding().equals(candidate.binding()) || evaluator.dominates(member, candidate)) return;
    }
    archive.removeIf(member -> evaluator.dominates(candidate, member));
    archive.add(candidate);
    archive.sort(evaluator.comparator());
    while (archive.size() > limit) archive.remove(archive.size() - 1);
  }

  private static boolean expired(long started, Long timeBudgetMs, long evaluations) {
    return timeBudgetMs != null && evaluations > 0
        && (System.nanoTime() - started) / 1000000L >= timeBudgetMs.longValue();
  }

  private static double probability(JsonObject options, String name, double fallback) {
    if (!options.has(name)) return fallback;
    double value = BindingProblem.finiteNumber(options.get(name), "options." + name);
    if (value < 0.0 || value > 1.0) throw new IllegalArgumentException("options." + name + " must be in [0,1]");
    return value;
  }
}
