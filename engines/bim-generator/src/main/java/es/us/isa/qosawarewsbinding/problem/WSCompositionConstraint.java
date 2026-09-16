/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;

/**
 *
 * @author japarejo
 */
public abstract class WSCompositionConstraint implements Constraint<QoSAwareWSCompositionSolution> {

    protected QoSAwareWSCompositionProblem problem;
    
    public WSCompositionConstraint(QoSAwareWSCompositionProblem problem)
    {
        this.problem=problem;
    }
    
    
    public abstract boolean meets(QoSAwareWSCompositionSolution solution);
        
    public abstract double meetingDistance(QoSAwareWSCompositionSolution solution); 
    
    
}
