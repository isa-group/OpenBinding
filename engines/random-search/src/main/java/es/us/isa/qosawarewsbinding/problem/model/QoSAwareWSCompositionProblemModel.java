/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem.model;

import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;

/**
 *
 * @author japarejo
 */
public class QoSAwareWSCompositionProblemModel extends ProblemModel<QoSAwareWSCompositionProblem> {
    private QoSAwareWSCompositionProblemStructuralModel structuralModel;
    private QoSAwareWSCompositionProblemQoSModel qosModel;
    private QoSAwareWSCompositionProblemServicesMarketModel marketModel;
    private QoSAwareWSCompositionProblemConstraintsModel constraintsModel;

    public QoSAwareWSCompositionProblemModel(QoSAwareWSCompositionProblemStructuralModel structuralModel, QoSAwareWSCompositionProblemQoSModel qosModel,QoSAwareWSCompositionProblemServicesMarketModel marketModel,QoSAwareWSCompositionProblemConstraintsModel constraintsModel)
    {
        this.structuralModel=structuralModel;
        this.marketModel=marketModel;
        this.qosModel=qosModel;
        this.constraintsModel=constraintsModel;
    }
    
    public QoSAwareWSCompositionProblemStructuralModel getStructuralModel() {
        return structuralModel;
    }

    public QoSAwareWSCompositionProblemQoSModel getQosModel() {
        return qosModel;
    }

    public QoSAwareWSCompositionProblemServicesMarketModel getMarketModel() {
        return marketModel;
    }

    public QoSAwareWSCompositionProblemConstraintsModel getConstraintsModel() {
        return constraintsModel;
    }
    
    @Override
    public String toString()
    {
        StringBuffer buffer=new StringBuffer("=== QOS-aware Web Service Composition Problem Model ===\n");
        buffer.append("== Structural Model ==\n");
        buffer.append(structuralModel);
        buffer.append("== QoS Model ==\n");
        if(qosModel!=null)
            buffer.append(qosModel);
        buffer.append("== Market Model ==\n");
        buffer.append(marketModel);
        buffer.append("== Constraints Model ==\n");
        if(constraintsModel!=null)
            buffer.append(constraintsModel);
        buffer.append("=======================================================\n");
        return buffer.toString();
    }
    
}
