/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem.generator;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.Branch;
import es.us.isa.qosawarewsbinding.CompositeStructuralComponent;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.Flow;
import es.us.isa.qosawarewsbinding.Loop;
import es.us.isa.qosawarewsbinding.Sequence;
import es.us.isa.qosawarewsbinding.StructuralComponent;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.problem.BinaryOperator;
import es.us.isa.qosawarewsbinding.problem.GlobalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.problem.model.GlobalQoSConstraintsModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemConstraintsModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemServicesMarketModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemStructuralModel;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.qos.aggretation.MaxAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MinAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ProductoryAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ProductoryPowAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.SumatoryAggregationFunction;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolution;
import es.us.isa.qosawarewsbinding.util.BoundedDomain;
import es.us.isa.qosawarewsbinding.util.DistributionFunction;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionProblemGenerator extends AbstractProblemGenerator<QoSAwareWSCompositionProblem>{

    public QoSAwareWSCompositionProblemGenerator(QoSAwareWSCompositionProblemModel model)
    {
        super(model);
    }
    
    
    public QoSAwareWSCompositionProblem generate() 
    {    
         WSCompositionStructure structure=generateStructure();
         WSCompositionQoSModel qosModel=generateQoSModel();
         Map<AbstractWebService,Set<ConcreteWebService>> market=generateMarket(structure,qosModel);
         List<WSCompositionConstraint> constraints=generateConstraints(market,qosModel);
         QoSAwareWSCompositionProblem problem=new QoSAwareWSCompositionProblem(structure,market,qosModel,constraints);
         generateGlobalConstraints(constraints ,market,qosModel,problem);
         generateAdditionalConstraints(constraints,market,qosModel,problem);
         return problem;
    }

    public double computeMax(QoSProperty property, Map<AbstractWebService, Set<ConcreteWebService>> market,QoSAwareWSCompositionProblem problem) {
        double result=0;        
        double localExtremeValue;
        Double value;
        ConcreteWebService cwsSelected=null;
        QoSAwareWSCompositionVectorSolution solution=new QoSAwareWSCompositionVectorSolution(problem);        
        for(AbstractWebService aws:market.keySet())
        {
            localExtremeValue=Double.MIN_VALUE;
            cwsSelected=null;
            for(ConcreteWebService cws:market.get(aws))
            {
                value=(Double)cws.getQoSValue(property);
                if(value>localExtremeValue || cwsSelected==null){
                    localExtremeValue=value;
                    cwsSelected=cws;
                }
            }
            solution.setSelectedService(aws, cwsSelected);
        }
        result=problem.getQosmodel().evaluate(solution, property, problem.getStructure().getStructure());
        return result;
    }

    public double computeMin(QoSProperty property, Map<AbstractWebService, Set<ConcreteWebService>> market,QoSAwareWSCompositionProblem problem) {
        double result=0;        
        double localExtremeValue;
        Double value;
        ConcreteWebService cwsSelected=null;
        QoSAwareWSCompositionVectorSolution solution=new QoSAwareWSCompositionVectorSolution(problem);        
        for(AbstractWebService aws:market.keySet())
        {
            localExtremeValue=Double.MAX_VALUE;
            cwsSelected=null;
            for(ConcreteWebService cws:market.get(aws))
            {
                value=(Double)cws.getQoSValue(property);
                if(value<localExtremeValue || cwsSelected==null){
                    localExtremeValue=value;
                    cwsSelected=cws;
                }
            }
            solution.setSelectedService(aws, cwsSelected);
        }
        result=problem.getQosmodel().evaluate(solution, property, problem.getStructure().getStructure());
        return result;
    }

    public List<WSCompositionConstraint> generateConstraints(Map<AbstractWebService, Set<ConcreteWebService>> market, WSCompositionQoSModel qosModel) {
        List<WSCompositionConstraint> result=new LinkedList<WSCompositionConstraint>();                
        
        return result;
    }

    public void generateGlobalConstraints(List<WSCompositionConstraint> result, Map<AbstractWebService, Set<ConcreteWebService>> market, WSCompositionQoSModel qosModel,QoSAwareWSCompositionProblem problem) {
        QoSAwareWSCompositionProblemModel problemModel=(QoSAwareWSCompositionProblemModel)getProblemModel();
        QoSAwareWSCompositionProblemConstraintsModel constraintsModel=problemModel.getConstraintsModel();
        GlobalQoSConstraintsModel globalConstraintsModel=constraintsModel.getGlobalConstraintsModel();
        int numberOfConstraints=globalConstraintsModel.getNumberOfConstraints();
        double probability=(double)numberOfConstraints/(double)qosModel.getQosProperties().size();
        double min;
        double max;
        double value;
        double percentage;
        BinaryOperator operator;       
        for(QoSProperty property:qosModel.getQosProperties())
        {
            if(Math.random()<probability)
            {
                if(property.getType()==QoSPropertyType.NEGATIVE)
                    operator=BinaryOperator.LOWEREQUAL;
                else
                    operator=BinaryOperator.GREATEREQUAL;
                min=computeMin(property,market,problem);
                max=computeMax(property,market,problem);
                percentage=((double)globalConstraintsModel.getDfPercentageOfOptimality().getValue())/100.0;
                value=min+percentage*(max-min);
                result.add(new GlobalQoSWSCompositionConstraint(problem, property, value, operator));
            }
        }             
    }
    
    public void generateAdditionalConstraints(List<WSCompositionConstraint> result, Map<AbstractWebService, Set<ConcreteWebService>> market, WSCompositionQoSModel qosModel,QoSAwareWSCompositionProblem problem) {
        // TODO: Implement the generation of additional constraints.
    }
    private Map<AbstractWebService, Set<ConcreteWebService>> generateMarket(WSCompositionStructure structure, WSCompositionQoSModel qosModel)
    {
        QoSAwareWSCompositionProblemModel problemModel=(QoSAwareWSCompositionProblemModel)getProblemModel();
        QoSAwareWSCompositionProblemServicesMarketModel marketModel=problemModel.getMarketModel();        
        return generateMarket(structure,qosModel,marketModel);
    }
    public Map<AbstractWebService, Set<ConcreteWebService>> generateMarket(WSCompositionStructure structure, WSCompositionQoSModel qosModel,QoSAwareWSCompositionProblemServicesMarketModel marketModel) {
        Map<AbstractWebService, Set<ConcreteWebService>> result=new HashMap<AbstractWebService, Set<ConcreteWebService>>();
        Set<ConcreteWebService> setCWS=null;                
        for(AbstractWebService aws:structure.getComponents())
        {
            setCWS=generateSubMarket(aws,qosModel,marketModel);
            result.put(aws, setCWS);
        }
        return result;
    }

    

    public WSCompositionQoSModel generateQoSModel() {
        Set<QoSProperty> qosProperties=new HashSet<QoSProperty>();
        QoSProperty cost=new QoSProperty<Double>("Cost",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.NEGATIVE);
        QoSProperty execTime=new QoSProperty<Double>("ExecTime",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.NEGATIVE);
        QoSProperty reliability=new QoSProperty<Double>("Reliability",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.POSITIVE);
        QoSProperty avaliability=new QoSProperty<Double>("Availability",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.POSITIVE);
        QoSProperty security=new QoSProperty<Double>("Security", new BoundedDomain(0.0,1.0),QoSPropertyType.POSITIVE);                        
        qosProperties.add(cost);            
        qosProperties.add(execTime);
        qosProperties.add(reliability);
        qosProperties.add(avaliability);
        qosProperties.add(security);                
        WSCompositionQoSModel qosmodel=new WSCompositionQoSModel(qosProperties);
        // Weights:
        Map<QoSProperty, Double> qosWeights=new HashMap<QoSProperty,Double>();
        qosWeights.put(cost, 0.3);
        qosWeights.put(execTime, 0.3);
        qosWeights.put(reliability, 0.1);
        qosWeights.put(avaliability, 0.1);
        qosWeights.put(security, 0.2);
        qosmodel.setQosPropertiesWeights(qosWeights);
        // Aggregation Functions:
        // For Cost:
        qosmodel.setAggregationFunction(cost, Sequence.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(cost, Loop.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(cost, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(cost, Flow.class, SumatoryAggregationFunction.getInstance());
        // For ExecTime:
        qosmodel.setAggregationFunction(execTime, Sequence.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(execTime, Loop.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(execTime, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(execTime, Flow.class, MaxAggregationFunction.getInstance());
        // For Reliability:
        qosmodel.setAggregationFunction(reliability, Sequence.class, ProductoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(reliability, Loop.class, ProductoryPowAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(reliability, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(reliability, Flow.class, ProductoryAggregationFunction.getInstance());
        // For Availability:
        qosmodel.setAggregationFunction(avaliability, Sequence.class, ProductoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(avaliability, Loop.class, ProductoryPowAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(avaliability, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(avaliability, Flow.class, ProductoryAggregationFunction.getInstance());
        // For Security:
        qosmodel.setAggregationFunction(security, Sequence.class, MinAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(security, Loop.class, MinAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(security, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(security, Flow.class, MinAggregationFunction.getInstance());
        return qosmodel;
    }

    public CompositeStructuralComponent generateStructuralComponent(QoSAwareWSCompositionProblemStructuralModel structuralModel) {
        CompositeStructuralComponent result=null;
        // This method must create the structural components associated with the control flow,
        // asigning their ponderation (number of iterations in the case of loops, and execution probability for
        // each branch in the case of IF-ELSEs.
        // Moreover in the case of IF-ELSEs, this method will create a sequence as the structural componen associated with
        // each branch
        double random=Math.random();
        if(random<(double)(structuralModel.getPercentageLoops()/100.0)){
            int numberOfIterations=structuralModel.getIterationsPerLoop().getValue();
            result=new Loop(numberOfIterations);
        }else{
            random=Math.random();
            Branch branch=new Branch();
            CompositeStructuralComponent branch1=new Sequence();
            CompositeStructuralComponent branch2=new Sequence();
            branch.addBranch(branch1, random);
            branch.addBranch(branch2, (1.0-random));
            result=branch;
        }
        return result;
    }

    private  WSCompositionStructure generateStructure()
    {
        QoSAwareWSCompositionProblemModel problemModel=(QoSAwareWSCompositionProblemModel)getProblemModel();
        QoSAwareWSCompositionProblemStructuralModel structuralModel=problemModel.getStructuralModel();
        return generateStructure(structuralModel);
    }
    
    public WSCompositionStructure generateStructure(QoSAwareWSCompositionProblemStructuralModel structuralModel) {
        WSCompositionStructure structure=null;                
        int nAbstractWebServices=(100-structuralModel.getPercentageOfControlFlowActivities())*structuralModel.getNumberOfActivities()/100;
        AbstractWebService []services=new AbstractWebService[nAbstractWebServices];
        // We create the abstract web services:
        for(int i=0;i<services.length;i++)
            services[i]=new AbstractWebService(String.valueOf(i));        
        // We create the basic structure using the value of cyclomatic complexity:
        List<CompositeStructuralComponent> structuralComponents=new LinkedList<CompositeStructuralComponent>();
        int nControlFlowActivities=structuralModel.getPercentageOfControlFlowActivities()*structuralModel.getNumberOfActivities()/100;
        for(int i=0;i<nControlFlowActivities;i++)
        {
            structuralComponents.add(generateStructuralComponent(structuralModel));
        }
        // Initial sequence:
        CompositeStructuralComponent root=new Sequence();
        // We create another list to store the candidate composite components to the insertion of others:
        List<CompositeStructuralComponent> candidatesToInsertion=new LinkedList<CompositeStructuralComponent>();
        candidatesToInsertion.add(root);       
        // We create another list to store the candidate composite components to the insertion of others that has no subcomponentes:
        List<CompositeStructuralComponent> emptyCandidatesToInsertion=new LinkedList<CompositeStructuralComponent>();
        // We distribute this structures in a control graph (in this case in a control tree)
        // having in to account the constraint on the nesting level:        
        
        // We Create a structure to store the nesting level of each component:
        Map<CompositeStructuralComponent,Integer> nestingLevel=new HashMap<CompositeStructuralComponent, Integer>();        
        nestingLevel.put(root, 0);
        // We distribute these components:
        StructuralComponent currentComponentToDistribute;
        CompositeStructuralComponent componentWhereWeNest;
        while(!structuralComponents.isEmpty())
        {
            currentComponentToDistribute=(StructuralComponent)getRandomElement(structuralComponents);
            componentWhereWeNest=(CompositeStructuralComponent)getRandomElement(candidatesToInsertion);
            // We impose the maximum nesting level:
            while(nestingLevel.get(componentWhereWeNest)>=structuralModel.getMaxNestingLevel())
                componentWhereWeNest=(CompositeStructuralComponent)getRandomElement(candidatesToInsertion);
            // We insert the structural component in a randomly selected position:
            insertRandomly(currentComponentToDistribute, componentWhereWeNest);
            // We updae the nesting level of each component:
            updateNestingLevel(currentComponentToDistribute, componentWhereWeNest,nestingLevel,candidatesToInsertion,emptyCandidatesToInsertion);
            structuralComponents.remove(currentComponentToDistribute);
        }
        // Once the control structure is created, we distribute the AbstractWebService invocations:        
        for(AbstractWebService service:services)
        {
            if(emptyCandidatesToInsertion.isEmpty()){
                componentWhereWeNest=(CompositeStructuralComponent)getRandomElement(candidatesToInsertion);
                insertRandomly(service,componentWhereWeNest);            
            }else{
                componentWhereWeNest=(CompositeStructuralComponent)getRandomElement(emptyCandidatesToInsertion);
                if(componentWhereWeNest instanceof Branch)                
                    insertRandomly(service,(CompositeStructuralComponent) componentWhereWeNest.getSubComponents().get(0));
                else
                    insertRandomly(service,componentWhereWeNest);
                emptyCandidatesToInsertion.remove(componentWhereWeNest);
            }
        }
        AbstractWebService myservice;
        int serviceIndex=0;
        for(int i=services.length+nControlFlowActivities;i<structuralModel.getNumberOfActivities();i++)
        {
            serviceIndex=(int)(Math.floor(Math.random()*((double)services.length)));
            myservice=services[serviceIndex];            
            if(emptyCandidatesToInsertion.isEmpty()){
                componentWhereWeNest=(CompositeStructuralComponent)getRandomElement(candidatesToInsertion);
                insertRandomly(myservice,componentWhereWeNest);
            }else{
                componentWhereWeNest=(CompositeStructuralComponent)getRandomElement(emptyCandidatesToInsertion);
                if(componentWhereWeNest instanceof Branch)                
                    insertRandomly(myservice,(CompositeStructuralComponent) componentWhereWeNest.getSubComponents().get(0));
                else
                    insertRandomly(myservice,componentWhereWeNest);
                emptyCandidatesToInsertion.remove(componentWhereWeNest);
            }
        }
        structure=new WSCompositionStructure(root);
        return structure;
    }

    private Set<ConcreteWebService> generateSubMarket(AbstractWebService aws, WSCompositionQoSModel qosModel, QoSAwareWSCompositionProblemServicesMarketModel marketModel) {
        Set<ConcreteWebService> result=new HashSet<ConcreteWebService>();
        int numberOfCandidates=Math.max(marketModel.getNumberOfCandidates().getValue(),2);
        ConcreteWebService cws=null;
        DistributionFunction<Double> qosDistribution=null;
        for(int i=0;i<numberOfCandidates;i++)
        {
            cws=new ConcreteWebService(aws.toString()+"-"+i, aws);
            for(QoSProperty property:qosModel.getQosProperties())
            {
                qosDistribution=marketModel.getQosValues().get(property);
                if(qosDistribution!=null)
                    cws.setQoSValue(property, qosDistribution.getValue());                
            }
            result.add(cws);
        }
        return result;
    }

    private Object getRandomElement(List structuralComponents) {
        int index=(int)(Math.floor(Math.random()*((double)structuralComponents.size())));
        return structuralComponents.get(index);
    }

    private void insertRandomly(StructuralComponent currentComponentToDistribute, CompositeStructuralComponent componentWhereWeNest) {
        List<StructuralComponent> listOfSubcomponents=componentWhereWeNest.getSubComponents();
        int index=(int)(Math.floor(Math.random()*((double)listOfSubcomponents.size())));
        listOfSubcomponents.add(index, currentComponentToDistribute);
    }

    private void updateNestingLevel(StructuralComponent currentComponentToDistribute, CompositeStructuralComponent componentWhereWeNest, Map<CompositeStructuralComponent, Integer> nestingLevel, List<CompositeStructuralComponent> candidatesToInsertion, List<CompositeStructuralComponent> emptyCandidatesToInsertion) {            
        int parentNestingLevel=nestingLevel.get(componentWhereWeNest);
        if(currentComponentToDistribute instanceof Loop){
            nestingLevel.put((Loop)currentComponentToDistribute, parentNestingLevel+1);
            candidatesToInsertion.add((Loop)currentComponentToDistribute);
            emptyCandidatesToInsertion.add((Loop)currentComponentToDistribute);
            emptyCandidatesToInsertion.remove(componentWhereWeNest);
        }else if(currentComponentToDistribute instanceof Branch){
            for(StructuralComponent subComponent:((Branch)currentComponentToDistribute).getSubComponents()){
                candidatesToInsertion.add((CompositeStructuralComponent)subComponent);
                nestingLevel.put((CompositeStructuralComponent)subComponent, parentNestingLevel+1);                
            }
            emptyCandidatesToInsertion.add((CompositeStructuralComponent)currentComponentToDistribute);
            emptyCandidatesToInsertion.remove(componentWhereWeNest);
        }                        
    }
    

}
