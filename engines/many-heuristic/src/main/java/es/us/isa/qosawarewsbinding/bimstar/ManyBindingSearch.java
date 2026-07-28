package es.us.isa.qosawarewsbinding.bimstar;

import static es.us.isa.openbinding.core.EngineModels.*;
import es.us.isa.openbinding.core.model.AggregationFunction;
import es.us.isa.openbinding.core.model.AggregationPolicy;
import es.us.isa.openbinding.core.model.Branch;
import es.us.isa.openbinding.core.model.Candidate;
import es.us.isa.openbinding.core.model.Composition;
import es.us.isa.openbinding.core.model.Constraint;
import es.us.isa.openbinding.core.model.E2eModel;
import es.us.isa.openbinding.core.model.E2eScenario;
import es.us.isa.openbinding.core.model.Feature;
import es.us.isa.openbinding.core.model.Node;
import es.us.isa.openbinding.core.model.Normalization;
import es.us.isa.openbinding.core.model.NumericRange;
import es.us.isa.openbinding.core.model.Objective;
import es.us.isa.openbinding.core.model.Placement;
import es.us.isa.openbinding.core.model.PlacementResourceConstraint;
import es.us.isa.openbinding.core.model.PlacementTransition;
import es.us.isa.openbinding.core.model.Pool;

import es.us.isa.openbinding.core.BindingEvaluator;
import es.us.isa.openbinding.core.PlacementEvaluator;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Many-objective sampling with a Pareto archive, over the shared evaluator.
 *
 * <p>The objectives are the per-target normalized losses the evaluator already
 * computes, so a lower value is better on every one of them and the archive
 * needs no direction handling. Constraints follow the same feasibility-first
 * rule as the other engines: a feasible candidate always beats an infeasible
 * one, and among infeasible ones the smaller hard violation wins.
 *
 * <p>When nothing feasible is found the best infeasible candidate is returned
 * rather than an empty front. An empty front used to become a 422, which said
 * "your request is invalid" about a problem that was merely hard.
 */
public final class ManyBindingSearch {

  public static final class Result {
    public List<Map<String, String>> bindings = new ArrayList<>();
    public List<Map<String, Double>> aggregated = new ArrayList<>();
    public List<List<ViolationDto>> violations = new ArrayList<>();
    public List<Boolean> feasible = new ArrayList<>();
    public long evaluations;
  }

  private ManyBindingSearch() {}

  public static Result run(
      Instance instance,
      Placement placement,
      int minIterations,
      Long timeBudgetMs,
      int archiveSize,
      long seed) {
    PlacementEvaluator placementEvaluator =
        placement != null ? new PlacementEvaluator(placement) : null;
    BindingEvaluator evaluator = new BindingEvaluator(instance, placementEvaluator);
    Random random = new Random(seed);

    List<String> targets = instance.objective != null && instance.objective.targets != null
        ? instance.objective.targets
        : new ArrayList<String>();

    int taskCount = evaluator.taskIds().size();
    List<BindingEvaluator.Evaluation> archive = new ArrayList<BindingEvaluator.Evaluation>();

    BindingEvaluator.Evaluation bestInfeasible = null;
    double bestHardViolation = Double.POSITIVE_INFINITY;

    Result result = new Result();
    long startNanos = System.nanoTime();
    for (long i = 1; shouldContinue(i, minIterations, timeBudgetMs, startNanos); i++) {
      List<Integer> chromosome = new ArrayList<Integer>(taskCount);
      for (int t = 0; t < taskCount; t++) {
        chromosome.add(Integer.valueOf(random.nextInt(evaluator.candidateCount(t))));
      }
      BindingEvaluator.Evaluation evaluation = evaluator.evaluate(chromosome);
      double hardViolation = evaluation.constraints().hardViolation();
      result.evaluations = i;

      if (hardViolation > 0.0) {
        if (hardViolation < bestHardViolation) {
          bestHardViolation = hardViolation;
          bestInfeasible = evaluation;
        }
        continue;
      }
      updateArchive(archive, evaluation, targets, archiveSize);
    }

    if (archive.isEmpty() && bestInfeasible != null) {
      archive.add(bestInfeasible);
    }

    for (BindingEvaluator.Evaluation evaluation : archive) {
      result.bindings.add(new LinkedHashMap<String, String>(evaluation.binding()));
      result.aggregated.add(new LinkedHashMap<String, Double>(evaluation.aggregated()));
      result.violations.add(new ArrayList<ViolationDto>(evaluation.constraints().violations()));
      result.feasible.add(Boolean.valueOf(evaluation.constraints().hardViolation() <= 0.0));
    }
    return result;
  }

  private static void updateArchive(
      List<BindingEvaluator.Evaluation> archive,
      BindingEvaluator.Evaluation candidate,
      List<String> targets,
      int archiveSize) {
    for (BindingEvaluator.Evaluation member : archive) {
      if (dominates(member, candidate, targets)) {
        return;
      }
    }
    List<BindingEvaluator.Evaluation> kept = new ArrayList<BindingEvaluator.Evaluation>();
    for (BindingEvaluator.Evaluation member : archive) {
      if (!dominates(candidate, member, targets)) {
        kept.add(member);
      }
    }
    archive.clear();
    archive.addAll(kept);
    if (archive.size() < archiveSize) {
      archive.add(candidate);
    }
  }

  /** Losses are minimized, so domination is "no worse anywhere, better somewhere". */
  private static boolean dominates(
      BindingEvaluator.Evaluation a, BindingEvaluator.Evaluation b, List<String> targets) {
    boolean strictlyBetterSomewhere = false;
    for (String target : targets) {
      double lossA = loss(a, target);
      double lossB = loss(b, target);
      if (lossA > lossB + 1e-12) {
        return false;
      }
      if (lossA < lossB - 1e-12) {
        strictlyBetterSomewhere = true;
      }
    }
    return strictlyBetterSomewhere;
  }

  private static double loss(BindingEvaluator.Evaluation evaluation, String target) {
    Double value = evaluation.losses().get(target);
    return value == null ? 1.0 : value.doubleValue();
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
