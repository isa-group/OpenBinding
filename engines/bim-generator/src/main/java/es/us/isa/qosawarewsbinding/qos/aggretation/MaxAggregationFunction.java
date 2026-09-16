/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.qos.aggretation;

import java.util.List;

/**
 *
 * @author José Antonio Parejo Maestre
 */
public class MaxAggregationFunction implements AggregationFunction {    
    
    private static MaxAggregationFunction _instance=null;
    
    private MaxAggregationFunction(){}
    
    public static MaxAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new MaxAggregationFunction();
        return _instance;
    }       
    
    @Override
    public String toString()
    {
        return "MAX";
    }

    
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        Double result=Double.MIN_VALUE;
        double candidate=0;       
        for(Double value:values)
        {
            candidate=value;
            if(candidate>result)
                result=candidate;            
        }
        if(values.size()==0)
            result=0.0;
        return result;
    }
}
