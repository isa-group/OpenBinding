package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class BindingEvaluator {
  record ConstraintEvaluation(double hardViolation, double softViolation, List<ViolationDto> violations) {}
  record Evaluation(
      Map<String, String> binding,
      Map<String, Double> aggregated,
      Map<String, Double> losses,
      ConstraintEvaluation constraints) {}

  private final Instance instance;
  private final List<String> taskIds;
  private final Map<String, List<Candidate>> candidatesByTask;
  private final Map<String, Feature> features;
  private final PlacementEvaluator placement;

  BindingEvaluator(Instance instance) {
    this(instance, null);
  }

  BindingEvaluator(Instance instance, PlacementEvaluator placement) {
    this.instance = instance;
    this.placement = placement;
    this.taskIds = collectTaskIds(instance.composition.root);
    this.candidatesByTask = groupCandidates(instance.candidates);
    this.features = new LinkedHashMap<>();
    for (Feature feature : instance.features) {
      features.put(feature.id, feature);
    }
    for (String taskId : taskIds) {
      if (!candidatesByTask.containsKey(taskId) || candidatesByTask.get(taskId).isEmpty()) {
        throw new IllegalArgumentException("No candidates available for task '" + taskId + "'");
      }
    }
  }

  List<String> taskIds() {
    return taskIds;
  }

  int candidateCount(int taskIndex) {
    return candidatesByTask.get(taskIds.get(taskIndex)).size();
  }

  Evaluation evaluate(List<Integer> chromosome) {
    Map<String, Candidate> selected = new LinkedHashMap<>();
    Map<String, String> binding = new LinkedHashMap<>();
    for (int i = 0; i < taskIds.size(); i++) {
      String taskId = taskIds.get(i);
      Candidate candidate = candidatesByTask.get(taskId).get(chromosome.get(i));
      selected.put(taskId, candidate);
      binding.put(taskId, candidate.id);
    }

    Map<String, Double> aggregated = new LinkedHashMap<>();
    Map<String, Double> losses = new LinkedHashMap<>();
    for (Feature feature : instance.features) {
      double raw = fromCompositionValue(feature, aggregate(instance.composition.root, feature, selected));
      aggregated.put(feature.id, raw);
      losses.put(feature.id, objectiveLoss(feature, raw));
    }

    // BIM': the end-to-end latency feature is derived from the placement
    // scheduling model instead of the aggregation tree.
    if (placement != null) {
      String latAttr = placement.e2eAttribute();
      Feature latFeature = latAttr != null ? features.get(latAttr) : null;
      if (latFeature != null) {
        double e2e = placement.e2eLatency(selected);
        aggregated.put(latAttr, e2e);
        losses.put(latAttr, objectiveLoss(latFeature, e2e));
      }
    }

    return new Evaluation(binding, aggregated, losses, evaluateConstraints(selected, aggregated));
  }

  double qualityScore(Evaluation evaluation) {
    double score = 0.0;
    double totalWeight = 0.0;
    for (String target : instance.objective.targets) {
      double weight = instance.objective.weights.getOrDefault(target, 1.0);
      score += weight * (1.0 - evaluation.losses.getOrDefault(target, 1.0));
      totalWeight += weight;
    }
    return totalWeight > 0.0 ? score / totalWeight : 0.0;
  }

  private double aggregate(Node node, Feature feature, Map<String, Candidate> selected) {
    String kind = upper(node.kind);
    return switch (kind) {
      case "TASK" -> toCompositionValue(
          feature, selected.get(node.task_id).features.getOrDefault(feature.id, neutral(feature)));
      case "ELEMENT" -> toCompositionValue(feature, neutral(feature));
      case "SEQ", "AND" -> aggregateChildren(node.children, feature, selected, function(feature, kind));
      case "XOR" -> aggregateXor(node, feature, selected);
      case "LOOP" -> aggregateLoop(node, feature, selected);
      default -> throw new IllegalArgumentException("Unsupported composition node: " + node.kind);
    };
  }

  private double aggregateChildren(
      List<Node> children, Feature feature, Map<String, Candidate> selected, String function) {
    List<Double> values = new ArrayList<>();
    if (children != null) {
      for (Node child : children) {
        values.add(aggregate(child, feature, selected));
      }
    }
    return aggregateValues(values, null, function, toCompositionValue(feature, neutral(feature)));
  }

  private double aggregateXor(Node node, Feature feature, Map<String, Candidate> selected) {
    List<Double> values = new ArrayList<>();
    List<Double> weights = new ArrayList<>();
    if (node.branches != null) {
      for (Branch branch : node.branches) {
        values.add(aggregate(branch.child, feature, selected));
        weights.add(branch.p);
      }
    }
    String fn = function(feature, "XOR");
    if (fn.equals("SUM") || fn.equals("WEIGHTED_SUM") || fn.equals("SCALED_SUM")) {
      return aggregateValues(
          values, weights, "WEIGHTED_SUM", toCompositionValue(feature, neutral(feature)));
    }
    return aggregateValues(values, null, fn, toCompositionValue(feature, neutral(feature)));
  }

  private double aggregateLoop(Node node, Feature feature, Map<String, Candidate> selected) {
    double value = aggregate(node.body, feature, selected);
    double iterations = node.expected_iterations != null
        ? node.expected_iterations
        : node.bounds != null ? (node.bounds.min + node.bounds.max) / 2.0 : 1.0;
    String fn = function(feature, "LOOP");
    if (fn.contains("PRODUCT")) {
      return Math.pow(value, iterations);
    }
    if (fn.contains("SUM") || fn.contains("SCALE")) {
      return value * iterations;
    }
    return value;
  }

  private double aggregateValues(
      List<Double> values, List<Double> weights, String function, double neutral) {
    if (values.isEmpty()) {
      return neutral;
    }
    return switch (function) {
      case "PRODUCT", "SCALED_PRODUCT" -> values.stream().reduce(1.0, (a, b) -> a * b);
      case "MAX", "SCALED_MAX" -> values.stream().mapToDouble(Double::doubleValue).max().orElse(neutral);
      case "MIN", "SCALED_MIN" -> values.stream().mapToDouble(Double::doubleValue).min().orElse(neutral);
      case "MEAN", "AVERAGE" -> values.stream().mapToDouble(Double::doubleValue).average().orElse(neutral);
      case "WEIGHTED_SUM" -> {
        double result = 0.0;
        for (int i = 0; i < values.size(); i++) {
          result += values.get(i) * weights.get(i);
        }
        yield result;
      }
      default -> values.stream().mapToDouble(Double::doubleValue).sum();
    };
  }

  private double objectiveLoss(Feature feature, double raw) {
    NumericRange range = normalizationRange(feature);
    if (range == null || Math.abs(range.max - range.min) < 1e-12) {
      return 0.0;
    }
    double normalized = clamp((raw - range.min) / (range.max - range.min));
    return upper(feature.direction).equals("MAXIMIZE") ? 1.0 - normalized : normalized;
  }

  private double toCompositionValue(Feature feature, double raw) {
    double denominator = productRatioDenominator(feature);
    if (denominator <= 1.0 || (raw >= 0.0 && raw <= 1.0)) {
      return raw;
    }
    return raw / denominator;
  }

  private double fromCompositionValue(Feature feature, double value) {
    double denominator = productRatioDenominator(feature);
    return denominator <= 1.0 ? value : value * denominator;
  }

  private double productRatioDenominator(Feature feature) {
    if (!"RATIO".equals(upper(feature.scale))
        || feature.valid_range == null
        || feature.valid_range.max <= 1.0
        || !usesProductSpace(feature)) {
      return 1.0;
    }
    return feature.valid_range.max;
  }

  private boolean usesProductSpace(Feature feature) {
    AggregationPolicy policy = instance.aggregation_policies.get(feature.id);
    if (policy == null || policy.compose == null) {
      return false;
    }
    return policy.compose.values().stream()
        .anyMatch(fn -> fn != null && upper(fn.fn).contains("PRODUCT"));
  }

  private ConstraintEvaluation evaluateConstraints(
      Map<String, Candidate> selected, Map<String, Double> aggregated) {
    double hard = 0.0;
    double soft = 0.0;
    List<ViolationDto> violations = new ArrayList<>();

    for (Constraint constraint : instance.constraints) {
      double violation = constraintViolation(constraint, selected, aggregated);
      if (violation <= 0.0) {
        continue;
      }
      if (constraint.isHard()) {
        hard += violation;
      } else {
        soft += violation;
      }
      ViolationDto dto = new ViolationDto();
      dto.constraint_id = constraint.id;
      dto.message = "Constraint " + constraint.id + " violated";
      dto.penalty = violation;
      dto.description = "Normalized violation: " + violation;
      violations.add(dto);
    }

    // BIM' placement constraints: resource capacity + transition latency.
    if (placement != null) {
      for (PlacementEvaluator.Violation violation : placement.check(selected)) {
        if (violation.hard()) {
          hard += violation.magnitude();
        } else {
          soft += violation.magnitude();
        }
        ViolationDto dto = new ViolationDto();
        dto.constraint_id = violation.constraintId();
        dto.message = violation.message();
        dto.penalty = violation.magnitude();
        dto.description = "Normalized violation: " + violation.magnitude();
        violations.add(dto);
      }
    }
    return new ConstraintEvaluation(hard, soft, violations);
  }

  private double constraintViolation(
      Constraint constraint, Map<String, Candidate> selected, Map<String, Double> aggregated) {
    if (upper(constraint.kind).equals("DEPENDENCY")) {
      return dependencyViolation(constraint, selected);
    }
    if (!upper(constraint.kind).equals("ATTRIBUTE_BOUND")) {
      return 0.0;
    }

    Feature feature = features.get(constraint.attribute_id);
    if (feature == null) {
      return 1.0;
    }
    double scale = featureRange(feature);
    if (upper(constraint.scope).equals("LOCAL")) {
      double sum = 0.0;
      for (String task : constraint.tasks) {
        Candidate candidate = selected.get(task);
        if (candidate == null) {
          sum += 1.0;
        } else {
          sum += boundViolation(
              candidate.features.getOrDefault(feature.id, neutral(feature)), constraint) / scale;
        }
      }
      return constraint.tasks.isEmpty() ? 0.0 : sum / constraint.tasks.size();
    }
    return boundViolation(aggregated.getOrDefault(feature.id, neutral(feature)), constraint) / scale;
  }

  private double dependencyViolation(Constraint constraint, Map<String, Candidate> selected) {
    // SAME_POOL / DIFFERENT_POOL group by placement pool; provider otherwise.
    boolean poolBased = upper(constraint.type).endsWith("_POOL");
    Set<String> groups = new LinkedHashSet<>();
    for (String task : constraint.tasks) {
      Candidate candidate = selected.get(task);
      if (candidate != null) {
        if (poolBased && placement != null) {
          String pool = placement.poolOf(candidate);
          groups.add(pool != null ? pool : candidate.id);
        } else {
          groups.add(candidate.provider_id != null ? candidate.provider_id : candidate.id);
        }
      }
    }
    int taskCount = Math.max(1, constraint.tasks.size());
    if (upper(constraint.type).startsWith("SAME")) {
      return Math.max(0, groups.size() - 1) / (double) taskCount;
    }
    return Math.max(0, constraint.tasks.size() - groups.size()) / (double) taskCount;
  }

  private double boundViolation(double current, Constraint constraint) {
    if (upper(constraint.op).equals("IN_RANGE")) {
      NumericRange range = rangeValue(constraint.value);
      if (range == null) {
        return 1.0;
      }
      return current < range.min ? range.min - current : Math.max(0.0, current - range.max);
    }
    double target = numberValue(constraint.value);
    return switch (constraint.op) {
      case "<=" -> Math.max(0.0, current - target);
      case "<" -> current < target ? 0.0 : current - target + 1e-12;
      case ">=" -> Math.max(0.0, target - current);
      case ">" -> current > target ? 0.0 : target - current + 1e-12;
      case "==" -> Math.abs(current - target);
      case "!=" -> Math.abs(current - target) < 1e-12 ? 1.0 : 0.0;
      default -> 0.0;
    };
  }

  private NumericRange rangeValue(Object value) {
    if (!(value instanceof Map<?, ?> map)) {
      return null;
    }
    NumericRange range = new NumericRange();
    range.min = ((Number) map.get("min")).doubleValue();
    range.max = ((Number) map.get("max")).doubleValue();
    return range;
  }

  private double numberValue(Object value) {
    if (value instanceof Number number) {
      return number.doubleValue();
    }
    throw new IllegalArgumentException("Constraint value must be numeric");
  }

  private NumericRange normalizationRange(Feature feature) {
    AggregationPolicy policy = instance.aggregation_policies.get(feature.id);
    if (policy != null && policy.normalize != null
        && "MINMAX".equals(upper(policy.normalize.type)) && policy.normalize.bounds != null) {
      return policy.normalize.bounds;
    }
    return feature.valid_range;
  }

  private double featureRange(Feature feature) {
    NumericRange range = normalizationRange(feature);
    return range == null ? 1.0 : Math.max(1e-12, Math.abs(range.max - range.min));
  }

  private double neutral(Feature feature) {
    AggregationPolicy policy = instance.aggregation_policies.get(feature.id);
    if (policy != null && policy.neutral != null) {
      return policy.neutral;
    }
    return upper(feature.direction).equals("MAXIMIZE")
        ? feature.valid_range.min
        : feature.valid_range.max;
  }

  private String function(Feature feature, String nodeKind) {
    AggregationPolicy policy = instance.aggregation_policies.get(feature.id);
    if (policy == null || policy.compose == null) {
      return nodeKind.equals("AND") ? "MAX" : "SUM";
    }
    String key = switch (nodeKind) {
      case "AND" -> "and";
      case "XOR" -> "xor";
      case "LOOP" -> "loop";
      default -> "seq";
    };
    AggregationFunction fn = policy.compose.get(key);
    return fn == null || fn.fn == null ? (nodeKind.equals("AND") ? "MAX" : "SUM") : upper(fn.fn);
  }

  private static Map<String, List<Candidate>> groupCandidates(List<Candidate> candidates) {
    Map<String, List<Candidate>> result = new LinkedHashMap<>();
    for (Candidate candidate : candidates) {
      result.computeIfAbsent(candidate.task_id, ignored -> new ArrayList<>()).add(candidate);
    }
    return result;
  }

  private static List<String> collectTaskIds(Node root) {
    Set<String> result = new LinkedHashSet<>();
    collectTaskIds(root, result);
    return new ArrayList<>(result);
  }

  private static void collectTaskIds(Node node, Set<String> result) {
    if (node == null) {
      return;
    }
    switch (upper(node.kind)) {
      case "TASK" -> result.add(node.task_id);
      case "SEQ", "AND" -> {
        if (node.children != null) {
          node.children.forEach(child -> collectTaskIds(child, result));
        }
      }
      case "XOR" -> {
        if (node.branches != null) {
          node.branches.forEach(branch -> collectTaskIds(branch.child, result));
        }
      }
      case "LOOP" -> collectTaskIds(node.body, result);
      default -> {}
    }
  }

  private static double clamp(double value) {
    return Math.max(0.0, Math.min(1.0, value));
  }

  private static String upper(String value) {
    return value == null ? "" : value.toUpperCase(Locale.ROOT);
  }
}
