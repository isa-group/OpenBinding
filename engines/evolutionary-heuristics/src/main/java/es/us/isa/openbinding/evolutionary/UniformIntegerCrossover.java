package es.us.isa.openbinding.evolutionary;

import java.util.ArrayList;
import java.util.List;
import org.uma.jmetal.operator.crossover.CrossoverOperator;
import org.uma.jmetal.solution.integersolution.IntegerSolution;
import org.uma.jmetal.util.errorchecking.JMetalException;
import org.uma.jmetal.util.pseudorandom.JMetalRandom;

/**
 * Uniform crossover for integer-encoded categorical assignments.
 *
 * <p>Candidate indices are categorical: index proximity does not imply
 * candidate similarity (candidates cluster by pool type in the index space).
 * Arithmetic recombination such as SBX biases the search towards index-local
 * moves, which hampers escaping those clusters. Uniform crossover swaps whole
 * genes instead: when a pair is crossed, each position is exchanged between
 * the two children with probability 0.5.
 */
@SuppressWarnings("serial")
final class UniformIntegerCrossover implements CrossoverOperator<IntegerSolution> {
  private final double crossoverProbability;

  UniformIntegerCrossover(double crossoverProbability) {
    if (crossoverProbability < 0.0 || crossoverProbability > 1.0) {
      throw new JMetalException("Crossover probability out of [0, 1]: " + crossoverProbability);
    }
    this.crossoverProbability = crossoverProbability;
  }

  @Override
  public double crossoverProbability() {
    return crossoverProbability;
  }

  @Override
  public int numberOfRequiredParents() {
    return 2;
  }

  @Override
  public int numberOfGeneratedChildren() {
    return 2;
  }

  @Override
  public List<IntegerSolution> execute(List<IntegerSolution> parents) {
    if (parents == null || parents.size() != 2) {
      throw new JMetalException("Uniform crossover requires exactly two parents");
    }
    JMetalRandom random = JMetalRandom.getInstance();
    IntegerSolution child1 = (IntegerSolution) parents.get(0).copy();
    IntegerSolution child2 = (IntegerSolution) parents.get(1).copy();

    if (random.nextDouble() <= crossoverProbability) {
      for (int i = 0; i < child1.variables().size(); i++) {
        if (random.nextDouble() < 0.5) {
          Integer tmp = child1.variables().get(i);
          child1.variables().set(i, child2.variables().get(i));
          child2.variables().set(i, tmp);
        }
      }
    }

    List<IntegerSolution> children = new ArrayList<>(2);
    children.add(child1);
    children.add(child2);
    return children;
  }
}
