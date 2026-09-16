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
public class AverageAggregationFunction extends NumericAggregationFunction {

    private static AverageAggregationFunction _instance=null;
    
    private AverageAggregationFunction(){}
    
    public static AverageAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new AverageAggregationFunction();
        return _instance;
    }
       
    @Override
    public String toString()
    {
        return "AVG";
    }

    
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        Double result=new Double(0.0);
        int i=0;
        for(Double value:values)            
            if(value!=null){
                if(ponderations.get(i)!=null)
                    result=value*ponderations.get(i)+result;                    
                i++;
            }
        if(values.size()==0)
        	result = 0.0;
        else
        	result = result/values.size();
        return result;
    }
}
