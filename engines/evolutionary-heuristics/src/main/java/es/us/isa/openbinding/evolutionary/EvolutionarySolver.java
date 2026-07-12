package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import org.uma.jmetal.algorithm.Algorithm;
import org.uma.jmetal.algorithm.multiobjective.nsgaii.NSGAIIBuilder;
import org.uma.jmetal.algorithm.multiobjective.nsgaiii.NSGAIIIBuilder;
import org.uma.jmetal.operator.crossover.CrossoverOperator;
import org.uma.jmetal.operator.crossover.impl.IntegerSBXCrossover;
import org.uma.jmetal.operator.mutation.MutationOperator;
import org.uma.jmetal.operator.mutation.impl.IntegerPolynomialMutation;
import org.uma.jmetal.operator.selection.impl.BinaryTournamentSelection;
import org.uma.jmetal.solution.integersolution.IntegerSolution;
import org.uma.jmetal.util.SolutionListUtils;
import org.uma.jmetal.util.pseudorandom.JMetalRandom;

final class EvolutionarySolver {
  SolveResponse solve(SolveRequest request) {
    validate(request);
    Options options = request.options == null ? new Options() : request.options;
    EvolutionaryBindingProblem problem =
        new EvolutionaryBindingProblem(request.instance, options, request.placement);

    double mutationProbability = options.mutation_probability != null
        ? options.mutation_probability
        : 1.0 / Math.max(1, problem.numberOfVariables());
    String operators = resolveOperators(options.operators);
    CrossoverOperator<IntegerSolution> crossover;
    MutationOperator<IntegerSolution> mutation;
    if ("UNIFORM".equals(operators)) {
      // Categorical variation: candidate indices carry no ordinal meaning, so
      // genes are exchanged whole and mutations resample the full domain.
      crossover = new UniformIntegerCrossover(options.crossover_probability);
      mutation = new RandomResetIntegerMutation(mutationProbability);
    } else {
      crossover = new IntegerSBXCrossover(options.crossover_probability, options.distribution_index);
      mutation = new IntegerPolynomialMutation(mutationProbability, options.distribution_index);
    }

    JMetalRandom.getInstance().setSeed(options.seed);
    String algorithmName = resolveAlgorithm(request.instance.objective.type, options.algorithm);
    boolean mono = "MONO".equalsIgnoreCase(request.instance.objective.type);
    Long timeBudgetMs = options.time_budget_ms;
    if (timeBudgetMs != null && !mono) {
      throw new IllegalArgumentException("time_budget_ms is only supported for MONO objectives");
    }

    // With a wall-clock budget the evaluation limit becomes effectively
    // unbounded; the problem interrupts the run once the budget is exhausted
    // (never before max_evaluations, which acts as the minimum budget).
    int maxEvaluations = timeBudgetMs != null ? Integer.MAX_VALUE - 1 : options.max_evaluations;

    Algorithm<List<IntegerSolution>> algorithm;
    if ("NSGAIII".equals(algorithmName)) {
      int iterations = Math.max(1, maxEvaluations / Math.max(1, options.population_size));
      algorithm = new NSGAIIIBuilder<IntegerSolution>(problem)
          .setMaxIterations(iterations)
          .setNumberOfDivisions(options.reference_divisions)
          .setCrossoverOperator(crossover)
          .setMutationOperator(mutation)
          .setSelectionOperator(new BinaryTournamentSelection<>())
          .build();
    } else {
      algorithm = new NSGAIIBuilder<IntegerSolution>(problem, crossover, mutation, options.population_size)
          .setMaxEvaluations(maxEvaluations)
          .build();
    }

    problem.resetTrace();
    problem.configureBudget(timeBudgetMs, options.max_evaluations);
    long started = System.currentTimeMillis();
    boolean budgetExhausted = false;
    List<IntegerSolution> result;
    try {
      algorithm.run();
      result = algorithm.result();
    } catch (EvolutionaryBindingProblem.BudgetExhaustedException exception) {
      budgetExhausted = true;
      result = new ArrayList<>();
    }
    long elapsed = System.currentTimeMillis() - started;
    // Snapshot before toDto(), which may re-evaluate solutions.
    List<java.util.Map<String, Object>> trace = problem.traceSnapshot();
    long evaluations = problem.evaluationCount();

    // For MONO the best individual ever evaluated is authoritative: it
    // survives generational replacement and budget interruptions.
    if (mono) {
      IntegerSolution best = problem.bestTrackedSolution();
      if (best != null) {
        result = new ArrayList<>(List.of(best));
      }
    }

    List<IntegerSolution> selected = selectResult(result, request.instance.objective.type, options.archive_size);
    SolveResponse response = new SolveResponse();
    for (IntegerSolution solution : selected) {
      response.solutions.add(toDto(solution, problem));
    }
    response.provenance.execution_time_ms = elapsed;
    response.provenance.metadata.put("algorithm", algorithmName);
    response.provenance.metadata.put("operators", operators);
    response.provenance.metadata.put("seed", options.seed);
    response.provenance.metadata.put("population_size", options.population_size);
    response.provenance.metadata.put("max_evaluations", options.max_evaluations);
    response.provenance.metadata.put("returned_solutions", response.solutions.size());
    response.provenance.metadata.put("evaluations", evaluations);
    response.provenance.metadata.put("trace", trace);
    response.provenance.metadata.put("time_budget_ms", timeBudgetMs);
    response.provenance.metadata.put("budget_exhausted", budgetExhausted);
    return response;
  }

  private List<IntegerSolution> selectResult(
      List<IntegerSolution> result, String objectiveType, int archiveSize) {
    if ("MONO".equalsIgnoreCase(objectiveType)) {
      return result.stream()
          .filter(this::feasible)
          .min(Comparator.comparingDouble(s -> s.objectives()[0]))
          .map(List::of)
          .orElseGet(() -> result.stream()
              .min(Comparator.comparingDouble(s -> Math.abs(s.constraints()[0])))
              .map(List::of)
              .orElseGet(List::of));
    }
    List<IntegerSolution> feasibleSolutions = result.stream().filter(this::feasible).toList();
    List<IntegerSolution> candidates = feasibleSolutions.isEmpty()
        ? result.stream()
            .sorted(Comparator.comparingDouble(s -> Math.abs(s.constraints()[0])))
            .limit(Math.max(1, archiveSize))
            .toList()
        : feasibleSolutions;
    List<IntegerSolution> front = SolutionListUtils.getNonDominatedSolutions(candidates);
    front.sort(Comparator.comparingDouble(this::objectiveSum));
    return new ArrayList<>(front.subList(0, Math.min(Math.max(1, archiveSize), front.size())));
  }

  private SolutionDto toDto(IntegerSolution solution, EvolutionaryBindingProblem problem) {
    BindingEvaluator.Evaluation evaluation =
        (BindingEvaluator.Evaluation) solution.attributes().get(EvolutionaryBindingProblem.EVALUATION_ATTRIBUTE);
    if (evaluation == null) {
      problem.evaluate(solution);
      evaluation =
          (BindingEvaluator.Evaluation) solution.attributes().get(EvolutionaryBindingProblem.EVALUATION_ATTRIBUTE);
    }

    SolutionDto dto = new SolutionDto();
    dto.binding.putAll(evaluation.binding());
    dto.aggregated_features.putAll(evaluation.aggregated());
    dto.violations.addAll(evaluation.constraints().violations());
    // The engine's internal search objective (lower is better; for MONO this
    // is the weighted mean of normalized losses, with Deb's infeasibility
    // offset when no hard constraint is satisfied). The gateway audits it
    // against the canonical reference evaluation.
    dto.objective_value = solution.objectives()[0];
    dto.metadata.put("quality_score", problem.evaluator().qualityScore(evaluation));
    dto.metadata.put("objective_vector", Arrays.stream(solution.objectives()).boxed().toList());
    dto.metadata.put("hard_violation", evaluation.constraints().hardViolation());
    dto.metadata.put("soft_violation", evaluation.constraints().softViolation());
    dto.metadata.put("feasible", feasible(solution));
    return dto;
  }

  private boolean feasible(IntegerSolution solution) {
    return solution.constraints().length == 0 || solution.constraints()[0] >= 0.0;
  }

  private double objectiveSum(IntegerSolution solution) {
    return Arrays.stream(solution.objectives()).sum();
  }

  private String resolveOperators(String configured) {
    if (configured == null || configured.isBlank()) {
      return "SBX";
    }
    String normalized = configured.trim().toUpperCase();
    if (!normalized.equals("SBX") && !normalized.equals("UNIFORM")) {
      throw new IllegalArgumentException("operators must be SBX or UNIFORM");
    }
    return normalized;
  }

  private String resolveAlgorithm(String objectiveType, String configured) {
    if (configured != null && !"AUTO".equalsIgnoreCase(configured)) {
      String normalized = configured.replace("-", "").toUpperCase();
      if (!normalized.equals("NSGAII") && !normalized.equals("NSGAIII")) {
        throw new IllegalArgumentException("algorithm must be AUTO, NSGAII, or NSGAIII");
      }
      return normalized;
    }
    return "MANY".equalsIgnoreCase(objectiveType) ? "NSGAIII" : "NSGAII";
  }

  private void validate(SolveRequest request) {
    if (request == null || request.instance == null) {
      throw new IllegalArgumentException("Missing OpenBinding instance");
    }
    if (request.instance.objective == null || request.instance.objective.targets.isEmpty()) {
      throw new IllegalArgumentException("At least one objective target is required");
    }
    if (request.instance.composition == null || request.instance.composition.root == null) {
      throw new IllegalArgumentException("A structured composition root is required");
    }
  }
}
