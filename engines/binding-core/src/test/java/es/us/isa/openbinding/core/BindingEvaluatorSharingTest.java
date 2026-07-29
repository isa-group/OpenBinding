package es.us.isa.openbinding.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import java.util.Arrays;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * One candidate serving several tasks at once.
 *
 * <p>The numbers here are worked out by hand and match the ones the gateway
 * reference evaluator produces for the same bindings: an engine that drifts
 * from them would report a solution the gateway then scores differently.
 */
class BindingEvaluatorSharingTest {
  private static final Gson GSON = new Gson();

  /** Two tasks in sequence; "both" can serve either, the others one each. */
  private static String instance(String features, String constraints) {
    return "{"
        + "  \"instance\": {"
        + "    \"features\": [" + features + "],"
        + "    \"candidates\": ["
        + "      {\"id\":\"both\",\"task_ids\":[\"a\",\"b\"],\"provider_id\":\"p1\","
        + "       \"features\":{\"cost\":10,\"latency\":4}},"
        + "      {\"id\":\"only_a\",\"task_ids\":[\"a\"],\"provider_id\":\"p1\","
        + "       \"features\":{\"cost\":3,\"latency\":1}},"
        + "      {\"id\":\"only_b\",\"task_ids\":[\"b\"],\"provider_id\":\"p1\","
        + "       \"features\":{\"cost\":3,\"latency\":1}}"
        + "    ],"
        + "    \"composition\": {\"type\":\"STRUCTURED\",\"root\":{\"kind\":\"SEQ\",\"children\":["
        + "      {\"kind\":\"TASK\",\"task_id\":\"a\"},"
        + "      {\"kind\":\"TASK\",\"task_id\":\"b\"}"
        + "    ]}},"
        + "    \"aggregation_policies\": {"
        + "      \"cost\":{\"neutral\":0,\"compose\":{\"seq\":{\"fn\":\"SUM\"}}},"
        + "      \"latency\":{\"neutral\":0,\"compose\":{\"seq\":{\"fn\":\"SUM\"}}}"
        + "    },"
        + "    \"constraints\": [" + constraints + "],"
        + "    \"objective\": {\"type\":\"MONO\",\"targets\":[\"cost\"],\"weights\":{\"cost\":1.0}}"
        + "  }"
        + "}";
  }

  private static final String SHARED_COST =
      "{\"id\":\"cost\",\"direction\":\"MINIMIZE\",\"valid_range\":{\"min\":0,\"max\":100},"
          + "\"sharing\":\"DIVIDE\"},"
          + "{\"id\":\"latency\",\"direction\":\"MINIMIZE\",\"valid_range\":{\"min\":0,\"max\":100}}";

  private static BindingEvaluator evaluator(String json) {
    EngineModels.SolveRequest request = GSON.fromJson(json, EngineModels.SolveRequest.class);
    return new BindingEvaluator(request.instance, null);
  }

  /** Index of a candidate within a task's own market, which is what an allele is. */
  private static int pick(BindingEvaluator evaluator, int taskIndex, String candidateId) {
    for (int i = 0; i < evaluator.candidateCount(taskIndex); i++) {
      BindingEvaluator.Evaluation trial =
          evaluator.evaluate(taskIndex == 0 ? Arrays.asList(i, 0) : Arrays.asList(0, i));
      String bound = trial.binding().get(evaluator.taskIds().get(taskIndex));
      if (candidateId.equals(bound)) {
        return i;
      }
    }
    throw new IllegalArgumentException("no such candidate for that task: " + candidateId);
  }

  @Test
  void aSharedCandidateSplitsWhatIsPaidForIt() {
    BindingEvaluator evaluator = evaluator(instance(SHARED_COST, ""));
    int a = pick(evaluator, 0, "both");
    int b = pick(evaluator, 1, "both");

    Map<String, Double> aggregated = evaluator.evaluate(Arrays.asList(a, b)).aggregated();

    assertEquals(10.0, aggregated.get("cost"), 1e-12, "10 paid once, 5 carried by each task");
    assertEquals(8.0, aggregated.get("latency"), 1e-12, "latency is spent per task, not split");
  }

  @Test
  void aCandidateUsedOnceIsNotSplit() {
    BindingEvaluator evaluator = evaluator(instance(SHARED_COST, ""));

    Map<String, Double> aggregated =
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "both"), pick(evaluator, 1, "only_b")))
            .aggregated();

    assertEquals(13.0, aggregated.get("cost"), 1e-12);
  }

  @Test
  void withoutASharingDeclarationNothingIsSplit() {
    String plain =
        "{\"id\":\"cost\",\"direction\":\"MINIMIZE\",\"valid_range\":{\"min\":0,\"max\":100}},"
            + "{\"id\":\"latency\",\"direction\":\"MINIMIZE\",\"valid_range\":{\"min\":0,\"max\":100}}";
    BindingEvaluator evaluator = evaluator(instance(plain, ""));

    Map<String, Double> aggregated =
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "both"), pick(evaluator, 1, "both")))
            .aggregated();

    assertEquals(20.0, aggregated.get("cost"), 1e-12);
  }

  @Test
  void sameCandidateIsSatisfiedOnlyByOneCandidateForBoth() {
    String constraint =
        "{\"id\":\"together\",\"kind\":\"DEPENDENCY\",\"type\":\"SAME_CANDIDATE\","
            + "\"tasks\":[\"a\",\"b\"],\"hard\":true}";
    BindingEvaluator evaluator = evaluator(instance(SHARED_COST, constraint));

    assertEquals(
        0.0,
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "both"), pick(evaluator, 1, "both")))
            .constraints().hardViolation(),
        1e-12);
    assertTrue(
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "only_a"), pick(evaluator, 1, "only_b")))
            .constraints().hardViolation() > 0.0);
  }

  @Test
  void differentCandidateIsTheOtherWayRound() {
    String constraint =
        "{\"id\":\"apart\",\"kind\":\"DEPENDENCY\",\"type\":\"DIFFERENT_CANDIDATE\","
            + "\"tasks\":[\"a\",\"b\"],\"hard\":true}";
    BindingEvaluator evaluator = evaluator(instance(SHARED_COST, constraint));

    assertEquals(
        0.0,
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "only_a"), pick(evaluator, 1, "only_b")))
            .constraints().hardViolation(),
        1e-12);
    assertTrue(
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "both"), pick(evaluator, 1, "both")))
            .constraints().hardViolation() > 0.0);
  }

  @Test
  void aCandidateServingTwoTasksIsAnOptionForEachOfThem() {
    BindingEvaluator evaluator = evaluator(instance(SHARED_COST, ""));

    assertEquals(2, evaluator.candidateCount(0));
    assertEquals(2, evaluator.candidateCount(1));
  }

  @Test
  void aSharedCandidateTakesUpItsDemandOnce() {
    String json = instance(SHARED_COST, "").replace(
        "\"objective\":",
        "\"resource_model\": {"
            + "  \"resources\":[\"memory\"],"
            + "  \"pools\":[{\"id\":\"pool\",\"name\":\"Node\",\"kind\":\"EDGE\","
            + "             \"capacity\":{\"memory\":3.0}}],"
            + "  \"candidate_bindings\":["
            + "    {\"candidate_id\":\"both\",\"pool_id\":\"pool\",\"demand\":{\"memory\":2.0}},"
            + "    {\"candidate_id\":\"only_a\",\"pool_id\":\"pool\",\"demand\":{\"memory\":2.0}},"
            + "    {\"candidate_id\":\"only_b\",\"pool_id\":\"pool\",\"demand\":{\"memory\":2.0}}"
            + "  ],"
            + "  \"constraints\":[{\"id\":\"cap\",\"kind\":\"DEPENDENCY\","
            + "                   \"type\":\"RESOURCE_CAPACITY\",\"scope\":\"ALL_POOLS\","
            + "                   \"resources\":[\"memory\"],\"hard\":true}]"
            + "},"
            + "\"objective\":");

    EngineModels.SolveRequest request = GSON.fromJson(json, EngineModels.SolveRequest.class);
    // The placement blocks are not part of the parsed instance; the engines
    // read them off the request as it arrived, and so does this.
    @SuppressWarnings("unchecked")
    Map<String, Object> raw = GSON.fromJson(json, Map.class);
    @SuppressWarnings("unchecked")
    Map<String, Object> instanceMap = (Map<String, Object>) raw.get("instance");
    PlacementEvaluator placement = new PlacementEvaluator(PlacementAdapter.from(instanceMap));
    BindingEvaluator evaluator = new BindingEvaluator(request.instance, placement);

    double shared =
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "both"), pick(evaluator, 1, "both")))
            .constraints().hardViolation();
    double separate =
        evaluator.evaluate(Arrays.asList(pick(evaluator, 0, "only_a"), pick(evaluator, 1, "only_b")))
            .constraints().hardViolation();

    assertEquals(0.0, shared, 1e-12, "one deployment wants 2.0 of the pool's 3.0");
    assertFalse(separate <= 0.0, "two deployments want 4.0 of a pool that has 3.0");
  }
}
