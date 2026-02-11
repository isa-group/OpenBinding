/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.io.Serializable;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;

/**
 *
 * @author japarejo
 */
public class WSCompositionStructure implements Serializable{
    protected Set<AbstractWebService> components;
    protected StructuralComponent structure;
    protected double numberOfexecutedTasks;
    
    public WSCompositionStructure(StructuralComponent structure)
    {
        this.structure=structure;
        components=new HashSet<AbstractWebService>();
        createComponents();
        numberOfexecutedTasks=numberOfExecutedTasks(structure);
    }

    public Set<AbstractWebService> getComponents() {
        return components;
    }

    public StructuralComponent getStructure() {
        return structure;
    }

    public int maxNestingLevel() {
        return computeMaxNestingLevel(structure);
    }

    private int NBuildingBlocks(Class<Loop> aClass, StructuralComponent structure) {
        int result=0;
        if(structure instanceof CompositeStructuralComponent)
        {
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)structure;
            for(StructuralComponent subComponent:compositeComponent.getSubComponents())
            {
                result+=NBuildingBlocks(aClass, subComponent);
            }
            if(structure.getClass().equals(aClass))
                result++;
        }
        return result;
    }

    private void addComponent(StructuralComponent structure) {        
        if(structure instanceof AbstractWebService)
            components.add((AbstractWebService) structure);
        else if (structure instanceof EmptyComponent) {
            // Do nothing, no AbstractWebService here
        } else if (structure instanceof CompositeStructuralComponent) {
            Collection<StructuralComponent> subcomponents=((CompositeStructuralComponent)structure).getSubComponents();
            for(StructuralComponent subcomponent:subcomponents)
                addComponent(subcomponent);
        }        
    }

    private int computeMaxNestingLevel(StructuralComponent structure) {
        int result=0;
        int auxNestingLevel;
        if(structure instanceof CompositeStructuralComponent)
        {
            result=1;
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)structure;
            for(StructuralComponent subComponent:compositeComponent.getSubComponents())
            {
                if(subComponent instanceof Sequence)
                    auxNestingLevel=computeMaxNestingLevel(subComponent);
                else
                    auxNestingLevel=1+computeMaxNestingLevel(subComponent);
                if(auxNestingLevel>result)
                    result=auxNestingLevel;
            }
        }
        return result;
    }

    private void createComponents() {
        addComponent(structure);
    }
    
    public int computeCyclomaticComplexity()
    {
        return computeCyclomaticComplexity(structure)+1;
    }
    
    public int computeMaxNesting()
    {
        return computeMaxNestingLevel(structure);
    }
    
    public int numberOfActivities()
    {
        return numberOfActivities(structure);
    }
    
    private int computeCyclomaticComplexity(StructuralComponent component)
    {
        int result=0;
        if(component instanceof CompositeStructuralComponent)
        {
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)component;
            if(compositeComponent instanceof Loop){
                result=1;
                for(StructuralComponent subComponent:compositeComponent.getSubComponents())
                {
                    result+=computeCyclomaticComplexity(subComponent);
                }
            }else if(compositeComponent instanceof Branch){
                result=compositeComponent.getSubComponents().size()-1;
                for(StructuralComponent subComponent:compositeComponent.getSubComponents())
                {
                    result+=computeCyclomaticComplexity(subComponent);
                }
            }else if(compositeComponent instanceof Flow){
                result=compositeComponent.getSubComponents().size()-1;
                for(StructuralComponent subComponent:compositeComponent.getSubComponents())
                {
                    result+=computeCyclomaticComplexity(subComponent);
                }
            }else if(component instanceof Sequence){
                for(StructuralComponent subComponent:compositeComponent.getSubComponents())
                {
                    result+=computeCyclomaticComplexity(subComponent);
                }
            }
        }
        return result;
    }

    private int numberOfActivities(StructuralComponent structure) {
        int result=1;
        if(structure instanceof CompositeStructuralComponent)
        {
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)structure;
            for(StructuralComponent subComponent:compositeComponent.getSubComponents())
            {
                    result+=numberOfActivities(subComponent);
            }
            if(structure instanceof Sequence)
                result=result-1;
            if(structure instanceof Flow)
                result=result-1;
        }
        return result;
    }

    private double numberOfExecutedTasks(StructuralComponent structure) {
        double result=0;
        if(structure instanceof CompositeStructuralComponent)
        {
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)structure;
            for(StructuralComponent subComponent:compositeComponent.getSubComponents())
            {
                    if(subComponent instanceof AbstractWebService)
                        result+=compositeComponent.getPonderation(subComponent);
                    else
                        result+=numberOfExecutedTasks(subComponent)*compositeComponent.getPonderation(subComponent);
            }            
        } else if (structure instanceof EmptyComponent) {
            result = 0;
        }else
            result=1;
        return result;
    }
    
    private int numberOfTaskActivities(StructuralComponent structure)
    {
        int result=0;
        if(structure instanceof CompositeStructuralComponent)
        {
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)structure;
            for(StructuralComponent subComponent:compositeComponent.getSubComponents())
            {
                    if(subComponent instanceof CompositeStructuralComponent)
                        result+=numberOfTaskActivities(subComponent);
                    else
                        result++;
            }            
        }else{
            result=1;
        }
        return result;
    }
    
    public double perecentageOfControlFlowActivities()
    {
        double percentageOfTaskActivities=((double)(numberOfTaskActivities(structure)))/((double)(numberOfActivities(structure)));
        return 1.0 - percentageOfTaskActivities;
    }
    
    public double numberOfExecutedTasks()
    {        
        if(numberOfexecutedTasks==Double.MIN_VALUE)
         numberOfexecutedTasks=numberOfExecutedTasks(structure);
        return numberOfexecutedTasks;
    }
            
    public double percentageOfLoops()
    {
        double result=0;
        double nloops=(double)NBuildingBlocks(Loop.class, structure);
        result=nloops/((double)(numberOfActivities(structure)-numberOfTaskActivities(structure)));
        return result;
    }
    public double averageIterationsPerLoop()
    {
        double nloops=(double)NBuildingBlocks(Loop.class, structure);
        double nTotalIterations=(double)NtotalIterations(structure);
        return nTotalIterations/nloops;
    }
    public double NtotalIterations(StructuralComponent structure)
    {
        double result=0;
        if(structure instanceof CompositeStructuralComponent)
        {
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)structure;
            for(StructuralComponent subComponent:compositeComponent.getSubComponents())
            {
                result+=NtotalIterations(subComponent);
            }
            if(structure instanceof Loop)
                result+=((Loop)structure).getAverageNumberOfIterations();
        }
        return result;
    }
}
