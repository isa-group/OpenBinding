package es.us.isa.qosawarewsbinding.bimstar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * BIM* request models for the placement-native path of the random-search
 * engine. Deliberately kept structurally identical to the evolutionary
 * engine's {@code ApiModels} so that both engines evaluate BIM* instances
 * with the same semantics (the gateway re-validates every solution against
 * its Python reference evaluator).
 */
public final class BimStarModels {
  private BimStarModels() {}

  public static final class BimStarSolveRequest {
    public String id;
    public Instance instance;
    public Placement placement;
    public Config config = new Config();
  }

  public static final class Config {
    // Minimum number of evaluations (the sole budget when no time budget is set).
    public int max_iterations = 1000;
    public Long seed;
    // Wall-clock stopping criterion; the search always completes at least
    // max_iterations evaluations even if the budget has expired.
    public Long time_budget_ms;
  }

  public static final class Instance {
    public Metadata metadata;
    public List<Feature> features = new ArrayList<>();
    public List<Candidate> candidates = new ArrayList<>();
    public Composition composition;
    public Map<String, AggregationPolicy> aggregation_policies = new LinkedHashMap<>();
    public List<Constraint> constraints = new ArrayList<>();
    public Objective objective;
  }

  public static final class Metadata {
    public String id;
  }

  public static final class Feature {
    public String id;
    public String direction;
    public String scale;
    public NumericRange valid_range;
  }

  public static final class NumericRange {
    public double min;
    public double max;
  }

  public static final class Candidate {
    public String id;
    public String task_id;
    public String provider_id;
    public Map<String, Double> features = new LinkedHashMap<>();
  }

  public static final class Composition {
    public String type;
    public Node root;
  }

  public static final class Node {
    public String id;
    public String kind;
    public String task_id;
    public List<Node> children;
    public List<Branch> branches;
    public Node body;
    public Double expected_iterations;
    public NumericRange bounds;
  }

  public static final class Branch {
    public double p;
    public Node child;
  }

  public static final class AggregationPolicy {
    public Double neutral;
    public Map<String, AggregationFunction> compose = new LinkedHashMap<>();
    public Normalization normalize;
  }

  public static final class AggregationFunction {
    public String fn;
  }

  public static final class Normalization {
    public String type;
    public NumericRange bounds;
    public Boolean increasing_is_better;
  }

  public static final class Constraint {
    public String id;
    public String kind;
    public String scope;
    public String attribute_id;
    public String op;
    public Object value;
    public List<String> tasks = new ArrayList<>();
    public String type;
    public Boolean hard;

    public boolean isHard() {
      return hard == null || hard;
    }
  }

  public static final class Objective {
    public String type;
    public List<String> targets = new ArrayList<>();
    public Map<String, Double> weights = new LinkedHashMap<>();
  }

  public static final class Placement {
    public Map<String, String> pool_of_candidate = new LinkedHashMap<>();
    public Map<String, Map<String, Double>> demand_of_candidate = new LinkedHashMap<>();
    public List<Pool> pools = new ArrayList<>();
    public List<PlacementResourceConstraint> resource_constraints = new ArrayList<>();
    public Map<String, Map<String, Double>> latency_matrix = new LinkedHashMap<>();
    public Map<String, Map<String, Double>> event_latency = new LinkedHashMap<>();
    public Map<String, String> event_pools = new LinkedHashMap<>();
    public List<PlacementTransition> transitions = new ArrayList<>();
    public E2eModel e2e;
  }

  public static final class Pool {
    public String id;
    public String kind;
    public Map<String, Double> capacity = new LinkedHashMap<>();
  }

  public static final class PlacementResourceConstraint {
    public String id;
    public Boolean hard;
    public List<String> resources = new ArrayList<>();
    public List<String> pools = new ArrayList<>();

    public boolean isHard() {
      return hard == null || hard;
    }
  }

  public static final class PlacementTransition {
    public String id;
    public Boolean hard;
    public String from_task;
    public String from_event;
    public String to_task;
    public String op;
    public Object value;

    public boolean isHard() {
      return hard == null || hard;
    }
  }

  public static final class E2eModel {
    public String attribute_id;
    public boolean include_execution_latency_feature;
    public String xor_semantics;
    public List<E2eScenario> scenarios = new ArrayList<>();
  }

  public static final class E2eScenario {
    public double prob;
    public List<String> order = new ArrayList<>();
    public Map<String, List<List<String>>> preds = new LinkedHashMap<>();
    public List<String> sinks = new ArrayList<>();
  }

  public static final class ViolationDto {
    public String constraint_id;
    public String message;
    public String code = "constraint_violation";
    public double penalty;
    public String description;
  }
}
