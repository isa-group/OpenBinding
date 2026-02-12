/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.AbstractWebService;

import java.io.Serializable;
import java.util.List;

/**
 *
 * @author antigravity
 */
public class LocalQoSWSCompositionConstraint extends WSCompositionConstraint implements Serializable {

    private QoSProperty property;
    private BinaryOperator operator;
    private Double value;
    private AbstractWebService task;

    public LocalQoSWSCompositionConstraint(QoSAwareWSCompositionProblem problem, QoSProperty property,
            BinaryOperator operator, Double value, AbstractWebService task, boolean hard) {
        super(problem);
        this.property = property;
        this.operator = operator;
        this.value = value;
        this.task = task;
        this.setHard(hard);
    }

    @Override
    public boolean meets(QoSAwareWSCompositionSolution solution) {
        return meetingDistance(solution) <= 0;
    }

    @Override
    public double meetingDistance(QoSAwareWSCompositionSolution solution) {
        es.us.isa.qosawarewsbinding.ConcreteWebService cws = solution.getSelectedService(task);
        if (cws == null)
            return 1.0; // Should not happen in complete solution

        Double currentVal = (Double) cws.getQoSValue(property);
        if (currentVal == null)
            return 1.0; // Missing data

        return meetingDistance(currentVal);
    }

    private double meetingDistance(Double currentValue) {
        double val = currentValue.doubleValue();
        double target = value.doubleValue();

        // Similar logic to GlobalQoSWSCompositionConstraint
        // Using existing logic for consistency
        double diff = val - target;

        switch (operator) {
            case EQUAL:
                return Math.abs(diff);
            case DISTINCT:
                return (diff == 0) ? 1.0 : 0.0;
            case GREATER:
                return (val > target) ? 0.0 : (target - val + Double.MIN_VALUE);
            case GREATEREQUAL:
                return (val >= target) ? 0.0 : (target - val);
            case LOWER:
                return (val < target) ? 0.0 : (val - target + Double.MIN_VALUE);
            case LOWEREQUAL:
                return (val <= target) ? 0.0 : (val - target);
            default:
                return 1.0;
        }
    }

    public QoSProperty getProperty() {
        return property;
    }

    public void setProperty(QoSProperty property) {
        this.property = property;
    }

    public BinaryOperator getOperator() {
        return operator;
    }

    public void setOperator(BinaryOperator operator) {
        this.operator = operator;
    }

    public Double getValue() {
        return value;
    }

    public void setValue(Double value) {
        this.value = value;
    }

    public AbstractWebService getTask() {
        return task;
    }

    public void setTask(AbstractWebService task) {
        this.task = task;
    }
}
