package es.us.isa.qosawarewsbinding.api;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.HashMap;

import org.junit.Test;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.api.dto.SolveRequest;
import es.us.isa.qosawarewsbinding.api.mapping.ProblemBuildResult;
import es.us.isa.qosawarewsbinding.api.mapping.ProblemBuilder;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolution;

public class ControllerObjectiveValueTest {
    private static final String COST = "cost";
    private static final String RELIABILITY = "reliability";

    @Test
    public void testComputeObjectiveValueUsesConfiguredWeights() {
        SolveRequest request = new SolveRequest();
        request.id = "many-objective-test";

        request.composition = new SolveRequest.CompositionStructure();
        request.composition.type = "structured";
        request.composition.root = new SolveRequest.Node();
        request.composition.root.id = "root";
        request.composition.root.kind = "TASK";
        request.composition.root.task_id = "T1";

        request.features = new SolveRequest.QoSModel();
        request.features.properties = new HashMap<String, SolveRequest.QoSPropertyDef>();
        request.features.weights = new HashMap<String, Double>();
        request.features.aggregation = new HashMap<String, SolveRequest.AggregationPolicy>();

        SolveRequest.QoSPropertyDef cost = new SolveRequest.QoSPropertyDef();
        cost.direction = "minimize";
        cost.min = 0.0;
        cost.max = 100.0;
        request.features.properties.put(COST, cost);
        request.features.weights.put(COST, 0.25);

        SolveRequest.QoSPropertyDef reliability = new SolveRequest.QoSPropertyDef();
        reliability.direction = "maximize";
        reliability.min = 0.0;
        reliability.max = 100.0;
        request.features.properties.put(RELIABILITY, reliability);
        request.features.weights.put(RELIABILITY, 0.75);

        SolveRequest.AggregationPolicy costAggregation = new SolveRequest.AggregationPolicy();
        costAggregation.seq = "sum";
        costAggregation.flow = "sum";
        costAggregation.branch = "sum";
        costAggregation.loop = "sum";
        request.features.aggregation.put(COST, costAggregation);

        SolveRequest.AggregationPolicy reliabilityAggregation = new SolveRequest.AggregationPolicy();
        reliabilityAggregation.seq = "sum";
        reliabilityAggregation.flow = "sum";
        reliabilityAggregation.branch = "sum";
        reliabilityAggregation.loop = "sum";
        request.features.aggregation.put(RELIABILITY, reliabilityAggregation);

        request.market = new HashMap<String, SolveRequest.ServiceCandidates>();
        SolveRequest.ServiceCandidates serviceCandidates = new SolveRequest.ServiceCandidates();
        SolveRequest.Service service = new SolveRequest.Service();
        service.id = "cand_t1";
        service.name = "cand_t1";
        service.features = new HashMap<String, Double>();
        service.features.put(COST, 10.0);
        service.features.put(RELIABILITY, 90.0);
        serviceCandidates.services = Arrays.asList(service);
        request.market.put("T1", serviceCandidates);

        ProblemBuildResult mapped = new ProblemBuilder().build(request);
        QoSAwareWSCompositionVectorSolution solution = new QoSAwareWSCompositionVectorSolution(mapped.problem);

        AbstractWebService task = mapped.taskMap.get("T1");
        ConcreteWebService selected = mapped.market.get(task).iterator().next();
        solution.setSelectedService(task, selected);

        assertEquals(70.0, Controller.computeObjectiveValue(mapped, solution), 0.0001);
    }
}