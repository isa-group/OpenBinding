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
public interface AggregationFunction {
    public Double aggregation(List<Double> values,  List<Double> ponderations);        
    
}
