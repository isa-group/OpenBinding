/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.qos.aggretation;

import java.util.List;

/**
 *
 * @author japarejo
 */
public class SumatoryPowAggregationFunction implements  AggregationFunction {
    
    private static SumatoryPowAggregationFunction _instance=null;
    
    private SumatoryPowAggregationFunction(){}
    
    public static SumatoryPowAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new SumatoryPowAggregationFunction();
        return _instance;
    }

    
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        double result=0;
        for(Double value:values)
            result+=value;
        double ponderation=1;
        if(ponderations.size()>0)
            ponderation=ponderations.get(0);
        result=Math.pow(result, ponderation);
        return result;
    }
    
    public String toString()
    {
        return "SUMPOW";        
    }

}
