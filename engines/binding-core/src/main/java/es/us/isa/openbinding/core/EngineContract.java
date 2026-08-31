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
    private final JsonObject options;

    Request(BindingProblem problem, JsonObject options) {
      this.problem = problem;
      this.options = options;
    }
    public BindingProblem problem() { return problem; }
    public JsonObject options() { return options; }
  }

  public static Request parse(String payload) {
    JsonElement parsed;
    try { parsed = new JsonParser().parse(payload); }
    catch (RuntimeException exception) { throw new IllegalArgumentException("Request body must be valid JSON", exception); }
    if (!parsed.isJsonObject()) throw new IllegalArgumentException("BindingProblemRequest must be an object");
    JsonObject envelope = parsed.getAsJsonObject();
    Set<String> allowed = new LinkedHashSet<String>(Arrays.asList("apiVersion", "kind", "protocol", "problem", "options"));
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
    JsonObject options = envelope.has("options")
        ? BindingProblem.requireObject(envelope, "options", "BindingProblemRequest") : new JsonObject();
    return new Request(new BindingProblem(problem), options.deepCopy());
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
    solution.add("metrics", metrics);
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
