package es.us.isa.openbinding.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Authoritative deterministic evaluation of a canonical BIM v1 decision. */
public final class CanonicalEvaluator {
  public static final class Violation {
    private final BindingProblem.Ref constraint;
    private final String enforcement;
    private final double penalty;
    private final String message;

    Violation(BindingProblem.Ref constraint, String enforcement, double penalty, String message) {
      this.constraint = constraint;
      this.enforcement = enforcement;
      this.penalty = penalty;
      this.message = message;
    }

    public BindingProblem.Ref constraint() { return constraint; }
    public String enforcement() { return enforcement; }
    public double penalty() { return penalty; }

    public JsonObject toJson() {
      JsonObject value = new JsonObject();
      value.add("constraint", constraint.toJson());
      value.addProperty("enforcement", enforcement);
      value.addProperty("message", message);
      value.addProperty("penalty", penalty);
      return value;
    }
  }

  public static final class Evaluation {
    private final Map<String, BindingProblem.Ref> binding;
    private final Map<String, Double> metrics;
    private final JsonObject objectives;
    private final List<Double> objectiveVector;
    private final List<Double> penalties;
    private final List<Violation> violations;
    private final int hardViolationCount;

    Evaluation(Map<String, BindingProblem.Ref> binding, Map<String, Double> metrics,
        JsonObject objectives, List<Double> objectiveVector, List<Double> penalties,
        List<Violation> violations, int hardViolationCount) {
      this.binding = Collections.unmodifiableMap(new LinkedHashMap<String, BindingProblem.Ref>(binding));
      this.metrics = Collections.unmodifiableMap(new LinkedHashMap<String, Double>(metrics));
      this.objectives = objectives.deepCopy();
      this.objectiveVector = Collections.unmodifiableList(new ArrayList<Double>(objectiveVector));
      this.penalties = Collections.unmodifiableList(new ArrayList<Double>(penalties));
      this.violations = Collections.unmodifiableList(new ArrayList<Violation>(violations));
      this.hardViolationCount = hardViolationCount;
    }

    public Map<String, BindingProblem.Ref> binding() { return binding; }
    public Map<String, Double> metrics() { return metrics; }
    public JsonObject objectives() { return objectives.deepCopy(); }
    public List<Double> objectiveVector() { return objectiveVector; }
    public List<Double> penalties() { return penalties; }
    public List<Violation> violations() { return violations; }
    public int hardViolationCount() { return hardViolationCount; }
    public boolean feasible() { return hardViolationCount == 0; }

    public JsonObject decisionJson() {
      JsonObject decision = new JsonObject();
      decision.addProperty("kind", "binding");
      JsonObject selected = new JsonObject();
      for (Map.Entry<String, BindingProblem.Ref> entry : binding.entrySet()) {
        selected.add(entry.getKey(), entry.getValue().toJson());
      }
      decision.add("binding", selected);
      return decision;
    }
  }

  private static final class ConstraintOutcome {
    final List<Violation> violations = new ArrayList<Violation>();
    final Map<String, Double> softPenaltyByRef = new LinkedHashMap<String, Double>();
    int hardViolationCount;
  }

  private static final class PlacementAssignment {
    final JsonObject model;
    final JsonObject demand;
    PlacementAssignment(JsonObject model, JsonObject demand) {
      this.model = model;
      this.demand = demand;
    }
  }

  private static final class FrontierEntry {
    final String kind;
    final String event;
    final BindingProblem.Ref pool;
    final double ready;
    FrontierEntry(String kind, String event, BindingProblem.Ref pool, double ready) {
      this.kind = kind;
      this.event = event;
      this.pool = pool;
      this.ready = ready;
    }
    static FrontierEntry event(String id, double ready) {
      return new FrontierEntry("event", id, null, ready);
    }
    static FrontierEntry pool(BindingProblem.Ref ref, double ready) {
      return new FrontierEntry("pool", null, ref, ready);
    }
    FrontierEntry at(double value) { return new FrontierEntry(kind, event, pool, value); }
  }

  private static final class PlacementVariant {
    final double probability;
    final List<FrontierEntry> frontier;
    PlacementVariant(double probability, List<FrontierEntry> frontier) {
      this.probability = probability;
      this.frontier = frontier;
    }
  }

  private static final class ParallelCombination {
    final double probability;
    final List<List<FrontierEntry>> frontiers;
    ParallelCombination(double probability, List<List<FrontierEntry>> frontiers) {
      this.probability = probability;
      this.frontiers = frontiers;
    }
  }

  private static final int PLACEMENT_VARIANT_LIMIT = 4096;

  private final BindingProblem problem;

  public CanonicalEvaluator(BindingProblem problem) {
    if (problem == null) throw new IllegalArgumentException("BindingProblem is required");
    this.problem = problem;
  }

  public BindingProblem problem() { return problem; }

  public Evaluation evaluate(Map<String, BindingProblem.Ref> decision) {
    Map<String, BindingProblem.Ref> binding = validateDecision(decision);
    Map<String, Double> metrics = evaluateMetrics(binding);
    metrics.putAll(evaluatePlacementMetrics(binding));
    ConstraintOutcome constraints = evaluateConstraints(binding, metrics);
    evaluatePlacementConstraints(binding, constraints);
    JsonObject optimization = problem.optimization();
    JsonArray terms = optimization.getAsJsonArray("terms");
    JsonArray components = new JsonArray();
    List<Double> termVector = new ArrayList<Double>();
    double weighted = 0.0;
    for (int index = 0; index < terms.size(); index++) {
      JsonObject term = terms.get(index).getAsJsonObject();
      BindingProblem.Ref metricRef = BindingProblem.ref(term.get("metric"), "optimization term.metric");
      double raw = metrics.get(metricRef.id()).doubleValue();
      double loss = objectiveLoss(raw, term);
      JsonObject component = new JsonObject();
      component.add("metric", metricRef.toJson());
      component.addProperty("value", raw);
      component.addProperty("loss", loss);
      component.addProperty("weight", term.get("weight").getAsDouble());
      components.add(component);
      termVector.add(Double.valueOf(loss));
      weighted += term.get("weight").getAsDouble() * loss;
    }

    List<Double> penalties = new ArrayList<Double>();
    double penaltyTotal = 0.0;
    for (JsonElement value : optimization.getAsJsonArray("penalties")) {
      JsonObject item = value.getAsJsonObject();
      BindingProblem.Ref constraintRef = BindingProblem.ref(item.get("constraint"), "optimization penalty.constraint");
      double raw = constraints.softPenaltyByRef.containsKey(constraintRef.key())
          ? constraints.softPenaltyByRef.get(constraintRef.key()).doubleValue() : 0.0;
      double weightedPenalty = raw * item.get("weight").getAsDouble();
      requireFiniteNonNegative(weightedPenalty, "weighted soft penalty");
      penalties.add(Double.valueOf(weightedPenalty));
      penaltyTotal += weightedPenalty;
    }

    String mode = optimization.get("mode").getAsString();
    List<Double> vector = new ArrayList<Double>();
    if ("weighted".equals(mode)) {
      vector.add(Double.valueOf(weighted + penaltyTotal));
    } else if ("satisfy".equals(mode)) {
      vector.add(Double.valueOf(penaltyTotal));
    } else {
      vector.addAll(termVector);
      vector.add(Double.valueOf(penaltyTotal));
    }
    JsonObject objectives = new JsonObject();
    objectives.addProperty("mode", mode);
    objectives.add("components", components);
    objectives.addProperty("penalty", penaltyTotal);
    if ("weighted".equals(mode) || "satisfy".equals(mode)) {
      objectives.addProperty("score", "weighted".equals(mode) ? weighted + penaltyTotal : penaltyTotal);
    } else if ("lexicographic".equals(mode) || "pareto".equals(mode)) {
      JsonArray score = new JsonArray();
      for (Double value : vector) score.add(value);
      objectives.add("score", score);
    }
    return new Evaluation(binding, metrics, objectives, vector, penalties,
        constraints.violations, constraints.hardViolationCount);
  }

  /** Feasibility-first total order used by single-result heuristic modes. */
  public Comparator<Evaluation> comparator() {
    return new Comparator<Evaluation>() {
      @Override public int compare(Evaluation left, Evaluation right) {
        if (left.feasible() != right.feasible()) return left.feasible() ? -1 : 1;
        if (!left.feasible() && left.hardViolationCount() != right.hardViolationCount()) {
          return left.hardViolationCount() < right.hardViolationCount() ? -1 : 1;
        }
        List<Double> a = left.objectiveVector();
        List<Double> b = right.objectiveVector();
        int size = Math.min(a.size(), b.size());
        for (int index = 0; index < size; index++) {
          int compared = Double.compare(a.get(index).doubleValue(), b.get(index).doubleValue());
          if (compared != 0) return compared;
        }
        return Integer.compare(a.size(), b.size());
      }
    };
  }

  public boolean dominates(Evaluation left, Evaluation right) {
    if (left.feasible() && !right.feasible()) return true;
    if (!left.feasible()) return false;
    if (!right.feasible()) return true;
    List<Double> a = left.objectiveVector();
    List<Double> b = right.objectiveVector();
    boolean better = false;
    for (int index = 0; index < Math.min(a.size(), b.size()); index++) {
      if (a.get(index).doubleValue() > b.get(index).doubleValue()) return false;
      if (a.get(index).doubleValue() < b.get(index).doubleValue()) better = true;
    }
    return better;
  }

  private Map<String, BindingProblem.Ref> validateDecision(Map<String, BindingProblem.Ref> decision) {
    if (decision == null) throw new IllegalArgumentException("Binding decision is required");
    Set<String> expected = new LinkedHashSet<String>(problem.serviceTasks());
    Set<String> actual = new LinkedHashSet<String>(decision.keySet());
    if (!actual.equals(expected)) {
      throw new IllegalArgumentException("Binding decision keys must be exactly service tasks; expected "
          + expected + " but found " + actual);
    }
    Map<String, BindingProblem.Ref> copy = new LinkedHashMap<String, BindingProblem.Ref>();
    for (String task : problem.serviceTasks()) {
      BindingProblem.Ref selected = decision.get(task);
      if (selected == null || !problem.eligible(task).contains(selected)) {
        throw new IllegalArgumentException("Candidate " + selected + " is not eligible for task '" + task + "'");
      }
      copy.put(task, selected);
    }
    return copy;
  }

  private Map<String, Double> evaluateMetrics(Map<String, BindingProblem.Ref> binding) {
    Map<String, Double> values = new LinkedHashMap<String, Double>();
    for (String metricId : problem.requiredMetrics()) {
      JsonObject metric = problem.metricDefinitions().get(metricId);
      Double value;
      if ("selectedCandidate".equals(BindingProblem.optionalString(metric, "scope", "invocation"))) {
        // Deployment/selection metrics are properties of the selected things,
        // not workflow invocations.  Aggregate every unique catalog-qualified
        // candidate exactly once, independent of XOR traversal and repeats.
        Set<BindingProblem.Ref> unique = new LinkedHashSet<BindingProblem.Ref>(binding.values());
        List<Double> selectedValues = new ArrayList<Double>();
        for (BindingProblem.Ref candidate : unique) {
          selectedValues.add(Double.valueOf(problem.candidateMetric(candidate, metricId)));
        }
        value = aggregate(selectedValues, metric.getAsJsonObject("aggregation").get("selection"),
            null, null);
      } else {
        value = workflowValue(problem.workflow(), "/spec/application/workflow", metricId, metric,
            binding, context(binding, Collections.<String, Double>emptyMap()));
      }
      double result = value == null ? metric.get("neutral").getAsDouble() : value.doubleValue();
      if (Double.isNaN(result) || Double.isInfinite(result)) {
        throw new IllegalArgumentException("Metric '" + metricId + "' evaluated to a non-finite value");
      }
      values.put(metricId, Double.valueOf(result));
    }
    return values;
  }

  private Map<String, Double> evaluatePlacementMetrics(
      Map<String, BindingProblem.Ref> binding) {
    Map<String, Double> result = new LinkedHashMap<String, Double>();
    for (JsonElement rawModel : problem.placement()) {
      JsonObject model = rawModel.getAsJsonObject();
      if (!model.has("globalLatency")) continue;
      String metric = model.getAsJsonObject("globalLatency").getAsJsonObject("metric")
          .get("id").getAsString();
      if (result.containsKey(metric)) {
        throw new IllegalArgumentException("More than one placement derives metric '" + metric + "'");
      }
      result.put(metric, Double.valueOf(globalLatency(model, binding)));
    }
    return result;
  }

  private PlacementAssignment placementAssignment(BindingProblem.Ref candidate) {
    PlacementAssignment result = null;
    int matches = 0;
    for (JsonElement rawModel : problem.placement()) {
      JsonObject model = rawModel.getAsJsonObject();
      for (JsonElement rawDemand : model.getAsJsonArray("demands")) {
        JsonObject demand = rawDemand.getAsJsonObject();
        if (candidate.equals(BindingProblem.ref(demand.get("candidate"), "placement demand.candidate"))) {
          result = new PlacementAssignment(model, demand);
          matches++;
        }
      }
    }
    if (matches != 1) {
      throw new IllegalArgumentException("Candidate " + candidate
          + " must have exactly one placement assignment; found " + matches);
    }
    return result;
  }

  private static double networkLatency(JsonObject model, BindingProblem.Ref source,
      BindingProblem.Ref target) {
    for (JsonElement rawLink : model.getAsJsonArray("network")) {
      JsonObject link = rawLink.getAsJsonObject();
      if (source.equals(BindingProblem.ref(link.get("from"), "placement network.from"))
          && target.equals(BindingProblem.ref(link.get("to"), "placement network.to"))) {
        return link.get("latency").getAsDouble();
      }
    }
    if (source.equals(target)) return 0.0;
    throw new IllegalArgumentException("Placement '" + model.get("resource").getAsString()
        + "' has no directed network latency from " + source + " to " + target);
  }

  private static double eventLatency(JsonObject model, String eventId,
      BindingProblem.Ref target) {
    JsonObject events = model.getAsJsonObject("events");
    if (!events.has(eventId) || !events.get(eventId).isJsonObject()) {
      throw new IllegalArgumentException("Unknown placement event '" + eventId + "'");
    }
    JsonObject event = events.getAsJsonObject(eventId);
    for (JsonElement rawLatency : event.getAsJsonArray("latency")) {
      JsonObject latency = rawLatency.getAsJsonObject();
      if (target.equals(BindingProblem.ref(latency.get("pool"), "placement event latency.pool"))) {
        return latency.get("latency").getAsDouble();
      }
    }
    return networkLatency(model, BindingProblem.ref(event.get("pool"), "placement event.pool"), target);
  }

  private double globalLatency(JsonObject model, Map<String, BindingProblem.Ref> binding) {
    JsonObject events = model.getAsJsonObject("events");
    List<String> eventIds = new ArrayList<String>(events.keySet());
    Collections.sort(eventIds);
    List<FrontierEntry> initial = new ArrayList<FrontierEntry>();
    for (String eventId : eventIds) initial.add(FrontierEntry.event(eventId, 0.0));
    List<PlacementVariant> variants = new ArrayList<PlacementVariant>();
    variants.add(new PlacementVariant(1.0, initial));
    JsonObject branchContext = context(binding, Collections.<String, Double>emptyMap());
    variants = placementWorkflow(problem.workflow(), "/spec/application/workflow", variants,
        model, binding, branchContext);
    double totalProbability = 0.0;
    double value = 0.0;
    for (PlacementVariant variant : variants) {
      totalProbability += variant.probability;
      value += variant.probability * latestReady(variant.frontier);
    }
    if (Math.abs(totalProbability - 1.0) > 1e-12) {
      throw new IllegalArgumentException("Placement latency routing probability is "
          + totalProbability + ", expected 1");
    }
    if (!Double.isFinite(value) || value < 0.0) {
      throw new IllegalArgumentException("Placement global latency must be finite and non-negative");
    }
    return value;
  }

  private List<PlacementVariant> placementWorkflow(JsonObject node, String pointer,
      List<PlacementVariant> variants, JsonObject model,
      Map<String, BindingProblem.Ref> binding, JsonObject branchContext) {
    String kind = node.get("kind").getAsString();
    if ("empty".equals(kind)) return variants;
    if ("task".equals(kind)) {
      BindingProblem.Ref task = BindingProblem.ref(node.get("task"), "workflow.task");
      if (!binding.containsKey(task.id())) return variants;
      BindingProblem.Ref candidate = binding.get(task.id());
      PlacementAssignment assignment = placementAssignment(candidate);
      if (!model.get("resource").getAsString().equals(assignment.model.get("resource").getAsString())) {
        throw new IllegalArgumentException("Task '" + task.id()
            + "' is assigned outside global latency placement '"
            + model.get("resource").getAsString() + "'");
      }
      BindingProblem.Ref target = BindingProblem.ref(assignment.demand.get("pool"), "placement demand.pool");
      JsonObject config = model.getAsJsonObject("globalLatency");
      double execution = config.get("includeExecution").getAsBoolean()
          ? problem.candidateMetric(candidate, config.getAsJsonObject("metric").get("id").getAsString()) : 0.0;
      List<PlacementVariant> result = new ArrayList<PlacementVariant>();
      for (PlacementVariant variant : variants) {
        double start = 0.0;
        for (FrontierEntry source : variant.frontier) {
          double transfer = "event".equals(source.kind)
              ? eventLatency(model, source.event, target)
              : networkLatency(model, source.pool, target);
          start = Math.max(start, source.ready + transfer);
        }
        List<FrontierEntry> frontier = new ArrayList<FrontierEntry>();
        frontier.add(FrontierEntry.pool(target, start + execution));
        result.add(new PlacementVariant(variant.probability, frontier));
      }
      return result;
    }
    if ("sequence".equals(kind)) {
      List<PlacementVariant> current = variants;
      JsonArray steps = node.getAsJsonArray("steps");
      for (int index = 0; index < steps.size(); index++) {
        current = placementWorkflow(steps.get(index).getAsJsonObject(), pointer + "/steps/" + index,
            current, model, binding, branchContext);
      }
      return current;
    }
    if ("parallel".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      List<PlacementVariant> result = new ArrayList<PlacementVariant>();
      for (PlacementVariant base : variants) {
        List<ParallelCombination> combinations = new ArrayList<ParallelCombination>();
        combinations.add(new ParallelCombination(base.probability,
            new ArrayList<List<FrontierEntry>>()));
        for (int branchIndex = 0; branchIndex < branches.size(); branchIndex++) {
          List<PlacementVariant> branchInput = new ArrayList<PlacementVariant>();
          branchInput.add(new PlacementVariant(1.0,
              new ArrayList<FrontierEntry>(base.frontier)));
          List<PlacementVariant> branchVariants = placementWorkflow(
              branches.get(branchIndex).getAsJsonObject(), pointer + "/branches/" + branchIndex,
              branchInput, model, binding, branchContext);
          List<ParallelCombination> next = new ArrayList<ParallelCombination>();
          for (ParallelCombination combination : combinations) {
            for (PlacementVariant branch : branchVariants) {
              List<List<FrontierEntry>> frontiers =
                  new ArrayList<List<FrontierEntry>>(combination.frontiers);
              frontiers.add(branch.frontier);
              next.add(new ParallelCombination(
                  combination.probability * branch.probability, frontiers));
            }
          }
          if (next.size() > PLACEMENT_VARIANT_LIMIT) placementVariantLimit();
          combinations = next;
        }
        boolean sum = "sum".equals(model.getAsJsonObject("globalLatency").get("parallel").getAsString());
        double baseline = latestReady(base.frontier);
        for (ParallelCombination combination : combinations) {
          List<FrontierEntry> flattened = new ArrayList<FrontierEntry>();
          if (sum) {
            double duration = 0.0;
            for (List<FrontierEntry> frontier : combination.frontiers) {
              duration += Math.max(0.0, latestReady(frontier) - baseline);
            }
            double finish = baseline + duration;
            for (List<FrontierEntry> frontier : combination.frontiers) {
              for (FrontierEntry source : frontier) flattened.add(source.at(finish));
            }
          } else {
            for (List<FrontierEntry> frontier : combination.frontiers) flattened.addAll(frontier);
          }
          result.add(new PlacementVariant(combination.probability, flattened));
        }
      }
      if (result.size() > PLACEMENT_VARIANT_LIMIT) placementVariantLimit();
      return result;
    }
    if ("exclusive".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      JsonObject config = model.getAsJsonObject("globalLatency");
      List<PlacementVariant> result = new ArrayList<PlacementVariant>();
      if ("routing".equals(config.get("exclusive").getAsString())) {
        for (int index = 0; index < branches.size(); index++) {
          JsonObject branch = branches.get(index).getAsJsonObject();
          BindingProblem.Ref target = problem.workflowBranchRef(pointer, index,
              branch.get("id").getAsString());
          Double branchProbability = problem.routingProbability(target);
          if (branchProbability == null) {
            throw new IllegalArgumentException("Missing routing probability for placement XOR branch " + target);
          }
          for (PlacementVariant variant : variants) {
            List<PlacementVariant> nestedInput = new ArrayList<PlacementVariant>();
            nestedInput.add(new PlacementVariant(1.0,
                new ArrayList<FrontierEntry>(variant.frontier)));
            List<PlacementVariant> nested = placementWorkflow(branch.getAsJsonObject("flow"),
                pointer + "/branches/" + index + "/flow", nestedInput,
                model, binding, branchContext);
            for (PlacementVariant child : nested) {
              result.add(new PlacementVariant(variant.probability
                  * branchProbability.doubleValue() * child.probability, child.frontier));
            }
          }
        }
        if (result.size() > PLACEMENT_VARIANT_LIMIT) placementVariantLimit();
        return result;
      }
      JsonObject selected = null;
      int selectedIndex = -1;
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = branches.get(index).getAsJsonObject();
        if (branch.has("when") && asBoolean(evaluateExpression(
            branch.getAsJsonObject("when"), branchContext), "exclusive branch.when")) {
          if (selected != null) {
            throw new IllegalArgumentException("Conditional placement XOR selected more than one branch");
          }
          selected = branch;
          selectedIndex = index;
        }
      }
      if (selected == null) throw new IllegalArgumentException("Conditional placement XOR selected no branch");
      return placementWorkflow(selected.getAsJsonObject("flow"),
          pointer + "/branches/" + selectedIndex + "/flow", variants,
          model, binding, branchContext);
    }
    if ("repeat".equals(kind)) {
      double count = node.has("count") ? node.get("count").getAsDouble()
          : node.get("expectedCount").getAsDouble();
      if (node.has("count")) {
        if (count > 10000.0) {
          throw new IllegalArgumentException("Placement latency exact repeat count exceeds 10000");
        }
        List<PlacementVariant> current = variants;
        for (int index = 0; index < (int) count; index++) {
          current = placementWorkflow(node.getAsJsonObject("body"), pointer + "/body",
              current, model, binding, branchContext);
        }
        return current;
      }
      List<PlacementVariant> result = new ArrayList<PlacementVariant>();
      for (PlacementVariant base : variants) {
        double baseline = latestReady(base.frontier);
        List<PlacementVariant> onceInput = new ArrayList<PlacementVariant>();
        onceInput.add(new PlacementVariant(1.0,
            new ArrayList<FrontierEntry>(base.frontier)));
        List<PlacementVariant> once = placementWorkflow(node.getAsJsonObject("body"),
            pointer + "/body", onceInput, model, binding, branchContext);
        for (PlacementVariant child : once) {
          List<FrontierEntry> scaled = new ArrayList<FrontierEntry>();
          for (FrontierEntry source : child.frontier) {
            scaled.add(source.at(baseline + (source.ready - baseline) * count));
          }
          result.add(new PlacementVariant(base.probability * child.probability, scaled));
        }
      }
      if (result.size() > PLACEMENT_VARIANT_LIMIT) placementVariantLimit();
      return result;
    }
    throw new IllegalArgumentException("Unsupported workflow kind in placement latency: '" + kind + "'");
  }

  private static double latestReady(List<FrontierEntry> frontier) {
    double result = 0.0;
    for (FrontierEntry source : frontier) result = Math.max(result, source.ready);
    return result;
  }

  private static void placementVariantLimit() {
    throw new IllegalArgumentException("Placement latency expands to more than "
        + PLACEMENT_VARIANT_LIMIT + " deterministic routing variants");
  }

  private Double workflowValue(JsonObject node, String pointer, String metricId, JsonObject metric,
      Map<String, BindingProblem.Ref> binding, JsonObject branchContext) {
    String kind = node.get("kind").getAsString();
    if ("task".equals(kind)) {
      BindingProblem.Ref task = BindingProblem.ref(node.get("task"), "workflow.task");
      if (!binding.containsKey(task.id())) return Double.valueOf(metric.get("neutral").getAsDouble());
      BindingProblem.Ref candidate = binding.get(task.id());
      return Double.valueOf(problem.candidateMetric(candidate, metricId));
    }
    if ("empty".equals(kind)) return Double.valueOf(metric.get("neutral").getAsDouble());
    JsonObject aggregation = metric.getAsJsonObject("aggregation");
    if ("sequence".equals(kind)) {
      return aggregate(children(node.getAsJsonArray("steps"), pointer + "/steps", metricId, metric, binding, branchContext),
          aggregation.get("sequence"), null, null);
    }
    if ("parallel".equals(kind)) {
      return aggregate(children(node.getAsJsonArray("branches"), pointer + "/branches", metricId, metric, binding, branchContext),
          aggregation.get("parallel"), null, null);
    }
    if ("exclusive".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      List<Double> values = new ArrayList<Double>();
      List<Double> probabilities = new ArrayList<Double>();
      JsonObject first = branches.get(0).getAsJsonObject();
      BindingProblem.Ref firstTarget = problem.workflowBranchRef(pointer, 0, first.get("id").getAsString());
      boolean probabilistic = problem.routingProbability(firstTarget) != null;
      if (probabilistic) {
        for (int index = 0; index < branches.size(); index++) {
          JsonObject branch = branches.get(index).getAsJsonObject();
          Double child = workflowValue(branch.getAsJsonObject("flow"),
              pointer + "/branches/" + index + "/flow", metricId, metric, binding, branchContext);
          values.add(child);
          BindingProblem.Ref target = problem.workflowBranchRef(pointer, index,
              branch.get("id").getAsString());
          probabilities.add(problem.routingProbability(target));
        }
        return aggregate(values, aggregation.get("exclusive"), probabilities, null);
      }
      JsonObject selected = null;
      int selectedIndex = -1;
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = branches.get(index).getAsJsonObject();
        boolean matches = asBoolean(evaluateExpression(branch.getAsJsonObject("when"), branchContext),
            "exclusive branch.when");
        if (matches) {
          if (selected != null) throw new IllegalArgumentException("Conditional XOR selected more than one branch");
          selected = branch;
          selectedIndex = index;
        }
      }
      if (selected == null) throw new IllegalArgumentException("Conditional XOR selected no branch");
      return workflowValue(selected.getAsJsonObject("flow"),
          pointer + "/branches/" + selectedIndex + "/flow", metricId, metric, binding, branchContext);
    }
    if ("repeat".equals(kind)) {
      Double body = workflowValue(node.getAsJsonObject("body"), pointer + "/body", metricId, metric, binding, branchContext);
      if (body == null) return null;
      double count = node.has("count") ? node.get("count").getAsDouble() : node.get("expectedCount").getAsDouble();
      return aggregate(Collections.singletonList(body), aggregation.get("repeat"), null, Double.valueOf(count));
    }
    throw new IllegalArgumentException("Unsupported workflow kind '" + kind + "'");
  }

  private List<Double> children(JsonArray nodes, String pointer, String metricId, JsonObject metric,
      Map<String, BindingProblem.Ref> binding, JsonObject branchContext) {
    List<Double> values = new ArrayList<Double>();
    for (int index = 0; index < nodes.size(); index++) {
      values.add(workflowValue(nodes.get(index).getAsJsonObject(), pointer + "/" + index,
          metricId, metric, binding, branchContext));
    }
    return values;
  }

  private Double aggregate(List<Double> values, JsonElement operator,
      List<Double> weights, Double count) {
    List<Double> present = new ArrayList<Double>();
    List<Double> presentWeights = new ArrayList<Double>();
    for (int index = 0; index < values.size(); index++) {
      Double value = values.get(index);
      if (value == null && weights != null) value = Double.valueOf(neutral(operator));
      if (value == null) continue;
      present.add(value);
      if (weights != null) presentWeights.add(weights.get(index));
    }
    if (operator.isJsonObject()) {
      JsonObject aggregationContext = new JsonObject();
      JsonArray valueArray = new JsonArray();
      for (Double value : present) valueArray.add(value);
      aggregationContext.add("values", valueArray);
      JsonArray weightArray = new JsonArray();
      for (Double weight : presentWeights) weightArray.add(weight);
      aggregationContext.add("weights", weightArray);
      aggregationContext.addProperty("count", count == null ? 0.0 : count.doubleValue());
      JsonObject custom = BindingProblem.requireObject(operator.getAsJsonObject(), "expression", "aggregation");
      return Double.valueOf(asNumber(evaluateExpression(custom, aggregationContext),
          "aggregation expression"));
    }
    if (present.isEmpty()) return Double.valueOf(neutral(operator));
    String operation = operator.getAsString();
    if ("sum".equals(operation)) {
      double result = 0.0;
      for (Double value : present) result += value.doubleValue();
      return Double.valueOf(result);
    }
    if ("product".equals(operation)) {
      double result = 1.0;
      for (Double value : present) result *= value.doubleValue();
      return Double.valueOf(result);
    }
    if ("min".equals(operation)) return Collections.min(present);
    if ("max".equals(operation)) return Collections.max(present);
    if ("weightedSum".equals(operation)) {
      double result = 0.0;
      for (int index = 0; index < present.size(); index++) {
        result += present.get(index).doubleValue() * presentWeights.get(index).doubleValue();
      }
      return Double.valueOf(result);
    }
    if ("weightedProduct".equals(operation)) {
      double result = 1.0;
      for (int index = 0; index < present.size(); index++) {
        double value = present.get(index).doubleValue();
        double weight = presentWeights.get(index).doubleValue();
        if (weight == 0.0) continue;
        if (value < 0.0 && weight != Math.rint(weight)) {
          throw new IllegalArgumentException(
              "weightedProduct cannot raise a negative value to a fractional routing weight");
        }
        result *= Math.pow(value, weight);
      }
      if (!Double.isFinite(result)) throw new IllegalArgumentException("weightedProduct result must be finite");
      return Double.valueOf(result);
    }
    if ("scale".equals(operation)) return Double.valueOf(present.get(0).doubleValue() * count.doubleValue());
    if ("power".equals(operation)) {
      double value = present.get(0).doubleValue();
      double exponent = count.doubleValue();
      if (value < 0.0 && exponent != Math.rint(exponent)) {
        throw new IllegalArgumentException("power cannot raise a negative value to a fractional expected count");
      }
      double result = Math.pow(value, exponent);
      if (!Double.isFinite(result)) throw new IllegalArgumentException("power result must be finite");
      return Double.valueOf(result);
    }
    if ("identity".equals(operation)) return present.get(0);
    throw new IllegalArgumentException("Unsupported aggregation operation '" + operation + "'");
  }

  private static double neutral(JsonElement operator) {
    if (operator != null && operator.isJsonPrimitive()) {
      String operation = operator.getAsString();
      if ("product".equals(operation) || "weightedProduct".equals(operation) || "power".equals(operation)) {
        return 1.0;
      }
    }
    return 0.0;
  }

  private ConstraintOutcome evaluateConstraints(Map<String, BindingProblem.Ref> binding,
      Map<String, Double> metrics) {
    ConstraintOutcome outcome = new ConstraintOutcome();
    JsonObject context = context(binding, metrics);
    for (JsonElement value : problem.constraints()) {
      JsonObject constraint = value.getAsJsonObject();
      BindingProblem.Ref ref = BindingProblem.ref(constraint.get("ref"), "constraint.ref");
      boolean applies = asBoolean(evaluateExpression(constraint.getAsJsonObject("when"), context), "constraint.when");
      if (!applies) continue;
      boolean satisfied = asBoolean(evaluateExpression(constraint.getAsJsonObject("assert"), context), "constraint.assert");
      if (satisfied) continue;
      String enforcement = constraint.get("enforcement").getAsString();
      double penalty = 0.0;
      if ("hard".equals(enforcement)) {
        outcome.hardViolationCount++;
      } else {
        penalty = asNumber(evaluateExpression(constraint.getAsJsonObject("penalty"), context), "constraint.penalty");
        requireFiniteNonNegative(penalty, "constraint.penalty");
        outcome.softPenaltyByRef.put(ref.key(), Double.valueOf(penalty));
      }
      outcome.violations.add(new Violation(ref, enforcement, penalty,
          "Constraint " + ref + " is not satisfied"));
    }
    return outcome;
  }

  private void evaluatePlacementConstraints(Map<String, BindingProblem.Ref> binding,
      ConstraintOutcome outcome) {
    if (problem.placement().size() == 0) return;
    Map<String, Double> invocations = taskInvocations(problem.workflow(),
        "/spec/application/workflow", binding, 1.0,
        context(binding, Collections.<String, Double>emptyMap()));
    for (JsonElement rawModel : problem.placement()) {
      JsonObject model = rawModel.getAsJsonObject();
      Map<BindingProblem.Ref, JsonObject> demandByCandidate =
          new LinkedHashMap<BindingProblem.Ref, JsonObject>();
      for (JsonElement rawDemand : model.getAsJsonArray("demands")) {
        JsonObject demand = rawDemand.getAsJsonObject();
        demandByCandidate.put(BindingProblem.ref(demand.get("candidate"), "placement demand.candidate"), demand);
      }
      Map<BindingProblem.Ref, JsonObject> poolByRef =
          new LinkedHashMap<BindingProblem.Ref, JsonObject>();
      for (Map.Entry<String, JsonElement> entry : model.getAsJsonObject("pools").entrySet()) {
        JsonObject pool = entry.getValue().getAsJsonObject();
        poolByRef.put(BindingProblem.ref(pool.get("ref"), "placement pool.ref"), pool);
      }

      if (model.has("capacityRules")) {
        for (JsonElement rawRule : model.getAsJsonArray("capacityRules")) {
          JsonObject rule = rawRule.getAsJsonObject();
          Map<BindingProblem.Ref, Map<String, Double>> usage =
              new LinkedHashMap<BindingProblem.Ref, Map<String, Double>>();
          Map<BindingProblem.Ref, Double> charges = new LinkedHashMap<BindingProblem.Ref, Double>();
          if ("selectedCandidate".equals(rule.get("scope").getAsString())) {
            for (BindingProblem.Ref candidate : new LinkedHashSet<BindingProblem.Ref>(binding.values())) {
              charges.put(candidate, Double.valueOf(1.0));
            }
          } else {
            for (Map.Entry<String, BindingProblem.Ref> selected : binding.entrySet()) {
              BindingProblem.Ref candidate = selected.getValue();
              double amount = invocations.containsKey(selected.getKey())
                  ? invocations.get(selected.getKey()).doubleValue() : 0.0;
              Double previous = charges.get(candidate);
              charges.put(candidate, Double.valueOf((previous == null ? 0.0 : previous.doubleValue()) + amount));
            }
          }
          for (Map.Entry<BindingProblem.Ref, Double> charge : charges.entrySet()) {
            JsonObject demand = demandByCandidate.get(charge.getKey());
            if (demand == null) continue;
            BindingProblem.Ref pool = BindingProblem.ref(demand.get("pool"), "placement demand.pool");
            Map<String, Double> poolUsage = usage.get(pool);
            if (poolUsage == null) {
              poolUsage = new LinkedHashMap<String, Double>();
              usage.put(pool, poolUsage);
            }
            JsonObject resources = demand.getAsJsonObject("resources");
            for (JsonElement rawDimension : rule.getAsJsonArray("resources")) {
              String dimension = rawDimension.getAsString();
              double value = resources.has(dimension) ? resources.get(dimension).getAsDouble() : 0.0;
              Double previous = poolUsage.get(dimension);
              poolUsage.put(dimension, Double.valueOf(
                  (previous == null ? 0.0 : previous.doubleValue())
                      + value * charge.getValue().doubleValue()));
            }
          }
          BindingProblem.Ref ruleRef = BindingProblem.ref(rule.get("ref"), "placement capacity rule.ref");
          for (Map.Entry<BindingProblem.Ref, Map<String, Double>> poolUsage : usage.entrySet()) {
            JsonObject pool = poolByRef.get(poolUsage.getKey());
            for (JsonElement rawDimension : rule.getAsJsonArray("resources")) {
              String dimension = rawDimension.getAsString();
              double used = poolUsage.getValue().containsKey(dimension)
                  ? poolUsage.getValue().get(dimension).doubleValue() : 0.0;
              double capacity = pool.getAsJsonObject("capacity").get(dimension).getAsDouble();
              if (used > capacity) {
                addPlacementViolation(outcome, ruleRef, "hard", 0.0,
                    "Pool " + poolUsage.getKey() + " uses " + used + " " + dimension
                        + ", above capacity " + capacity);
              }
            }
          }
        }
      }

      for (JsonElement rawTransition : model.getAsJsonArray("transitions")) {
        JsonObject transition = rawTransition.getAsJsonObject();
        BindingProblem.Ref from = BindingProblem.ref(transition.get("from"), "placement transition.from");
        BindingProblem.Ref to = BindingProblem.ref(transition.get("to"), "placement transition.to");
        BindingProblem.Ref fromPool = endpointPool(model, from, binding);
        BindingProblem.Ref toPool = endpointPool(model, to, binding);
        double current = model.get("resource").getAsString().equals(from.resource())
            ? eventLatency(model, from.id(), toPool)
            : networkLatency(model, fromPool, toPool);
        double maximum = transition.get("maximum").getAsDouble();
        if (current > maximum) {
          String enforcement = transition.get("enforcement").getAsString();
          double penalty = "soft".equals(enforcement)
              ? transition.get("penalty").getAsDouble() : 0.0;
          addPlacementViolation(outcome,
              BindingProblem.ref(transition.get("ref"), "placement transition.ref"),
              enforcement, penalty, "Transition latency " + current
                  + " exceeds maximum " + maximum);
        }
      }
    }
  }

  private BindingProblem.Ref endpointPool(JsonObject model, BindingProblem.Ref endpoint,
      Map<String, BindingProblem.Ref> binding) {
    if (model.get("resource").getAsString().equals(endpoint.resource())) {
      JsonObject event = model.getAsJsonObject("events").getAsJsonObject(endpoint.id());
      if (event == null) throw new IllegalArgumentException("Unknown placement event " + endpoint);
      return BindingProblem.ref(event.get("pool"), "placement event.pool");
    }
    if (!binding.containsKey(endpoint.id())) {
      throw new IllegalArgumentException("Placement transition endpoint " + endpoint
          + " is not a service task");
    }
    PlacementAssignment assignment = placementAssignment(binding.get(endpoint.id()));
    if (!model.get("resource").getAsString().equals(assignment.model.get("resource").getAsString())) {
      throw new IllegalArgumentException("Placement transition endpoint " + endpoint
          + " is assigned to another placement resource");
    }
    return BindingProblem.ref(assignment.demand.get("pool"), "placement demand.pool");
  }

  private void addPlacementViolation(ConstraintOutcome outcome, BindingProblem.Ref ref,
      String enforcement, double penalty, String message) {
    if ("hard".equals(enforcement)) outcome.hardViolationCount++;
    else {
      requireFiniteNonNegative(penalty, "placement transition penalty");
      outcome.softPenaltyByRef.put(ref.key(), Double.valueOf(penalty));
    }
    outcome.violations.add(new Violation(ref, enforcement, penalty, message));
  }

  private Map<String, Double> taskInvocations(JsonObject node, String pointer,
      Map<String, BindingProblem.Ref> binding, double multiplier, JsonObject branchContext) {
    Map<String, Double> result = new LinkedHashMap<String, Double>();
    String kind = node.get("kind").getAsString();
    if ("task".equals(kind)) {
      String task = BindingProblem.ref(node.get("task"), "workflow.task").id();
      if (binding.containsKey(task)) result.put(task, Double.valueOf(multiplier));
      return result;
    }
    if ("empty".equals(kind)) return result;
    if ("sequence".equals(kind) || "parallel".equals(kind)) {
      JsonArray children = node.getAsJsonArray("sequence".equals(kind) ? "steps" : "branches");
      String field = "sequence".equals(kind) ? "steps" : "branches";
      for (int index = 0; index < children.size(); index++) {
        mergeCounts(result, taskInvocations(children.get(index).getAsJsonObject(),
            pointer + "/" + field + "/" + index, binding, multiplier, branchContext));
      }
      return result;
    }
    if ("repeat".equals(kind)) {
      double count = node.has("count") ? node.get("count").getAsDouble()
          : node.get("expectedCount").getAsDouble();
      return taskInvocations(node.getAsJsonObject("body"), pointer + "/body",
          binding, multiplier * count, branchContext);
    }
    if ("exclusive".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      boolean routed = true;
      List<Double> probabilities = new ArrayList<Double>();
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = branches.get(index).getAsJsonObject();
        Double probability = problem.routingProbability(problem.workflowBranchRef(pointer, index,
            branch.get("id").getAsString()));
        probabilities.add(probability);
        if (probability == null) routed = false;
      }
      if (routed) {
        for (int index = 0; index < branches.size(); index++) {
          JsonObject branch = branches.get(index).getAsJsonObject();
          mergeCounts(result, taskInvocations(branch.getAsJsonObject("flow"),
              pointer + "/branches/" + index + "/flow", binding,
              multiplier * probabilities.get(index).doubleValue(), branchContext));
        }
        return result;
      }
      JsonObject selected = null;
      int selectedIndex = -1;
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = branches.get(index).getAsJsonObject();
        if (branch.has("when") && asBoolean(evaluateExpression(
            branch.getAsJsonObject("when"), branchContext), "exclusive branch.when")) {
          if (selected != null) throw new IllegalArgumentException("Conditional XOR selected more than one branch");
          selected = branch;
          selectedIndex = index;
        }
      }
      if (selected == null) throw new IllegalArgumentException("Conditional XOR selected no branch");
      return taskInvocations(selected.getAsJsonObject("flow"),
          pointer + "/branches/" + selectedIndex + "/flow", binding, multiplier, branchContext);
    }
    throw new IllegalArgumentException("Unsupported workflow kind '" + kind + "'");
  }

  private static void mergeCounts(Map<String, Double> target, Map<String, Double> values) {
    for (Map.Entry<String, Double> entry : values.entrySet()) {
      Double previous = target.get(entry.getKey());
      target.put(entry.getKey(), Double.valueOf(
          (previous == null ? 0.0 : previous.doubleValue()) + entry.getValue().doubleValue()));
    }
  }

  private JsonObject context(Map<String, BindingProblem.Ref> binding, Map<String, Double> metrics) {
    JsonObject context = new JsonObject();
    JsonObject bindingJson = new JsonObject();
    for (Map.Entry<String, BindingProblem.Ref> entry : binding.entrySet()) bindingJson.add(entry.getKey(), entry.getValue().toJson());
    JsonObject metricJson = new JsonObject();
    for (Map.Entry<String, Double> entry : metrics.entrySet()) metricJson.addProperty(entry.getKey(), entry.getValue());
    context.add("binding", bindingJson);
    context.add("metrics", metricJson);
    context.add("candidates", problem.candidatesJson());
    context.add("extensions", problem.extensions().deepCopy());
    context.add("placement", problem.placement().deepCopy());
    JsonObject taskContext = new JsonObject();
    for (String taskId : problem.taskIds()) {
      JsonObject task = new JsonObject();
      if (binding.containsKey(taskId)) {
        BindingProblem.Ref selected = binding.get(taskId);
        JsonObject candidate = problem.candidate(selected);
        task.add("candidate", selected.toJson());
        if (candidate.has("provider")) task.add("provider", candidate.get("provider").deepCopy());
        task.add("metrics", problem.candidateMetrics(selected));
        task.add("properties", candidate.has("properties")
            ? candidate.getAsJsonObject("properties").deepCopy() : new JsonObject());
      } else {
        task.add("candidate", JsonNull.INSTANCE);
        task.add("metrics", new JsonObject());
        task.add("properties", new JsonObject());
      }
      taskContext.add(taskId, task);
    }
    context.add("tasks", taskContext);
    return context;
  }

  private JsonElement evaluateExpression(JsonObject node, JsonObject context) {
    String kind = node.get("kind").getAsString();
    if ("literal".equals(kind)) return node.has("value") ? node.get("value") : JsonNull.INSTANCE;
    if ("path".equals(kind)) return path(context, node.getAsJsonArray("segments"));
    if ("not".equals(kind)) return new JsonPrimitive(!asBoolean(evaluateExpression(node.getAsJsonObject("value"), context), "not"));
    if ("negate".equals(kind)) {
      double value = -asNumber(evaluateExpression(node.getAsJsonObject("value"), context), "negate");
      if (!Double.isFinite(value)) throw new IllegalArgumentException("Expression produced non-finite number");
      return new JsonPrimitive(value);
    }
    if ("and".equals(kind)) {
      boolean left = asBoolean(evaluateExpression(node.getAsJsonObject("left"), context), "and.left");
      return new JsonPrimitive(left && asBoolean(evaluateExpression(node.getAsJsonObject("right"), context), "and.right"));
    }
    if ("or".equals(kind)) {
      boolean left = asBoolean(evaluateExpression(node.getAsJsonObject("left"), context), "or.left");
      return new JsonPrimitive(left || asBoolean(evaluateExpression(node.getAsJsonObject("right"), context), "or.right"));
    }
    if ("compare".equals(kind)) {
      JsonElement left = evaluateExpression(node.getAsJsonObject("left"), context);
      JsonElement right = evaluateExpression(node.getAsJsonObject("right"), context);
      return new JsonPrimitive(compare(left, right, node.get("op").getAsString()));
    }
    if ("arithmetic".equals(kind)) {
      double left = asNumber(evaluateExpression(node.getAsJsonObject("left"), context), "arithmetic.left");
      double right = asNumber(evaluateExpression(node.getAsJsonObject("right"), context), "arithmetic.right");
      String operation = node.get("op").getAsString();
      double result;
      if ("add".equals(operation)) result = left + right;
      else if ("sub".equals(operation)) result = left - right;
      else if ("mul".equals(operation)) result = left * right;
      else if ("div".equals(operation)) {
        if (right == 0.0) throw new IllegalArgumentException("Expression divides by zero");
        result = left / right;
      } else if ("pow".equals(operation)) result = Math.pow(left, right);
      else throw new IllegalArgumentException("Unsupported arithmetic operator '" + operation + "'");
      if (Double.isNaN(result) || Double.isInfinite(result)) throw new IllegalArgumentException("Expression produced non-finite number");
      return new JsonPrimitive(result);
    }
    if ("call".equals(kind)) {
      String name = node.get("name").getAsString();
      JsonArray args = node.getAsJsonArray("args");
      if ("has".equals(name)) {
        try { evaluateExpression(args.get(0).getAsJsonObject(), context); return new JsonPrimitive(true); }
        catch (IllegalArgumentException exception) { return new JsonPrimitive(false); }
      }
      List<JsonElement> evaluated = new ArrayList<JsonElement>();
      for (JsonElement argument : args) evaluated.add(evaluateExpression(argument.getAsJsonObject(), context));
      if ("weightedSum".equals(name) || "weightedProduct".equals(name)) {
        if (evaluated.size() != 2 || !evaluated.get(0).isJsonArray() || !evaluated.get(1).isJsonArray()) {
          throw new IllegalArgumentException(name + " requires values and weights lists");
        }
        List<Double> values = numericValues(evaluated.get(0), name);
        List<Double> weights = numericValues(evaluated.get(1), name);
        if (values.size() != weights.size()) {
          throw new IllegalArgumentException(name + " values and weights must have equal length");
        }
        double result = "weightedProduct".equals(name) ? 1.0 : 0.0;
        for (int index = 0; index < values.size(); index++) {
          if ("weightedProduct".equals(name)) {
            double value = values.get(index).doubleValue();
            double weight = weights.get(index).doubleValue();
            if (weight == 0.0) continue;
            if (value < 0.0 && weight != Math.rint(weight)) {
              throw new IllegalArgumentException(
                  "weightedProduct cannot raise a negative value to a fractional weight");
            }
            result *= Math.pow(value, weight);
          } else {
            result += values.get(index).doubleValue() * weights.get(index).doubleValue();
          }
        }
        if (!Double.isFinite(result)) throw new IllegalArgumentException(name + " result must be finite");
        return new JsonPrimitive(result);
      }
      List<Double> values = new ArrayList<Double>();
      if (evaluated.size() == 1 && evaluated.get(0).isJsonArray()) {
        values.addAll(numericValues(evaluated.get(0), name));
      } else {
        for (JsonElement item : evaluated) values.add(Double.valueOf(asNumber(item, name)));
      }
      if (values.isEmpty()) throw new IllegalArgumentException(name + " requires at least one argument");
      if ("min".equals(name)) return new JsonPrimitive(Collections.min(values));
      if ("max".equals(name)) return new JsonPrimitive(Collections.max(values));
      double result = "product".equals(name) ? 1.0 : 0.0;
      for (Double item : values) result = "product".equals(name) ? result * item.doubleValue() : result + item.doubleValue();
      return new JsonPrimitive(result);
    }
    throw new IllegalArgumentException("Unsupported expression kind '" + kind + "'");
  }

  private static List<Double> numericValues(JsonElement value, String name) {
    if (!value.isJsonArray()) throw new IllegalArgumentException(name + " argument must be a numeric list");
    List<Double> numbers = new ArrayList<Double>();
    for (JsonElement item : value.getAsJsonArray()) numbers.add(Double.valueOf(asNumber(item, name + " argument")));
    return numbers;
  }

  private JsonElement path(JsonObject context, JsonArray segments) {
    JsonElement current = context;
    for (JsonElement item : segments) {
      String segment = item.getAsString();
      if (!current.isJsonObject() || !current.getAsJsonObject().has(segment)) {
        throw new IllegalArgumentException("Unknown expression path " + segments);
      }
      current = current.getAsJsonObject().get(segment);
    }
    return current;
  }

  private static boolean compare(JsonElement left, JsonElement right, String operation) {
    if (left.isJsonPrimitive() && right.isJsonPrimitive()
        && left.getAsJsonPrimitive().isNumber() && right.getAsJsonPrimitive().isNumber()) {
      double a = left.getAsDouble(), b = right.getAsDouble();
      if ("eq".equals(operation)) return a == b;
      if ("ne".equals(operation)) return a != b;
      if ("lt".equals(operation)) return a < b;
      if ("lte".equals(operation)) return a <= b;
      if ("gt".equals(operation)) return a > b;
      if ("gte".equals(operation)) return a >= b;
    }
    boolean bothStrings = left.isJsonPrimitive() && right.isJsonPrimitive()
        && left.getAsJsonPrimitive().isString() && right.getAsJsonPrimitive().isString();
    if (bothStrings) {
      int order = compareCodePoints(left.getAsString(), right.getAsString());
      if ("eq".equals(operation)) return order == 0;
      if ("ne".equals(operation)) return order != 0;
      if ("lt".equals(operation)) return order < 0;
      if ("lte".equals(operation)) return order <= 0;
      if ("gt".equals(operation)) return order > 0;
      if ("gte".equals(operation)) return order >= 0;
    }
    boolean sameRuntimeType = (left.isJsonNull() && right.isJsonNull())
        || (left.isJsonArray() && right.isJsonArray())
        || (left.isJsonObject() && right.isJsonObject())
        || (left.isJsonPrimitive() && right.isJsonPrimitive()
            && left.getAsJsonPrimitive().isBoolean() && right.getAsJsonPrimitive().isBoolean());
    if (sameRuntimeType && "eq".equals(operation)) return left.equals(right);
    if (sameRuntimeType && "ne".equals(operation)) return !left.equals(right);
    if ("eq".equals(operation) || "ne".equals(operation)) {
      throw new IllegalArgumentException("Equality operands have incompatible runtime types");
    }
    throw new IllegalArgumentException("Ordered comparison requires two numbers or two strings");
  }

  private static int compareCodePoints(String left, String right) {
    int leftIndex = 0, rightIndex = 0;
    while (leftIndex < left.length() && rightIndex < right.length()) {
      int leftPoint = left.codePointAt(leftIndex);
      int rightPoint = right.codePointAt(rightIndex);
      if (leftPoint != rightPoint) return Integer.compare(leftPoint, rightPoint);
      leftIndex += Character.charCount(leftPoint);
      rightIndex += Character.charCount(rightPoint);
    }
    if (leftIndex == left.length() && rightIndex == right.length()) return 0;
    return leftIndex == left.length() ? -1 : 1;
  }

  private static boolean asBoolean(JsonElement value, String where) {
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
      throw new IllegalArgumentException(where + " must evaluate to boolean");
    }
    return value.getAsBoolean();
  }

  private static double asNumber(JsonElement value, String where) {
    return BindingProblem.finiteNumber(value, where);
  }

  private static double objectiveLoss(double raw, JsonObject term) {
    double value = raw;
    if (term.has("normalize")) {
      JsonObject normalize = term.getAsJsonObject("normalize");
      double min = normalize.get("min").getAsDouble();
      double max = normalize.get("max").getAsDouble();
      value = (raw - min) / (max - min);
      if (normalize.has("clamp") && normalize.get("clamp").getAsBoolean()) {
        value = Math.max(0.0, Math.min(1.0, value));
      }
    }
    if ("maximize".equals(term.get("direction").getAsString())) {
      value = term.has("normalize") ? 1.0 - value : -value;
    }
    if (Double.isNaN(value) || Double.isInfinite(value)) throw new IllegalArgumentException("Objective produced non-finite value");
    return value;
  }

  private static void requireFiniteNonNegative(double value, String where) {
    if (Double.isNaN(value) || Double.isInfinite(value) || value < 0.0) {
      throw new IllegalArgumentException(where + " must be finite and non-negative");
    }
  }

}
