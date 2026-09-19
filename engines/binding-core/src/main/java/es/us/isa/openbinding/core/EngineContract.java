package es.us.isa.openbinding.core;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** Strict private transport shared by the JVM engines. */
public final class EngineContract {
  public static final String REQUEST_KIND = "BindingProblemRequest";
  private static final Gson GSON = new Gson();

  private EngineContract() {}

  public static final class Request {
    private final BindingProblem problem;
    private final JsonObject optimization;
    private final JsonObject options;

    Request(BindingProblem problem, JsonObject optimization, JsonObject options) {
      this.problem = problem;
      this.optimization = optimization;
      this.options = options;
    }
    public BindingProblem problem() { return problem; }
    public JsonObject optimization() { return optimization; }
    public JsonObject options() { return options; }
  }

  public static Request parse(String payload) {
    JsonElement parsed;
    try { parsed = new JsonParser().parse(payload); }
    catch (RuntimeException exception) { throw new IllegalArgumentException("Request body must be valid JSON", exception); }
    if (!parsed.isJsonObject()) throw new IllegalArgumentException("BindingProblemRequest must be an object");
    JsonObject envelope = parsed.getAsJsonObject();
    Set<String> allowed = new LinkedHashSet<String>(Arrays.asList("apiVersion", "kind", "protocol", "problem", "optimization", "options"));
    Set<String> unknown = new LinkedHashSet<String>(envelope.keySet());
    unknown.removeAll(allowed);
    if (!unknown.isEmpty()) throw new IllegalArgumentException("BindingProblemRequest has unknown fields " + unknown);
    String apiVersion = BindingProblem.requiredString(envelope, "apiVersion", "BindingProblemRequest");
    String kind = BindingProblem.requiredString(envelope, "kind", "BindingProblemRequest");
    String protocol = BindingProblem.requiredString(envelope, "protocol", "BindingProblemRequest");
    if (!BindingProblem.API_VERSION.equals(apiVersion) || !REQUEST_KIND.equals(kind)) {
      throw new IllegalArgumentException("Expected canonical bim/v1 BindingProblemRequest");
    }
    if (!"bim-engine/v1".equals(protocol)) {
      throw new IllegalArgumentException("BindingProblemRequest.protocol must be bim-engine/v1");
    }
    JsonObject problem = BindingProblem.requireObject(envelope, "problem", "BindingProblemRequest");
    JsonObject optimization = BindingProblem.requireObject(envelope, "optimization", "BindingProblemRequest");
    validateOptimization(problem, optimization);
    JsonObject options = envelope.has("options")
        ? BindingProblem.requireObject(envelope, "options", "BindingProblemRequest") : new JsonObject();
    return new Request(new BindingProblem(problem), optimization.deepCopy(), options.deepCopy());
  }

  private static void validateOptimization(JsonObject problemDocument, JsonObject optimization) {
    Set<String> allowed = new LinkedHashSet<String>(Arrays.asList("type", "scalarization", "weights"));
    Set<String> unknown = new LinkedHashSet<String>(optimization.keySet());
    unknown.removeAll(allowed);
    if (!unknown.isEmpty()) throw new IllegalArgumentException("Execution optimization has unknown fields " + unknown);
    String type = BindingProblem.requiredString(optimization, "type", "execution optimization");
    if (!Arrays.asList("SINGLE", "MULTI", "MANY").contains(type)) throw new IllegalArgumentException("Unsupported execution optimization type '" + type + "'");
    String scalarization = BindingProblem.requiredString(optimization, "scalarization", "execution optimization");
    if (scalarization.isEmpty()) throw new IllegalArgumentException("Execution scalarization must not be empty");
    JsonObject spec = problemDocument.getAsJsonObject("spec");
    JsonArray criteria = spec.getAsJsonObject("optimization").getAsJsonArray("criteria");
    int count = criteria.size();
    if ("MULTI".equals(type) && (count < 2 || count > 3)) throw new IllegalArgumentException("MULTI requires two or three criteria");
    if ("MANY".equals(type) && count < 3) throw new IllegalArgumentException("MANY requires at least three criteria");
    JsonArray weights = optimization.has("weights") ? BindingProblem.requireArray(optimization, "weights", "execution optimization") : new JsonArray();
    Set<String> ids = new LinkedHashSet<String>();
    for (JsonElement value : criteria) ids.add(BindingProblem.requiredString(value.getAsJsonObject(), "id", "optimization criterion"));
    Set<String> seen = new LinkedHashSet<String>();
    double total = 0.0;
    for (JsonElement value : weights) {
      JsonObject item = BindingProblem.object(value, "execution optimization weight");
      if (!item.keySet().equals(new LinkedHashSet<String>(Arrays.asList("criteria", "value")))) throw new IllegalArgumentException("Each execution weight requires criteria and value");
      String id = BindingProblem.requiredString(item, "criteria", "execution optimization weight");
      double weight = BindingProblem.finiteNumber(item.get("value"), "execution optimization weight.value");
      if (!ids.contains(id) || !seen.add(id) || weight <= 0) throw new IllegalArgumentException("Execution weights must reference unique criteria with positive values");
      total += weight;
    }
    if (weights.size() != 0 && seen.size() != ids.size()) throw new IllegalArgumentException("Execution weights must cover every criterion");
    if (weights.size() != 0 && Math.abs(total - 1.0) > 1e-9) throw new IllegalArgumentException("Execution weights must be normalized to 1");
    if (count == 0 && !"feasibility".equals(scalarization)) throw new IllegalArgumentException("Empty criteria require feasibility scalarization");
  }

  public static void validateOptions(JsonObject options, String... allowedNames) {
    Set<String> allowed = new LinkedHashSet<String>(Arrays.asList(allowedNames));
    Set<String> unknown = new LinkedHashSet<String>(options.keySet());
    unknown.removeAll(allowed);
    if (!unknown.isEmpty()) throw new IllegalArgumentException("Unknown engine options " + unknown);
  }

  public static int integerOption(JsonObject options, String name, int fallback, int minimum, int maximum) {
    if (!options.has(name)) return fallback;
    double raw = BindingProblem.finiteNumber(options.get(name), "options." + name);
    if (raw != Math.rint(raw) || raw < minimum || raw > maximum) {
      throw new IllegalArgumentException("options." + name + " must be an integer in [" + minimum + "," + maximum + "]");
    }
    return (int) raw;
  }

  public static long longOption(JsonObject options, String name, long fallback) {
    if (!options.has(name)) return fallback;
    JsonElement raw = options.get(name);
    if (raw == null || !raw.isJsonPrimitive() || !raw.getAsJsonPrimitive().isNumber()) {
      throw new IllegalArgumentException("options." + name + " must be an integer");
    }
    try {
      // Preserve the JSON token exactly.  Going through double would silently
      // change reproducibility seeds above 2^53.
      return raw.getAsBigDecimal().longValueExact();
    } catch (ArithmeticException | NumberFormatException exception) {
      throw new IllegalArgumentException("options." + name
          + " must be an integer in the signed 64-bit range", exception);
    }
  }

  public static Long optionalPositiveLong(JsonObject options, String name) {
    if (!options.has(name)) return null;
    long value = longOption(options, name, 0L);
    if (value < 1) throw new IllegalArgumentException("options." + name + " must be positive");
    return Long.valueOf(value);
  }

  public static String stringOption(JsonObject options, String name, String fallback) {
    if (!options.has(name)) return fallback;
    return BindingProblem.requiredString(options, name, "options");
  }

  public static JsonObject response(String termination, Iterable<CanonicalEvaluator.Evaluation> evaluations,
      JsonObject provenance) {
    if (!Arrays.asList("OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN").contains(termination)) {
      throw new IllegalArgumentException("Invalid engine termination '" + termination + "'");
    }
    JsonObject response = new JsonObject();
    response.addProperty("termination", termination);
    JsonArray solutions = new JsonArray();
    if (evaluations != null) {
      for (CanonicalEvaluator.Evaluation evaluation : evaluations) solutions.add(solution(evaluation));
    }
    response.add("solutions", solutions);
    if (provenance != null) response.add("provenance", provenance);
    return response;
  }

  public static JsonObject solution(CanonicalEvaluator.Evaluation evaluation) {
    JsonObject solution = new JsonObject();
    solution.add("decision", evaluation.decisionJson());
    JsonObject metrics = new JsonObject();
    for (Map.Entry<String, Double> entry : evaluation.metrics().entrySet()) metrics.addProperty(entry.getKey(), entry.getValue());
    solution.add("features", metrics);
    solution.add("objectives", evaluation.objectives());
    JsonArray penalties = new JsonArray();
    for (Double penalty : evaluation.penalties()) penalties.add(penalty);
    solution.add("penalties", penalties);
    JsonArray violations = new JsonArray();
    for (CanonicalEvaluator.Violation violation : evaluation.violations()) violations.add(violation.toJson());
    solution.add("violations", violations);
    return solution;
  }

  public static String json(JsonElement value) { return GSON.toJson(value); }
}
