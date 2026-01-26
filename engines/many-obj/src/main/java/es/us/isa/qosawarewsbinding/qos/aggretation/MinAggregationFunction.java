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
public class MinAggregationFunction implements AggregationFunction{

    private static MinAggregationFunction _instance=null;
    
    private MinAggregationFunction(){}
    
    public static MinAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new MinAggregationFunction();
        return _instance;
    }      

    @Override
     public String toString()
     {
         return "MIN";
     }

    
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        Double result=Double.MAX_VALUE;
        double candidate=0;        
        for(Double value:values)
        {
            candidate=value;
            if(candidate<result)
                result=candidate;
            
        }
        if(values.size()==0)
            result=0.0;
        return result;
    }
   
}
