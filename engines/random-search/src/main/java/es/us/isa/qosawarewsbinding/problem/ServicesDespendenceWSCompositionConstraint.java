/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.io.Serializable;
import java.util.Map;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;

/**
 *
 * @author japarejo
 */
public class ServicesDespendenceWSCompositionConstraint extends WSCompositionConstraint implements Serializable{

    public Map<AbstractWebService,ConcreteWebService> dependences;
    
    public ServicesDespendenceWSCompositionConstraint(QoSAwareWSCompositionProblem problem, Map<AbstractWebService, ConcreteWebService> dependences)
    {
        super(problem);
        this.dependences=dependences;
    }
            
    @Override
    public boolean meets(QoSAwareWSCompositionSolution solution) {
        return meetingDistance(solution)==0;
    }

    @Override
    public double meetingDistance(QoSAwareWSCompositionSolution solution) {
        double distance=0;
        int present=0;
        for(AbstractWebService aws:dependences.keySet())
        {
            if(solution.isUsing(aws, dependences.get(aws)))
                present++;
        }
        distance=((double)present)/((double)dependences.keySet().size());
        return distance;
    }

}
