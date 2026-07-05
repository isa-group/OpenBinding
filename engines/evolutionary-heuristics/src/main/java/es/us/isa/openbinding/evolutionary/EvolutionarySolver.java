package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import org.uma.jmetal.algorithm.Algorithm;
import org.uma.jmetal.algorithm.multiobjective.nsgaii.NSGAIIBuilder;
import org.uma.jmetal.algorithm.multiobjective.nsgaiii.NSGAIIIBuilder;
import org.uma.jmetal.operator.crossover.impl.IntegerSBXCrossover;
import org.uma.jmetal.operator.mutation.impl.IntegerPolynomialMutation;
import org.uma.jmetal.operator.selection.impl.BinaryTournamentSelection;
import org.uma.jmetal.solution.integersolution.IntegerSolution;
import org.uma.jmetal.util.SolutionListUtils;
import org.uma.jmetal.util.pseudorandom.JMetalRandom;

final class EvolutionarySolver {
  SolveResponse solve(SolveRequest request) {
    validate(request);
    Options options = request.options == null ? new Options() : request.options;
    EvolutionaryBindingProblem problem = new EvolutionaryBindingProblem(request.instance, options);

    double mutationProbability = options.mutation_probability != null
        ? options.mutation_probability
        : 1.0 / Math.max(1, problem.numberOfVariables());
    IntegerSBXCrossover crossover =
        new IntegerSBXCrossover(options.crossover_probability, options.distribution_index);
    IntegerPolynomialMutation mutation =
        new IntegerPolynomialMutation(mutationProbability, options.distribution_index);

    JMetalRandom.getInstance().setSeed(options.seed);
    String algorithmName = resolveAlgorithm(request.instance.objective.type, options.algorithm);
    Algorithm<List<IntegerSolution>> algorithm;
    if ("NSGAIII".equals(algorithmName)) {
      int iterations = Math.max(1, options.max_evaluations / Math.max(1, options.population_size));
      algorithm = new NSGAIIIBuilder<IntegerSolution>(problem)
          .setMaxIterations(iterations)
          .setNumberOfDivisions(options.reference_divisions)
          .setCrossoverOperator(crossover)
          .setMutationOperator(mutation)
          .setSelectionOperator(new BinaryTournamentSelection<>())
          .build();
    } else {
      algorithm = new NSGAIIBuilder<IntegerSolution>(problem, crossover, mutation, options.population_size)
          .setMaxEvaluations(options.max_evaluations)
          .build();
    }

    long started = System.currentTimeMillis();
    algorithm.run();
    List<IntegerSolution> result = algorithm.result();
    long elapsed = System.currentTimeMillis() - started;

    List<IntegerSolution> selected = selectResult(result, request.instance.objective.type, options.archive_size);
    SolveResponse response = new SolveResponse();
    for (IntegerSolution solution : selected) {
      response.solutions.add(toDto(solution, problem));
    }
    response.provenance.execution_time_ms = elapsed;
    response.provenance.metadata.put("algorithm", algorithmName);
    response.provenance.metadata.put("seed", options.seed);
    response.provenance.metadata.put("population_size", options.population_size);
    response.provenance.metadata.put("max_evaluations", options.max_evaluations);
    response.provenance.metadata.put("returned_solutions", response.solutions.size());
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
    dto.objective_value = problem.evaluator().qualityScore(evaluation);
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
