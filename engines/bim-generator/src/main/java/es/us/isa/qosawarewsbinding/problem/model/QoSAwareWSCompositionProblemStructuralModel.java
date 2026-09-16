package es.us.isa.qosawarewsbinding.problem.model;

import es.us.isa.qosawarewsbinding.util.DistributionFunction;

public class QoSAwareWSCompositionProblemStructuralModel {
    private int numberOfActivities;
    private int numberOfAbstractServices;
    private int maxNestingLevel;
    private int percentageOfControlFlowActivities;
    private double percentageLoops;
    private DistributionFunction<Integer> iterationsPerLoop;
    private DistributionFunction<Integer> branchesPerIf;

    public int getNumberOfActivities() {
        return numberOfActivities;
    }

    public void setNumberOfActivities(int numberOfActivities) {
        this.numberOfActivities = numberOfActivities;
    }

    public int getNumberOfAbstractServices() {
        return (numberOfActivities*(100-percentageOfControlFlowActivities))/100;
    }
    
    public int getMaxNestingLevel() {
        return maxNestingLevel;
    }

    public void setMaxNestingLevel(int maxNestingLevel) {
        this.maxNestingLevel = maxNestingLevel;
    }

    public int getPercentageOfControlFlowActivities() {
        return percentageOfControlFlowActivities;
    }

    public void setPercentageOfControlFlowActivities(int cyclomaticComplexity) {
        this.percentageOfControlFlowActivities = cyclomaticComplexity;
    }

    public double getPercentageLoops() {
        return percentageLoops;
    }

    public void setPercentageLoops(double percentageLoops) {
        this.percentageLoops = percentageLoops;
    }

    public DistributionFunction<Integer> getIterationsPerLoop() {
        return iterationsPerLoop;
    }

    public void setIterationsPerLoop(DistributionFunction<Integer> iterationsPerLoop) {
        this.iterationsPerLoop = iterationsPerLoop;
    }

    public DistributionFunction<Integer> getBranchesPerIf() {
        return branchesPerIf;
    }

    public void setBranchesPerIf(DistributionFunction<Integer> branchesPerIf) {
        this.branchesPerIf = branchesPerIf;
    }

    @Override
    public String toString()
    {
        StringBuffer buffer=new StringBuffer("QoSAwareStructuralModel(\n");
        String prefix="   ";
        buffer.append(prefix+"NActivities="+numberOfActivities+",\n");
        buffer.append(prefix+"NAbstractServices="+numberOfAbstractServices+",\n");
        buffer.append(prefix+"PercentageOfControlFlowActivities="+percentageOfControlFlowActivities+",\n");
        buffer.append(prefix+"MaxNestingLevel="+maxNestingLevel+",\n");
        buffer.append(prefix+"PercentageOfLoops="+percentageLoops+",\n");
        buffer.append(prefix+"AverageNumberOfIterations(in Loops)="+iterationsPerLoop+",\n");
        buffer.append(prefix+"AverageNumberOfBranches(in Ifs)="+branchesPerIf+",\n");
        buffer.append(prefix+")\n");
        return buffer.toString();
    }
}