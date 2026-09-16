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
public class ProductoryAggregationFunction implements AggregationFunction {

     private static ProductoryAggregationFunction _instance=null;
    
    private ProductoryAggregationFunction(){}
    
    public static ProductoryAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new ProductoryAggregationFunction();
        return _instance;
    }        
    
    @Override
    public String toString()
    {
        return "PRODUCT";
    }

    
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        Double result=new Double(1.0);
        int i=0;
        for(Double value:values){                            
                result=result*value*ponderations.get(i);
                i++;
        }
        if(values.size()==0)
            result=0.0;
        return result;
    }
}
