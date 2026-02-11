package es.us.isa.qosawarewsbinding.api.mapping;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;

import java.util.Map;
import java.util.Set;

public class ProblemBuildResult {
    public final QoSAwareWSCompositionProblem problem;
    public final WSCompositionStructure structure;
    public final WSCompositionQoSModel qosModel;
    public final Map<String, AbstractWebService> taskMap;
    public final Map<String, QoSProperty<Double>> propertyMap;
    public final Map<AbstractWebService, Set<ConcreteWebService>> market;

    public ProblemBuildResult(
            QoSAwareWSCompositionProblem problem,
            WSCompositionStructure structure,
            WSCompositionQoSModel qosModel,
            Map<String, AbstractWebService> taskMap,
            Map<String, QoSProperty<Double>> propertyMap,
            Map<AbstractWebService, Set<ConcreteWebService>> market
    ) {
        this.problem = problem;
        this.structure = structure;
        this.qosModel = qosModel;
        this.taskMap = taskMap;
        this.propertyMap = propertyMap;
        this.market = market;
    }
}
