package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.solution.Solution;

public abstract class EvaluationCountProblem implements Problem {
    private long fitnessEvaluationCount;
    private long feasibilityEvaluationCount;
    
    public EvaluationCountProblem()
    {
        fitnessEvaluationCount=0;
        feasibilityEvaluationCount=0;
    }
    
    
    public final double fitness(Solution sol) {
        fitnessEvaluationCount++;
        return computeFitness(sol);
    }
    
    public final boolean feasible(Solution sol) {
        feasibilityEvaluationCount++;
        return computeFeasibility(sol);
    }

    protected abstract boolean computeFeasibility(Solution sol);

    protected abstract double computeFitness(Solution sol);

    public long getFitnessEvaluationCount() {
        return fitnessEvaluationCount;
    }

    public long getFeasibilityEvaluationCount() {
        return feasibilityEvaluationCount;
    }

}