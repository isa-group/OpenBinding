package es.us.isa.qosawarewsbinding.mains;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.Branch;
import es.us.isa.qosawarewsbinding.CompositeStructuralComponent;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.Flow;
import es.us.isa.qosawarewsbinding.Loop;
import es.us.isa.qosawarewsbinding.Sequence;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.problem.ProblemReaderAndWriter;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.qos.aggretation.MaxAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MinAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ProductoryAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.SumatoryAggregationFunction;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolution;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolutionNavigable;
import es.us.isa.qosawarewsbinding.util.BoundedDomain;

/**
 * Hello world!
 *
 */
public class BasicAppTest 
{
    
    private static QoSProperty<Double> cost;
    private static QoSProperty<Double> execTime;
    private static QoSProperty<Double> reliability;
    private static QoSProperty<Double> avaliability;
    private static QoSProperty<Double> security;                        
    
    private static AbstractWebService t1;
    private static ConcreteWebService s11;
    private static ConcreteWebService s12;
    
    private static AbstractWebService t2;
    private static ConcreteWebService s21;
    private static ConcreteWebService s22;
    private static ConcreteWebService s23;
    
    private static AbstractWebService t3;
    private static ConcreteWebService s31;
    private static ConcreteWebService s32;
    
    private static AbstractWebService t4;
    private static ConcreteWebService s41;
    private static ConcreteWebService s42;
    
    public static void main( String[] args )
    {
        /*
		// Dummy BPEL using 4 tasks in a sequence  (execution goes top-down):
		//		O
		//	 	|		 Cst Tm  Rel Rep Sec       Cst  Tm  Rel Rep Sec
		//		t1  {s11(0.1,0.2,0.3,0.4,0.9),s12(0.25,0.07,0.3,0.8,0.9)} 
		//		|
		//		t2  {s21(0.5,0.05,0.8,0.4,0.9),s22(0.1,0.2,0.3,0.4,0.9),s23(0.2,0.1,0.3,0.7,0.6))
		//		|
		//		t3	(s31(0.5,0.05,0.8,0.4,0.9),s32(0.15,0.15,0.3,0.9,0.5))
		//		|
		//		t4	(s41(0.5,0.05,0.8,0.4,0.9),s42(0.15,0.15,0.3,0.9,0.5))
		//		|
		//              X
         */
        
        // Composition Structure:
        t1=new AbstractWebService("t1");
        t2=new AbstractWebService("t2");
        t3=new AbstractWebService("t3");
        t4=new AbstractWebService("t4");
        CompositeStructuralComponent sc=new Sequence();
        Branch myswitch=new Branch();
        sc.getSubComponents().add(myswitch);
        CompositeStructuralComponent b1=new Sequence();
        CompositeStructuralComponent b2=new Sequence();
        myswitch.addBranch(b1, 0.6);
        myswitch.addBranch(b2, 0.4);
        b1.getSubComponents().add(t1);
        Loop myloop=new Loop(4000);
        b2.getSubComponents().add(myloop);
        myloop.getSubComponents().add(t2);
        //sc.getSubComponents().add(t2);
        //sc.getSubComponents().add(t2);
        //sc.getSubComponents().add(t3);
        //sc.getSubComponents().add(t4);        
        WSCompositionStructure compositionStructure=new WSCompositionStructure(sc);
        
        WSCompositionQoSModel qosmodel=createQosModel();                          
                
        QoSAwareWSCompositionProblem problem=new QoSAwareWSCompositionProblem(compositionStructure,qosmodel);
        System.out.println("Number of executed tasks:"+problem.numberOfExecutedTasks());        
        populateMarket(problem.getMarket(), compositionStructure.getComponents());
        long milisegundos=2000;      
        QoSAwareWSCompositionVectorSolutionNavigable initial=new QoSAwareWSCompositionVectorSolutionNavigable(problem);
        /*
        // Usage of Simulated Annealing to optimize the selection of services:
        // parameters 1000 º of initial temperature and a geometric cooler of 0.95
        Cooler cooler=new GeometricCooler(0.90);
        Metaheuristic sa=new SA(cooler,10000);
        //Observer observerOptimalSolutionSA=new CurrentSolutionObserver((LocalSearch)sa, null);
        //ChartRenderer2 rendererGraficaSA=new ChartRenderer2((es.us.lsi.isa.fom.observer.Observer) observerOptimalSolutionSA,true);                                       
        //sa.setObserver(observerOptimalSolutionSA);
        //observerOptimalSolutionSA.setVisualizator(rendererGraficaSA);                        
        
        TimeTerminator terminator=new TimeTerminator(milisegundos);
        sa.setTerminator(terminator);
        int numberOfAnts=4;
        int percentageOfTrailUpdaters=25;
        Selector trailUpdaters=new ElitistSelector(false);            
        Observer observer=new NullObserver();
        
        double geometricEvaporationValue=0.95;
        double pBest=0.05;
        int solutionComponents=4;
        double averageItemsToChoose=2.3;        
        MaxMinQoSAwareWSCompositionPheromoneTrail mmtrail=new MaxMinQoSAwareWSCompositionPheromoneTrail(null,geometricEvaporationValue,pBest,solutionComponents,averageItemsToChoose,problem);
        Metaheuristic mmas=new AntColonyOptimization(numberOfAnts, mmtrail, percentageOfTrailUpdaters, trailUpdaters,1.0,2.0, observer, terminator);
        mmtrail.setACO((AntColonyOptimization)mmas);
        percentageOfTrailUpdaters=50;
        EvaporationScheme scheme=new GeometricEvaporationScheme(geometricEvaporationValue);
        BaseQoSAwareWSCompositionPhreomoneTrail trail=new BaseQoSAwareWSCompositionPhreomoneTrail(scheme, null, problem);
        Metaheuristic aco=new AntColonyOptimization(numberOfAnts, trail, percentageOfTrailUpdaters, trailUpdaters,1.0,2.0, observer, terminator);
        trail.setACO((AntColonyOptimization)aco);
        QoSAwareWSCompositionVectorSolutionNavigable initial=new QoSAwareWSCompositionVectorSolutionNavigable(problem);
        QoSAwareWSCompositionVectorAnt ant=new QoSAwareWSCompositionVectorAnt(initial);
        QoSAwareWSCompositionVectorAnt ant2=new QoSAwareWSCompositionVectorAnt(initial);
        Solution optimizedSA=sa.optimize(initial);
        Solution optimizedMMAS=mmas.optimize(ant);        
        Solution optimizedACO=aco.optimize(ant2);        
        Selector selectorMutacion=new RandomSelector(false);
        Selector selectorCruce=new TournamentSelector(false,2);
	Selector selectorInversion=new RandomSelector(true);
	Selector selectorSupervivencia=new TournamentSelector(false,10);
	int basicGAPopulationSize=20;
        float basicGADeahRate=(float) 0.4;
        float basicGAIncestThreshold=(float) 0.95;
        float basicGAMutationProbability=(float) 0.2;
        float basicGAInversionProbability=(float) 0.01;
        Metaheuristic ga=new GeneticAlgorithm(basicGAPopulationSize,basicGADeahRate,basicGAIncestThreshold,basicGAMutationProbability,basicGAInversionProbability,selectorMutacion,selectorInversion,selectorCruce,selectorSupervivencia);		
        ga.setTerminator(terminator);
        Solution individual=new QoSAwareWSCompositionVectorIndividual(problem);
        Solution optimizedGA=ga.optimize(individual);
        System.out.println("Final Temperature:"+((SA)sa).getTemperaturaActual());*/
        QoSAwareWSCompositionVectorSolution optimal=new QoSAwareWSCompositionVectorSolution(problem);         
        optimal.setSelectedService(t1, s12);
        optimal.setSelectedService(t2, s23);
        optimal.setSelectedService(t3,s32);
        optimal.setSelectedService(t4, s42);
        optimal.getFitness();
        System.out.println("Problem:");
        System.out.println(problem);
        System.out.println(problem.numberOfExecutedTasks());        
        System.out.println("Solutions:");
        System.out.println("----------------------");
        System.out.println("Initial:"+initial);
        /*System.out.println("----------------------");
        System.out.println("Optimized SA:"+optimizedSA);
        System.out.println("----------------------");
        System.out.println("Optimized ACO:"+optimizedACO);        
        System.out.println("----------------------");        
        System.out.println("Optimized MMAS:"+optimizedMMAS);        
        System.out.println("----------------------");
        System.out.println("Optimized GA:"+optimizedGA);;*/
        System.out.println("----------------------");
        System.out.println("Global Optimum:"+optimal);        
        System.out.println("----------------------");
        System.out.println("Optimums per QoSProperty:");
        QoSAwareWSCompositionSolution solutionPerProp=null;
        for(QoSProperty property:problem.getQosmodel().getQosProperties()){
            solutionPerProp=problem.computeBestSolution(property);
            System.out.println("   "+property.getName());
            System.out.println("   "+problem.bestValue(property));
            System.out.println("   "+solutionPerProp);
            System.out.println("   -----------------");
        }
        System.out.println("----------------------");
                
        ProblemReaderAndWriter.write(".\\data\\pruebatonta.txt", problem);
        
    }

    private static WSCompositionQoSModel createQosModel() {
        // QosModel Creation:
        // Properties:
        Set<QoSProperty> qosProperties=new HashSet<QoSProperty>();
        cost=new QoSProperty<Double>("Cost",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.NEGATIVE);
        execTime=new QoSProperty<Double>("ExecTime",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.NEGATIVE);
        reliability=new QoSProperty<Double>("Reliability",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.POSITIVE);
        avaliability=new QoSProperty<Double>("Availability",new BoundedDomain<Double>(0.0,1.0),QoSPropertyType.POSITIVE);
        security=new QoSProperty<Double>("Security", new BoundedDomain(0.0,1.0),QoSPropertyType.POSITIVE);                        
        qosProperties.add(cost);            
        qosProperties.add(execTime);
        qosProperties.add(reliability);
        qosProperties.add(avaliability);
        qosProperties.add(security);                
        WSCompositionQoSModel qosmodel=new WSCompositionQoSModel(qosProperties);
        // Weights:
        Map<QoSProperty, Double> qosWeights=new HashMap<QoSProperty,Double>();
        qosWeights.put(cost, 0.3);
        qosWeights.put(execTime, 0.2);
        qosWeights.put(reliability, 0.2);
        qosWeights.put(avaliability, 0.2);
        qosWeights.put(security, 0.1);
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
        qosmodel.setAggregationFunction(reliability, Loop.class, ProductoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(reliability, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(reliability, Flow.class, ProductoryAggregationFunction.getInstance());
        // For Availability:
        qosmodel.setAggregationFunction(avaliability, Sequence.class, ProductoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(avaliability, Loop.class, ProductoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(avaliability, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(avaliability, Flow.class, ProductoryAggregationFunction.getInstance());
        // For Security:
        qosmodel.setAggregationFunction(security, Sequence.class, MinAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(security, Loop.class, MinAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(security, Branch.class, SumatoryAggregationFunction.getInstance());
        qosmodel.setAggregationFunction(security, Flow.class, MinAggregationFunction.getInstance());
        return qosmodel;
    }
    
    private static void populateMarket(Map<AbstractWebService, Set<ConcreteWebService>> market, Set<AbstractWebService> components) {
        // Servicios Web concretos:
        s11=new ConcreteWebService("s11", t1);
        s11.setQoSValue(cost, 0.1);
        s11.setQoSValue(execTime, 0.2);
        s11.setQoSValue(reliability,new Double(0.3)); // Reliability
	s11.setQoSValue(avaliability,new Double(0.4)); // Reputation
	s11.setQoSValue(security,new Double(0.9)); // Security

        s12=new ConcreteWebService("s12", t1);
        s12.setQoSValue(cost,new Double(0.25));	// Cost
	s12.setQoSValue(execTime,new Double(0.07)); // Time		
	s12.setQoSValue(reliability,new Double(0.3)); // Reliability
	s12.setQoSValue(avaliability,new Double(0.8)); // Reputation
	s12.setQoSValue(security,new Double(0.9)); // Security	
        Set<ConcreteWebService> s1=new HashSet<ConcreteWebService>();
        s1.add(s11);
        s1.add(s12);        
        market.put(t1, s1);
        
        s21=new ConcreteWebService("s21", t2);
        s21.setQoSValue(cost, 0.5);
        s21.setQoSValue(execTime, 0.05);
        s21.setQoSValue(reliability,0.8); // Reliability
	s21.setQoSValue(avaliability,0.4); // Reputation
	s21.setQoSValue(security,new Double(0.9)); // Security
        
        s22=new ConcreteWebService("s22", t2);
        s22.setQoSValue(cost,new Double(0.1));	// Cost
	s22.setQoSValue(execTime,new Double(0.2)); // Time		
	s22.setQoSValue(reliability,new Double(0.3)); // Reliability
	s22.setQoSValue(avaliability,new Double(0.4)); // Reputation
	s22.setQoSValue(security,new Double(0.9)); // Security
        
        s23=new ConcreteWebService("s23", t2);        
        s23.setQoSValue(cost,new Double(0.2));	// Cost
	s23.setQoSValue(execTime,new Double(0.1)); // Time		
	s23.setQoSValue(reliability,new Double(0.3)); // Reliability
	s23.setQoSValue(avaliability,new Double(0.7)); // Reputation
	s23.setQoSValue(security,new Double(0.6)); // Security
        Set<ConcreteWebService> s2=new HashSet<ConcreteWebService>();
        s2.add(s21);
        s2.add(s22);
        s2.add(s23);       
        market.put(t2, s2);
        
        s31=new ConcreteWebService("s31", t3);
        s31.setQoSValue(cost,new Double(0.5));	// Cost
	s31.setQoSValue(execTime,new Double(0.05)); // Time		
	s31.setQoSValue(reliability,new Double(0.8)); // Reliability
	s31.setQoSValue(avaliability,new Double(0.4)); // Reputation
	s31.setQoSValue(security,new Double(0.9)); // Security
        
        s32=new ConcreteWebService("s32", t3);
        s32.setQoSValue(cost,new Double(0.15));	// Cost
	s32.setQoSValue(execTime,new Double(0.15)); // Time		
	s32.setQoSValue(reliability,new Double(0.3)); // Reliability
	s32.setQoSValue(avaliability,new Double(0.9)); // Reputation
	s32.setQoSValue(security,new Double(0.5)); // Security
        Set<ConcreteWebService> s3=new HashSet<ConcreteWebService>();
        s3.add(s31);
        s3.add(s32);
        	
        market.put(t3, s3);
        
        s41=new ConcreteWebService("s41", t4);
        s41.setQoSValue(cost,new Double(0.5));	// Cost
	s41.setQoSValue(execTime,new Double(0.05)); 	// Time		
	s41.setQoSValue(reliability,new Double(0.8)); 	// Reliability
	s41.setQoSValue(avaliability,new Double(0.4)); 	// Reputation
	s41.setQoSValue(security,new Double(0.9)); 	// Security
        
        s42=new ConcreteWebService("s42", t4);
        s42.setQoSValue(cost,new Double(0.15));	// Cost
	s42.setQoSValue(execTime,new Double(0.15)); 	// Time		
	s42.setQoSValue(reliability,new Double(0.3)); 	// Reliability
	s42.setQoSValue(avaliability,new Double(0.9)); 	// Reputation
	s42.setQoSValue(security,new Double(0.5)); 	// Security
        Set<ConcreteWebService> s4=new HashSet<ConcreteWebService>();
        s4.add(s41);
        s4.add(s42);
        market.put(t4, s4);        
    }
}
