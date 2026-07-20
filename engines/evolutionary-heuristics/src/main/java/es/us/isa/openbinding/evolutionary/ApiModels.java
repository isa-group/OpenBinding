package es.us.isa.openbinding.evolutionary;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ApiModels {
  private ApiModels() {}

  static final class SolveRequest {
    Instance instance;
    Options options = new Options();
    Placement placement;
  }

  /**
   * Placement payload precomputed by the gateway for BIM' instances: pool
   * bindings, capacities, latency matrices and the XOR-scenario precedence
   * DAGs used to evaluate end-to-end latency.
   */
  static final class Placement {
    Map<String, String> pool_of_candidate = new LinkedHashMap<>();
    Map<String, Map<String, Double>> demand_of_candidate = new LinkedHashMap<>();
    List<Pool> pools = new ArrayList<>();
    List<PlacementResourceConstraint> resource_constraints = new ArrayList<>();
    Map<String, Map<String, Double>> latency_matrix = new LinkedHashMap<>();
    Map<String, Map<String, Double>> event_latency = new LinkedHashMap<>();
    Map<String, String> event_pools = new LinkedHashMap<>();
    List<PlacementTransition> transitions = new ArrayList<>();
    E2eModel e2e;
  }

  static final class Pool {
    String id;
    String kind;
    Map<String, Double> capacity = new LinkedHashMap<>();
  }

  static final class PlacementResourceConstraint {
    String id;
    Boolean hard;
    List<String> resources = new ArrayList<>();
    List<String> pools = new ArrayList<>();

    boolean isHard() {
      return hard == null || hard;
    }
  }

  static final class PlacementTransition {
    String id;
    Boolean hard;
    String from_task;
    String from_event;
    String to_task;
    String op;
    Object value;

    boolean isHard() {
      return hard == null || hard;
    }
  }

  static final class E2eModel {
    String attribute_id;
    boolean include_execution_latency_feature;
    String xor_semantics;
    List<E2eScenario> scenarios = new ArrayList<>();
  }

  static final class E2eScenario {
    double prob;
    List<String> order = new ArrayList<>();
    Map<String, List<List<String>>> preds = new LinkedHashMap<>();
    List<String> sinks = new ArrayList<>();
  }

  static final class Instance {
    Metadata metadata;
    List<Feature> features = new ArrayList<>();
    List<Candidate> candidates = new ArrayList<>();
    Composition composition;
    Map<String, AggregationPolicy> aggregation_policies = new LinkedHashMap<>();
    List<Constraint> constraints = new ArrayList<>();
    Objective objective;
  }

  static final class Metadata {
    String id;
  }

  static final class Feature {
    String id;
    String direction;
    String scale;
    NumericRange valid_range;
  }

  static final class NumericRange {
    double min;
    double max;
  }

  static final class Candidate {
    String id;
    String task_id;
    String provider_id;
    Map<String, Double> features = new LinkedHashMap<>();
  }

  static final class Composition {
    String type;
    Node root;
  }

  static final class Node {
    String id;
    String kind;
    String task_id;
    List<Node> children;
    List<Branch> branches;
    Node body;
    Double expected_iterations;
    NumericRange bounds;
  }

  static final class Branch {
    double p;
    Node child;
  }

  static final class AggregationPolicy {
    Double neutral;
    Map<String, AggregationFunction> compose = new LinkedHashMap<>();
    Normalization normalize;
  }

  static final class AggregationFunction {
    String fn;
  }

  static final class Normalization {
    String type;
    NumericRange bounds;
    Boolean increasing_is_better;
  }

  static final class Constraint {
    String id;
    String kind;
    String scope;
    String attribute_id;
    String op;
    Object value;
    List<String> tasks = new ArrayList<>();
    String type;
    Boolean hard;

    boolean isHard() {
      return hard == null || hard;
    }
  }

  static final class Objective {
    String type;
    List<String> targets = new ArrayList<>();
    Map<String, Double> weights = new LinkedHashMap<>();
  }

  static final class Options {
    String algorithm = "AUTO";
    // Variation operators: SBX (IntegerSBX + polynomial mutation, jMetal
    // defaults) or UNIFORM (uniform crossover + random-reset mutation, the
    // standard choice for categorical candidate indices).
    String operators = "SBX";
    int population_size = 100;
    // Without a time budget: total evaluation budget. With a time budget:
    // minimum number of evaluations that is always honoured.
    int max_evaluations = 10_000;
    double crossover_probability = 0.9;
    Double mutation_probability;
    double distribution_index = 20.0;
    int archive_size = 100;
    double soft_penalty = 10.0;
    long seed = 1L;
    int reference_divisions = 12;
    // Wall-clock stopping criterion (MONO only).
    Long time_budget_ms;
  }

  static final class SolveResponse {
    List<SolutionDto> solutions = new ArrayList<>();
    Provenance provenance = new Provenance();
  }

  static final class SolutionDto {
    double objective_value;
    Map<String, String> binding = new LinkedHashMap<>();
    Map<String, Double> aggregated_features = new LinkedHashMap<>();
    List<ViolationDto> violations = new ArrayList<>();
    Map<String, Object> metadata = new LinkedHashMap<>();
  }

  static final class ViolationDto {
    String constraint_id;
    String message;
    String code = "constraint_violation";
    double penalty;
    String description;
  }

  static final class Provenance {
    String engine_id = "evolutionary-heuristics";
    long execution_time_ms;
    Map<String, Object> metadata = new LinkedHashMap<>();
  }
}
