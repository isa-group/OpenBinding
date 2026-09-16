/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

/**
 *
 * @author japarejo
 */
public class Branch implements CompositeStructuralComponent {
    
    protected Map<StructuralComponent,Double> branches;    
    protected List<StructuralComponent> subComponents;
    public Branch()
    {
        branches=new HashMap<StructuralComponent,Double>();        
        subComponents=new LinkedList<StructuralComponent>();
    }
    
    
    public List<StructuralComponent> getSubComponents() {
        return subComponents;
    }
    
    public void addBranch(StructuralComponent body, Double probability)
    {     
        /*double scalingFactor=1.0/(1.0+probability.doubleValue());
        Double auxProbability=null;
        for(StructuralComponent branch:branches.keySet())
        {
            auxProbability=branches.get(branch);
            branches.put(branch,auxProbability.doubleValue()*scalingFactor);
        }
        if(subComponents.size()==0)
            branches.put(body,1.0);                
        else*/
        branches.put(body, probability);
        subComponents.add(body);
    }
    
    public void removeBrach(StructuralComponent body)            
    {
        if(hasBranch(body))
        {
            Double probability=branches.get(body);                          
            branches.remove(body);            
            subComponents.remove(body);
            if(probability.doubleValue()!=1.0)
            {
                double scalingFactor=1.0/(1.0-probability.doubleValue());
                for(StructuralComponent branch:branches.keySet())
                {
                    probability=branches.get(branch);
                    branches.put(branch,probability.doubleValue()*scalingFactor);
                }
            }            
        }
    }
    
    public int numberOfBranches()
    {
        return subComponents.size();
    }

    private boolean hasBranch(StructuralComponent body) {
        return subComponents.contains(body);
    }
        
    
    public Double getBranchProbability(StructuralComponent body)            
    {
        Double result=new Double(0);
        if(hasBranch(body))
            result=branches.get(body);
        return result;
    }

    
    public Double getPonderation(StructuralComponent subcomponent) {
        return getBranchProbability(subcomponent);
    }

    
    public String toStructuralString(String prefix) {
        String newline = System.getProperty("line.separator");
        StringBuffer buffer=new StringBuffer(prefix+"BRANCH(");
        for(StructuralComponent subComponent:subComponents)
            buffer.append(branches.get(subComponent)+";");
        buffer.append(")["+newline);
        String myprefix=prefix+"      ";
        for(StructuralComponent subComponent:subComponents)
            buffer.append(subComponent.toStructuralString(myprefix)+newline+prefix+","+newline);
        buffer.append(prefix+"]");
        return buffer.toString();    
    }

    @Override
    public String toString()
    {
        return toStructuralString("");
    }


	public boolean isEmpty() {
		boolean result=true;
		for(StructuralComponent branch:subComponents){
			if(!branch.isEmpty()){
				result=false;
				break;
			}
		}
		return result;
	}
    
    /*@Override
    public void buildEvaluationMap(Map<List<AbstractWebService>, Double> evaluationMap, Double currentValue) {
        StructuralComponent component=null;
        double probability=0;
        for(String branchname:branches.keySet())
        {
            component=branches.get(branchname);
            probability=probabilities.get(branchname);
            if(component instanceof CompositeStructuralComponent)
                ((CompositeStructuralComponent)component).buildEvaluationMap(evaluationMap, probability*currentValue.doubleValue());
            else{
                List<AbstractWebService> services=new ArrayList<AbstractWebService>(1);
                services.add((AbstractWebService)component);
                evaluationMap.put(services,currentValue);
            }
        }
    }*/
    
}
