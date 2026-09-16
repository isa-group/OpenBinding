/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem.model;

import es.us.isa.qosawarewsbinding.util.DistributionFunction;


/**
 *
 * @author japarejo
 */
public class GlobalQoSConstraintsModel {
    private int numberOfConstraints;
    private DistributionFunction<Integer> dfPercentageOfOptimality;
    
    public GlobalQoSConstraintsModel(int numberOfConstraints, DistributionFunction<Integer> dfPercentageOfOptimality)
    {
        this.numberOfConstraints=numberOfConstraints;
        this.dfPercentageOfOptimality=dfPercentageOfOptimality;        
    }

    public int getNumberOfConstraints() {
        return numberOfConstraints;
    }

    public DistributionFunction<Integer> getDfPercentageOfOptimality() {
        return dfPercentageOfOptimality;
    }
    
    public String toString()
    {
        StringBuffer buffer=new StringBuffer("GlobalQoSConstraintsModel(");
        buffer.append("NumberOfConstraints:"+getNumberOfConstraints());
        buffer.append(",PercentageOfOptimality:"+getDfPercentageOfOptimality());
        buffer.append(")");
        return buffer.toString();
    }

    public void setNumberOfConstraints(int numberOfConstraints) {
        this.numberOfConstraints = numberOfConstraints;
    }
}
