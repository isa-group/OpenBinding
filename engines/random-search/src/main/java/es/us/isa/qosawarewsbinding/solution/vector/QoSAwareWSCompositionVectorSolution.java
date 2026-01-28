/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.solution.vector;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.Solution;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionVectorSolution extends QoSAwareWSCompositionSolution {

    protected int[] selectedServicesIndexes;
    
    public QoSAwareWSCompositionVectorSolution(QoSAwareWSCompositionProblem problem)
    {
        super(problem);
        if(!(problem instanceof QoSAwareWSCompositionProblemInteger))
            this.problem=new QoSAwareWSCompositionProblemInteger(problem); 
        selectedServicesIndexes=new int[problem.getMarket().keySet().size()];
        //for(int i=0;i<selectedServicesIndexes.length;i++)
        //    selectedServicesIndexes[i]=0;            
    }
    public QoSAwareWSCompositionVectorSolution(QoSAwareWSCompositionVectorSolution solution)
    {
        this((QoSAwareWSCompositionProblem)solution.getProblem());
        assign(solution);
    }
    @Override
    public ConcreteWebService getSelectedService(AbstractWebService aws) {
        int awsIndex=getIntegerProblem().getIndex(aws);
        return getIntegerProblem().getService(awsIndex,selectedServicesIndexes[awsIndex]);
    }
    
    public int getSelectedService(int aws)
    {
        int result=-1;
        if(aws>=0 && aws<selectedServicesIndexes.length)
            result=selectedServicesIndexes[aws];
        return result;
    }
    
    public void setSelectedService(int aws, int cws)
    {
        selectedServicesIndexes[aws]=cws;
    }

    @Override
    public void setSelectedService(AbstractWebService aws, ConcreteWebService cws) {
        int awsIndex=getIntegerProblem().getIndex(aws);
        int serviceIndex=getIntegerProblem().getServiceIndex(awsIndex,cws);
        selectedServicesIndexes[awsIndex]=serviceIndex;        
    }
    
    public void updateFitness()
    {
        fitness=problem.fitness(this);
    }
    
    @Override
    public Solution createRandom() {
        QoSAwareWSCompositionVectorSolution result=new QoSAwareWSCompositionVectorSolution((QoSAwareWSCompositionProblem)problem);
        result.randomize();
        return result;
    }    
    
    private QoSAwareWSCompositionProblemInteger getIntegerProblem()
    {
        return (QoSAwareWSCompositionProblemInteger)problem;
    }
    
    protected void randomize()
    {
        for(int i=0;i<selectedServicesIndexes.length;i++)
            selectedServicesIndexes[i]=(int)Math.floor(Math.random()*(double)(getIntegerProblem().numberOfCandidates(i)));
    }
    
     public void assign(QoSAwareWSCompositionVectorSolution solution)
     {
         if(this.selectedServicesIndexes.length==solution.selectedServicesIndexes.length && this.problem==solution.problem)
            System.arraycopy(solution.selectedServicesIndexes, 0,this.selectedServicesIndexes, 0, selectedServicesIndexes.length);
     }
    
    @Override
     public String toString()
     {
         return super.toString();                 
     }
}
