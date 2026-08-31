package es.us.isa.openbinding.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The canonical, source-free input consumed by every JVM engine.
 *
 * <p>This class deliberately models the compiler IR instead of any authoring
 * document.  In particular, candidate identifiers are scoped by their catalog
 * and decisions therefore use {@code {resource,id}} references.  An engine
 * receiving an {@code Instance}, source resource, URL, or an earlier shape
 * fails before search starts.</p>
 */
public final class BindingProblem {
  public static final String API_VERSION = "bim/v1";
  public static final String KIND = "BindingProblem";

  public static final class Ref {
    private final String resource;
    private final String id;

    public Ref(String resource, String id) {
      if (resource == null || resource.isEmpty() || id == null || id.isEmpty()) {
        throw new IllegalArgumentException("A reference requires non-empty resource and id");
      }
      this.resource = resource;
      this.id = id;
    }

    public String resource() { return resource; }
    public String id() { return id; }

    public JsonObject toJson() {
      JsonObject value = new JsonObject();
      value.addProperty("resource", resource);
      value.addProperty("id", id);
      return value;
    }

    public String key() { return resource + "\u0000" + id; }

    @Override public boolean equals(Object other) {
      if (!(other instanceof Ref)) return false;
      Ref ref = (Ref) other;
      return resource.equals(ref.resource) && id.equals(ref.id);
    }

    @Override public int hashCode() { return 31 * resource.hashCode() + id.hashCode(); }
    @Override public String toString() { return resource + ":" + id; }
  }

  private final JsonObject document;
  private final JsonObject spec;
  private final JsonObject application;
  private final String applicationResource;
  private final JsonObject tasks;
  private final JsonObject metrics;
  private final JsonObject catalogs;
  private final JsonObject eligibility;
  private final Map<Ref, Double> routing;
  private final List<String> serviceTasks;
  private final List<String> requiredMetrics;
  private final Map<String, JsonObject> metricDefinitions;
  private final Map<String, Map<String, String>> metricAliases;
  private final Map<String, String> constraintEnforcement;

  public BindingProblem(JsonObject document) {
    if (document == null) throw new IllegalArgumentException("BindingProblem is required");
    this.document = document.deepCopy();
    requireOnly(this.document, "BindingProblem", "apiVersion", "kind", "metadata", "spec");
    requireExact(this.document, "apiVersion", API_VERSION, "BindingProblem");
    requireExact(this.document, "kind", KIND, "BindingProblem");
    JsonObject metadata = requireObject(this.document, "metadata", "BindingProblem");
    requireOnly(metadata, "BindingProblem.metadata", "name");
    requiredString(metadata, "name", "BindingProblem.metadata");
    this.spec = requireObject(this.document, "spec", "BindingProblem");
    requireOnly(spec, "BindingProblem.spec", "profile", "dialects", "instance", "application",
        "candidates", "eligibility", "routing", "constraints", "placement", "optimization",
        "extensions", "sourceMap");
    validateIdentity();
    this.application = requireObject(spec, "application", "BindingProblem.spec");
    requireOnly(application, "BindingProblem.spec.application", "resource", "tasks", "metrics",
        "requiredMetrics", "taskRequiredMetrics", "workflow");
    this.applicationResource = requiredString(application, "resource", "BindingProblem.spec.application");
    this.tasks = requireObject(application, "tasks", "BindingProblem.spec.application");
    this.metrics = requireObject(application, "metrics", "BindingProblem.spec.application");
    this.catalogs = requireObject(spec, "candidates", "BindingProblem.spec");
    this.eligibility = requireObject(spec, "eligibility", "BindingProblem.spec");
    requireArray(spec, "routing", "BindingProblem.spec");
    requireArray(spec, "constraints", "BindingProblem.spec");
    requireArray(spec, "placement", "BindingProblem.spec");
    requireObject(spec, "optimization", "BindingProblem.spec");
    requireObject(spec, "extensions", "BindingProblem.spec");
    requireObject(spec, "sourceMap", "BindingProblem.spec");
    requireObject(application, "workflow", "BindingProblem.spec.application");

    this.serviceTasks = new ArrayList<String>();
    this.requiredMetrics = new ArrayList<String>();
    this.metricDefinitions = new LinkedHashMap<String, JsonObject>();
    this.metricAliases = new LinkedHashMap<String, Map<String, String>>();
    this.constraintEnforcement = new LinkedHashMap<String, String>();
    this.routing = new LinkedHashMap<Ref, Double>();
    validateTasks();
    validateMetrics();
    validateRequiredMetrics();
    validateCandidatesAndEligibility();
    validateWorkflow(application.getAsJsonObject("workflow"), "/spec/application/workflow", 0);
    validateRouting(application.getAsJsonObject("workflow"));
    validateConstraints();
    validatePlacement();
    validateOptimization();
  }

  public JsonObject document() { return document.deepCopy(); }
  public JsonObject spec() { return spec; }
  public JsonObject application() { return application; }
  public String applicationResource() { return applicationResource; }
  public JsonObject workflow() { return application.getAsJsonObject("workflow"); }
  public JsonArray routing() { return spec.getAsJsonArray("routing"); }
  public JsonObject extensions() { return spec.getAsJsonObject("extensions"); }
  public JsonArray constraints() { return spec.getAsJsonArray("constraints"); }
  public JsonObject optimization() { return spec.getAsJsonObject("optimization"); }
  public JsonArray placement() {
    return spec.has("placement") ? spec.getAsJsonArray("placement") : new JsonArray();
  }
  public List<String> serviceTasks() { return Collections.unmodifiableList(serviceTasks); }
  public Set<String> taskIds() { return Collections.unmodifiableSet(tasks.keySet()); }
  public Map<String, JsonObject> metricDefinitions() {
    return Collections.unmodifiableMap(metricDefinitions);
  }
  public List<String> requiredMetrics() { return Collections.unmodifiableList(requiredMetrics); }
  public JsonObject task(String taskId) { return tasks.getAsJsonObject(taskId); }

  public Double routingProbability(Ref target) { return routing.get(target); }

  public List<Ref> eligible(String taskId) {
    JsonArray values = eligibility.getAsJsonArray(taskId);
    if (values == null) return Collections.emptyList();
    List<Ref> refs = new ArrayList<Ref>();
    for (JsonElement value : values) refs.add(ref(value, "eligibility." + taskId));
    return refs;
  }

  public JsonObject candidate(Ref ref) {
    JsonObject catalog = catalogs.getAsJsonObject(ref.resource());
    JsonObject values = catalog == null ? null : catalog.getAsJsonObject("candidates");
    if (values == null || !values.has(ref.id()) || !values.get(ref.id()).isJsonObject()) {
      throw new IllegalArgumentException("Unknown candidate reference " + ref);
    }
    return values.getAsJsonObject(ref.id());
  }

  public double candidateMetric(Ref ref, String metricId) {
    JsonObject values = candidateMetrics(ref);
    if (!values.has(metricId)) {
      throw new IllegalArgumentException("Candidate " + ref + " does not provide metric '" + metricId + "'");
    }
    return finiteNumber(values.get(metricId), "candidate " + ref + " metric " + metricId);
  }

  public JsonObject candidateMetrics(Ref ref) {
    JsonObject local = requireObject(candidate(ref), "metrics", "candidate " + ref);
    Map<String, String> aliases = metricAliases.get(ref.resource());
    JsonObject canonical = new JsonObject();
    if (aliases == null) return canonical;
    for (Map.Entry<String, String> entry : aliases.entrySet()) {
      if (local.has(entry.getValue())) canonical.add(entry.getKey(), local.get(entry.getValue()).deepCopy());
    }
    return canonical;
  }

  public JsonObject candidatesJson() { return catalogs; }

  public static Ref ref(JsonElement element, String where) {
    if (element == null || !element.isJsonObject()) {
      throw new IllegalArgumentException(where + " must be a {resource,id} reference");
    }
    JsonObject value = element.getAsJsonObject();
    Set<String> unknown = new LinkedHashSet<String>(value.keySet());
    unknown.remove("resource");
    unknown.remove("id");
    if (!unknown.isEmpty()) {
      throw new IllegalArgumentException(where + " has unknown reference fields " + unknown);
    }
    return new Ref(requiredString(value, "resource", where), requiredString(value, "id", where));
  }

  private void validateTasks() {
    if (tasks.size() == 0) throw new IllegalArgumentException("application.tasks cannot be empty");
    for (Map.Entry<String, JsonElement> entry : tasks.entrySet()) {
      if (!entry.getValue().isJsonObject()) {
        throw new IllegalArgumentException("Task '" + entry.getKey() + "' must be an object");
      }
      JsonObject task = entry.getValue().getAsJsonObject();
      String kind = requiredString(task, "kind", "task " + entry.getKey());
      if ("service".equals(kind)) {
        requireOnly(task, "task " + entry.getKey(), "kind", "name", "requires");
        serviceTasks.add(entry.getKey());
        JsonObject requires = requireObject(task, "requires", "service task " + entry.getKey());
        requireOnly(requires, "service task " + entry.getKey() + ".requires", "type", "predicate");
        requiredString(requires, "type", "service task " + entry.getKey() + ".requires");
        if (requires.has("predicate")) validateExpression(
            requireObject(requires, "predicate", "service task " + entry.getKey() + ".requires"), 0);
      } else if (!"local".equals(kind)) {
        throw new IllegalArgumentException("Task '" + entry.getKey() + "' has unsupported kind '" + kind + "'");
      } else {
        requireOnly(task, "task " + entry.getKey(), "kind", "name");
      }
    }
  }

  private void validateMetrics() {
    for (Map.Entry<String, JsonElement> entry : metrics.entrySet()) {
      if (!entry.getValue().isJsonObject()) {
        throw new IllegalArgumentException("Metric '" + entry.getKey() + "' must be an object");
      }
      JsonObject metric = entry.getValue().getAsJsonObject();
      requireOnly(metric, "metric " + entry.getKey(), "name", "type", "unit", "domain",
          "direction", "scope", "neutral", "aggregation");
      requireExact(metric, "type", "number", "metric " + entry.getKey());
      requiredString(metric, "unit", "metric " + entry.getKey());
      requireObject(metric, "domain", "metric " + entry.getKey());
      String direction = requiredString(metric, "direction", "metric " + entry.getKey());
      if (!"minimize".equals(direction) && !"maximize".equals(direction)) {
        throw new IllegalArgumentException("Metric '" + entry.getKey() + "' has invalid direction '" + direction + "'");
      }
      String scope = optionalString(metric, "scope", "invocation");
      if (!"invocation".equals(scope) && !"selectedCandidate".equals(scope)) {
        throw new IllegalArgumentException("Metric '" + entry.getKey() + "' has unsupported scope '" + scope + "'");
      }
      finiteNumber(metric.get("neutral"), "metric " + entry.getKey() + ".neutral");
      JsonObject aggregation = requireObject(metric, "aggregation", "metric " + entry.getKey());
      validateAggregation(entry.getKey(), aggregation);
      metricDefinitions.put(entry.getKey(), metric);
    }
  }

  private void validateRequiredMetrics() {
    JsonArray global = requireArray(application, "requiredMetrics", "BindingProblem.spec.application");
    Set<String> unique = new LinkedHashSet<String>();
    for (JsonElement value : global) {
      if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
          || value.getAsString().isEmpty()) {
        throw new IllegalArgumentException("application.requiredMetrics must contain metric identifiers");
      }
      String metric = value.getAsString();
      if (!metricDefinitions.containsKey(metric)) {
        throw new IllegalArgumentException("application.requiredMetrics references unknown metric '" + metric + "'");
      }
      if (!unique.add(metric)) {
        throw new IllegalArgumentException("application.requiredMetrics contains duplicate metric '" + metric + "'");
      }
      requiredMetrics.add(metric);
    }
    JsonObject local = requireObject(application, "taskRequiredMetrics", "BindingProblem.spec.application");
    for (Map.Entry<String, JsonElement> entry : local.entrySet()) {
      if (!serviceTasks.contains(entry.getKey()) || !entry.getValue().isJsonArray()) {
        throw new IllegalArgumentException("application.taskRequiredMetrics contains an invalid task entry '"
            + entry.getKey() + "'");
      }
      Set<String> taskMetrics = new LinkedHashSet<String>();
      for (JsonElement value : entry.getValue().getAsJsonArray()) {
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
            || !metricDefinitions.containsKey(value.getAsString()) || !taskMetrics.add(value.getAsString())) {
          throw new IllegalArgumentException("application.taskRequiredMetrics." + entry.getKey()
              + " must contain unique known metric identifiers");
        }
      }
    }
  }

  private static void validateAggregation(String metricId, JsonObject aggregation) {
    String[] keys = {"sequence", "parallel", "exclusive", "repeat", "selection"};
    Set<String> allowed = new LinkedHashSet<String>();
    Collections.addAll(allowed, keys);
    Set<String> unknown = new LinkedHashSet<String>(aggregation.keySet());
    unknown.removeAll(allowed);
    if (!unknown.isEmpty()) {
      throw new IllegalArgumentException("Metric '" + metricId + "' has unknown aggregation fields " + unknown);
    }
    for (String key : keys) {
      if (!aggregation.has(key)) {
        throw new IllegalArgumentException("metric " + metricId + ".aggregation." + key + " is required");
      }
      JsonElement raw = aggregation.get(key);
      if (raw.isJsonObject()) {
        JsonObject custom = raw.getAsJsonObject();
        requireOnly(custom, "metric " + metricId + ".aggregation." + key, "expression");
        validateExpression(requireObject(custom, "expression",
            "metric " + metricId + ".aggregation." + key), 0);
        continue;
      }
      if (!raw.isJsonPrimitive() || !raw.getAsJsonPrimitive().isString()) {
        throw new IllegalArgumentException("metric " + metricId + ".aggregation." + key
            + " must be an operator or ExpressionIR");
      }
      String operation = raw.getAsString();
      boolean simple = "sum".equals(operation) || "product".equals(operation)
          || "min".equals(operation) || "max".equals(operation);
      boolean valid = (("sequence".equals(key) || "parallel".equals(key) || "selection".equals(key)) && simple)
          || ("exclusive".equals(key) && ("weightedSum".equals(operation)
              || "weightedProduct".equals(operation) || "min".equals(operation) || "max".equals(operation)))
          || ("repeat".equals(key) && ("scale".equals(operation)
              || "power".equals(operation) || "identity".equals(operation)));
      if (!valid) {
        throw new IllegalArgumentException("Unsupported " + key + " aggregation '" + operation
            + "' for metric '" + metricId + "'");
      }
    }
  }

  private void validateCandidatesAndEligibility() {
    for (Map.Entry<String, JsonElement> catalogEntry : catalogs.entrySet()) {
      if (!catalogEntry.getValue().isJsonObject()) {
        throw new IllegalArgumentException("Candidate catalog '" + catalogEntry.getKey() + "' must be an object");
      }
      String catalogId = catalogEntry.getKey();
      JsonObject catalog = catalogEntry.getValue().getAsJsonObject();
      requireOnly(catalog, "candidate catalog " + catalogId, "providers", "metricBindings", "candidates");
      JsonObject providers = requireObject(catalog, "providers", "candidate catalog " + catalogId);
      for (Map.Entry<String, JsonElement> providerEntry : providers.entrySet()) {
        JsonObject provider = object(providerEntry.getValue(), "provider " + catalogId + ":" + providerEntry.getKey());
        requireOnly(provider, "provider " + catalogId + ":" + providerEntry.getKey(), "name", "properties");
        if (provider.has("name")) requiredString(provider, "name", "provider " + catalogId + ":" + providerEntry.getKey());
        requireObject(provider, "properties", "provider " + catalogId + ":" + providerEntry.getKey());
      }
      JsonObject bindings = requireObject(catalog, "metricBindings", "candidate catalog " + catalogId);
      Map<String, String> canonicalToAlias = new LinkedHashMap<String, String>();
      for (Map.Entry<String, JsonElement> binding : bindings.entrySet()) {
        Ref metric = ref(binding.getValue(), "candidate catalog " + catalogId + ".metricBindings." + binding.getKey());
        if (!applicationResource.equals(metric.resource()) || !metricDefinitions.containsKey(metric.id())) {
          throw new IllegalArgumentException("Candidate catalog " + catalogId
              + " binds alias '" + binding.getKey() + "' to unknown metric " + metric);
        }
        if (canonicalToAlias.put(metric.id(), binding.getKey()) != null) {
          throw new IllegalArgumentException("Candidate catalog " + catalogId
              + " binds the same metric more than once: " + metric);
        }
      }
      metricAliases.put(catalogId, canonicalToAlias);
      JsonObject catalogCandidates = requireObject(catalog, "candidates", "candidate catalog " + catalogId);
      if (catalogCandidates.size() == 0) {
        throw new IllegalArgumentException("Candidate catalog '" + catalogId + "' cannot be empty");
      }
      for (Map.Entry<String, JsonElement> candidateEntry : catalogCandidates.entrySet()) {
        if (!candidateEntry.getValue().isJsonObject()) {
          throw new IllegalArgumentException("Candidate '" + candidateEntry.getKey() + "' must be an object");
        }
        JsonObject candidate = candidateEntry.getValue().getAsJsonObject();
        requireOnly(candidate, "candidate " + catalogId + ":" + candidateEntry.getKey(),
            "ref", "name", "provider", "provides", "properties", "metrics");
        Ref declared = ref(candidate.get("ref"), "candidate.ref");
        if (!catalogId.equals(declared.resource()) || !candidateEntry.getKey().equals(declared.id())) {
          throw new IllegalArgumentException("Candidate map key and candidate.ref disagree for " + declared);
        }
        if (candidate.has("provider")) {
          Ref provider = ref(candidate.get("provider"), "candidate " + declared + ".provider");
          if (!catalogId.equals(provider.resource()) || !providers.has(provider.id())) {
            throw new IllegalArgumentException("Candidate " + declared + " references unknown provider " + provider);
          }
        }
        requireObject(candidate, "properties", "candidate " + declared);
        JsonArray provides = requireArray(candidate, "provides", "candidate " + declared);
        for (JsonElement providedValue : provides) {
          JsonObject provided = object(providedValue, "candidate " + declared + ".provides");
          requireOnly(provided, "candidate " + declared + ".provides", "type", "properties");
          requiredString(provided, "type", "candidate " + declared + ".provides");
          requireObject(provided, "properties", "candidate " + declared + ".provides");
        }
        JsonObject candidateMetrics = requireObject(candidate, "metrics", "candidate " + declared);
        for (Map.Entry<String, JsonElement> value : candidateMetrics.entrySet()) {
          if (!bindings.has(value.getKey())) {
            throw new IllegalArgumentException("Candidate " + declared + " provides unknown metric alias '" + value.getKey() + "'");
          }
          finiteNumber(value.getValue(), "candidate " + declared + " metric " + value.getKey());
        }
      }
    }

    Set<String> allowedEligibility = new LinkedHashSet<String>(serviceTasks);
    Set<String> actualEligibility = new LinkedHashSet<String>(eligibility.keySet());
    if (!actualEligibility.equals(allowedEligibility)) {
      throw new IllegalArgumentException("eligibility keys must be exactly the service tasks; expected "
          + allowedEligibility + " but found " + actualEligibility);
    }
    for (String taskId : serviceTasks) {
      JsonArray values = requireArray(eligibility, taskId, "eligibility");
      if (values.size() == 0) throw new IllegalArgumentException("No eligible candidate for service task '" + taskId + "'");
      Set<Ref> unique = new LinkedHashSet<Ref>();
      for (JsonElement value : values) {
        Ref candidateRef = ref(value, "eligibility." + taskId);
        candidate(candidateRef);
        if (!unique.add(candidateRef)) throw new IllegalArgumentException("Duplicate eligibility reference " + candidateRef);
        for (String metric : requiredMetrics) candidateMetric(candidateRef, metric);
        JsonObject taskRequired = application.getAsJsonObject("taskRequiredMetrics");
        if (taskRequired.has(taskId)) {
          for (JsonElement metric : taskRequired.getAsJsonArray(taskId)) {
            candidateMetric(candidateRef, metric.getAsString());
          }
        }
      }
    }
  }

  private void validateWorkflow(JsonObject node, String pointer, int depth) {
    if (depth > 128) throw new IllegalArgumentException("Workflow exceeds maximum nesting depth");
    String kind = requiredString(node, "kind", pointer);
    if ("task".equals(kind)) {
      requireOnly(node, pointer, "kind", "id", "task");
      Ref taskRef = ref(node.get("task"), pointer + ".task");
      if (!tasks.has(taskRef.id())) throw new IllegalArgumentException("Workflow references unknown task '" + taskRef.id() + "'");
      if (!applicationResource.equals(taskRef.resource())) {
        throw new IllegalArgumentException("Workflow task reference " + taskRef
            + " must target application resource '" + applicationResource + "'");
      }
      return;
    }
    if ("empty".equals(kind)) { requireOnly(node, pointer, "kind", "id"); return; }
    if ("sequence".equals(kind)) {
      requireOnly(node, pointer, "kind", "id", "steps");
      validateChildren(requireArray(node, "steps", pointer), pointer + ".steps", depth);
      return;
    }
    if ("parallel".equals(kind)) {
      requireOnly(node, pointer, "kind", "id", "branches");
      validateChildren(requireArray(node, "branches", pointer), pointer + ".branches", depth);
      return;
    }
    if ("exclusive".equals(kind)) {
      requireOnly(node, pointer, "kind", "id", "branches");
      JsonArray branches = requireArray(node, "branches", pointer);
      if (branches.size() == 0) throw new IllegalArgumentException(pointer + ".branches cannot be empty");
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = object(branches.get(index), pointer + ".branches[" + index + "]");
        requireOnly(branch, pointer + ".branches[" + index + "]", "id", "flow", "when");
        requiredString(branch, "id", pointer + ".branches[" + index + "]");
        validateWorkflow(requireObject(branch, "flow", pointer + ".branches[" + index + "]"), pointer, depth + 1);
      }
      return;
    }
    if ("repeat".equals(kind)) {
      requireOnly(node, pointer, "kind", "id", "body", "count", "expectedCount");
      boolean count = node.has("count");
      boolean expected = node.has("expectedCount");
      if (count == expected) throw new IllegalArgumentException(pointer + " requires exactly one of count or expectedCount");
      double repetitions = finiteNumber(node.get(count ? "count" : "expectedCount"), pointer + ".repeat count");
      if (repetitions < 0 || (count && repetitions != Math.rint(repetitions))) {
        throw new IllegalArgumentException(pointer + " repeat count is invalid");
      }
      validateWorkflow(requireObject(node, "body", pointer), pointer + ".body", depth + 1);
      return;
    }
    throw new IllegalArgumentException(pointer + " has unsupported workflow kind '" + kind + "'");
  }

  private void validateChildren(JsonArray children, String pointer, int depth) {
    for (int index = 0; index < children.size(); index++) {
      validateWorkflow(object(children.get(index), pointer + "[" + index + "]"), pointer + "[" + index + "]", depth + 1);
    }
  }

  private void validateRouting(JsonObject workflow) {
    Ref previous = null;
    for (JsonElement value : routing()) {
      JsonObject entry = object(value, "routing entry");
      requireOnly(entry, "routing entry", "target", "probability");
      Ref target = ref(entry.get("target"), "routing entry.target");
      double probability = finiteNumber(entry.get("probability"), "routing entry.probability");
      if (probability < 0.0 || probability > 1.0) {
        throw new IllegalArgumentException("Routing probability is outside [0,1]");
      }
      if (routing.put(target, Double.valueOf(probability)) != null) {
        throw new IllegalArgumentException("Duplicate routing target " + target);
      }
      if (previous != null && compareRefs(previous, target) >= 0) {
        throw new IllegalArgumentException("Routing entries must be canonically ordered by target reference");
      }
      previous = target;
    }
    List<JsonObject> xors = new ArrayList<JsonObject>();
    List<String> pointers = new ArrayList<String>();
    collectXors(workflow, "/spec/application/workflow", xors, pointers);
    Set<Ref> used = new LinkedHashSet<Ref>();
    Set<Ref> declaredBranches = new LinkedHashSet<Ref>();
    for (int xorIndex = 0; xorIndex < xors.size(); xorIndex++) {
      JsonObject xor = xors.get(xorIndex);
      String pointer = pointers.get(xorIndex);
      JsonArray branches = xor.getAsJsonArray("branches");
      int probabilistic = 0;
      int conditional = 0;
      double sum = 0.0;
      for (int branchIndex = 0; branchIndex < branches.size(); branchIndex++) {
        JsonElement value = branches.get(branchIndex);
        JsonObject branch = value.getAsJsonObject();
        String id = branch.get("id").getAsString();
        Ref target = workflowBranchRef(pointer, branchIndex, id);
        if (!declaredBranches.add(target)) {
          throw new IllegalArgumentException("Duplicate workflow branch reference " + target);
        }
        if (routing.containsKey(target)) {
          probabilistic++;
          double probability = routing.get(target).doubleValue();
          sum += probability;
          used.add(target);
        }
        if (branch.has("when")) {
          conditional++;
          validateExpression(requireObject(branch, "when", "exclusive branch " + id), 0);
        }
      }
      if (probabilistic == branches.size() && conditional == 0) {
        // Source decimals sum exactly to one; the canonical IR stores IEEE-754
        // numbers, so permit only the rounding error introduced by lowering.
        if (Math.abs(sum - 1.0) > 1e-12) {
          throw new IllegalArgumentException("XOR routing probabilities must sum to 1");
        }
      } else if (probabilistic == 0 && conditional == branches.size()) {
        // The selected binding must make exactly one static condition true;
        // CanonicalEvaluator checks that decision-dependent invariant.
      } else {
        throw new IllegalArgumentException("Each XOR must be fully probabilistic or fully conditional, never partial or mixed");
      }
    }
    Set<Ref> extra = new LinkedHashSet<Ref>(routing.keySet());
    extra.removeAll(used);
    if (!extra.isEmpty()) throw new IllegalArgumentException("Routing contains unknown targets " + extra);
  }

  Ref workflowBranchRef(String xorPointer, int branchIndex, String id) {
    JsonObject sourceMap = spec.getAsJsonObject("sourceMap");
    String branchPointer = xorPointer + "/branches/" + branchIndex;
    String elementPointer = "/spec/application/workflow/elements/" + escapePointer(id);
    JsonElement location = sourceMap.get(branchPointer);
    if (location == null) location = sourceMap.get(elementPointer);
    String owner = applicationResource;
    if (location != null && location.isJsonObject() && location.getAsJsonObject().has("resource")) {
      owner = requiredString(location.getAsJsonObject(), "resource", "sourceMap " + branchPointer);
    }
    return new Ref(owner, id);
  }

  private static int compareRefs(Ref left, Ref right) {
    int resource = left.resource().compareTo(right.resource());
    return resource != 0 ? resource : left.id().compareTo(right.id());
  }

  private static String escapePointer(String value) {
    return value.replace("~", "~0").replace("/", "~1");
  }

  private void collectXors(JsonObject node, String pointer, List<JsonObject> xors,
      List<String> pointers) {
    String kind = node.get("kind").getAsString();
    if ("exclusive".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = branches.get(index).getAsJsonObject();
        collectXors(branch.getAsJsonObject("flow"), pointer + "/branches/" + index + "/flow", xors, pointers);
      }
      xors.add(node);
      pointers.add(pointer);
    } else if ("sequence".equals(kind)) {
      JsonArray steps = node.getAsJsonArray("steps");
      for (int index = 0; index < steps.size(); index++) {
        collectXors(steps.get(index).getAsJsonObject(), pointer + "/steps/" + index, xors, pointers);
      }
    } else if ("parallel".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      for (int index = 0; index < branches.size(); index++) {
        collectXors(branches.get(index).getAsJsonObject(), pointer + "/branches/" + index, xors, pointers);
      }
    } else if ("repeat".equals(kind)) {
      collectXors(node.getAsJsonObject("body"), pointer + "/body", xors, pointers);
    }
  }

  private void validateConstraints() {
    for (JsonElement value : constraints()) {
      JsonObject constraint = object(value, "constraint");
      requireOnly(constraint, "constraint", "ref", "when", "assert", "enforcement", "penalty");
      Ref constraintRef = ref(constraint.get("ref"), "constraint.ref");
      if (constraintEnforcement.containsKey(constraintRef.key())) {
        throw new IllegalArgumentException("Duplicate constraint reference " + constraintRef);
      }
      String enforcement = requiredString(constraint, "enforcement", "constraint " + constraintRef);
      if (!"hard".equals(enforcement) && !"soft".equals(enforcement)) {
        throw new IllegalArgumentException("Unsupported constraint enforcement '" + enforcement + "'");
      }
      constraintEnforcement.put(constraintRef.key(), enforcement);
      validateExpression(requireObject(constraint, "when", "constraint " + constraintRef), 0);
      validateExpression(requireObject(constraint, "assert", "constraint " + constraintRef), 0);
      if ("soft".equals(enforcement)) validateExpression(requireObject(constraint, "penalty", "constraint " + constraintRef), 0);
      else if (constraint.has("penalty")) throw new IllegalArgumentException("Hard constraint " + constraintRef + " cannot have a penalty");
    }
  }

  private void validateOptimization() {
    JsonObject optimization = optimization();
    requireOnly(optimization, "optimization", "resource", "mode", "type", "terms", "penalties");
    requiredString(optimization, "resource", "optimization");
    String mode = requiredString(optimization, "mode", "optimization");
    if (!"satisfy".equals(mode) && !"weighted".equals(mode)
        && !"lexicographic".equals(mode) && !"pareto".equals(mode)) {
      throw new IllegalArgumentException("Unsupported optimization mode '" + mode + "'");
    }
    String objectiveType = requiredString(optimization, "type", "optimization");
    if (!"MONO".equals(objectiveType) && !"MULTI".equals(objectiveType)
        && !"MANY".equals(objectiveType)) {
      throw new IllegalArgumentException("Unsupported objective type '" + objectiveType + "'");
    }
    JsonArray terms = requireArray(optimization, "terms", "optimization");
    if ("satisfy".equals(mode) && terms.size() != 0) throw new IllegalArgumentException("satisfy optimization cannot contain terms");
    if (!"satisfy".equals(mode) && terms.size() == 0) throw new IllegalArgumentException(mode + " optimization requires terms");
    if ("satisfy".equals(mode) && !"MONO".equals(objectiveType)) {
      throw new IllegalArgumentException("satisfy optimization must use objective type MONO");
    }
    if ("MULTI".equals(objectiveType) && (terms.size() < 2 || terms.size() > 3)) {
      throw new IllegalArgumentException("MULTI optimization requires two or three terms");
    }
    if ("MANY".equals(objectiveType) && terms.size() < 3) {
      throw new IllegalArgumentException("MANY optimization requires at least three terms");
    }
    double termWeightTotal = 0.0;
    for (JsonElement value : terms) {
      JsonObject term = object(value, "optimization term");
      requireOnly(term, "optimization term", "metric", "direction", "weight", "normalize");
      Ref metric = ref(term.get("metric"), "optimization term.metric");
      if (!metricDefinitions.containsKey(metric.id())) throw new IllegalArgumentException("Unknown optimization metric " + metric);
      if (!requiredMetrics.contains(metric.id())) {
        throw new IllegalArgumentException("Optimization metric is not materialized in application.requiredMetrics: " + metric);
      }
      if (!applicationResource.equals(metric.resource())) {
        throw new IllegalArgumentException("Optimization metric " + metric
            + " must target application resource '" + applicationResource + "'");
      }
      String direction = requiredString(term, "direction", "optimization term");
      if (!"minimize".equals(direction) && !"maximize".equals(direction)) throw new IllegalArgumentException("Invalid objective direction");
      double weight = finiteNumber(term.get("weight"), "optimization term.weight");
      if (weight <= 0) throw new IllegalArgumentException("Optimization weights must be positive");
      termWeightTotal += weight;
      if (("lexicographic".equals(mode) || "pareto".equals(mode)) && weight != 1.0) {
        throw new IllegalArgumentException(mode + " optimization terms must carry canonical weight 1");
      }
      if (term.has("normalize")) {
        JsonObject bounds = object(term.get("normalize"), "optimization term.normalize");
        requireOnly(bounds, "optimization term.normalize", "min", "max", "clamp");
        double min = finiteNumber(bounds.get("min"), "normalize.min");
        double max = finiteNumber(bounds.get("max"), "normalize.max");
        if (max <= min) throw new IllegalArgumentException("normalize.max must be greater than normalize.min");
        if (!bounds.has("clamp") || !bounds.get("clamp").isJsonPrimitive()
            || !bounds.get("clamp").getAsJsonPrimitive().isBoolean()) {
          throw new IllegalArgumentException("normalize.clamp must be boolean");
        }
      }
    }
    if ("weighted".equals(mode) && Math.abs(termWeightTotal - 1.0) > 1e-12) {
      throw new IllegalArgumentException("Weighted optimization term weights must be normalized to 1 in canonical IR");
    }
    JsonArray penalties = requireArray(optimization, "penalties", "optimization");
    Set<String> referenced = new LinkedHashSet<String>();
    double penaltyWeightTotal = 0.0;
    for (JsonElement value : penalties) {
      JsonObject penalty = object(value, "optimization penalty");
      requireOnly(penalty, "optimization penalty", "constraint", "weight");
      Ref constraint = ref(penalty.get("constraint"), "optimization penalty.constraint");
      if (!"soft".equals(constraintEnforcement.get(constraint.key()))) {
        throw new IllegalArgumentException("Optimization penalty must reference a soft constraint: " + constraint);
      }
      if (!referenced.add(constraint.key())) {
        throw new IllegalArgumentException("Duplicate optimization penalty for " + constraint);
      }
      double weight = finiteNumber(penalty.get("weight"), "optimization penalty.weight");
      if (weight <= 0) throw new IllegalArgumentException("Penalty weights must be positive");
      penaltyWeightTotal += weight;
    }
    if (penalties.size() > 0 && Math.abs(penaltyWeightTotal - 1.0) > 1e-12) {
      throw new IllegalArgumentException("Optimization penalty weights must be normalized to 1 in canonical IR");
    }
    for (Map.Entry<String, String> entry : constraintEnforcement.entrySet()) {
      if ("soft".equals(entry.getValue()) && !referenced.contains(entry.getKey())) {
        throw new IllegalArgumentException("Soft constraint " + printableRefKey(entry.getKey())
            + " is not part of optimization.penalties");
      }
    }
  }

  private void validatePlacement() {
    Set<String> resources = new LinkedHashSet<String>();
    Set<String> assignedCandidates = new LinkedHashSet<String>();
    Set<String> globalMetrics = new LinkedHashSet<String>();
    for (JsonElement rawModel : placement()) {
      JsonObject model = object(rawModel, "placement");
      requireOnly(model, "placement", "resource", "pools", "demands", "network", "events",
          "transitions", "globalLatency", "capacityRules");
      String resource = requiredString(model, "resource", "placement");
      if (!resources.add(resource)) throw new IllegalArgumentException("Duplicate placement resource '" + resource + "'");

      JsonObject pools = requireObject(model, "pools", "placement " + resource);
      if (pools.size() == 0) throw new IllegalArgumentException("placement " + resource + ".pools cannot be empty");
      for (Map.Entry<String, JsonElement> poolEntry : pools.entrySet()) {
        JsonObject pool = object(poolEntry.getValue(), "placement pool " + poolEntry.getKey());
        requireOnly(pool, "placement pool " + poolEntry.getKey(), "ref", "name", "kind", "capacity", "properties");
        Ref poolRef = ref(pool.get("ref"), "placement pool.ref");
        if (!resource.equals(poolRef.resource()) || !poolEntry.getKey().equals(poolRef.id())) {
          throw new IllegalArgumentException("Placement pool map key and pool.ref disagree for " + poolRef);
        }
        requiredString(pool, "kind", "placement pool " + poolRef);
        if (pool.has("name")) requiredString(pool, "name", "placement pool " + poolRef);
        validateNonNegativeMap(requireObject(pool, "capacity", "placement pool " + poolRef),
            "placement pool " + poolRef + ".capacity");
        requireObject(pool, "properties", "placement pool " + poolRef);
      }

      JsonArray demands = requireArray(model, "demands", "placement " + resource);
      Set<String> modelCandidates = new LinkedHashSet<String>();
      Set<String> assignedPools = new LinkedHashSet<String>();
      for (JsonElement rawDemand : demands) {
        JsonObject demand = object(rawDemand, "placement demand");
        requireOnly(demand, "placement demand", "candidate", "pool", "resources");
        Ref candidateRef = ref(demand.get("candidate"), "placement demand.candidate");
        candidate(candidateRef);
        Ref poolRef = ref(demand.get("pool"), "placement demand.pool");
        JsonObject pool = placementPool(resource, pools, poolRef, "placement demand.pool");
        if (!modelCandidates.add(candidateRef.key()) || !assignedCandidates.add(candidateRef.key())) {
          throw new IllegalArgumentException("Candidate " + candidateRef + " has more than one placement assignment");
        }
        assignedPools.add(poolRef.key());
        JsonObject demandResources = requireObject(demand, "resources", "placement demand " + candidateRef);
        validateNonNegativeMap(demandResources, "placement demand " + candidateRef + ".resources");
        JsonObject capacity = pool.getAsJsonObject("capacity");
        for (Map.Entry<String, JsonElement> amount : demandResources.entrySet()) {
          if (!capacity.has(amount.getKey())) {
            throw new IllegalArgumentException("Placement pool " + poolRef
                + " lacks demand dimension '" + amount.getKey() + "'");
          } else if (amount.getValue().getAsDouble() > capacity.get(amount.getKey()).getAsDouble()) {
            throw new IllegalArgumentException("Candidate " + candidateRef + " demand exceeds pool "
                + poolRef + " capacity for '" + amount.getKey() + "'");
          }
        }
      }

      JsonArray network = requireArray(model, "network", "placement " + resource);
      Set<String> links = new LinkedHashSet<String>();
      for (JsonElement rawLink : network) {
        JsonObject link = object(rawLink, "placement network link");
        requireOnly(link, "placement network link", "from", "to", "latency");
        Ref from = ref(link.get("from"), "placement network link.from");
        Ref to = ref(link.get("to"), "placement network link.to");
        placementPool(resource, pools, from, "placement network link.from");
        placementPool(resource, pools, to, "placement network link.to");
        nonNegative(link.get("latency"), "placement network link.latency");
        if (!links.add(from.key() + "\u0001" + to.key())) {
          throw new IllegalArgumentException("Duplicate directed placement network link " + from + " -> " + to);
        }
      }

      JsonObject events = requireObject(model, "events", "placement " + resource);
      for (Map.Entry<String, JsonElement> eventEntry : events.entrySet()) {
        JsonObject event = object(eventEntry.getValue(), "placement event " + eventEntry.getKey());
        requireOnly(event, "placement event " + eventEntry.getKey(), "ref", "pool", "latency");
        Ref eventRef = ref(event.get("ref"), "placement event.ref");
        if (!resource.equals(eventRef.resource()) || !eventEntry.getKey().equals(eventRef.id())) {
          throw new IllegalArgumentException("Placement event map key and event.ref disagree for " + eventRef);
        }
        placementPool(resource, pools, ref(event.get("pool"), "placement event.pool"), "placement event.pool");
        Set<String> latencyPools = new LinkedHashSet<String>();
        for (JsonElement rawLatency : requireArray(event, "latency", "placement event " + eventRef)) {
          JsonObject latency = object(rawLatency, "placement event latency");
          requireOnly(latency, "placement event latency", "pool", "latency");
          Ref target = ref(latency.get("pool"), "placement event latency.pool");
          placementPool(resource, pools, target, "placement event latency.pool");
          if (!latencyPools.add(target.key())) {
            throw new IllegalArgumentException("Placement event " + eventRef + " repeats latency for " + target);
          }
          nonNegative(latency.get("latency"), "placement event latency");
        }
      }

      for (JsonElement rawTransition : requireArray(model, "transitions", "placement " + resource)) {
        JsonObject transition = object(rawTransition, "placement transition");
        requireOnly(transition, "placement transition", "ref", "from", "to", "metric", "maximum",
            "enforcement", "penalty");
        Ref transitionRef = ref(transition.get("ref"), "placement transition.ref");
        if (!resource.equals(transitionRef.resource())) {
          throw new IllegalArgumentException("Placement transition " + transitionRef
              + " must be owned by placement resource '" + resource + "'");
        }
        validatePlacementEndpoint(resource, events, ref(transition.get("from"), "placement transition.from"));
        validatePlacementEndpoint(resource, events, ref(transition.get("to"), "placement transition.to"));
        Ref metricRef = ref(transition.get("metric"), "placement transition.metric");
        validateApplicationMetric(metricRef, "placement transition.metric");
        nonNegative(transition.get("maximum"), "placement transition.maximum");
        String enforcement = requiredString(transition, "enforcement", "placement transition " + transitionRef);
        if (!"hard".equals(enforcement) && !"soft".equals(enforcement)) {
          throw new IllegalArgumentException("Invalid placement transition enforcement '" + enforcement + "'");
        }
        if ("soft".equals(enforcement)) nonNegative(transition.get("penalty"), "placement transition.penalty");
        else if (transition.has("penalty")) {
          throw new IllegalArgumentException("Hard placement transition " + transitionRef + " cannot have a penalty");
        }
        addPlacementConstraint(transitionRef, enforcement);
      }

      if (model.has("globalLatency")) {
        JsonObject global = object(model.get("globalLatency"), "placement globalLatency");
        requireOnly(global, "placement globalLatency", "metric", "includeExecution", "exclusive", "parallel");
        Ref metricRef = ref(global.get("metric"), "placement globalLatency.metric");
        validateApplicationMetric(metricRef, "placement globalLatency.metric");
        if (!requiredMetrics.contains(metricRef.id())) {
          throw new IllegalArgumentException("Placement global latency metric is not materialized: " + metricRef);
        }
        if (!globalMetrics.add(metricRef.key())) {
          throw new IllegalArgumentException("More than one placement derives metric " + metricRef);
        }
        requiredBoolean(global, "includeExecution", "placement globalLatency");
        String exclusive = requiredString(global, "exclusive", "placement globalLatency");
        String parallel = requiredString(global, "parallel", "placement globalLatency");
        if (!"routing".equals(exclusive) && !"condition".equals(exclusive)) {
          throw new IllegalArgumentException("placement globalLatency.exclusive must be routing or condition");
        }
        if (!"max".equals(parallel) && !"sum".equals(parallel)) {
          throw new IllegalArgumentException("placement globalLatency.parallel must be max or sum");
        }
        validatePlacementXorMode(workflow(), "/spec/application/workflow", exclusive);
      }

      if (model.has("capacityRules")) {
        for (JsonElement rawRule : requireArray(model, "capacityRules", "placement " + resource)) {
          JsonObject rule = object(rawRule, "placement capacity rule");
          requireOnly(rule, "placement capacity rule", "ref", "resources", "scope");
          Ref ruleRef = ref(rule.get("ref"), "placement capacity rule.ref");
          if (!resource.equals(ruleRef.resource())) {
            throw new IllegalArgumentException("Placement capacity rule " + ruleRef
                + " must be owned by placement resource '" + resource + "'");
          }
          JsonArray dimensions = requireArray(rule, "resources", "placement capacity rule " + ruleRef);
          if (dimensions.size() == 0) throw new IllegalArgumentException("Placement capacity rule resources cannot be empty");
          Set<String> uniqueDimensions = new LinkedHashSet<String>();
          for (JsonElement rawDimension : dimensions) {
            if (!rawDimension.isJsonPrimitive() || !rawDimension.getAsJsonPrimitive().isString()
                || rawDimension.getAsString().isEmpty() || !uniqueDimensions.add(rawDimension.getAsString())) {
              throw new IllegalArgumentException("Placement capacity rule resources must be unique non-empty strings");
            }
          }
          for (Map.Entry<String, JsonElement> poolEntry : pools.entrySet()) {
            JsonObject capacity = poolEntry.getValue().getAsJsonObject().getAsJsonObject("capacity");
            if (!capacity.keySet().containsAll(uniqueDimensions)) {
              throw new IllegalArgumentException("Placement pool '" + poolEntry.getKey()
                  + "' lacks a constrained capacity dimension");
            }
          }
          String scope = requiredString(rule, "scope", "placement capacity rule " + ruleRef);
          if (!"invocation".equals(scope) && !"selectedCandidate".equals(scope)) {
            throw new IllegalArgumentException("Unsupported placement capacity scope '" + scope + "'");
          }
          addPlacementConstraint(ruleRef, "hard");
        }
      }

      if (model.has("globalLatency") || model.getAsJsonArray("transitions").size() > 0) {
        // All directed transfers that a decision can require are materialized.
        for (String source : assignedPools) {
          for (String target : assignedPools) {
            if (!source.equals(target) && !links.contains(source + "\u0001" + target)) {
              throw new IllegalArgumentException("Placement network is missing a required directed pool link");
            }
          }
        }
        for (Map.Entry<String, JsonElement> eventEntry : events.entrySet()) {
          JsonObject event = eventEntry.getValue().getAsJsonObject();
          Ref eventPool = ref(event.get("pool"), "placement event.pool");
          Set<String> explicit = new LinkedHashSet<String>();
          for (JsonElement rawLatency : event.getAsJsonArray("latency")) {
            explicit.add(ref(rawLatency.getAsJsonObject().get("pool"), "placement event latency.pool").key());
          }
          for (String target : assignedPools) {
            if (!target.equals(eventPool.key()) && !explicit.contains(target)
                && !links.contains(eventPool.key() + "\u0001" + target)) {
              throw new IllegalArgumentException("Placement event '" + eventEntry.getKey()
                  + "' cannot reach an assigned pool");
            }
          }
        }
      }
    }

    Set<String> eligibleCandidates = new LinkedHashSet<String>();
    for (String task : serviceTasks) for (Ref candidate : eligible(task)) eligibleCandidates.add(candidate.key());
    if (placement().size() > 0 && !assignedCandidates.containsAll(eligibleCandidates)) {
      Set<String> missing = new LinkedHashSet<String>(eligibleCandidates);
      missing.removeAll(assignedCandidates);
      throw new IllegalArgumentException("Placement assignments must cover every eligible candidate; missing "
          + printableRefKeys(missing));
    }
  }

  private void addPlacementConstraint(Ref ref, String enforcement) {
    if (constraintEnforcement.put(ref.key(), enforcement) != null) {
      throw new IllegalArgumentException("Duplicate constraint reference " + ref);
    }
  }

  private void validateApplicationMetric(Ref metric, String where) {
    if (!applicationResource.equals(metric.resource()) || !metricDefinitions.containsKey(metric.id())) {
      throw new IllegalArgumentException(where + " references unknown Application metric " + metric);
    }
  }

  private void validatePlacementXorMode(JsonObject node, String pointer, String mode) {
    String kind = node.get("kind").getAsString();
    if ("exclusive".equals(kind)) {
      JsonArray branches = node.getAsJsonArray("branches");
      for (int index = 0; index < branches.size(); index++) {
        JsonObject branch = branches.get(index).getAsJsonObject();
        if ("routing".equals(mode) && routingProbability(workflowBranchRef(pointer, index,
            branch.get("id").getAsString())) == null) {
          throw new IllegalArgumentException(
              "placement globalLatency.exclusive=routing requires probabilities for every XOR");
        }
        if ("condition".equals(mode) && !branch.has("when")) {
          throw new IllegalArgumentException(
              "placement globalLatency.exclusive=condition requires a condition on every XOR branch");
        }
        validatePlacementXorMode(branch.getAsJsonObject("flow"),
            pointer + "/branches/" + index + "/flow", mode);
      }
    } else if ("sequence".equals(kind) || "parallel".equals(kind)) {
      String field = "sequence".equals(kind) ? "steps" : "branches";
      JsonArray children = node.getAsJsonArray(field);
      for (int index = 0; index < children.size(); index++) {
        validatePlacementXorMode(children.get(index).getAsJsonObject(),
            pointer + "/" + field + "/" + index, mode);
      }
    } else if ("repeat".equals(kind)) {
      validatePlacementXorMode(node.getAsJsonObject("body"), pointer + "/body", mode);
    }
  }

  private void validatePlacementEndpoint(String placementResource, JsonObject events, Ref endpoint) {
    if (placementResource.equals(endpoint.resource()) && events.has(endpoint.id())) return;
    if (applicationResource.equals(endpoint.resource()) && serviceTasks.contains(endpoint.id())) return;
    throw new IllegalArgumentException("Unknown placement transition endpoint " + endpoint);
  }

  private static JsonObject placementPool(String placementResource, JsonObject pools, Ref ref, String where) {
    if (!placementResource.equals(ref.resource()) || !pools.has(ref.id()) || !pools.get(ref.id()).isJsonObject()) {
      throw new IllegalArgumentException(where + " references unknown placement pool " + ref);
    }
    return pools.getAsJsonObject(ref.id());
  }

  private static void validateNonNegativeMap(JsonObject values, String where) {
    for (Map.Entry<String, JsonElement> entry : values.entrySet()) {
      if (entry.getKey().isEmpty()) throw new IllegalArgumentException(where + " has an empty dimension");
      nonNegative(entry.getValue(), where + "." + entry.getKey());
    }
  }

  private static double nonNegative(JsonElement value, String where) {
    double result = finiteNumber(value, where);
    if (result < 0.0) throw new IllegalArgumentException(where + " must be non-negative");
    return result;
  }

  private static boolean requiredBoolean(JsonObject owner, String key, String where) {
    if (!owner.has(key) || !owner.get(key).isJsonPrimitive()
        || !owner.getAsJsonPrimitive(key).isBoolean()) {
      throw new IllegalArgumentException(where + "." + key + " must be boolean");
    }
    return owner.get(key).getAsBoolean();
  }

  private static String printableRefKey(String key) {
    int separator = key.indexOf('\u0000');
    return separator < 0 ? key : key.substring(0, separator) + ":" + key.substring(separator + 1);
  }

  private static Set<String> printableRefKeys(Set<String> keys) {
    Set<String> result = new LinkedHashSet<String>();
    for (String key : keys) result.add(printableRefKey(key));
    return result;
  }

  private void validateIdentity() {
    JsonObject profile = requireObject(spec, "profile", "BindingProblem.spec");
    requireOnly(profile, "BindingProblem.spec.profile", "namespace", "id", "version",
        "output", "deterministic", "digest", "adapter");
    requiredString(profile, "namespace", "BindingProblem.spec.profile");
    requireExact(profile, "id", "qos-binding/v1", "BindingProblem.spec.profile");
    requiredString(profile, "version", "BindingProblem.spec.profile");
    JsonObject output = requireObject(profile, "output", "BindingProblem.spec.profile");
    requireOnly(output, "BindingProblem.spec.profile.output", "apiVersion", "kind", "schemaDigest");
    requireExact(output, "apiVersion", API_VERSION, "BindingProblem.spec.profile.output");
    requireExact(output, "kind", KIND, "BindingProblem.spec.profile.output");
    requireDigest(output, "schemaDigest", "BindingProblem.spec.profile.output");
    if (!profile.has("deterministic") || !profile.get("deterministic").isJsonPrimitive()
        || !profile.getAsJsonPrimitive("deterministic").isBoolean()
        || !profile.get("deterministic").getAsBoolean()) {
      throw new IllegalArgumentException("BindingProblem.spec.profile.deterministic must be true");
    }
    requireDigest(profile, "digest", "BindingProblem.spec.profile");
    validateAdapter(requireObject(profile, "adapter", "BindingProblem.spec.profile"),
        "BindingProblem.spec.profile.adapter");

    JsonArray dialects = requireArray(spec, "dialects", "BindingProblem.spec");
    if (dialects.size() == 0) throw new IllegalArgumentException("BindingProblem.spec.dialects cannot be empty");
    Set<String> dialectRevisions = new LinkedHashSet<String>();
    for (int index = 0; index < dialects.size(); index++) {
      JsonObject dialect = object(dialects.get(index), "BindingProblem.spec.dialects[" + index + "]");
      String where = "BindingProblem.spec.dialects[" + index + "]";
      requireOnly(dialect, where, "namespace", "id", "version", "digest", "irFeatures", "adapter");
      String namespace = requiredString(dialect, "namespace", where);
      String id = requiredString(dialect, "id", where);
      String version = requiredString(dialect, "version", where);
      if (!dialectRevisions.add(namespace + "\u0000" + id + "\u0000" + version)) {
        throw new IllegalArgumentException("BindingProblem.spec.dialects repeats revision "
            + namespace + ":" + id + "@" + version);
      }
      requireDigest(dialect, "digest", where);
      JsonArray features = requireArray(dialect, "irFeatures", where);
      Set<String> featureKeys = new LinkedHashSet<String>();
      for (int featureIndex = 0; featureIndex < features.size(); featureIndex++) {
        String featureWhere = where + ".irFeatures[" + featureIndex + "]";
        JsonObject feature = object(features.get(featureIndex), featureWhere);
        requireOnly(feature, featureWhere, "dimension", "value");
        String dimension = requiredString(feature, "dimension", featureWhere);
        String value = requiredString(feature, "value", featureWhere);
        if (!featureKeys.add(dimension + "\u0000" + value)) {
          throw new IllegalArgumentException(where + ".irFeatures contains duplicate "
              + dimension + ":" + value);
        }
      }
      validateAdapter(requireObject(dialect, "adapter", where), where + ".adapter");
    }

    JsonObject instance = requireObject(spec, "instance", "BindingProblem.spec");
    requireOnly(instance, "BindingProblem.spec.instance", "digest", "resources");
    requireDigest(instance, "digest", "BindingProblem.spec.instance");
    JsonObject resources = requireObject(instance, "resources", "BindingProblem.spec.instance");
    if (resources.size() == 0) {
      throw new IllegalArgumentException("BindingProblem.spec.instance.resources cannot be empty");
    }
    for (Map.Entry<String, JsonElement> entry : resources.entrySet()) {
      String where = "BindingProblem.spec.instance.resources." + entry.getKey();
      JsonObject resource = object(entry.getValue(), where);
      requireOnly(resource, where, "role", "apiVersion", "kind", "path", "registered", "digest");
      requiredString(resource, "role", where);
      requiredString(resource, "apiVersion", where);
      requiredString(resource, "kind", where);
      requireDigest(resource, "digest", where);
      boolean local = resource.has("path");
      boolean registered = resource.has("registered");
      if (local == registered) {
        throw new IllegalArgumentException(where + " requires exactly one of path or registered");
      }
      if (local) {
        requiredString(resource, "path", where);
      } else {
        JsonObject reference = requireObject(resource, "registered", where);
        requireOnly(reference, where + ".registered", "namespace", "name", "version", "digest");
        requiredString(reference, "namespace", where + ".registered");
        requiredString(reference, "name", where + ".registered");
        requiredString(reference, "version", where + ".registered");
        requireDigest(reference, "digest", where + ".registered");
      }
    }
  }

  private static void validateAdapter(JsonObject adapter, String where) {
    requireOnly(adapter, where, "id", "version", "digest");
    requiredString(adapter, "id", where);
    requiredString(adapter, "version", where);
    requireDigest(adapter, "digest", where);
  }

  private static String requireDigest(JsonObject owner, String key, String where) {
    String value = requiredString(owner, key, where);
    if (!value.matches("sha256-[0-9a-f]{64}")) {
      throw new IllegalArgumentException(where + "." + key + " must be a canonical SHA-256 digest");
    }
    return value;
  }

  private static void validateExpression(JsonObject node, int depth) {
    if (depth > 32) throw new IllegalArgumentException("Expression exceeds maximum depth");
    String kind = requiredString(node, "kind", "expression");
    if ("literal".equals(kind)) { requireOnly(node, "literal expression", "kind", "value"); return; }
    if ("path".equals(kind)) {
      requireOnly(node, "path expression", "kind", "segments");
      JsonArray segments = requireArray(node, "segments", "expression path");
      if (segments.size() == 0) throw new IllegalArgumentException("expression path segments cannot be empty");
      for (int index = 0; index < segments.size(); index++) {
        if (!segments.get(index).isJsonPrimitive()
            || !segments.get(index).getAsJsonPrimitive().isString()
            || segments.get(index).getAsString().isEmpty()) {
          throw new IllegalArgumentException("expression path segment " + index + " must be a non-empty string");
        }
      }
      return;
    }
    if ("not".equals(kind) || "negate".equals(kind)) {
      requireOnly(node, kind + " expression", "kind", "value");
      validateExpression(requireObject(node, "value", kind + " expression"), depth + 1);
      return;
    }
    if ("and".equals(kind) || "or".equals(kind)) {
      requireOnly(node, kind + " expression", "kind", "left", "right");
      validateExpression(requireObject(node, "left", kind + " expression"), depth + 1);
      validateExpression(requireObject(node, "right", kind + " expression"), depth + 1);
      return;
    }
    if ("compare".equals(kind) || "arithmetic".equals(kind)) {
      requireOnly(node, kind + " expression", "kind", "op", "left", "right");
      String operation = requiredString(node, "op", kind + " expression");
      Set<String> allowed = new LinkedHashSet<String>();
      if ("compare".equals(kind)) Collections.addAll(allowed, "eq", "ne", "lt", "lte", "gt", "gte");
      else Collections.addAll(allowed, "add", "sub", "mul", "div", "pow");
      if (!allowed.contains(operation)) throw new IllegalArgumentException("Unsupported expression operator '" + operation + "'");
      validateExpression(requireObject(node, "left", kind + " expression"), depth + 1);
      validateExpression(requireObject(node, "right", kind + " expression"), depth + 1);
      return;
    }
    if ("call".equals(kind)) {
      requireOnly(node, "call expression", "kind", "name", "args");
      String name = requiredString(node, "name", "call expression");
      if (!"has".equals(name) && !"min".equals(name) && !"max".equals(name)
          && !"sum".equals(name) && !"product".equals(name)
          && !"weightedSum".equals(name) && !"weightedProduct".equals(name)) {
        throw new IllegalArgumentException("Unsupported expression function '" + name + "'");
      }
      JsonArray args = requireArray(node, "args", "call expression");
      if (args.size() == 0 || args.size() > 16) throw new IllegalArgumentException("Expression calls need one to sixteen arguments");
      if ("has".equals(name) && (args.size() != 1 || !args.get(0).isJsonObject()
          || !"path".equals(args.get(0).getAsJsonObject().get("kind").getAsString()))) {
        throw new IllegalArgumentException("has requires exactly one path");
      }
      if (("weightedSum".equals(name) || "weightedProduct".equals(name)) && args.size() != 2) {
        throw new IllegalArgumentException(name + " requires values and weights");
      }
      for (JsonElement argument : args) validateExpression(object(argument, "call argument"), depth + 1);
      return;
    }
    throw new IllegalArgumentException("Unsupported expression kind '" + kind + "'");
  }

  public static JsonObject object(JsonElement value, String where) {
    if (value == null || !value.isJsonObject()) throw new IllegalArgumentException(where + " must be an object");
    return value.getAsJsonObject();
  }
  public static JsonObject requireObject(JsonObject owner, String key, String where) {
    if (!owner.has(key) || !owner.get(key).isJsonObject()) throw new IllegalArgumentException(where + "." + key + " must be an object");
    return owner.getAsJsonObject(key);
  }
  public static JsonArray requireArray(JsonObject owner, String key, String where) {
    if (!owner.has(key) || !owner.get(key).isJsonArray()) throw new IllegalArgumentException(where + "." + key + " must be an array");
    return owner.getAsJsonArray(key);
  }
  public static String requiredString(JsonObject owner, String key, String where) {
    if (!owner.has(key) || !owner.get(key).isJsonPrimitive()
        || !owner.getAsJsonPrimitive(key).isString() || owner.get(key).getAsString().isEmpty()) {
      throw new IllegalArgumentException(where + "." + key + " must be a non-empty string");
    }
    return owner.get(key).getAsString();
  }
  public static String optionalString(JsonObject owner, String key, String fallback) {
    return owner.has(key) ? requiredString(owner, key, "object") : fallback;
  }
  public static double finiteNumber(JsonElement value, String where) {
    if (value == null || !value.isJsonPrimitive()) throw new IllegalArgumentException(where + " must be a finite number");
    JsonPrimitive primitive = value.getAsJsonPrimitive();
    if (!primitive.isNumber()) throw new IllegalArgumentException(where + " must be a finite number");
    double number = primitive.getAsDouble();
    if (Double.isNaN(number) || Double.isInfinite(number)) throw new IllegalArgumentException(where + " must be finite");
    return number;
  }
  private static void requireExact(JsonObject owner, String key, String expected, String where) {
    String actual = requiredString(owner, key, where);
    if (!expected.equals(actual)) throw new IllegalArgumentException(where + "." + key + " must be " + expected);
  }

  private static void requireOnly(JsonObject owner, String where, String... allowedNames) {
    Set<String> allowed = new LinkedHashSet<String>();
    Collections.addAll(allowed, allowedNames);
    Set<String> unknown = new LinkedHashSet<String>(owner.keySet());
    unknown.removeAll(allowed);
    if (!unknown.isEmpty()) throw new IllegalArgumentException(where + " has unknown fields " + unknown);
  }
}
