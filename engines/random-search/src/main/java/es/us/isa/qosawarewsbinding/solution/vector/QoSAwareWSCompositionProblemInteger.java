/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.solution.vector;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.problem.ExecutionPath;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.Solution;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionProblemInteger extends QoSAwareWSCompositionProblem {

	private Map<AbstractWebService, Integer> abstractWebServicesIndexes;
	private QoSAwareWSCompositionProblem problem;
	private ConcreteWebService[][] services;    


	public  QoSAwareWSCompositionProblemInteger(QoSAwareWSCompositionProblem problem)
	{
		super(problem.getStructure(),problem.getQosmodel());
		this.problem=problem;
		abstractWebServicesIndexes=new HashMap<AbstractWebService, Integer>();
		int numberofAbstractServices=problem.getMarket().keySet().size();
		services=new ConcreteWebService[numberofAbstractServices][];
		int i=0;
		int j=0;
		for(AbstractWebService aws:problem.getMarket().keySet()){
			abstractWebServicesIndexes.put(aws, i);
			services[i]=new ConcreteWebService[problem.getMarket().get(aws).size()];
			j=0;
			for(ConcreteWebService service:problem.getMarket().get(aws)){
				services[i][j]=service;
				j++;
			}
			i++;            
		}        
	}

	@Override
	public double feasibilityDistance(Solution sol) {
		return problem.feasibilityDistance(sol);
	}

	@Override
	public double feasibilityFreeFitness(Solution sol) {
		return problem.feasibilityFreeFitness(sol);
	}


	@Override
	public int numberOfCandidates(AbstractWebService aws)
	{ 
		return problem.numberOfCandidates(aws);
	}

	@Override
	public Map<AbstractWebService, Set<ConcreteWebService>> getMarket() {
		return problem.getMarket();
	}

	@Override
	public WSCompositionStructure getStructure()
	{
		return problem.getStructure();
	}

	public int numberOfCandidates(int aws)
	{
		return services[aws].length;                 
	}

	public ConcreteWebService getService(int aws, int index)
	{
		return services[aws][index];
	}

	public int getIndex(AbstractWebService aws)
	{
		return abstractWebServicesIndexes.get(aws);
	}

	int getServiceIndex(int aws, ConcreteWebService cws) {
		ConcreteWebService []concreteservices=services[aws];
		int result=-1;
		for(int i=0;i<concreteservices.length && result==-1;i++)
			if(concreteservices[i]==cws)
				result=i;
		return result;
	}       

	@Override
	public Set<ExecutionPath> getExpaths() {
		return problem.getExpaths();
	}

	public double numberOfExecutedTasks()
	{
		return problem.numberOfExecutedTasks();
	}

	@Override
	public List<WSCompositionConstraint> getConstraints() {
		return problem.getConstraints();
	}

	public Double bestValue(QoSProperty property) {
		QoSAwareWSCompositionSolution solution = computeBestSolution(property);
		return getQosmodel().evaluate(solution, property, getStructure());
	}

	public Double worstValue(QoSProperty property) {
		QoSAwareWSCompositionSolution solution = computeWorstSolution(property);
		return getQosmodel().evaluate(solution, property, getStructure());
	}

	public QoSAwareWSCompositionSolution computeBestSolution(QoSProperty property) {
		QoSAwareWSCompositionVectorSolution result = new QoSAwareWSCompositionVectorSolution(this);
		ConcreteWebService bestCandidate;
		ConcreteWebService cws;
		Set<AbstractWebService> abstractServices = this.abstractWebServicesIndexes.keySet();
		int i;
		for(AbstractWebService aws: abstractServices){
			i = this.abstractWebServicesIndexes.get(aws);
			bestCandidate = services[i][0];
			for(int j=0; j<services[i].length; j++){
				cws = services[i][j];
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
			result.setSelectedService(aws, bestCandidate);
		}
		return result;
	}

	public QoSAwareWSCompositionSolution computeWorstSolution(QoSProperty property) {
		QoSAwareWSCompositionVectorSolution result = new QoSAwareWSCompositionVectorSolution(this);
		ConcreteWebService worstCandidate = null;
		ConcreteWebService cws;
		Set<AbstractWebService> abstractServices = this.abstractWebServicesIndexes.keySet();
		int i;
		for(AbstractWebService aws: abstractServices){
			i = this.abstractWebServicesIndexes.get(aws);
			worstCandidate = services[i][0];
			for(int j=0; j<services[i].length; j++){
				cws = services[i][j];
				if (property.getType() == QoSPropertyType.POSITIVE) {
					if (((Double) cws.getQoSValue(property)) < ((Double) worstCandidate.getQoSValue(property))) {
						worstCandidate = cws;
					}
				} else {
					if (((Double) cws.getQoSValue(property)) > ((Double) worstCandidate.getQoSValue(property))) {
						worstCandidate = cws;
					}
				}
			}
			result.setSelectedService(aws, worstCandidate);
		}
		return result;
	}
}
