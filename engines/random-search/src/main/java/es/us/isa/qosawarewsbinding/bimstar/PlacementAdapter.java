package es.us.isa.qosawarewsbinding.bimstar;

import es.us.isa.openbinding.core.PlacementModel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds this engine's placement view from the instance it was given.
 *
 * <p>The gateway used to precompute this and ship it alongside the instance;
 * the derivation now happens here, from {@code resource_model} and
 * {@code latency_model}, using the semantics shared with every other engine.
 *
 * <p>An instance without those blocks produces an empty placement: no pools,
 * no capacity checks, no transitions and no end-to-end latency, which is what
 * lets the evaluator run unchanged on plain binding problems.
 */
public final class PlacementAdapter {

    private PlacementAdapter() {
    }

    public static BimStarModels.Placement from(Map<String, Object> instance) {
        PlacementModel model = new PlacementModel(instance);
        BimStarModels.Placement placement = new BimStarModels.Placement();

        placement.pool_of_candidate = new LinkedHashMap<String, String>(model.poolOfCandidate());
        placement.demand_of_candidate =
                new LinkedHashMap<String, Map<String, Double>>(model.demandOfCandidate());

        for (PlacementModel.Pool pool : model.pools()) {
            BimStarModels.Pool dto = new BimStarModels.Pool();
            dto.id = pool.id;
            dto.kind = pool.kind;
            dto.capacity = new LinkedHashMap<String, Double>(pool.capacity);
            placement.pools.add(dto);
        }

        for (PlacementModel.CapacityConstraint constraint : model.capacityConstraints()) {
            BimStarModels.PlacementResourceConstraint dto =
                    new BimStarModels.PlacementResourceConstraint();
            dto.id = constraint.id;
            dto.hard = Boolean.valueOf(constraint.hard);
            dto.resources = new ArrayList<String>(constraint.resources);
            dto.pools = new ArrayList<String>(constraint.pools);
            placement.resource_constraints.add(dto);
        }

        placement.latency_matrix =
                new LinkedHashMap<String, Map<String, Double>>(model.latencyMatrix());
        placement.event_latency =
                new LinkedHashMap<String, Map<String, Double>>(model.eventLatency());
        placement.event_pools = new LinkedHashMap<String, String>(model.eventPools());

        for (PlacementModel.Transition transition : model.transitions()) {
            BimStarModels.PlacementTransition dto = new BimStarModels.PlacementTransition();
            dto.id = transition.id;
            dto.hard = Boolean.valueOf(transition.hard);
            dto.from_task = transition.fromTask;
            dto.from_event = transition.fromEvent;
            dto.to_task = transition.toTask;
            dto.op = transition.op;
            dto.value = transition.value;
            placement.transitions.add(dto);
        }

        PlacementModel.GlobalLatency globalLatency = model.globalLatency();
        if (globalLatency != null) {
            BimStarModels.E2eModel e2e = new BimStarModels.E2eModel();
            e2e.attribute_id = globalLatency.attributeId;
            e2e.include_execution_latency_feature = globalLatency.includeExecutionLatencyFeature;
            e2e.xor_semantics = globalLatency.xorSemantics;
            for (PlacementModel.Scenario scenario : model.scenarios()) {
                e2e.scenarios.add(toDto(scenario));
            }
            placement.e2e = e2e;
        }

        return placement;
    }

    private static BimStarModels.E2eScenario toDto(PlacementModel.Scenario scenario) {
        BimStarModels.E2eScenario dto = new BimStarModels.E2eScenario();
        dto.prob = scenario.prob;
        dto.order = new ArrayList<String>(scenario.order);
        dto.sinks = new ArrayList<String>(scenario.sinks);
        for (Map.Entry<String, List<PlacementModel.Source>> entry : scenario.preds.entrySet()) {
            List<List<String>> sources = new ArrayList<List<String>>();
            for (PlacementModel.Source source : entry.getValue()) {
                List<String> pair = new ArrayList<String>(2);
                pair.add(source.kind);
                pair.add(source.id);
                sources.add(pair);
            }
            dto.preds.put(entry.getKey(), sources);
        }
        return dto;
    }
}
