/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.solution.vector;


/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionVectorMovement {

    private int abstractWebService;
    private int previousSelectedService;
    private int newSelectedService;
    
    public QoSAwareWSCompositionVectorMovement(QoSAwareWSCompositionVectorSolutionNavigable solution) 
    {        
        
	QoSAwareWSCompositionProblemInteger problem=(QoSAwareWSCompositionProblemInteger)solution.getProblem();
        int services=problem.getMarket().keySet().size();
	while(abstractWebService<services && problem.numberOfCandidates(abstractWebService)<2)
				abstractWebService++;		
	previousSelectedService=solution.getSelectedService(abstractWebService);
	newSelectedService=0;		
	if(previousSelectedService==newSelectedService)
			newSelectedService=1;		
    }
    
    public QoSAwareWSCompositionVectorMovement(int abstractWebService, int previousSelectedService, int newSelectedService)
    {
        this.abstractWebService=abstractWebService;
        this.newSelectedService=newSelectedService;
        this.previousSelectedService=previousSelectedService;
    }
    
    private QoSAwareWSCompositionVectorMovement(QoSAwareWSCompositionVectorMovement value)
    {
        this.abstractWebService=value.abstractWebService;
        this.previousSelectedService=value.previousSelectedService;
        this.newSelectedService=value.newSelectedService;
                
    }

    public int getAbstractWebService() {
        return abstractWebService;
    }

    public int getNewConcreteService() {
        return newSelectedService;
    }
    
    public int getPreviousConcreteService()
    {
        return previousSelectedService;
    }
    
     @Override
     public boolean equals(Object o)
     {
        boolean result=false;
        if(o instanceof QoSAwareWSCompositionVectorMovement)
        {
            QoSAwareWSCompositionVectorMovement move=(QoSAwareWSCompositionVectorMovement)o;
            result=(this.abstractWebService==move.abstractWebService && this.previousSelectedService==move.previousSelectedService && this.newSelectedService==move.newSelectedService);
        }
        return result;
     }

    public QoSAwareWSCompositionVectorMovement nextMovement(QoSAwareWSCompositionVectorSolutionNavigable solution) 
    {
        QoSAwareWSCompositionVectorMovement result=new QoSAwareWSCompositionVectorMovement(this);
	QoSAwareWSCompositionProblemInteger problem=(QoSAwareWSCompositionProblemInteger)solution.getProblem();
        int services=problem.getMarket().keySet().size();		
        result.newSelectedService++;	        
	if(result.newSelectedService>=problem.numberOfCandidates(result.abstractWebService)){			
            result.abstractWebService++;
            if(result.abstractWebService==services){
		result.abstractWebService=0;
            }
            while(result.abstractWebService<abstractWebService && problem.numberOfCandidates(result.abstractWebService)<=1)
		result.abstractWebService++;	
            result.newSelectedService=0;                        
            if(result.previousSelectedService==result.newSelectedService && problem.numberOfCandidates(result.abstractWebService)>1)
                result.newSelectedService=1;                            
	}			
	result.previousSelectedService=solution.getSelectedService(result.abstractWebService);
	return result;
    }
    
    @Override
    public String toString()
    {
        return "["+abstractWebService+","+previousSelectedService+","+newSelectedService+"]";
    }

}
