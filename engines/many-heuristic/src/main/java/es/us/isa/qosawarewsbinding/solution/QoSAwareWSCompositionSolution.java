/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.solution;

import java.util.Map;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;

/**
 * 
 * @author japarejo
 */
public abstract class QoSAwareWSCompositionSolution extends
		AbstractSolution<QoSAwareWSCompositionProblem> {

	public QoSAwareWSCompositionSolution(QoSAwareWSCompositionProblem problem) {
		super(problem);
	}

	public abstract ConcreteWebService getSelectedService(AbstractWebService aws);

	public abstract void setSelectedService(AbstractWebService aws,
			ConcreteWebService cws);

	public boolean isUsingServices(
			Map<AbstractWebService, ConcreteWebService> cwservices) {
		boolean result = true;
		int i = 0;
		for (AbstractWebService aws : cwservices.keySet()) {
			if (!isUsing(aws, cwservices.get(aws)))
				return false;
		}
		return result;
	}

	public boolean isUsing(AbstractWebService aws, ConcreteWebService cws) {
		return cws == getSelectedService(aws);
	}

	@Override
	public String toString() {
		StringBuffer buffer = new StringBuffer("(");
		QoSAwareWSCompositionProblem myproblem = (QoSAwareWSCompositionProblem) problem;
		for (AbstractWebService aws : myproblem.getStructure().getComponents()) {
			buffer.append("|");
			buffer.append(aws.toString());
			buffer.append("->");
			buffer.append(getSelectedService(aws));
			buffer.append("|");
		}
		buffer.append("),");
		buffer.append(super.toString());
		return buffer.toString();
	}
}
