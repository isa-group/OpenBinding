/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.qos.aggretation;

import java.util.List;

/**
 *
 * @author antigravity
 */
public class ScaledSumAggregationFunction implements AggregationFunction {

    // Singleton? The others were.
    private static ScaledSumAggregationFunction instance = new ScaledSumAggregationFunction();

    public static ScaledSumAggregationFunction getInstance() {
        return instance;
    }

    @Override
    public Double aggregation(List<Double> values, List<Double> ponderations) {
        double result = 0;
        for (Double value : values) {
            result += value;
        }
        double factor = 1.0;
        if (ponderations != null && !ponderations.isEmpty()) {
            factor = ponderations.get(0);
        }
        return result * factor;
    }
}
