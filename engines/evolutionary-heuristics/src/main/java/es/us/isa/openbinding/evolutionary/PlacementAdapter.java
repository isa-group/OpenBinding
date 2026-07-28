package es.us.isa.openbinding.evolutionary;

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
 * <p>An instance without those blocks produces an empty placement, which is
 * what lets the problem definition run unchanged on plain binding problems.
 */
final class PlacementAdapter {

  private PlacementAdapter() {}

  static ApiModels.Placement from(Map<String, Object> instance) {
    PlacementModel model = new PlacementModel(instance);
    ApiModels.Placement placement = new ApiModels.Placement();

    placement.pool_of_candidate = new LinkedHashMap<>(model.poolOfCandidate());
    placement.demand_of_candidate = new LinkedHashMap<>(model.demandOfCandidate());

    for (PlacementModel.Pool pool : model.pools()) {
      ApiModels.Pool dto = new ApiModels.Pool();
      dto.id = pool.id;
      dto.kind = pool.kind;
      dto.capacity = new LinkedHashMap<>(pool.capacity);
      placement.pools.add(dto);
    }

    for (PlacementModel.CapacityConstraint constraint : model.capacityConstraints()) {
      ApiModels.PlacementResourceConstraint dto = new ApiModels.PlacementResourceConstraint();
      dto.id = constraint.id;
      dto.hard = constraint.hard;
      dto.resources = new ArrayList<>(constraint.resources);
      dto.pools = new ArrayList<>(constraint.pools);
      placement.resource_constraints.add(dto);
    }

    placement.latency_matrix = new LinkedHashMap<>(model.latencyMatrix());
    placement.event_latency = new LinkedHashMap<>(model.eventLatency());
    placement.event_pools = new LinkedHashMap<>(model.eventPools());

    for (PlacementModel.Transition transition : model.transitions()) {
      ApiModels.PlacementTransition dto = new ApiModels.PlacementTransition();
      dto.id = transition.id;
      dto.hard = transition.hard;
      dto.from_task = transition.fromTask;
      dto.from_event = transition.fromEvent;
      dto.to_task = transition.toTask;
      dto.op = transition.op;
      dto.value = transition.value;
      placement.transitions.add(dto);
    }

    PlacementModel.GlobalLatency globalLatency = model.globalLatency();
    if (globalLatency != null) {
      ApiModels.E2eModel e2e = new ApiModels.E2eModel();
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

  private static ApiModels.E2eScenario toDto(PlacementModel.Scenario scenario) {
    ApiModels.E2eScenario dto = new ApiModels.E2eScenario();
    dto.prob = scenario.prob;
    dto.order = new ArrayList<>(scenario.order);
    dto.sinks = new ArrayList<>(scenario.sinks);
    for (Map.Entry<String, List<PlacementModel.Source>> entry : scenario.preds.entrySet()) {
      List<List<String>> sources = new ArrayList<>();
      for (PlacementModel.Source source : entry.getValue()) {
        sources.add(new ArrayList<>(List.of(source.kind, source.id)));
      }
      dto.preds.put(entry.getKey(), sources);
    }
    return dto;
  }
}
