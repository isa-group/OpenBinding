/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem.model;

import java.util.HashMap;
import java.util.Map;

import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.util.DistributionFunction;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionProblemServicesMarketModel {
    private DistributionFunction<Integer> numberOfCandidates;
    private Map<QoSProperty,DistributionFunction<Double>> qosValues;

    public QoSAwareWSCompositionProblemServicesMarketModel(DistributionFunction<Integer> numberOfCandidates) {
        this(numberOfCandidates, new HashMap<QoSProperty, DistributionFunction<Double>>());
    }
    
    public QoSAwareWSCompositionProblemServicesMarketModel(DistributionFunction<Integer> numberOfCandidates, Map<QoSProperty, DistributionFunction<Double>> qosValues)
    {
        this.numberOfCandidates=numberOfCandidates;
        this.qosValues=qosValues;
    }
    
    
    public DistributionFunction<Integer> getNumberOfCandidates() {
        return numberOfCandidates;
    }

    public Map<QoSProperty, DistributionFunction<Double>> getQosValues() {
        return qosValues;
    }
    
    @Override
    public String toString()
    {
        StringBuffer buffer=new StringBuffer("ServicesMarquetModel(");
        buffer.append("NumberOfCandidates:"+numberOfCandidates+",\n");
        for(QoSProperty property:qosValues.keySet())
        {
            buffer.append("          "+property.getName()+":"+qosValues.get(property)+"\n");
        }
        buffer.append(")\n");
        return buffer.toString();                
    }
}
