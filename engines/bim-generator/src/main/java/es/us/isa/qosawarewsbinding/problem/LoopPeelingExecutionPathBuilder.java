/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.Branch;
import es.us.isa.qosawarewsbinding.Loop;
import es.us.isa.qosawarewsbinding.Sequence;
import es.us.isa.qosawarewsbinding.StructuralComponent;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;

/**
 *
 * @author japarejo
 */
public class LoopPeelingExecutionPathBuilder implements ExecutionPathsBuilder {
    
    public Set<ExecutionPath> buildPaths(QoSAwareWSCompositionProblem aThis) {
        Set<ExecutionPath> execPaths=new HashSet<ExecutionPath>();
        buildPaths(aThis.getStructure(),execPaths,aThis);
        return execPaths;
    }

    private void buildPaths(WSCompositionStructure structure, Set<ExecutionPath> execPaths, QoSAwareWSCompositionProblem aThis) {
        List<AbstractWebService> previous=new LinkedList<AbstractWebService>();
        List<StructuralComponent> components=((Sequence)structure.getStructure()).getSubComponents();
        buildPaths(previous,components,0,1.0,execPaths,aThis);
    }

    private void buildPaths(List<AbstractWebService> previous, List<StructuralComponent> components, int i, double d, Set<ExecutionPath> execPaths, QoSAwareWSCompositionProblem aThis) {
        if(i<components.size())
        {
            StructuralComponent comp=components.get(i);
            if(comp instanceof AbstractWebService)
            {
                previous.add((AbstractWebService)comp);
                buildPaths(previous,components,i+1,d,execPaths,aThis);
                previous.remove(comp);
            }else if(comp instanceof Sequence)
            {
                List<StructuralComponent> subComponents=((Sequence)comp).getSubComponents();
                List<StructuralComponent> newComponents=createComponentsSec(subComponents,components,1,i);
                buildPaths(previous,newComponents,i,d,execPaths,aThis);
            }else if(comp instanceof Loop){
                List<StructuralComponent> subComponents=((Loop)comp).getSubComponents();                
                List<StructuralComponent> newComponents=null;
                for(int j=0;j<=((Loop)comp).getAverageNumberOfIterations();j++){
                    newComponents=createComponentsLoops(subComponents,components,j,i);
                    buildPaths(previous,newComponents,i,d,execPaths,aThis);
                }
            }else if(comp instanceof Branch)
            {
                for(StructuralComponent sc:((Branch)comp).getSubComponents())
                {
                    components.set(i, sc);
                    buildPaths(previous,components,i,d*((Branch)comp).getBranchProbability(sc),execPaths,aThis);
                }
            }            
        }else{
            execPaths.add(new ExecutionPath(aThis, previous,d));        
        }
    }

    private List<StructuralComponent> createComponentsLoops(List<StructuralComponent> subComponents, List<StructuralComponent> components, int i, int j) {
        List<StructuralComponent> result=new LinkedList<StructuralComponent>();
        for(int k=0;k<i;k++)
        {
            result.add(components.get(k));
        }
        
        Branch b=new Branch();
        Branch childBranch=null;
        Sequence auxBranch=null;        
        Sequence voidSec=new Sequence();
        result.add(b);
        double branchProb=0.5;
        for(int k=0;k<j;k++)
        {            
            auxBranch=new Sequence();
            auxBranch.getSubComponents().addAll(subComponents);            
            b.addBranch(voidSec, branchProb);
            b.addBranch(auxBranch, 1.0-branchProb);
            childBranch=new Branch();
            auxBranch.getSubComponents().add(childBranch);
            b=childBranch;
        }
        for(int k=i+1;k<components.size();k++)
        {            
            result.add(components.get(k));
        }
        return result;
    }

    private List<StructuralComponent> createComponentsSec(List<StructuralComponent> subComponents, List<StructuralComponent> components, int i, int j) {
        List<StructuralComponent> result=new LinkedList<StructuralComponent>();
        for(int k=0;k<i;k++)
        {
            result.add(components.get(k));
        }
        for(int k=0;k<j;k++)
        {
            result.addAll(subComponents);
        }
        for(int k=i+1;k<components.size();k++)
        {            
            result.add(components.get(k));
        }
        return result;
    }

}
