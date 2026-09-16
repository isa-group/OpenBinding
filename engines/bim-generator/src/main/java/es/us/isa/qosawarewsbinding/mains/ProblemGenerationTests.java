/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.mains;

import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.problem.generator.QoSAwareWSCompositionProblemGenerator;
import es.us.isa.qosawarewsbinding.problem.model.GlobalQoSConstraintsModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemConstraintsModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemServicesMarketModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemStructuralModel;
import es.us.isa.qosawarewsbinding.problem.model.ServiceDependencesConstraintsModel;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.util.DistributionFunction;
import es.us.isa.qosawarewsbinding.util.DoubleGaussianDistributionFunction;
import es.us.isa.qosawarewsbinding.util.DoubleUniformDistributionFunction;
import es.us.isa.qosawarewsbinding.util.IntegerGausssianDistributionFunction;

/**
 *
 * @author japarejo
 */
public class ProblemGenerationTests {

    private static QoSAwareWSCompositionProblemStructuralModel structureModel;
    private static WSCompositionStructure structure;
    private static QoSAwareWSCompositionProblemGenerator problemGenerator;
    private static QoSAwareWSCompositionProblemModel problemModel;
    private static WSCompositionQoSModel qosModel;
    private static QoSAwareWSCompositionProblemServicesMarketModel marketModel;
    private static QoSAwareWSCompositionProblemConstraintsModel constraintsModel;
    private static Map<QoSProperty, DistributionFunction<Double>> marketValues;
    private static Map<AbstractWebService, Set<ConcreteWebService>> market;
    
    public static void main(String args[]) {
        int numberOfConstraints=2;        
        //problemModel=new QoSAwareWSCompositionProblemModel();
        problemGenerator = new QoSAwareWSCompositionProblemGenerator(problemModel);
        System.out.println("Structure Generation Tests:");
        testStructureGeneration();
        testMarketGeneration();
        DistributionFunction<Integer> dfPercentageOfOptimality=new IntegerGausssianDistributionFunction(65, 10.0);
        GlobalQoSConstraintsModel globalConstraintsModel=new GlobalQoSConstraintsModel(numberOfConstraints, dfPercentageOfOptimality);
        ServiceDependencesConstraintsModel serviceDependencesConstraintsModel=new ServiceDependencesConstraintsModel();
        constraintsModel=new QoSAwareWSCompositionProblemConstraintsModel(globalConstraintsModel, serviceDependencesConstraintsModel);
        problemModel=new QoSAwareWSCompositionProblemModel(structureModel, null, marketModel, constraintsModel);
        problemGenerator.setProblemModel(problemModel);
        testConstraintsGeneration();
    }

    private static void testAverageIterationsPerLoop() {
        // TODO: IMPLEMENT
    }

    private static void testConstraintsGeneration() {
                
        List<WSCompositionConstraint> constraints=new LinkedList<WSCompositionConstraint>();
        problemGenerator.generateGlobalConstraints(constraints, market, qosModel, null);
        System.out.println("<============ CONSTRAINTS GENERATIONS TEST =============>");
        System.out.println("----------------------------------------------");
        System.out.println("Global Constraints:");
        for(WSCompositionConstraint constraint:constraints)
        {
            System.out.println(constraint);
        }
        System.out.println("----------------------------------------------");
        System.out.println("<====================================================================>");
    }

    private static void testCyclomaticComplexity() {
        // TODO: IMPLEMENT
    }

    private static void testMaxNesting() {
        // TODO: IMPLEMENT
    }

    private static void testNumberOfActivities() {
    }

    private static void testPercentageOfLoops() {
        // TODO: IMPLEMENT
    }

    private static void testStructureGeneration() {
        // Creation of the basic model:
        int contolFlowPercentage = 5;
        int numberOfAbstractServices = 10;
        int numberOfActivities = 15;
        int maxNestingLevel = 3;
        int averageIterationsPerLoop = 5;
        double tipicalDeviationOfIterationsPerLoop = 1.5;
        int averageBranchesPerIf = 2;
        double tipicalDeviationOfBrahchesPerIf = 0.0;
        double percentageOfLoops = 0.5;
        DistributionFunction<Integer> iterationsPerLoop = new IntegerGausssianDistributionFunction(averageIterationsPerLoop, tipicalDeviationOfIterationsPerLoop);
        DistributionFunction<Integer> branchesPerIf = new IntegerGausssianDistributionFunction(averageBranchesPerIf, tipicalDeviationOfBrahchesPerIf);

        structureModel = new QoSAwareWSCompositionProblemStructuralModel();
        structureModel.setBranchesPerIf(branchesPerIf);
        structureModel.setPercentageOfControlFlowActivities(contolFlowPercentage);
        structureModel.setIterationsPerLoop(iterationsPerLoop);        
        structureModel.setNumberOfActivities(numberOfActivities);
        structureModel.setMaxNestingLevel(maxNestingLevel);
        structureModel.setPercentageLoops(percentageOfLoops);

        structure = problemGenerator.generateStructure(structureModel);
        System.out.println("<============ STRUCTURE OF COMPOSITION GENERATION TESTS =============>");
        System.out.println("----------------------------------------------");
        System.out.println("STRUCTURAL MODEL:");
        System.out.println(structureModel);
        System.out.println("----------------------------------------------");
        System.out.println("GENERATED STRUCTURE:");
        System.out.println(structure.getStructure().toStructuralString(""));
        System.out.println("----------------------------------------------");
        System.out.println("SRUCTURE DATA:");
        System.out.println("Number of Activities:" + structure.numberOfActivities());
        System.out.println("Cyclomatic Complexity:" + structure.computeCyclomaticComplexity());
        System.out.println("Max Nesting Level:" + structure.computeMaxNesting());
        System.out.println("----------------------------------------------");
        System.out.println("<====================================================================>");
    // Testing of the different properties of the generated model:
        /*testNumberOfActivities();
    testMaxNesting();
    testCyclomaticComplexity();
    testPercentageOfLoops();
    testAverageIterationsPerLoop();*/                
        
        
    }

    private static void testMarketGeneration() {
        qosModel = problemGenerator.generateQoSModel();
        DistributionFunction<Integer> dfNumberOfCandidates = new IntegerGausssianDistributionFunction(5, 2.0);
        marketValues = new HashMap<QoSProperty, DistributionFunction<Double>>();
        QoSProperty cost = qosModel.getQoSProperty("Cost");
        QoSProperty execTime = qosModel.getQoSProperty("ExecTime");
        QoSProperty reliability = qosModel.getQoSProperty("Reliability");
        QoSProperty avaliability = qosModel.getQoSProperty("Availability");
        QoSProperty security = qosModel.getQoSProperty("Security");
        double minCost = 0.2;
        double maxCost = 0.95;
        DistributionFunction<Double> dfCost = new DoubleUniformDistributionFunction(minCost, maxCost);
        double avgExecTime = 0.5;
        double stdDevExecTime = 0.4;
        DistributionFunction<Double> dfExecTime = new DoubleGaussianDistributionFunction(avgExecTime, stdDevExecTime);
        double minReliability = 0.3;
        double maxReliability = 0.9;
        DistributionFunction<Double> dfReliability = new DoubleUniformDistributionFunction(minReliability, maxReliability);
        double minAvaliability = 0.8;
        double maxAvaliability = 0.99;
        DistributionFunction<Double> dfAvaliability = new DoubleUniformDistributionFunction(minAvaliability, maxAvaliability);
        double minSecurity = 0.6;
        double maxSecurity = 0.99;
        DistributionFunction<Double> dfSecurity = new DoubleUniformDistributionFunction(minSecurity, maxSecurity);

        marketValues.put(cost, dfCost);
        marketValues.put(execTime, dfExecTime);
        marketValues.put(reliability, dfReliability);
        marketValues.put(avaliability, dfAvaliability);
        marketValues.put(security, dfSecurity);

        marketModel = new QoSAwareWSCompositionProblemServicesMarketModel(dfNumberOfCandidates, marketValues);

        market = problemGenerator.generateMarket(structure, qosModel, marketModel);
        System.out.println("<============== MARKET OF SERVICES GENERATION TESTS ===============>");
        for (AbstractWebService aws : market.keySet()) {
            System.out.println("AWS" + aws.toString() + ":");
            for (ConcreteWebService cws : market.get(aws)) {
                System.out.print("      S" + cws.getName() + "(");
                for (QoSProperty property : qosModel.getQosProperties()) {
                    System.out.print(property.getName() + ":" + cws.getQoSValue(property) + ",");
                }
                System.out.println(")");
            }
        }
        System.out.println("<====================================================================>");
    }
}
