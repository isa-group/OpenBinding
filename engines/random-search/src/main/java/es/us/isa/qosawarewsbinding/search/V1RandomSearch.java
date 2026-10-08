package es.us.isa.qosawarewsbinding.search;

import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.CanonicalEvaluator;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;

/** Seeded random search over the canonical BIM v1 eligibility matrix. */
public final class V1RandomSearch {
  public static final class Result {
    private final CanonicalEvaluator.Evaluation best;
    private final long evaluations;
    private final long elapsedMs;
    private final JsonArray trace;

    Result(CanonicalEvaluator.Evaluation best, long evaluations, long elapsedMs, JsonArray trace) {
      this.best = best;
      this.evaluations = evaluations;
      this.elapsedMs = elapsedMs;
      this.trace = trace;
    }
    public CanonicalEvaluator.Evaluation best() { return best; }
    public long evaluations() { return evaluations; }
    public long elapsedMs() { return elapsedMs; }
    public JsonArray trace() { return trace; }
  }

  private V1RandomSearch() {}

  public static Result run(BindingProblem problem, int iterations, Long timeBudgetMs, long seed) {
    JsonObject execution = new JsonObject();
    execution.addProperty("type", "SINGLE");
    execution.addProperty("scalarization", "weighted-sum");
    com.google.gson.JsonArray weights = new com.google.gson.JsonArray();
    for (com.google.gson.JsonElement item : problem.optimization().getAsJsonArray("criteria")) {
      JsonObject weight = new JsonObject();
      weight.addProperty("criteria", item.getAsJsonObject().get("id").getAsString());
      weight.addProperty("value", 1.0);
      weights.add(weight);
    }
    execution.add("weights", weights);
    return run(problem, execution, iterations, timeBudgetMs, seed);
  }

  public static Result run(BindingProblem problem, JsonObject optimization, int iterations, Long timeBudgetMs, long seed) {
    if (iterations < 1) throw new IllegalArgumentException("iterations must be positive");
    CanonicalEvaluator evaluator = new CanonicalEvaluator(problem);
    Random random = new Random(seed);
    CanonicalEvaluator.Evaluation best = null;
    long started = System.nanoTime();
    long completed = 0;
    JsonArray trace = new JsonArray();

    for (int iteration = 0; iteration < iterations; iteration++) {
      if (iteration > 0 && expired(started, timeBudgetMs)) break;
      Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
      for (String task : problem.serviceTasks()) {
        List<BindingProblem.Ref> eligible = problem.eligible(task);
        decision.put(task, eligible.get(random.nextInt(eligible.size())));
      }
      CanonicalEvaluator.Evaluation evaluation = evaluator.evaluate(decision, optimization);
      completed++;
      if (evaluation.feasible() && (best == null || evaluator.comparator().compare(evaluation, best) < 0)) {
        best = evaluation;
        JsonObject event = new JsonObject();
        event.addProperty("eval_index", completed);
        event.addProperty("iteration", iteration + 1);
        event.addProperty("elapsed_ms", (System.nanoTime() - started) / 1000000L);
        event.add("best_objective", best.objectives().get("score"));
        event.addProperty("binding_hash", bindingHash(best.binding()));
        event.addProperty("feasible", true);
        trace.add(event);
      }
    }
    long elapsed = (System.nanoTime() - started) / 1000000L;
    return new Result(best, completed, elapsed, trace);
  }

  private static String bindingHash(Map<String, BindingProblem.Ref> binding) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (Map.Entry<String, BindingProblem.Ref> item : new TreeMap<String, BindingProblem.Ref>(binding).entrySet()) {
        BindingProblem.Ref ref = item.getValue();
        digest.update((item.getKey() + "=" + ref.resource() + "/" + ref.id() + "\n")
            .getBytes(StandardCharsets.UTF_8));
      }
      StringBuilder hex = new StringBuilder();
      for (byte value : digest.digest()) hex.append(String.format("%02x", value & 0xff));
      return hex.toString();
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  private static boolean expired(long started, Long budgetMs) {
    return budgetMs != null && (System.nanoTime() - started) / 1000000L >= budgetMs.longValue();
  }
}
