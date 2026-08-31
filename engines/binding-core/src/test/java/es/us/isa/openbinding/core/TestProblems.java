package es.us.isa.openbinding.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.LinkedHashMap;
import java.util.Map;

public final class TestProblems {
  private TestProblems() {}

  public static JsonObject twoCandidates() {
    String json = "{"
        + "\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblem\",\"metadata\":{\"name\":\"two\"},"
        + "\"spec\":{"
        + "\"profile\":{\"namespace\":\"bim.builtin\",\"id\":\"qos-binding/v1\",\"version\":\"1.0.0\","
        + "\"output\":{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblem\",\"schemaDigest\":\""
        + digest("ir-schema") + "\"},\"deterministic\":true,\"digest\":\"" + digest("profile") + "\","
        + "\"adapter\":{\"id\":\"qos-binding-profile\",\"version\":\"1.0.0\",\"digest\":\""
        + digest("profile-adapter") + "\"}},"
        + "\"dialects\":[{\"namespace\":\"bim.builtin\",\"id\":\"qos-binding/v1\",\"version\":\"1.0.0\","
        + "\"digest\":\"" + digest("dialect") + "\",\"irFeatures\":[],"
        + "\"adapter\":{\"id\":\"bim-core\",\"version\":\"1.0.0\",\"digest\":\""
        + digest("dialect-adapter") + "\"}}],"
        + "\"instance\":{\"digest\":\"" + digest("instance") + "\",\"resources\":{"
        + resource("app", "application", "Application", "application.json") + ","
        + resource("catalog-a", "candidates", "CandidateCatalog", "catalog-a.json") + ","
        + resource("catalog-b", "candidates", "CandidateCatalog", "catalog-b.json") + ","
        + resource("optimization", "optimization", "Optimization", "optimization.json") + "}},"
        + "\"application\":{\"resource\":\"app\","
        + "\"tasks\":{\"t\":{\"kind\":\"service\",\"requires\":{\"type\":\"compute\"}}},"
        + "\"metrics\":{" + metric("cost", "selectedCandidate") + "," + metric("latency", "invocation") + "},"
        + "\"requiredMetrics\":[\"cost\",\"latency\"],\"taskRequiredMetrics\":{},"
        + "\"workflow\":{\"kind\":\"task\",\"task\":{\"resource\":\"app\",\"id\":\"t\"}}},"
        + "\"candidates\":{"
        + "\"catalog-a\":" + catalog("catalog-a", "service", "provider-a", 1, 10, "eu") + ","
        + "\"catalog-b\":" + catalog("catalog-b", "service", "provider-b", 9, 1, "us") + "},"
        + "\"eligibility\":{\"t\":[{\"resource\":\"catalog-a\",\"id\":\"service\"},{\"resource\":\"catalog-b\",\"id\":\"service\"}]},"
        + "\"routing\":[],\"constraints\":[],\"placement\":[],"
        + "\"optimization\":{\"resource\":\"optimization\",\"mode\":\"weighted\",\"type\":\"MONO\","
        + "\"terms\":[{\"metric\":{\"resource\":\"app\",\"id\":\"cost\"},\"direction\":\"minimize\",\"weight\":1}],\"penalties\":[]},"
        + "\"extensions\":{},\"sourceMap\":{}}}";
    return new JsonParser().parse(json).getAsJsonObject();
  }

  public static String envelope(JsonObject problem, String options) {
    return "{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblemRequest\","
        + "\"protocol\":\"bim-engine/v1\",\"problem\":" + problem + ",\"options\":" + options + "}";
  }

  public static Map<String, BindingProblem.Ref> decision(String catalog) {
    Map<String, BindingProblem.Ref> binding = new LinkedHashMap<String, BindingProblem.Ref>();
    binding.put("t", new BindingProblem.Ref(catalog, "service"));
    return binding;
  }

  private static String metric(String id, String scope) {
    return "\"" + id + "\":{\"type\":\"number\",\"unit\":\"1\","
        + "\"domain\":{\"kind\":\"real\"},\"direction\":\"minimize\","
        + "\"scope\":\"" + scope + "\",\"neutral\":0,"
        + "\"aggregation\":{\"sequence\":\"sum\",\"parallel\":\"sum\","
        + "\"exclusive\":\"weightedSum\",\"repeat\":\"scale\",\"selection\":\"sum\"}}";
  }

  private static String candidate(String catalog, String id, String provider,
      double cost, double latency, String region) {
    return "{\"ref\":{\"resource\":\"" + catalog + "\",\"id\":\"" + id + "\"},"
        + "\"provider\":{\"resource\":\"" + catalog + "\",\"id\":\"" + provider + "\"},"
        + "\"provides\":[{\"type\":\"compute\",\"properties\":{}}],"
        + "\"properties\":{\"region\":\"" + region + "\"},"
        + "\"metrics\":{\"price\":" + cost + ",\"response\":" + latency + "}}";
  }

  private static String catalog(String catalog, String candidate, String provider,
      double cost, double latency, String region) {
    return "{\"providers\":{\"" + provider + "\":{\"properties\":{}}},"
        + "\"metricBindings\":{\"price\":{\"resource\":\"app\",\"id\":\"cost\"},"
        + "\"response\":{\"resource\":\"app\",\"id\":\"latency\"}},"
        + "\"candidates\":{\"" + candidate + "\":"
        + candidate(catalog, candidate, provider, cost, latency, region) + "}}";
  }

  private static String resource(String id, String role, String kind, String path) {
    return "\"" + id + "\":{\"role\":\"" + role + "\",\"kind\":\"" + kind
        + "\",\"apiVersion\":\"qos-binding/v1\",\"path\":\"" + path
        + "\",\"digest\":\"" + digest(id) + "\"}";
  }

  private static String digest(String seed) {
    String hex = Integer.toHexString(seed.hashCode()).replace("-", "0");
    StringBuilder result = new StringBuilder("sha256-");
    while (result.length() < 71) result.append(hex);
    return result.substring(0, 71);
  }
}
