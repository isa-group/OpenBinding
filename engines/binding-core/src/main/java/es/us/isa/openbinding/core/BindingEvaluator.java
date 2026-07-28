package es.us.isa.openbinding.core;

import es.us.isa.openbinding.core.BimStarModels.AggregationFunction;
import es.us.isa.openbinding.core.BimStarModels.AggregationPolicy;
import es.us.isa.openbinding.core.BimStarModels.Branch;
import es.us.isa.openbinding.core.BimStarModels.Candidate;
import es.us.isa.openbinding.core.BimStarModels.Constraint;
import es.us.isa.openbinding.core.BimStarModels.Feature;
import es.us.isa.openbinding.core.BimStarModels.Instance;
import es.us.isa.openbinding.core.BimStarModels.Node;
import es.us.isa.openbinding.core.BimStarModels.NumericRange;
import es.us.isa.openbinding.core.BimStarModels.ViolationDto;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Binding evaluation for BIM' instances. Kept in sync with the evolutionary
 * engine's {@code BindingEvaluator} (aggregation semantics, normalization
 * losses, constraint magnitudes) so both engines optimize the same function.
 * Written in Java 8 style: this engine builds with JDK 8.
 */
public final class BindingEvaluator {

  public static final class ConstraintEvaluation {
    private final double hardViolation;
    private final double softViolation;
    private final List<ViolationDto> violations;

    ConstraintEvaluation(double hardViolation, double softViolation, List<ViolationDto> violations) {
      this.hardViolation = hardViolation;
      this.softViolation = softViolation;
      this.violations = violations;
    }

    public double hardViolation() {
      return hardViolation;
    }

    public double softViolation() {
      return softViolation;
    }

    public List<ViolationDto> violations() {
      return violations;
    }
  }

  public static final class Evaluation {
    private final Map<String, String> binding;
    private final Map<String, Double> aggregated;
    private final Map<String, Double> losses;
    private final ConstraintEvaluation constraints;

    Evaluation(
        Map<String, String> binding,
        Map<String, Double> aggregated,
        Map<String, Double> losses,
        ConstraintEvaluation constraints) {
      this.binding = binding;
      this.aggregated = aggregated;
      this.losses = losses;
      this.constraints = constraints;
    }

    public Map<String, String> binding() {
      return binding;
    }

    public Map<String, Double> aggregated() {
      return aggregated;
    }

    public Map<String, Double> losses() {
      return losses;
    }

    public ConstraintEvaluation constraints() {
      return constraints;
    }
  }

  private final Instance instance;
  private final List<String> taskIds;
  private final Map<String, List<Candidate>> candidatesByTask;
  private final Map<String, Feature> features;
  private final PlacementEvaluator placement;

  public BindingEvaluator(Instance instance, PlacementEvaluator placement) {
    this.instance = instance;
    this.placement = placement;
    this.taskIds = collectTaskIds(instance.composition.root);
    this.candidatesByTask = groupCandidates(instance.candidates);
    this.features = new LinkedHashMap<String, Feature>();
    for (Feature feature : instance.features) {
      features.put(feature.id, feature);
    }
    for (String taskId : taskIds) {
      if (!candidatesByTask.containsKey(taskId) || candidatesByTask.get(taskId).isEmpty()) {
        throw new IllegalArgumentException("No candidates available for task '" + taskId + "'");
      }
    }
  }

  public List<String> taskIds() {
    return taskIds;
  }

  public int candidateCount(int taskIndex) {
    return candidatesByTask.get(taskIds.get(taskIndex)).size();
  }

  public Evaluation evaluate(List<Integer> chromosome) {
    Map<String, Candidate> selected = new LinkedHashMap<String, Candidate>();
    Map<String, String> binding = new LinkedHashMap<String, String>();
    for (int i = 0; i < taskIds.size(); i++) {
      String taskId = taskIds.get(i);
      Candidate candidate = candidatesByTask.get(taskId).get(chromosome.get(i));
      selected.put(taskId, candidate);
      binding.put(taskId, candidate.id);
    }

    Map<String, Double> aggregated = new LinkedHashMap<String, Double>();
    Map<String, Double> losses = new LinkedHashMap<String, Double>();
    for (Feature feature : instance.features) {
      double raw = fromCompositionValue(feature, aggregate(instance.composition.root, feature, selected));
      aggregated.put(feature.id, raw);
      losses.put(feature.id, objectiveLoss(feature, raw));
    }

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

  /** MONO objective: weighted normalized loss (lower is better). */
  public double monoObjective(Evaluation evaluation, double softPenalty) {
    double weightedLoss = 0.0;
    double totalWeight = 0.0;
    for (String target : instance.objective.targets) {
      Double weight = instance.objective.weights.get(target);
      double w = weight == null ? 1.0 : weight.doubleValue();
      Double loss = evaluation.losses().get(target);
      weightedLoss += w * (loss == null ? 1.0 : loss.doubleValue());
      totalWeight += w;
    }
    return (totalWeight > 0.0 ? weightedLoss / totalWeight : weightedLoss)
        + softPenalty * evaluation.constraints().softViolation();
  }

  private double aggregate(Node node, Feature feature, Map<String, Candidate> selected) {
    String kind = upper(node.kind);
    if ("TASK".equals(kind)) {
      Candidate candidate = selected.get(node.task_id);
      Double value = candidate.features.get(feature.id);
      return toCompositionValue(feature, value == null ? neutral(feature) : value.doubleValue());
    }
    if ("ELEMENT".equals(kind)) {
      return toCompositionValue(feature, neutral(feature));
    }
    if ("SEQ".equals(kind) || "AND".equals(kind)) {
      return aggregateChildren(node.children, feature, selected, function(feature, kind));
    }
    if ("XOR".equals(kind)) {
      return aggregateXor(node, feature, selected);
    }
    if ("LOOP".equals(kind)) {
      return aggregateLoop(node, feature, selected);
    }
    throw new IllegalArgumentException("Unsupported composition node: " + node.kind);
  }

  private double aggregateChildren(
      List<Node> children, Feature feature, Map<String, Candidate> selected, String function) {
    List<Double> values = new ArrayList<Double>();
    if (children != null) {
      for (Node child : children) {
        values.add(aggregate(child, feature, selected));
      }
    }
    return aggregateValues(values, null, function, toCompositionValue(feature, neutral(feature)));
  }

  private double aggregateXor(Node node, Feature feature, Map<String, Candidate> selected) {
    List<Double> values = new ArrayList<Double>();
    List<Double> weights = new ArrayList<Double>();
    if (node.branches != null) {
      for (Branch branch : node.branches) {
        values.add(aggregate(branch.child, feature, selected));
        weights.add(branch.p);
      }
    }
    String fn = function(feature, "XOR");
    if ("SUM".equals(fn) || "WEIGHTED_SUM".equals(fn) || "SCALED_SUM".equals(fn)) {
      return aggregateValues(
          values, weights, "WEIGHTED_SUM", toCompositionValue(feature, neutral(feature)));
    }
    return aggregateValues(values, null, fn, toCompositionValue(feature, neutral(feature)));
  }

  private double aggregateLoop(Node node, Feature feature, Map<String, Candidate> selected) {
    double value = aggregate(node.body, feature, selected);
    double iterations;
    if (node.expected_iterations != null) {
      iterations = node.expected_iterations.doubleValue();
    } else if (node.bounds != null) {
      iterations = (node.bounds.min + node.bounds.max) / 2.0;
    } else {
      iterations = 1.0;
    }
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
    if ("PRODUCT".equals(function) || "SCALED_PRODUCT".equals(function)) {
      double result = 1.0;
      for (Double value : values) {
        result *= value.doubleValue();
      }
      return result;
    }
    if ("MAX".equals(function) || "SCALED_MAX".equals(function)) {
      double result = neutral;
      boolean first = true;
      for (Double value : values) {
        result = first ? value.doubleValue() : Math.max(result, value.doubleValue());
        first = false;
      }
      return result;
    }
    if ("MIN".equals(function) || "SCALED_MIN".equals(function)) {
      double result = neutral;
      boolean first = true;
      for (Double value : values) {
        result = first ? value.doubleValue() : Math.min(result, value.doubleValue());
        first = false;
      }
      return result;
    }
    if ("MEAN".equals(function) || "AVERAGE".equals(function)) {
      double total = 0.0;
      for (Double value : values) {
        total += value.doubleValue();
      }
      return total / values.size();
    }
    if ("WEIGHTED_SUM".equals(function)) {
      double result = 0.0;
      for (int i = 0; i < values.size(); i++) {
        result += values.get(i).doubleValue() * weights.get(i).doubleValue();
      }
      return result;
    }
    double total = 0.0;
    for (Double value : values) {
      total += value.doubleValue();
    }
    return total;
  }

  private double objectiveLoss(Feature feature, double raw) {
    NumericRange range = normalizationRange(feature);
    if (range == null || Math.abs(range.max - range.min) < 1e-12) {
      return 0.0;
    }
    double normalized = clamp((raw - range.min) / (range.max - range.min));
    return "MAXIMIZE".equals(upper(feature.direction)) ? 1.0 - normalized : normalized;
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
    for (AggregationFunction fn : policy.compose.values()) {
      if (fn != null && upper(fn.fn).contains("PRODUCT")) {
        return true;
      }
    }
    return false;
  }

  private ConstraintEvaluation evaluateConstraints(
      Map<String, Candidate> selected, Map<String, Double> aggregated) {
    double hard = 0.0;
    double soft = 0.0;
    List<ViolationDto> violations = new ArrayList<ViolationDto>();

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
    if ("DEPENDENCY".equals(upper(constraint.kind))) {
      return dependencyViolation(constraint, selected);
    }
    if (!"ATTRIBUTE_BOUND".equals(upper(constraint.kind))) {
      return 0.0;
    }

    Feature feature = features.get(constraint.attribute_id);
    if (feature == null) {
      return 1.0;
    }
    double scale = featureRange(feature);
    if ("LOCAL".equals(upper(constraint.scope))) {
      double sum = 0.0;
      for (String task : constraint.tasks) {
        Candidate candidate = selected.get(task);
        if (candidate == null) {
          sum += 1.0;
        } else {
          Double value = candidate.features.get(feature.id);
          double current = value == null ? neutral(feature) : value.doubleValue();
          sum += boundViolation(current, constraint) / scale;
        }
      }
      return constraint.tasks.isEmpty() ? 0.0 : sum / constraint.tasks.size();
    }
    Double aggregatedValue = aggregated.get(feature.id);
    double current = aggregatedValue == null ? neutral(feature) : aggregatedValue.doubleValue();
    return boundViolation(current, constraint) / scale;
  }

  private double dependencyViolation(Constraint constraint, Map<String, Candidate> selected) {
    // SAME_POOL / DIFFERENT_POOL group by placement pool; provider otherwise.
    boolean poolBased = upper(constraint.type).endsWith("_POOL");
    Set<String> groups = new LinkedHashSet<String>();
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
    if ("IN_RANGE".equals(upper(constraint.op))) {
      NumericRange range = rangeValue(constraint.value);
      if (range == null) {
        return 1.0;
      }
      return current < range.min ? range.min - current : Math.max(0.0, current - range.max);
    }
    double target = numberValue(constraint.value);
    String operator = constraint.op;
    if ("<=".equals(operator)) {
      return Math.max(0.0, current - target);
    }
    if ("<".equals(operator)) {
      return current < target ? 0.0 : current - target + 1e-12;
    }
    if (">=".equals(operator)) {
      return Math.max(0.0, target - current);
    }
    if (">".equals(operator)) {
      return current > target ? 0.0 : target - current + 1e-12;
    }
    if ("==".equals(operator)) {
      return Math.abs(current - target);
    }
    if ("!=".equals(operator)) {
      return Math.abs(current - target) < 1e-12 ? 1.0 : 0.0;
    }
    return 0.0;
  }

  private NumericRange rangeValue(Object value) {
    if (!(value instanceof Map)) {
      return null;
    }
    Map<?, ?> map = (Map<?, ?>) value;
    NumericRange range = new NumericRange();
    range.min = ((Number) map.get("min")).doubleValue();
    range.max = ((Number) map.get("max")).doubleValue();
    return range;
  }

  private double numberValue(Object value) {
    if (value instanceof Number) {
      return ((Number) value).doubleValue();
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
      return policy.neutral.doubleValue();
    }
    return "MAXIMIZE".equals(upper(feature.direction))
        ? feature.valid_range.min
        : feature.valid_range.max;
  }

  private String function(Feature feature, String nodeKind) {
    AggregationPolicy policy = instance.aggregation_policies.get(feature.id);
    if (policy == null || policy.compose == null) {
      return "AND".equals(nodeKind) ? "MAX" : "SUM";
    }
    String key;
    if ("AND".equals(nodeKind)) {
      key = "and";
    } else if ("XOR".equals(nodeKind)) {
      key = "xor";
    } else if ("LOOP".equals(nodeKind)) {
      key = "loop";
    } else {
      key = "seq";
    }
    AggregationFunction fn = policy.compose.get(key);
    if (fn == null || fn.fn == null) {
      return "AND".equals(nodeKind) ? "MAX" : "SUM";
    }
    return upper(fn.fn);
  }

  private static Map<String, List<Candidate>> groupCandidates(List<Candidate> candidates) {
    Map<String, List<Candidate>> result = new LinkedHashMap<String, List<Candidate>>();
    for (Candidate candidate : candidates) {
      List<Candidate> bucket = result.get(candidate.task_id);
      if (bucket == null) {
        bucket = new ArrayList<Candidate>();
        result.put(candidate.task_id, bucket);
      }
      bucket.add(candidate);
    }
    return result;
  }

  private static List<String> collectTaskIds(Node root) {
    Set<String> result = new LinkedHashSet<String>();
    collectTaskIds(root, result);
    return new ArrayList<String>(result);
  }

  private static void collectTaskIds(Node node, Set<String> result) {
    if (node == null) {
      return;
    }
    String kind = upper(node.kind);
    if ("TASK".equals(kind)) {
      result.add(node.task_id);
    } else if ("SEQ".equals(kind) || "AND".equals(kind)) {
      if (node.children != null) {
        for (Node child : node.children) {
          collectTaskIds(child, result);
        }
      }
    } else if ("XOR".equals(kind)) {
      if (node.branches != null) {
        for (Branch branch : node.branches) {
          collectTaskIds(branch.child, result);
        }
      }
    } else if ("LOOP".equals(kind)) {
      collectTaskIds(node.body, result);
    }
  }

  private static double clamp(double value) {
    return Math.max(0.0, Math.min(1.0, value));
  }

  private static String upper(String value) {
    return value == null ? "" : value.toUpperCase(Locale.ROOT);
  }
}
