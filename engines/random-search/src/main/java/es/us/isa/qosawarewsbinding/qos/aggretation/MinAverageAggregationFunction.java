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
public class MinAverageAggregationFunction implements AggregationFunction{

    private static MinAverageAggregationFunction _instance=null;
    
    private MinAverageAggregationFunction(){}
    
    public static MinAverageAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new MinAverageAggregationFunction();
        return _instance;
    }      

    @Override
     public String toString()
     {
         return "MINAVG";
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
        else
        	result=result/values.size();
        return result;
    }
   
}
