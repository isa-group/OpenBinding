/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem.model;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionProblemConstraintsModel {
    private GlobalQoSConstraintsModel globalConstraintsModel;
    private ServiceDependencesConstraintsModel serviceDependencesConstraintsModel;
    
    public QoSAwareWSCompositionProblemConstraintsModel(GlobalQoSConstraintsModel globalConstraintsModel,ServiceDependencesConstraintsModel serviceDependencesConstraintsModel)
    {
        this.globalConstraintsModel=globalConstraintsModel;
        this.serviceDependencesConstraintsModel=serviceDependencesConstraintsModel;
    }
    
    public GlobalQoSConstraintsModel getGlobalConstraintsModel() {
        return globalConstraintsModel;
    }

    public ServiceDependencesConstraintsModel getServiceDependencesConstraintsModel() {
        return serviceDependencesConstraintsModel;
    }
    
    @Override
    public String toString()
    {
        StringBuffer buffer=new StringBuffer("ConstraintsModel(\n");
        buffer.append(globalConstraintsModel+"\n");
        buffer.append(serviceDependencesConstraintsModel+"\n");
        buffer.append(";");
        return buffer.toString();
    }
}
