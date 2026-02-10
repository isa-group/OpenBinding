package es.us.isa.qosawarewsbinding.problem;

public class SimpleUnfeasibilityPenalizator implements UnfeasibilityPenalizator {

    @Override
    public double penalize(double fitness, double feasibilityDistance) {
        if (feasibilityDistance > 0) {
            // If infeasible, return a negative utility based on distance.
            // 'fitness' here is the utility (0..1).
            // The problem minimizes (1.0 - result).
            // We want (1.0 - result) to be LARGE.
            // If result = -distance, then 1.0 - (-distance) = 1.0 + distance.
            return -feasibilityDistance;
        }
        return fitness;
    }

}
