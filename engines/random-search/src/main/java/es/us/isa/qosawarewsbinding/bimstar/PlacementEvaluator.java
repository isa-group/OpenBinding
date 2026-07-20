package es.us.isa.qosawarewsbinding.bimstar;

import es.us.isa.qosawarewsbinding.bimstar.BimStarModels.Candidate;
import es.us.isa.qosawarewsbinding.bimstar.BimStarModels.E2eScenario;
import es.us.isa.qosawarewsbinding.bimstar.BimStarModels.Placement;
import es.us.isa.qosawarewsbinding.bimstar.BimStarModels.PlacementResourceConstraint;
import es.us.isa.qosawarewsbinding.bimstar.BimStarModels.PlacementTransition;
import es.us.isa.qosawarewsbinding.bimstar.BimStarModels.Pool;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Evaluation of the BIM' placement semantics for a selected binding.
 *
 * <p>Kept in sync with the evolutionary engine's {@code PlacementEvaluator}
 * and the gateway reference evaluator
 * ({@code openbinding_gateway.validation.engine_plugins.bimstar}).
 * Written in Java 8 style: this engine builds with JDK 8.
 */
public final class PlacementEvaluator {

  public static final class Violation {
    private final String constraintId;
    private final String message;
    private final double magnitude;
    private final boolean hard;

    Violation(String constraintId, String message, double magnitude, boolean hard) {
      this.constraintId = constraintId;
      this.message = message;
      this.magnitude = magnitude;
      this.hard = hard;
    }

    public String constraintId() {
      return constraintId;
    }

    public String message() {
      return message;
    }

    public double magnitude() {
      return magnitude;
    }

    public boolean hard() {
      return hard;
    }
  }

  private final Placement placement;
  private final Map<String, Pool> poolsById = new LinkedHashMap<String, Pool>();

  public PlacementEvaluator(Placement placement) {
    this.placement = placement;
    for (Pool pool : placement.pools) {
      poolsById.put(pool.id, pool);
    }
  }

  public String e2eAttribute() {
    return placement.e2e != null ? placement.e2e.attribute_id : null;
  }

  public String poolOf(Candidate candidate) {
    return placement.pool_of_candidate.get(candidate.id);
  }

  public double poolLatency(String poolA, String poolB) {
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
    return value.doubleValue();
  }

  public double eventLatency(String eventId, String poolB) {
    Double value = lookup(placement.event_latency, eventId, poolB);
    if (value == null) {
      String eventPool = placement.event_pools.get(eventId);
      if (eventPool != null) {
        return poolLatency(eventPool, poolB);
      }
      throw new IllegalArgumentException(
          "Missing event latency entry for '" + eventId + "' -> '" + poolB + "'");
    }
    return value.doubleValue();
  }

  private static Double lookup(Map<String, Map<String, Double>> matrix, String a, String b) {
    Map<String, Double> row = matrix.get(a);
    return row == null ? null : row.get(b);
  }

  /** Expected (or worst-case) makespan of the binding over the XOR scenarios. */
  public double e2eLatency(Map<String, Candidate> selected) {
    if (placement.e2e == null) {
      return 0.0;
    }
    boolean worstCase = "WORST_CASE".equals(upper(placement.e2e.xor_semantics));
    String latAttr = placement.e2e.attribute_id;
    boolean includeExec = placement.e2e.include_execution_latency_feature;

    double expected = 0.0;
    double worst = 0.0;
    for (E2eScenario scenario : placement.e2e.scenarios) {
      Map<String, Double> finish = new LinkedHashMap<String, Double>();
      for (String taskId : scenario.order) {
        Candidate candidate = selected.get(taskId);
        String toPool = poolOf(candidate);
        double start = 0.0;
        List<List<String>> sources = scenario.preds.get(taskId);
        if (sources == null) {
          sources = Collections.emptyList();
        }
        for (List<String> source : sources) {
          String srcKind = source.get(0);
          String srcId = source.get(1);
          double ready;
          double transfer;
          if ("event".equals(srcKind)) {
            ready = 0.0;
            transfer = eventLatency(srcId, toPool);
          } else {
            ready = finish.get(srcId).doubleValue();
            transfer = poolLatency(poolOf(selected.get(srcId)), toPool);
          }
          start = Math.max(start, ready + transfer);
        }
        double exec = 0.0;
        if (includeExec && latAttr != null) {
          Double execValue = candidate.features.get(latAttr);
          exec = execValue == null ? 0.0 : execValue.doubleValue();
        }
        finish.put(taskId, start + exec);
      }
      List<String> sinks = scenario.sinks.isEmpty() ? scenario.order : scenario.sinks;
      double makespan = 0.0;
      for (String sink : sinks) {
        Double value = finish.get(sink);
        makespan = Math.max(makespan, value == null ? 0.0 : value.doubleValue());
      }
      expected += scenario.prob * makespan;
      worst = Math.max(worst, makespan);
    }
    return worstCase ? worst : expected;
  }

  /** Capacity and transition violations for the binding (normalized magnitudes). */
  public List<Violation> check(Map<String, Candidate> selected) {
    List<Violation> violations = new ArrayList<Violation>();

    Map<String, Map<String, Double>> usage = new LinkedHashMap<String, Map<String, Double>>();
    for (Candidate candidate : selected.values()) {
      String pool = poolOf(candidate);
      if (pool == null) {
        continue;
      }
      Map<String, Double> demand = placement.demand_of_candidate.get(candidate.id);
      if (demand == null) {
        continue;
      }
      Map<String, Double> poolUsage = usage.get(pool);
      if (poolUsage == null) {
        poolUsage = new LinkedHashMap<String, Double>();
        usage.put(pool, poolUsage);
      }
      for (Map.Entry<String, Double> entry : demand.entrySet()) {
        Double current = poolUsage.get(entry.getKey());
        poolUsage.put(
            entry.getKey(),
            (current == null ? 0.0 : current.doubleValue()) + entry.getValue().doubleValue());
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
          Double usedValue = poolUsage.get(resource);
          double used = usedValue == null ? 0.0 : usedValue.doubleValue();
          if (used > capacity.doubleValue() + 1e-6) {
            violations.add(new Violation(
                constraint.id,
                "Pool '" + poolId + "' exceeds capacity of '" + resource + "' ("
                    + used + " > " + capacity + ")",
                (used - capacity.doubleValue()) / Math.max(1.0, capacity.doubleValue()),
                constraint.isHard()));
          }
        }
      }
    }

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
    if ("IN_RANGE".equals(upper(op)) && value instanceof Map) {
      Map<?, ?> map = (Map<?, ?>) value;
      double min = ((Number) map.get("min")).doubleValue();
      double max = ((Number) map.get("max")).doubleValue();
      double raw = current < min ? min - current : Math.max(0.0, current - max);
      return raw / Math.max(1.0, Math.abs(max));
    }
    if (!(value instanceof Number)) {
      return 0.0;
    }
    double target = ((Number) value).doubleValue();
    String operator = op == null ? "<=" : op;
    double raw;
    if ("<=".equals(operator)) {
      raw = Math.max(0.0, current - target);
    } else if ("<".equals(operator)) {
      raw = current < target ? 0.0 : current - target + 1e-12;
    } else if (">=".equals(operator)) {
      raw = Math.max(0.0, target - current);
    } else if (">".equals(operator)) {
      raw = current > target ? 0.0 : target - current + 1e-12;
    } else if ("==".equals(operator)) {
      raw = Math.abs(current - target);
    } else {
      raw = 0.0;
    }
    return raw / Math.max(1.0, Math.abs(target));
  }

  private static String upper(String value) {
    return value == null ? "" : value.toUpperCase(Locale.ROOT);
  }
}
