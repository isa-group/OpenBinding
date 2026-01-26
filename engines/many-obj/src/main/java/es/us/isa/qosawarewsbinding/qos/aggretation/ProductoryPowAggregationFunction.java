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
public class ProductoryPowAggregationFunction implements AggregationFunction {
    private static ProductoryPowAggregationFunction _instance=null;
    
    private ProductoryPowAggregationFunction(){}
    
    public static ProductoryPowAggregationFunction getInstance()
    {
        if(_instance==null)
                _instance=new ProductoryPowAggregationFunction();
        return _instance;
    }

    
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        double result=1;
        for(Double value:values)
            if(value!=0)
                result*=value;
        double ponderation=1;
        if(ponderations.size()>0)
            ponderation=ponderations.get(0);
        result=Math.pow(result, ponderation);
        return result;
    }
    
    @Override
    public String toString()
    {
        return "POW";
    }
}
