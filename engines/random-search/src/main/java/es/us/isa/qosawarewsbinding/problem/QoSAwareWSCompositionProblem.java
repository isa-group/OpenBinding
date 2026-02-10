/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.problem;

import java.io.Serializable;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.Solution;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolution;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionProblem extends FeasibilityAwareProblem implements Serializable {

    private WSCompositionStructure structure;
    private Map<AbstractWebService, Set<ConcreteWebService>> market;
    private WSCompositionQoSModel qosmodel;
    private List<WSCompositionConstraint> constraints;
    private Set<ExecutionPath> expaths;
    private static ExecutionPathsBuilder expathBuilder = null;
    public boolean scaled;

    public QoSAwareWSCompositionProblem(WSCompositionStructure structure, Map<AbstractWebService, Set<ConcreteWebService>> market, WSCompositionQoSModel qosmodel, List<WSCompositionConstraint> constraints) {
        this.structure = structure;
        this.market = market;
        this.qosmodel = qosmodel;
        this.constraints = constraints;
        this.expaths = null;
        this.scaled = false;
    }

    public QoSAwareWSCompositionProblem(WSCompositionStructure structure, WSCompositionQoSModel qosmodel) {
        this(structure, new HashMap<AbstractWebService, Set<ConcreteWebService>>(), qosmodel, new LinkedList<WSCompositionConstraint>());
    }

    public int numberOfCandidates(AbstractWebService aws) {
        return getMarket().get(aws).size();
    }

    public String getDescription() {
        throw new UnsupportedOperationException("Not supported yet.");
    }

    public WSCompositionStructure getStructure() {
        return structure;
    }

    public Map<AbstractWebService, Set<ConcreteWebService>> getMarket() {
        return market;
    }

    public WSCompositionQoSModel getQosmodel() {
        return qosmodel;
    }

    public List<WSCompositionConstraint> getConstraints() {
        return constraints;
    }

    public String toString() {
        StringBuffer buffer = new StringBuffer("=== QoS-aware Web Service Composition Problem Instance ===\n");
        buffer.append(getStructure().getStructure().toStructuralString(""));
        buffer.append(toStringMarket());
        buffer.append(getQosmodel());
        buffer.append(getConstraints());
        buffer.append("==========================================================\n");
        return buffer.toString();

    }

    private double scale(double value, double Qmax, double Qmin, QoSProperty property) {
        double result = 0;
        if (Qmax != Qmin) {
            if (property.getType() == QoSPropertyType.POSITIVE) {
                result = (value - Qmin) / (Qmax - Qmin);
            } else {
                result = (Qmax - value) / (Qmax - Qmin);
            }
        } else {
            result = 1.0;
        }
        return result;
    }

    private String toStringMarket() {

        StringBuffer buffer = new StringBuffer("--- MARKET OF SERVICES ---");
        for (AbstractWebService aws : market.keySet()) {
            buffer.append("\nAWS" + aws.toString() + ":");
            for (ConcreteWebService cws : market.get(aws)) {
                buffer.append("      S" + cws.getName() + "(");
                for (QoSProperty property : getQosmodel().getQosProperties()) {
                    buffer.append(property.getName() + ":" + cws.getQoSValue(property) + ",");
                }
                buffer.append(")");
            }
        }
        buffer.append("\n--------------------------\n");
        return buffer.toString();
    }

    public double feasibilityDistance(Solution sol) {
        double value = 0;
        for (WSCompositionConstraint constraint : getConstraints()) {
            if (constraint.isHard()) {
                value += constraint.meetingDistance((QoSAwareWSCompositionSolution) sol);
            }
        }
        return value;
    }

    protected double computeFitness(Solution sol) {
        double feasibilityDistance = feasibilityDistance(sol);
        double result = feasibilityFreeFitness(sol);
        if (getPenalizator() != null) {
            result = getPenalizator().penalize(result, feasibilityDistance);
        }
        return 1.0 - result;
    }

    public double feasibilityFreeFitness(Solution sol) {
        double result = 0;
        if (!scaled) {
            scale();
        }
        result = getQosmodel().evaluate((QoSAwareWSCompositionSolution) sol, getStructure());
        result = result / numberOfExecutedTasks();
        return result;
    }

    public double candidatesPerService() {
        int totalNumberOfCandidates = 0;
        for (AbstractWebService aws : getMarket().keySet()) {
            totalNumberOfCandidates += getMarket().get(aws).size();
        }
        return ((double) (totalNumberOfCandidates)) / ((double) (getMarket().keySet().size()));
    }

    public Set<ExecutionPath> getExecutionPaths() {
        if (getExpaths() == null) {
            if (expathBuilder != null) {
                setExpaths(expathBuilder.buildPaths(this));
            } else {
                expathBuilder = new LoopUnfoldingExecutionPathsBuilder();
                setExpaths(expathBuilder.buildPaths(this));
            }
        }
        return getExpaths();
    }

    public boolean isScaled() {
        return scaled;
    }

    public void scale() {
        for (QoSProperty property : getQosmodel().getQosProperties()) {
            scale(property);
        }
        scaled = true;
    //System.out.println("Problem Reescaled!! Current State:");
        //System.out.println(this);
    }

    private void scale(QoSProperty property) {
        double Qmax = max(property);
        double Qmin = min(property);
        double value = 0;
        for (AbstractWebService aws : getMarket().keySet()) {
            for (ConcreteWebService cws : getMarket().get(aws)) {
                Double objVal = (Double) cws.getQoSValue(property);
                if (objVal != null) {
                    value = objVal;
                    value = scale(value, Qmax, Qmin, property);
                    cws.setQoSValue(property, value);
                }
            }
        }

        for (WSCompositionConstraint constraint : constraints) {
            if (constraint instanceof GlobalQoSWSCompositionConstraint) {
                if (((GlobalQoSWSCompositionConstraint) constraint).getProperty().equals(property)) {
                    value = ((GlobalQoSWSCompositionConstraint) constraint).getValue();
                    value = scale(value, Qmax, Qmin, property);
                    if (value < 0) {
                        value = 1 - value;
                    }
                    ((GlobalQoSWSCompositionConstraint) constraint).setValue(value);
                }
            }
        }

    }

    private double max(QoSProperty property) {
        double result = -Double.MAX_VALUE; 
        boolean found = false;
        for (AbstractWebService aws : getMarket().keySet()) {
            for (ConcreteWebService cws : market.get(aws)) {
                Double candidate = (Double) cws.getQoSValue(property);
                if (candidate != null) {
                    if (candidate > result) {
                        result = candidate;
                    }
                    found = true;
                }
            }
        }
        return found ? result : 1.0; // Default max if no values
    }

    private double min(QoSProperty property) {
        double result = Double.MAX_VALUE;
        boolean found = false;
        for (AbstractWebService aws : market.keySet()) {
            for (ConcreteWebService cws : market.get(aws)) {
                Double candidate = (Double) cws.getQoSValue(property);
                if (candidate != null) {
                    if (candidate < result) {
                        result = candidate;
                    }
                    found = true;
                }
            }
        }
        return found ? result : 0.0; // Default min if no values
    }

    public void setStructure(WSCompositionStructure structure) {
        this.structure = structure;
    }

    public void setQosmodel(WSCompositionQoSModel qosmodel) {
        this.qosmodel = qosmodel;
    }

    public void setConstraints(List<WSCompositionConstraint> constraints) {
        this.constraints = constraints;
    }

    public Set<ExecutionPath> getExpaths() {
        return expaths;
    }

    public void setExpaths(Set<ExecutionPath> expaths) {
        this.expaths = expaths;
    }

    public double numberOfExecutedTasks() {
        return structure.numberOfExecutedTasks();
    }

    public String getProblemType() {
        return "QoS-awareCWSBinding";
    }

    public Double bestValue(QoSProperty property) {
        QoSAwareWSCompositionSolution solution = computeBestSolution(property);
        return qosmodel.evaluate(solution, property, structure);
    }
    
    public Double worstValue(QoSProperty property) {
        QoSAwareWSCompositionSolution solution = computeWorstSolution(property);
        return qosmodel.evaluate(solution, property, structure);
    }

    public QoSAwareWSCompositionSolution computeBestSolution(QoSProperty property) {
        QoSAwareWSCompositionVectorSolution result = new QoSAwareWSCompositionVectorSolution(this);
        ConcreteWebService bestCandidate = null;
        
        for (AbstractWebService aws : market.keySet()) {
            for (ConcreteWebService cws : market.get(aws)) {
                if (bestCandidate == null) {
                    bestCandidate = cws;
                } else {
                    if (property.getType() == QoSPropertyType.POSITIVE) {
                        if (((Double) cws.getQoSValue(property)) > ((Double) bestCandidate.getQoSValue(property))) {
                            bestCandidate = cws;
                        }
                    } else {
                        if (((Double) cws.getQoSValue(property)) < ((Double) bestCandidate.getQoSValue(property))) {
                            bestCandidate = cws;
                        }
                    }
                }
            }
            result.setSelectedService(aws, bestCandidate);
            bestCandidate = null;
        }
        return result;
    }
    
    public QoSAwareWSCompositionSolution computeWorstSolution(QoSProperty property) {
        QoSAwareWSCompositionVectorSolution result = new QoSAwareWSCompositionVectorSolution(this);
        ConcreteWebService worstCandidate = null;
        System.out.println("Search worst solution...");
        for (AbstractWebService aws : market.keySet()) {
            for (ConcreteWebService cws : market.get(aws)) {
                if (worstCandidate == null) {
                    worstCandidate = cws;
                } else {
                	
                	System.out.println("type: " + property.getType() + " worst: " + ((Double) worstCandidate.getQoSValue(property)) + " cws: " + ((Double) cws.getQoSValue(property)));
                	
                    if (property.getType() == QoSPropertyType.POSITIVE) {
                        if (((Double) cws.getQoSValue(property)) < ((Double) worstCandidate.getQoSValue(property))) {
                            worstCandidate = cws;
                        }
                    } else {
                        if (((Double) cws.getQoSValue(property)) > ((Double) worstCandidate.getQoSValue(property))) {
                            worstCandidate = cws;
                        }
                    }
                    System.out.println("Updated worst: " + ((Double) worstCandidate.getQoSValue(property)));
                }
            }
            result.setSelectedService(aws, worstCandidate);
            worstCandidate = null;
        }
        return result;
    }
}
