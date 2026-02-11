package es.us.isa.qosawarewsbinding.api.solver;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolution;

import java.util.List;

public class RandomSearchSolver {
    private final LexicographicSelector selector = new LexicographicSelector();

    public QoSAwareWSCompositionSolution solve(QoSAwareWSCompositionProblem problem, int iterations) {
        QoSAwareWSCompositionSolution best = new QoSAwareWSCompositionVectorSolution(problem);
        double bestFitness = problem.fitness(best);
        List<AbstractWebService> taskOrder = selector.getTaskOrder(problem);
        final double eps = 1e-12;

        for (int i = 0; i < iterations; i++) {
            QoSAwareWSCompositionSolution sol = (QoSAwareWSCompositionSolution)
                    new QoSAwareWSCompositionVectorSolution(problem).createRandom();

            double f = problem.fitness(sol);

            if (f < bestFitness - eps) {
                best = sol;
                bestFitness = f;
            } else if (Math.abs(f - bestFitness) <= eps && selector.isLexicographicallySmaller(sol, best, taskOrder)) {
                best = sol;
                bestFitness = f;
            }
        }
        return best;
    }
}
