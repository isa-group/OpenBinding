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
public class SumatoryAggregationFunction extends NumericAggregationFunction {

    private static SumatoryAggregationFunction _instance=null;
    
    private SumatoryAggregationFunction(){}
    
    public static SumatoryAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new SumatoryAggregationFunction();
        return _instance;
    }
       
    @Override
    public String toString()
    {
        return "SUM";
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
        return result;
    }
            
}
