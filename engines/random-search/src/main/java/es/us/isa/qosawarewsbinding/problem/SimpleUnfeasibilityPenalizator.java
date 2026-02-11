package es.us.isa.qosawarewsbinding.problem;

public class SimpleUnfeasibilityPenalizator implements UnfeasibilityPenalizator {

    @Override
    public double penalize(double fitness, double feasibilityDistance) {
        if (feasibilityDistance > 0) {
            // If infeasible, increase the objective by the distance so it is worse.
            return fitness + feasibilityDistance;
        }
        return fitness;
    }

}
