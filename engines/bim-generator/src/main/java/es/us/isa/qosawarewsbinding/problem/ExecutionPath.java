/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

import es.us.isa.qosawarewsbinding.AbstractWebService;

/**
 *
 * @author japarejo
 */
public class ExecutionPath {
    private QoSAwareWSCompositionProblem problem;
    private List<AbstractWebService> executedTasks;
    private double probabilityOfExecution;

    public ExecutionPath(QoSAwareWSCompositionProblem problem, List<AbstractWebService> execTasks,double prob)
    {
        this.problem=problem;
        this.executedTasks=new ArrayList<AbstractWebService>(execTasks.size());
        this.executedTasks.addAll(execTasks);
        this.probabilityOfExecution=prob;
    }
    
    public ExecutionPath(QoSAwareWSCompositionProblem problem, double prob)
    {
        this.problem=problem;
        this.executedTasks=new LinkedList<AbstractWebService>();
        this.probabilityOfExecution=prob;
    }
    
    public QoSAwareWSCompositionProblem getProblem() {
        return problem;
    }

    public List<AbstractWebService> getExecutedTasks() {
        return executedTasks;
    }

    public double getProbabilityOfExecution() {
        return probabilityOfExecution;
    }

    public void setProbabilityOfExecution(double pk) {
        this.probabilityOfExecution = pk;
    }
    
    @Override
    public boolean equals(Object obj)
    {
        boolean result=false;
        if(obj instanceof ExecutionPath)
        {
            ExecutionPath myobj=(ExecutionPath)obj;
            result=(problem==myobj.getProblem());
            result=result && (probabilityOfExecution==myobj.getProbabilityOfExecution());
            result=(result && executedTasks.equals(myobj.getExecutedTasks()));
        }
        return result;
    }

    @Override
    public int hashCode() {
        int hash = 7;
        hash = 29 * hash + (this.problem != null ? this.problem.hashCode() : 0);
        hash = 29 * hash + (this.executedTasks != null ? this.executedTasks.hashCode() : 0);
        hash = 29 * hash + (int) (Double.doubleToLongBits(this.probabilityOfExecution) ^ (Double.doubleToLongBits(this.probabilityOfExecution) >>> 32));
        return hash;
    }
}
