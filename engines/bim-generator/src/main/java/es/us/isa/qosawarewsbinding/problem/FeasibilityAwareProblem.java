package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.solution.Solution;

public abstract class FeasibilityAwareProblem extends EvaluationCountProblem {

    private UnfeasibilityPenalizator penalizator;
    
    public FeasibilityAwareProblem()
    {
        penalizator=null;
    }
    
    public FeasibilityAwareProblem(UnfeasibilityPenalizator penalizator)
    {
        this.penalizator=penalizator;
    }
    
    
    @Override
    protected double computeFitness(Solution sol) {
    	double result=feasibilityFreeFitness(sol);
    	if(penalizator!=null)
    		result=getPenalizator().penalize(result,feasibilityDistance(sol));
        return result;
    }

    public abstract double feasibilityDistance(Solution sol);
    
    public abstract double feasibilityFreeFitness(Solution sol);
    
    @Override
    protected boolean computeFeasibility(Solution sol) {
        return feasibilityDistance(sol)>0;
    }

    /**
     * @return the penalizator
     */
    public UnfeasibilityPenalizator getPenalizator() {
        return penalizator;
    }
    

}

