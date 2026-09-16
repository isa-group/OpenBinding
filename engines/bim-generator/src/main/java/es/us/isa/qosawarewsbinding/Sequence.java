/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.util.LinkedList;
import java.util.List;

/**
 *
 * @author japarejo
 */
public class Sequence implements CompositeStructuralComponent {
    protected List<StructuralComponent> subComponents;
    public Sequence()
    {
        subComponents=new LinkedList<StructuralComponent>();
    }

    
    public List<StructuralComponent> getSubComponents() {
        return subComponents;
    }
    /*
    @Override
    public void buildEvaluationMap(Map<List<AbstractWebService>, Double> evaluationMap, Double currentValue) {
        List<AbstractWebService> services=new LinkedList<AbstractWebService>();
        for(StructuralComponent component:subComponents)
        {
            if(component instanceof AbstractWebService)
            {
                services.add((AbstractWebService)component);
            }else
                ((CompositeStructuralComponent)component).buildEvaluationMap(evaluationMap,currentValue);
        }
        if(services.size()>0)
            evaluationMap.put(services, currentValue);
    }*/

    
    public Double getPonderation(StructuralComponent subcomponent) {
        return 1.0;
    }
    
    @Override
    public String toString()
    {
        StringBuffer buffer=new StringBuffer("Sec[");        
        for(StructuralComponent subComponent:subComponents)
            buffer.append(subComponent.toString()+",");
        buffer.append("]");
        return buffer.toString();
    }

    
    public String toStructuralString(String prefix) {
        StringBuffer buffer=new StringBuffer(prefix+"SEC[");
        String newline = System.getProperty("line.separator");
        String myprefix=prefix+"    ";
        if(subComponents.size()>0)
        {
            if(!(subComponents.get(0) instanceof AbstractWebService))
                buffer.append(newline);
        }
        boolean newlinegenerated=false;
        for(StructuralComponent subComponent:subComponents)
            if(subComponent instanceof CompositeStructuralComponent){
                buffer.append(newline+subComponent.toStructuralString(myprefix)+newline+prefix+",");
                newlinegenerated=true;
            }else
                buffer.append(subComponent.toStructuralString("")+",");        
        buffer.append(newline+prefix+"]");        
        return buffer.toString();
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
    
    
    
}
