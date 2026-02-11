/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;

import java.io.Serializable;
import java.util.Map;

/**
 *
 * @author antigravity
 */
public class RangeGlobalQoSWSCompositionConstraint extends WSCompositionConstraint implements Serializable {

    private QoSProperty property;
    private Double min;
    private Double max;
    private BinaryOperator operator;

    public RangeGlobalQoSWSCompositionConstraint() {
        this.operator = BinaryOperator.IN_RANGE;
    }

    public RangeGlobalQoSWSCompositionConstraint(QoSAwareWSCompositionProblem problem, QoSProperty property, Double min,
            Double max, boolean hard) {
        super(problem);
        this.property = property;
        this.min = min;
        this.max = max;
        this.operator = BinaryOperator.IN_RANGE;
        this.setHard(hard);
    }

    @Override
    public boolean meets(QoSAwareWSCompositionSolution solution) {
        return meetingDistance(solution) <= 0;
    }

    @Override
    public double meetingDistance(QoSAwareWSCompositionSolution solution) {
        Double currentValue = problem.getQosmodel().evaluate(solution, property, problem.getStructure());
        return meetingDistance(currentValue);
    }

    private double meetingDistance(Double currentValue) {
        if (currentValue == null)
            return 1.0; // Distance if null?
        double val = currentValue.doubleValue();

        // Distance is how far from range
        if (val < min)
            return min - val;
        if (val > max)
            return val - max;
        return 0.0;
    }

    public QoSProperty getProperty() {
        return property;
    }

    public void setProperty(QoSProperty property) {
        this.property = property;
    }

    public Double getMin() {
        return min;
    }

    public void setMin(Double min) {
        this.min = min;
    }

    public Double getMax() {
        return max;
    }

    public void setMax(Double max) {
        this.max = max;
    }

    public BinaryOperator getOperator() {
        return operator;
    }

    public void setOperator(BinaryOperator operator) {
        this.operator = operator;
    }
}
