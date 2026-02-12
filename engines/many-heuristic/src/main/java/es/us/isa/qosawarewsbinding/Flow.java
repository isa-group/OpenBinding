/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.util.List;

/**
 *
 * @author japarejo
 */
public class Flow implements CompositeStructuralComponent {
    
    private List<StructuralComponent> subcomponents;

    public Flow() {
        subcomponents = new java.util.LinkedList<StructuralComponent>();
    }
    
    public List<StructuralComponent> getSubComponents() {
        return subcomponents;
    }

    
    public Double getPonderation(StructuralComponent subcomponent) {
        return 1.0;
    }

    
    public String toStructuralString(String prefix) {
        String newline = System.getProperty("line.separator");
        StringBuffer buffer=new StringBuffer(prefix+"FLOW["+newline);
        String myprefix=prefix+"  ||=>";
        for(StructuralComponent subComponent:subcomponents)
            buffer.append(subComponent.toStructuralString(myprefix)+",");
        buffer.append("]");
        return buffer.toString();
    }
    
    public boolean isEmpty() {
    	boolean result=true;
		for(StructuralComponent branch:subcomponents){
			if(!branch.isEmpty()){
				result=false;
				break;
			}
		}
		return result;
	}

    /*@Override
    public void buildEvaluationMap(Map<List<AbstractWebService>, Double> evaluationMap, Double currentValue) {
        List<AbstractWebService> services=new LinkedList<AbstractWebService>();
        for(StructuralComponent component:subcomponents)
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
}
