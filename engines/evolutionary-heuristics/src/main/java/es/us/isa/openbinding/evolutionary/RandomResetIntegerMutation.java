package es.us.isa.openbinding.evolutionary;

import org.uma.jmetal.operator.mutation.MutationOperator;
import org.uma.jmetal.solution.integersolution.IntegerSolution;
import org.uma.jmetal.util.bounds.Bounds;
import org.uma.jmetal.util.errorchecking.JMetalException;
import org.uma.jmetal.util.pseudorandom.JMetalRandom;

/**
 * Random-reset mutation for integer-encoded categorical assignments.
 *
 * <p>Each gene mutates with the configured probability to a candidate drawn
 * uniformly from the whole domain of its task (both bounds inclusive), unlike
 * polynomial mutation whose perturbations stay index-local. This is the
 * standard mutation for categorical encodings and lets the search escape
 * index-clustered regions (e.g. pool-type blocks) in a single step.
 *
 * <p>Not replaced by jMetal's {@code IntegerSimpleRandomMutation}: its
 * sampling ({@code lower + (int)((upper - lower) * rand)}) never yields the
 * upper bound, so the last candidate of every task would be unreachable.
 */
@SuppressWarnings("serial")
final class RandomResetIntegerMutation implements MutationOperator<IntegerSolution> {
  private final double mutationProbability;

  RandomResetIntegerMutation(double mutationProbability) {
    if (mutationProbability < 0.0 || mutationProbability > 1.0) {
      throw new JMetalException("Mutation probability out of [0, 1]: " + mutationProbability);
    }
    this.mutationProbability = mutationProbability;
  }

  @Override
  public double mutationProbability() {
    return mutationProbability;
  }

  @Override
  public IntegerSolution execute(IntegerSolution solution) {
    if (solution == null) {
      throw new JMetalException("Null solution");
    }
    JMetalRandom random = JMetalRandom.getInstance();
    for (int i = 0; i < solution.variables().size(); i++) {
      if (random.nextDouble() <= mutationProbability) {
        Bounds<Integer> bounds = solution.getBounds(i);
        solution.variables().set(
            i, random.nextInt(bounds.getLowerBound(), bounds.getUpperBound()));
      }
    }
    return solution;
  }
}
