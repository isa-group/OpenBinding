package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import java.util.ArrayList;
import java.util.List;
import org.uma.jmetal.problem.integerproblem.impl.AbstractIntegerProblem;
import org.uma.jmetal.solution.integersolution.IntegerSolution;

final class EvolutionaryBindingProblem extends AbstractIntegerProblem {
  static final String EVALUATION_ATTRIBUTE = "openbinding.evaluation";

  private final BindingEvaluator evaluator;
  private final Instance instance;
  private final Options options;
  private final boolean hasSoftConstraints;

  EvolutionaryBindingProblem(Instance instance, Options options) {
    this.instance = instance;
    this.options = options;
    this.evaluator = new BindingEvaluator(instance);
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
      solution.objectives()[0] = (totalWeight > 0.0 ? weightedLoss / totalWeight : weightedLoss)
          + options.soft_penalty * evaluation.constraints().softViolation();
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
    return solution;
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
