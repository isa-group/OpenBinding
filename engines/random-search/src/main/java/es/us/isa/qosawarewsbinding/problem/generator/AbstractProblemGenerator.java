package es.us.isa.qosawarewsbinding.problem.generator;

import es.us.isa.qosawarewsbinding.problem.Problem;
import es.us.isa.qosawarewsbinding.problem.model.ProblemModel;

public abstract class AbstractProblemGenerator<X extends Problem> implements ProblemGenerator<X> {
    
    private ProblemModel<X> problemModel;

    public AbstractProblemGenerator(ProblemModel<X> pmodel)
    {
        this.problemModel=pmodel;
    }
    
    public ProblemModel<X> getProblemModel() {
        return problemModel;
    }

    public void setProblemModel(ProblemModel<X> problemModel) {
        this.problemModel = problemModel;
    }
    
    
}