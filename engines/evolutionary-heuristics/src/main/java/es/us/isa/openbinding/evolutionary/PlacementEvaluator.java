package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Evaluation of the BIM' placement semantics for a selected binding.
 *
 * <p>Mirrors the gateway reference evaluator
 * ({@code openbinding_gateway.validation.engine_plugins.bimstar}):
 * <ul>
 *   <li>End-to-end latency = expected (or worst-case) makespan over the XOR
 *       scenarios shipped in the placement payload, computed by critical-path
 *       scheduling over each scenario's precedence DAG.</li>
 *   <li>RESOURCE_CAPACITY dependency constraints: cumulative demand of
 *       selected candidates placed on a pool must fit its declared capacity,
 *       per resource.</li>
 *   <li>Transition latency constraints: pairwise bounds over the latency
 *       matrix (or event latency matrix for event-driven transitions).</li>
 * </ul>
 * Any divergence from the Python evaluator is a bug; the gateway re-validates
 * every returned solution against the reference implementation.
 */
final class PlacementEvaluator {

  record Violation(String constraintId, String message, double magnitude, boolean hard) {}

  private final Placement placement;
  private final Map<String, Pool> poolsById = new LinkedHashMap<>();

  PlacementEvaluator(Placement placement) {
    this.placement = placement;
    for (Pool pool : placement.pools) {
      poolsById.put(pool.id, pool);
    }
  }

  String e2eAttribute() {
    return placement.e2e != null ? placement.e2e.attribute_id : null;
  }

  boolean includeExecutionLatency() {
    return placement.e2e != null && placement.e2e.include_execution_latency_feature;
  }

  String poolOf(Candidate candidate) {
    return placement.pool_of_candidate.get(candidate.id);
  }

  double poolLatency(String poolA, String poolB) {
    Double value = lookup(placement.latency_matrix, poolA, poolB);
    if (value == null) {
      value = lookup(placement.latency_matrix, poolB, poolA);
    }
    if (value == null) {
      if (poolA != null && poolA.equals(poolB)) {
        return 0.0;
      }
      throw new IllegalArgumentException(
          "Missing pool latency entry for '" + poolA + "' -> '" + poolB + "'");
    }
    return value;
  }

  double eventLatency(String eventId, String poolB) {
    Double value = lookup(placement.event_latency, eventId, poolB);
    if (value == null) {
      String eventPool = placement.event_pools.get(eventId);
      if (eventPool != null) {
        return poolLatency(eventPool, poolB);
      }
      throw new IllegalArgumentException(
          "Missing event latency entry for '" + eventId + "' -> '" + poolB + "'");
    }
    return value;
  }

  private static Double lookup(Map<String, Map<String, Double>> matrix, String a, String b) {
    Map<String, Double> row = matrix.get(a);
    return row == null ? null : row.get(b);
  }

  /** Expected (or worst-case) makespan of the binding over the XOR scenarios. */
  double e2eLatency(Map<String, Candidate> selected) {
    if (placement.e2e == null) {
      return 0.0;
    }
    boolean worstCase =
        "WORST_CASE".equals(upper(placement.e2e.xor_semantics));
    String latAttr = placement.e2e.attribute_id;
    boolean includeExec = placement.e2e.include_execution_latency_feature;

    double expected = 0.0;
    double worst = 0.0;
    for (E2eScenario scenario : placement.e2e.scenarios) {
      Map<String, Double> finish = new LinkedHashMap<>();
      for (String taskId : scenario.order) {
        Candidate candidate = selected.get(taskId);
        String toPool = poolOf(candidate);
        double start = 0.0;
        for (List<String> source : scenario.preds.getOrDefault(taskId, List.of())) {
          String srcKind = source.get(0);
          String srcId = source.get(1);
          double ready;
          double transfer;
          if ("event".equals(srcKind)) {
            ready = 0.0;
            transfer = eventLatency(srcId, toPool);
          } else {
            ready = finish.get(srcId);
            transfer = poolLatency(poolOf(selected.get(srcId)), toPool);
          }
          start = Math.max(start, ready + transfer);
        }
        double exec = includeExec && latAttr != null
            ? candidate.features.getOrDefault(latAttr, 0.0)
            : 0.0;
        finish.put(taskId, start + exec);
      }
      List<String> sinks = scenario.sinks.isEmpty() ? scenario.order : scenario.sinks;
      double makespan = 0.0;
      for (String sink : sinks) {
        makespan = Math.max(makespan, finish.getOrDefault(sink, 0.0));
      }
      expected += scenario.prob * makespan;
      worst = Math.max(worst, makespan);
    }
    return worstCase ? worst : expected;
  }

  /** Capacity and transition violations for the binding (normalized magnitudes). */
  List<Violation> check(Map<String, Candidate> selected) {
    List<Violation> violations = new ArrayList<>();

    // RESOURCE_CAPACITY dependency: accumulate demands per pool over all selected candidates.
    Map<String, Map<String, Double>> usage = new LinkedHashMap<>();
    for (Candidate candidate : selected.values()) {
      String pool = poolOf(candidate);
      if (pool == null) {
        continue;
      }
      Map<String, Double> demand = placement.demand_of_candidate.get(candidate.id);
      if (demand == null) {
        continue;
      }
      Map<String, Double> poolUsage = usage.computeIfAbsent(pool, ignored -> new LinkedHashMap<>());
      for (Map.Entry<String, Double> entry : demand.entrySet()) {
        poolUsage.merge(entry.getKey(), entry.getValue(), Double::sum);
      }
    }

    for (PlacementResourceConstraint constraint : placement.resource_constraints) {
      for (String poolId : constraint.pools) {
        Pool pool = poolsById.get(poolId);
        Map<String, Double> poolUsage = usage.get(poolId);
        if (pool == null || poolUsage == null) {
          continue;
        }
        for (String resource : constraint.resources) {
          Double capacity = pool.capacity.get(resource);
          if (capacity == null) {
            continue; // undeclared capacity = unconstrained
          }
          double used = poolUsage.getOrDefault(resource, 0.0);
          if (used > capacity + 1e-6) {
            violations.add(new Violation(
                constraint.id,
                "Pool '" + poolId + "' exceeds capacity of '" + resource + "' ("
                    + used + " > " + capacity + ")",
                (used - capacity) / Math.max(1.0, capacity),
                constraint.isHard()));
          }
        }
      }
    }

    // Transition latency constraints.
    for (PlacementTransition transition : placement.transitions) {
      Candidate toCandidate = selected.get(transition.to_task);
      if (toCandidate == null) {
        continue;
      }
      String toPool = poolOf(toCandidate);
      double current;
      if (transition.from_event != null) {
        current = eventLatency(transition.from_event, toPool);
      } else {
        Candidate fromCandidate = selected.get(transition.from_task);
        if (fromCandidate == null) {
          continue;
        }
        current = poolLatency(poolOf(fromCandidate), toPool);
      }
      double magnitude = boundViolation(current, transition.op, transition.value);
      if (magnitude > 0.0) {
        violations.add(new Violation(
            transition.id,
            "Transition latency to task '" + transition.to_task + "' violated ("
                + current + " " + transition.op + " " + transition.value + ")",
            magnitude,
            transition.isHard()));
      }
    }

    return violations;
  }

  private double boundViolation(double current, String op, Object value) {
    if ("IN_RANGE".equals(upper(op)) && value instanceof Map<?, ?> map) {
      double min = ((Number) map.get("min")).doubleValue();
      double max = ((Number) map.get("max")).doubleValue();
      double raw = current < min ? min - current : Math.max(0.0, current - max);
      return raw / Math.max(1.0, Math.abs(max));
    }
    if (!(value instanceof Number number)) {
      return 0.0;
    }
    double target = number.doubleValue();
    double raw = switch (op == null ? "<=" : op) {
      case "<=" -> Math.max(0.0, current - target);
      case "<" -> current < target ? 0.0 : current - target + 1e-12;
      case ">=" -> Math.max(0.0, target - current);
      case ">" -> current > target ? 0.0 : target - current + 1e-12;
      case "==" -> Math.abs(current - target);
      default -> 0.0;
    };
    return raw / Math.max(1.0, Math.abs(target));
  }

  private static String upper(String value) {
    return value == null ? "" : value.toUpperCase(Locale.ROOT);
  }
}
