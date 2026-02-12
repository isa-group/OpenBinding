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
public class Loop implements CompositeStructuralComponent {
    
    private int averageNumberOfIterations;    
    protected List<StructuralComponent> subComponents;
    public Loop(int averageNumberOfIterations)
    {
        this(averageNumberOfIterations,null);                
    }
    public Loop(int averageNumberOfIterations, StructuralComponent component){
        this.averageNumberOfIterations=averageNumberOfIterations;
        subComponents=new LinkedList<StructuralComponent>();
        if(component!=null)
            subComponents.add(component);            
    }

    
    public List<StructuralComponent> getSubComponents() {
        return subComponents;
    }

    public int getAverageNumberOfIterations() {
        return averageNumberOfIterations;
    }

    public void setAverageNumberOfIterations(int averageNumberOfIterations) {
        this.averageNumberOfIterations = averageNumberOfIterations;
    }

    
    public Double getPonderation(StructuralComponent subcomponent) {
        return (double)averageNumberOfIterations;
    }

    
    public String toStructuralString(String prefix) {
        String newline = System.getProperty("line.separator");
        StringBuffer buffer=new StringBuffer(prefix+"LOOP("+averageNumberOfIterations+")[");
        String myprefix=prefix+"      ";
        if(subComponents.size()>0)
        {
            if(!(subComponents.get(0) instanceof AbstractWebService))
                buffer.append(newline);
        }
        for(StructuralComponent subComponent:subComponents){
            if(subComponent instanceof CompositeStructuralComponent)
                buffer.append(newline+subComponent.toStructuralString(myprefix)+newline+prefix+",");
            else
                buffer.append(subComponent.toStructuralString("")+",");
        }
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

    /*@Override
    public void buildEvaluationMap(Map<List<AbstractWebService>, Double> evaluationMap, Double currentValue) {
        List<AbstractWebService> services=new LinkedList<AbstractWebService>();
        for(StructuralComponent component:subComponents)
        {
            if(component instanceof AbstractWebService)
            {
                services.add((AbstractWebService)component);
            }else
                ((CompositeStructuralComponent)component).buildEvaluationMap(evaluationMap,currentValue*averageNumberOfIterations);
        }
        if(services.size()>0)
            evaluationMap.put(services, currentValue*averageNumberOfIterations);
    }*/
    @Override
    public String toString()
    {
        return toStructuralString("");
    }
}
