package es.us.isa.openbinding.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class CanonicalEvaluatorConformanceTest {
  @Test void canonicalObjectiveTypeEnforcesOnlyItsDeclaredCardinality() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject optimization = document.getAsJsonObject("spec").getAsJsonObject("optimization");
    optimization.addProperty("mode", "pareto");
    optimization.addProperty("type", "MULTI");
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(document));

    optimization.getAsJsonArray("terms").add(optimization.getAsJsonArray("terms").get(0).deepCopy());
    assertDoesNotThrow(() -> new BindingProblem(document));
    optimization.addProperty("type", "MANY");
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(document));

    optimization.getAsJsonArray("terms").add(optimization.getAsJsonArray("terms").get(0).deepCopy());
    assertDoesNotThrow(() -> new BindingProblem(document));
    optimization.addProperty("type", "MONO");
    assertDoesNotThrow(() -> new BindingProblem(document));
  }

  @Test void catalogQualifiedCandidateIdentityChangesTheObjective() {
    BindingProblem problem = new BindingProblem(TestProblems.twoCandidates());
    CanonicalEvaluator evaluator = new CanonicalEvaluator(problem);
    CanonicalEvaluator.Evaluation cheap = evaluator.evaluate(TestProblems.decision("catalog-a"));
    CanonicalEvaluator.Evaluation fast = evaluator.evaluate(TestProblems.decision("catalog-b"));

    assertEquals("catalog-a", cheap.binding().get("t").resource());
    assertEquals(1.0, cheap.metrics().get("cost"));
    assertTrue(evaluator.comparator().compare(cheap, fast) < 0);
  }

  @Test void objectiveDominanceUsesExactDeclaredValuesWithoutHiddenTolerance() {
    JsonObject document = TestProblems.twoCandidates();
    document.getAsJsonObject("spec").getAsJsonObject("candidates")
        .getAsJsonObject("catalog-b").getAsJsonObject("candidates")
        .getAsJsonObject("service").getAsJsonObject("metrics")
        .addProperty("price", 1.0000000005);
    CanonicalEvaluator evaluator = new CanonicalEvaluator(new BindingProblem(document));
    CanonicalEvaluator.Evaluation lower = evaluator.evaluate(TestProblems.decision("catalog-a"));
    CanonicalEvaluator.Evaluation higher = evaluator.evaluate(TestProblems.decision("catalog-b"));
    assertTrue(evaluator.dominates(lower, higher));
    assertFalse(evaluator.dominates(higher, lower));
  }

  @Test void changingObjectiveAndHardConstraintChangesThePreferredBinding() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject optimization = document.getAsJsonObject("spec").getAsJsonObject("optimization");
    optimization.getAsJsonArray("terms").get(0).getAsJsonObject()
        .add("metric", ref("app", "latency"));
    BindingProblem latencyProblem = new BindingProblem(document);
    CanonicalEvaluator latency = new CanonicalEvaluator(latencyProblem);
    assertTrue(latency.comparator().compare(
        latency.evaluate(TestProblems.decision("catalog-b")),
        latency.evaluate(TestProblems.decision("catalog-a"))) < 0);

    JsonObject constrainedDocument = TestProblems.twoCandidates();
    JsonObject constraint = new JsonObject();
    constraint.add("ref", ref("constraints", "latency-limit"));
    constraint.add("when", literal(true));
    constraint.addProperty("enforcement", "hard");
    constraint.add("assert", compare("lte", path("tasks.t.metrics.latency"), literal(5)));
    constrainedDocument.getAsJsonObject("spec").getAsJsonArray("constraints").add(constraint);
    BindingProblem constrained = new BindingProblem(constrainedDocument);
    CanonicalEvaluator evaluator = new CanonicalEvaluator(constrained);
    assertFalse(evaluator.evaluate(TestProblems.decision("catalog-a")).feasible());
    assertTrue(evaluator.evaluate(TestProblems.decision("catalog-b")).feasible());
  }

  @Test void absentOptionalProviderMakesHasFalse() {
    JsonObject document = TestProblems.twoCandidates();
    document.getAsJsonObject("spec").getAsJsonObject("candidates")
        .getAsJsonObject("catalog-a").getAsJsonObject("candidates")
        .getAsJsonObject("service").remove("provider");
    JsonObject has = new JsonObject(); has.addProperty("kind", "call"); has.addProperty("name", "has");
    JsonArray arguments = new JsonArray(); arguments.add(path("tasks.t.provider")); has.add("args", arguments);
    JsonObject absent = new JsonObject(); absent.addProperty("kind", "not"); absent.add("value", has);
    JsonObject constraint = new JsonObject(); constraint.add("ref", ref("constraints", "provider-absent"));
    constraint.add("when", literal(true)); constraint.add("assert", absent); constraint.addProperty("enforcement", "hard");
    document.getAsJsonObject("spec").getAsJsonArray("constraints").add(constraint);

    CanonicalEvaluator.Evaluation evaluation = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(TestProblems.decision("catalog-a"));
    assertTrue(evaluation.feasible());
  }

  @Test void selectedCandidateIsCountedOnceAcrossXorAndRepeat() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject app = spec.getAsJsonObject("application");
    JsonObject tasks = app.getAsJsonObject("tasks");
    tasks.add("u", tasks.getAsJsonObject("t").deepCopy());
    JsonArray eligible = spec.getAsJsonObject("eligibility").getAsJsonArray("t");
    JsonArray eligibleU = new JsonArray();
    eligibleU.add(eligible.get(0).deepCopy());
    spec.getAsJsonObject("eligibility").add("u", eligibleU);

    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    branches.add(branch("a", "t"));
    branches.add(branch("b", "u"));
    xor.add("branches", branches);
    JsonObject repeat = new JsonObject();
    repeat.addProperty("kind", "repeat");
    repeat.addProperty("expectedCount", 3.5);
    repeat.add("body", xor);
    app.add("workflow", repeat);
    spec.getAsJsonArray("routing").add(routing("app", "a", 0.25));
    spec.getAsJsonArray("routing").add(routing("app", "b", 0.75));

    BindingProblem problem = new BindingProblem(document);
    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    decision.put("t", new BindingProblem.Ref("catalog-a", "service"));
    decision.put("u", new BindingProblem.Ref("catalog-a", "service"));
    CanonicalEvaluator.Evaluation evaluation = new CanonicalEvaluator(problem).evaluate(decision);
    assertEquals(1.0, evaluation.metrics().get("cost"));
  }

  @Test void aggregationExpressionSupportsWeightedSumLists() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject metric = document.getAsJsonObject("spec").getAsJsonObject("application")
        .getAsJsonObject("metrics").getAsJsonObject("latency");
    JsonObject call = new JsonObject();
    call.addProperty("kind", "call");
    call.addProperty("name", "weightedSum");
    JsonArray args = new JsonArray();
    args.add(path("values"));
    args.add(path("weights"));
    call.add("args", args);
    JsonObject custom = new JsonObject();
    custom.add("expression", call);
    metric.getAsJsonObject("aggregation").add("exclusive", custom);

    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject app = spec.getAsJsonObject("application");
    JsonObject tasks = app.getAsJsonObject("tasks");
    tasks.add("u", tasks.getAsJsonObject("t").deepCopy());
    JsonArray secondEligible = new JsonArray();
    secondEligible.add(ref("catalog-b", "service"));
    spec.getAsJsonObject("eligibility").add("u", secondEligible);
    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    branches.add(branch("slow", "t"));
    branches.add(branch("fast", "u"));
    xor.add("branches", branches);
    app.add("workflow", xor);
    spec.getAsJsonArray("routing").add(routing("app", "fast", 0.75));
    spec.getAsJsonArray("routing").add(routing("app", "slow", 0.25));

    BindingProblem problem = new BindingProblem(document);
    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    decision.put("t", new BindingProblem.Ref("catalog-a", "service"));
    decision.put("u", new BindingProblem.Ref("catalog-b", "service"));
    assertEquals(3.25, new CanonicalEvaluator(problem).evaluate(decision).metrics().get("latency"));

    call.addProperty("name", "weightedProduct");
    BindingProblem productProblem = new BindingProblem(document);
    assertEquals(Math.pow(10.0, 0.25), new CanonicalEvaluator(productProblem)
        .evaluate(decision).metrics().get("latency"), 1e-12);
  }

  @Test void weightedProductSkipsZeroWeightsAndRejectsNegativeFractionalPowers() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject app = spec.getAsJsonObject("application");
    app.getAsJsonObject("tasks").add("u", app.getAsJsonObject("tasks").get("t").deepCopy());
    JsonArray eligibleU = new JsonArray();
    eligibleU.add(ref("catalog-b", "service"));
    spec.getAsJsonObject("eligibility").add("u", eligibleU);
    spec.getAsJsonObject("candidates").getAsJsonObject("catalog-a")
        .getAsJsonObject("candidates").getAsJsonObject("service")
        .getAsJsonObject("metrics").addProperty("response", -2);
    app.getAsJsonObject("metrics").getAsJsonObject("latency")
        .getAsJsonObject("aggregation").addProperty("exclusive", "weightedProduct");
    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    branches.add(branch("negative", "t"));
    branches.add(branch("positive", "u"));
    xor.add("branches", branches);
    app.add("workflow", xor);
    spec.getAsJsonArray("routing").add(routing("app", "negative", 0));
    spec.getAsJsonArray("routing").add(routing("app", "positive", 1));
    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    decision.put("t", new BindingProblem.Ref("catalog-a", "service"));
    decision.put("u", new BindingProblem.Ref("catalog-b", "service"));
    assertEquals(1.0, new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision).metrics().get("latency"));

    spec.getAsJsonArray("routing").get(0).getAsJsonObject().addProperty("probability", 0.5);
    spec.getAsJsonArray("routing").get(1).getAsJsonObject().addProperty("probability", 0.5);
    CanonicalEvaluator evaluator = new CanonicalEvaluator(new BindingProblem(document));
    assertThrows(IllegalArgumentException.class, () -> evaluator.evaluate(decision));
  }

  @Test void conditionalXorRequiresExactlyOneTrueBranch() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject app = document.getAsJsonObject("spec").getAsJsonObject("application");
    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    JsonObject eu = branch("eu", "t");
    eu.add("when", compare("eq", path("tasks.t.properties.region"), literal("eu")));
    JsonObject us = branch("us", "t");
    us.add("when", compare("eq", path("tasks.t.properties.region"), literal("us")));
    branches.add(eu);
    branches.add(us);
    xor.add("branches", branches);
    app.add("workflow", xor);

    BindingProblem problem = new BindingProblem(document);
    assertEquals(10.0, new CanonicalEvaluator(problem)
        .evaluate(TestProblems.decision("catalog-a")).metrics().get("latency"));
  }

  @Test void customAggregationReceivesEmptyValuesWeightsAndZeroCount() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject application = document.getAsJsonObject("spec").getAsJsonObject("application");
    JsonObject local = new JsonObject();
    local.addProperty("kind", "local");
    application.getAsJsonObject("tasks").add("local", local);
    JsonObject localFlow = new JsonObject();
    localFlow.addProperty("kind", "task");
    localFlow.add("task", ref("app", "local"));
    JsonArray steps = new JsonArray();
    steps.add(localFlow);
    JsonObject sequence = new JsonObject();
    sequence.addProperty("kind", "sequence");
    sequence.add("steps", steps);
    application.add("workflow", sequence);
    JsonObject custom = new JsonObject();
    custom.add("expression", literal(7));
    application.getAsJsonObject("metrics").getAsJsonObject("latency")
        .getAsJsonObject("aggregation").add("sequence", custom);

    CanonicalEvaluator.Evaluation evaluation = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(TestProblems.decision("catalog-a"));
    assertEquals(7.0, evaluation.metrics().get("latency"));
  }

  @Test void localBranchUsesTheMaterializedMetricNeutral() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    JsonObject latency = application.getAsJsonObject("metrics").getAsJsonObject("latency");
    latency.addProperty("neutral", 1);
    latency.getAsJsonObject("aggregation").addProperty("sequence", "product");

    JsonObject local = new JsonObject();
    local.addProperty("kind", "local");
    application.getAsJsonObject("tasks").add("local", local);
    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    branches.add(branch("local", "local"));
    branches.add(branch("service", "t"));
    xor.add("branches", branches);
    application.add("workflow", xor);
    spec.getAsJsonArray("routing").add(routing("app", "local", 0.5));
    spec.getAsJsonArray("routing").add(routing("app", "service", 0.5));

    CanonicalEvaluator.Evaluation evaluation = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(TestProblems.decision("catalog-a"));
    assertEquals(5.5, evaluation.metrics().get("latency"));
  }

  @Test void objectiveNormalizationClampsOnlyWhenExplicitlyRequested() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject term = document.getAsJsonObject("spec").getAsJsonObject("optimization")
        .getAsJsonArray("terms").get(0).getAsJsonObject();
    JsonObject normalize = new JsonObject();
    normalize.addProperty("min", 0);
    normalize.addProperty("max", 5);
    normalize.addProperty("clamp", false);
    term.add("normalize", normalize);

    CanonicalEvaluator evaluator = new CanonicalEvaluator(new BindingProblem(document));
    assertEquals(1.8, evaluator.evaluate(TestProblems.decision("catalog-b"))
        .objectives().getAsJsonArray("components").get(0).getAsJsonObject().get("loss").getAsDouble());

    normalize.addProperty("clamp", true);
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    assertEquals(1.0, evaluator.evaluate(TestProblems.decision("catalog-b"))
        .objectives().getAsJsonArray("components").get(0).getAsJsonObject().get("loss").getAsDouble());

    term.addProperty("direction", "maximize");
    normalize.addProperty("clamp", false);
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    assertEquals(-0.8, evaluator.evaluate(TestProblems.decision("catalog-b"))
        .objectives().getAsJsonArray("components").get(0).getAsJsonObject().get("loss").getAsDouble(), 1e-12);
    term.remove("normalize");
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    assertEquals(-9.0, evaluator.evaluate(TestProblems.decision("catalog-b"))
        .objectives().getAsJsonArray("components").get(0).getAsJsonObject().get("loss").getAsDouble());
    term.add("normalize", normalize);
    normalize.remove("clamp");
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(document));
  }

  @Test void routingTargetsAreFullRefsAndNeverImplicitIds() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    branches.add(branch("a", "t"));
    branches.add(branch("b", "t"));
    xor.add("branches", branches);
    application.add("workflow", xor);
    spec.getAsJsonArray("routing").add(routing("overlay", "a", 0.5));
    spec.getAsJsonArray("routing").add(routing("overlay", "b", 0.5));
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(document));
  }

  @Test void softPenaltyIsExplicitAndChangesCanonicalScore() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject constraint = new JsonObject();
    constraint.add("ref", ref("constraints", "preference"));
    constraint.add("when", literal(true));
    constraint.add("assert", literal(false));
    constraint.addProperty("enforcement", "soft");
    constraint.add("penalty", literal(2));
    document.getAsJsonObject("spec").getAsJsonArray("constraints").add(constraint);
    JsonObject penalty = new JsonObject();
    penalty.add("constraint", ref("constraints", "preference"));
    penalty.addProperty("weight", 1);
    document.getAsJsonObject("spec").getAsJsonObject("optimization")
        .getAsJsonArray("penalties").add(penalty);

    CanonicalEvaluator.Evaluation evaluation = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(TestProblems.decision("catalog-a"));
    assertEquals(3.0, evaluation.objectives().get("score").getAsDouble());
    assertEquals(2.0, evaluation.violations().get(0).penalty());

    penalty.add("constraint", ref("constraints", "missing"));
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(document));
  }

  @Test void placementCapacityDistinguishesInvocationAndSelectedCandidateScopes() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    application.getAsJsonObject("tasks").add("u",
        application.getAsJsonObject("tasks").get("t").deepCopy());
    spec.getAsJsonObject("eligibility").add("u",
        spec.getAsJsonObject("eligibility").getAsJsonArray("t").deepCopy());
    JsonObject sequence = new JsonObject();
    sequence.addProperty("kind", "sequence");
    JsonArray steps = new JsonArray();
    steps.add(task("t"));
    steps.add(task("u"));
    sequence.add("steps", steps);
    application.add("workflow", sequence);

    JsonObject placement = placementModel();
    placement.getAsJsonObject("pools").add("shared", pool("placement", "shared", 5));
    placement.getAsJsonArray("demands").add(demand("catalog-a", "service", "shared", 3));
    placement.getAsJsonArray("demands").add(demand("catalog-b", "service", "shared", 3));
    placement.getAsJsonArray("capacityRules").add(capacityRule("invocation"));
    spec.getAsJsonArray("placement").add(placement);

    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    decision.put("t", new BindingProblem.Ref("catalog-a", "service"));
    decision.put("u", new BindingProblem.Ref("catalog-a", "service"));
    CanonicalEvaluator.Evaluation invocation = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision);
    assertFalse(invocation.feasible());
    assertEquals("placement", invocation.violations().get(0).constraint().resource());

    placement.getAsJsonArray("capacityRules").get(0).getAsJsonObject()
        .addProperty("scope", "selectedCandidate");
    CanonicalEvaluator.Evaluation selected = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision);
    assertTrue(selected.feasible());
  }

  @Test void placementTransitionPenaltyAndGlobalLatencyAreAuthoritative() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    application.getAsJsonObject("tasks").add("u",
        application.getAsJsonObject("tasks").get("t").deepCopy());
    JsonArray tEligible = new JsonArray();
    tEligible.add(ref("catalog-a", "service"));
    JsonArray uEligible = new JsonArray();
    uEligible.add(ref("catalog-b", "service"));
    spec.getAsJsonObject("eligibility").add("t", tEligible);
    spec.getAsJsonObject("eligibility").add("u", uEligible);
    JsonObject sequence = new JsonObject();
    sequence.addProperty("kind", "sequence");
    JsonArray steps = new JsonArray();
    steps.add(task("t"));
    steps.add(task("u"));
    sequence.add("steps", steps);
    application.add("workflow", sequence);

    JsonObject placement = placementModel();
    placement.getAsJsonObject("pools").add("left", pool("placement", "left", 10));
    placement.getAsJsonObject("pools").add("right", pool("placement", "right", 10));
    placement.getAsJsonArray("demands").add(demand("catalog-a", "service", "left", 1));
    placement.getAsJsonArray("demands").add(demand("catalog-b", "service", "right", 1));
    placement.getAsJsonArray("network").add(link("left", "right", 5));
    placement.getAsJsonArray("network").add(link("right", "left", 7));
    placement.getAsJsonObject("events").add("start", event("start", "left"));
    JsonObject global = new JsonObject();
    global.add("metric", ref("app", "latency"));
    global.addProperty("includeExecution", true);
    global.addProperty("exclusive", "routing");
    global.addProperty("parallel", "max");
    placement.add("globalLatency", global);
    JsonObject transition = new JsonObject();
    transition.add("ref", ref("placement", "slow-link"));
    transition.add("from", ref("app", "t"));
    transition.add("to", ref("app", "u"));
    transition.add("metric", ref("app", "latency"));
    transition.addProperty("maximum", 4);
    transition.addProperty("enforcement", "soft");
    transition.addProperty("penalty", 7);
    placement.getAsJsonArray("transitions").add(transition);
    spec.getAsJsonArray("placement").add(placement);
    JsonObject penalty = new JsonObject();
    penalty.add("constraint", ref("placement", "slow-link"));
    penalty.addProperty("weight", 1);
    spec.getAsJsonObject("optimization").getAsJsonArray("penalties").add(penalty);

    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    decision.put("t", new BindingProblem.Ref("catalog-a", "service"));
    decision.put("u", new BindingProblem.Ref("catalog-b", "service"));
    CanonicalEvaluator.Evaluation evaluation = new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision);
    assertEquals(16.0, evaluation.metrics().get("latency"));
    assertTrue(evaluation.feasible());
    assertEquals(7.0, evaluation.violations().get(0).penalty());
    assertEquals(17.0, evaluation.objectives().get("score").getAsDouble());
  }

  @Test void placementGlobalLatencyComposesRoutingParallelAndExpectedRepeats() {
    JsonObject document = placementLatencyProblem();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    JsonObject xor = new JsonObject();
    xor.addProperty("kind", "exclusive");
    JsonArray branches = new JsonArray();
    branches.add(branch("left", "t"));
    branches.add(branch("right", "u"));
    xor.add("branches", branches);
    application.add("workflow", xor);
    spec.getAsJsonArray("routing").add(routing("app", "left", 0.25));
    spec.getAsJsonArray("routing").add(routing("app", "right", 0.75));
    Map<String, BindingProblem.Ref> decision = placementDecision();
    assertEquals(7.0, new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision).metrics().get("latency"));

    JsonObject parallel = new JsonObject();
    parallel.addProperty("kind", "parallel");
    JsonArray parallelBranches = new JsonArray();
    parallelBranches.add(task("t"));
    parallelBranches.add(task("u"));
    parallel.add("branches", parallelBranches);
    application.add("workflow", parallel);
    spec.add("routing", new JsonArray());
    assertEquals(10.0, new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision).metrics().get("latency"));
    spec.getAsJsonArray("placement").get(0).getAsJsonObject()
        .getAsJsonObject("globalLatency").addProperty("parallel", "sum");
    assertEquals(16.0, new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision).metrics().get("latency"));

    JsonObject repeat = new JsonObject();
    repeat.addProperty("kind", "repeat");
    repeat.addProperty("expectedCount", 2);
    repeat.add("body", task("t"));
    application.add("workflow", repeat);
    assertEquals(20.0, new CanonicalEvaluator(new BindingProblem(document))
        .evaluate(decision).metrics().get("latency"));
  }

  @Test void everyBuiltInWorkflowAggregationMatchesItsAnalyticalFormula() {
    Map<String, Double> binaryExpected = new LinkedHashMap<String, Double>();
    binaryExpected.put("sum", 11.0);
    binaryExpected.put("product", 10.0);
    binaryExpected.put("min", 1.0);
    binaryExpected.put("max", 10.0);
    for (String kind : new String[] {"sequence", "parallel"}) {
      for (Map.Entry<String, Double> expected : binaryExpected.entrySet()) {
        JsonObject document = twoTaskProblem(kind);
        document.getAsJsonObject("spec").getAsJsonObject("application")
            .getAsJsonObject("metrics").getAsJsonObject("latency")
            .getAsJsonObject("aggregation").addProperty(kind, expected.getKey());
        double actual = new CanonicalEvaluator(new BindingProblem(document))
            .evaluate(placementDecision()).metrics().get("latency").doubleValue();
        assertEquals(expected.getValue().doubleValue(), actual, 1e-12,
            kind + "." + expected.getKey());
      }
    }

    Map<String, Double> exclusiveExpected = new LinkedHashMap<String, Double>();
    exclusiveExpected.put("weightedSum", 3.25);
    exclusiveExpected.put("weightedProduct", Math.pow(10.0, 0.25));
    exclusiveExpected.put("min", 1.0);
    exclusiveExpected.put("max", 10.0);
    for (Map.Entry<String, Double> expected : exclusiveExpected.entrySet()) {
      JsonObject document = twoTaskProblem("exclusive");
      JsonObject spec = document.getAsJsonObject("spec");
      spec.getAsJsonArray("routing").add(routing("app", "left", 0.25));
      spec.getAsJsonArray("routing").add(routing("app", "right", 0.75));
      spec.getAsJsonObject("application").getAsJsonObject("metrics")
          .getAsJsonObject("latency").getAsJsonObject("aggregation")
          .addProperty("exclusive", expected.getKey());
      double actual = new CanonicalEvaluator(new BindingProblem(document))
          .evaluate(placementDecision()).metrics().get("latency").doubleValue();
      assertEquals(expected.getValue().doubleValue(), actual, 1e-12,
          "exclusive." + expected.getKey());
    }

    Map<String, Double> repeatExpected = new LinkedHashMap<String, Double>();
    repeatExpected.put("scale", 25.0);
    repeatExpected.put("power", Math.pow(10.0, 2.5));
    repeatExpected.put("identity", 10.0);
    for (Map.Entry<String, Double> expected : repeatExpected.entrySet()) {
      JsonObject document = TestProblems.twoCandidates();
      JsonObject application = document.getAsJsonObject("spec").getAsJsonObject("application");
      JsonObject repeat = new JsonObject();
      repeat.addProperty("kind", "repeat");
      repeat.addProperty("expectedCount", 2.5);
      repeat.add("body", task("t"));
      application.add("workflow", repeat);
      application.getAsJsonObject("metrics").getAsJsonObject("latency")
          .getAsJsonObject("aggregation").addProperty("repeat", expected.getKey());
      double actual = new CanonicalEvaluator(new BindingProblem(document))
          .evaluate(TestProblems.decision("catalog-a")).metrics().get("latency").doubleValue();
      assertEquals(expected.getValue().doubleValue(), actual, 1e-12,
          "repeat." + expected.getKey());
    }
  }

  @Test void weightedLexicographicParetoAndSatisfyHaveDistinctExactOrders() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject optimization = document.getAsJsonObject("spec").getAsJsonObject("optimization");
    JsonArray terms = optimization.getAsJsonArray("terms");
    terms.get(0).getAsJsonObject().addProperty("weight", 0.25);
    JsonObject latency = new JsonObject();
    latency.add("metric", ref("app", "latency"));
    latency.addProperty("direction", "minimize");
    latency.addProperty("weight", 0.75);
    terms.add(latency);
    CanonicalEvaluator evaluator = new CanonicalEvaluator(new BindingProblem(document));
    CanonicalEvaluator.Evaluation a = evaluator.evaluate(TestProblems.decision("catalog-a"));
    CanonicalEvaluator.Evaluation b = evaluator.evaluate(TestProblems.decision("catalog-b"));
    assertEquals(7.75, a.objectiveVector().get(0), 1e-12);
    assertEquals(3.0, b.objectiveVector().get(0), 1e-12);
    assertTrue(evaluator.comparator().compare(b, a) < 0);

    optimization.addProperty("mode", "lexicographic");
    terms.get(0).getAsJsonObject().addProperty("weight", 1);
    terms.get(1).getAsJsonObject().addProperty("weight", 1);
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    a = evaluator.evaluate(TestProblems.decision("catalog-a"));
    b = evaluator.evaluate(TestProblems.decision("catalog-b"));
    assertEquals(java.util.Arrays.asList(1.0, 10.0, 0.0), a.objectiveVector());
    assertEquals(java.util.Arrays.asList(9.0, 1.0, 0.0), b.objectiveVector());
    assertTrue(evaluator.comparator().compare(a, b) < 0);

    optimization.addProperty("mode", "pareto");
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    a = evaluator.evaluate(TestProblems.decision("catalog-a"));
    b = evaluator.evaluate(TestProblems.decision("catalog-b"));
    assertFalse(evaluator.dominates(a, b));
    assertFalse(evaluator.dominates(b, a));

    optimization.addProperty("mode", "satisfy");
    optimization.add("terms", new JsonArray());
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    assertEquals(0.0, evaluator.evaluate(TestProblems.decision("catalog-a"))
        .objectiveVector().get(0), 1e-12);
  }

  @Test void hardFeasibilityAndDynamicSoftPenaltyAreEvaluatedWithoutHiddenTolerance() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject hard = new JsonObject();
    hard.add("ref", ref("constraints", "latency-limit"));
    hard.add("when", literal(true));
    hard.add("assert", compare("lte", path("metrics.latency"), literal(5)));
    hard.addProperty("enforcement", "hard");
    spec.getAsJsonArray("constraints").add(hard);
    CanonicalEvaluator evaluator = new CanonicalEvaluator(new BindingProblem(document));
    CanonicalEvaluator.Evaluation slow = evaluator.evaluate(TestProblems.decision("catalog-a"));
    CanonicalEvaluator.Evaluation fast = evaluator.evaluate(TestProblems.decision("catalog-b"));
    assertFalse(slow.feasible());
    assertTrue(fast.feasible());
    assertTrue(evaluator.comparator().compare(fast, slow) < 0);

    spec.getAsJsonArray("constraints").remove(0);
    JsonObject soft = new JsonObject();
    soft.add("ref", ref("constraints", "latency-preference"));
    soft.add("when", literal(true));
    soft.add("assert", compare("lte", path("metrics.latency"), literal(5)));
    soft.addProperty("enforcement", "soft");
    JsonObject penaltyExpression = new JsonObject();
    penaltyExpression.addProperty("kind", "arithmetic");
    penaltyExpression.addProperty("op", "sub");
    penaltyExpression.add("left", path("metrics.latency"));
    penaltyExpression.add("right", literal(5));
    soft.add("penalty", penaltyExpression);
    spec.getAsJsonArray("constraints").add(soft);
    JsonObject penalty = new JsonObject();
    penalty.add("constraint", ref("constraints", "latency-preference"));
    penalty.addProperty("weight", 1);
    spec.getAsJsonObject("optimization").getAsJsonArray("penalties").add(penalty);
    evaluator = new CanonicalEvaluator(new BindingProblem(document));
    slow = evaluator.evaluate(TestProblems.decision("catalog-a"));
    fast = evaluator.evaluate(TestProblems.decision("catalog-b"));
    assertEquals(5.0, slow.penalties().get(0), 1e-12);
    assertEquals(6.0, slow.objectiveVector().get(0), 1e-12);
    assertEquals(0.0, fast.penalties().get(0), 1e-12);
    assertEquals(9.0, fast.objectiveVector().get(0), 1e-12);
    assertTrue(evaluator.comparator().compare(slow, fast) < 0);
  }

  @Test void canonicalIdentityPinsProfileDialectsAdaptersAndResources() {
    JsonObject document = TestProblems.twoCandidates();
    new BindingProblem(document);

    JsonObject missingAdapter = document.deepCopy();
    missingAdapter.getAsJsonObject("spec").getAsJsonObject("profile").remove("adapter");
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(missingAdapter));

    JsonObject malformedDigest = document.deepCopy();
    malformedDigest.getAsJsonObject("spec").getAsJsonArray("dialects").get(0)
        .getAsJsonObject().addProperty("digest", "sha256-not-a-digest");
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(malformedDigest));

    JsonObject duplicateFeature = document.deepCopy();
    JsonObject feature = new JsonObject();
    feature.addProperty("dimension", "placement");
    feature.addProperty("value", "placement");
    JsonArray features = duplicateFeature.getAsJsonObject("spec").getAsJsonArray("dialects")
        .get(0).getAsJsonObject().getAsJsonArray("irFeatures");
    features.add(feature);
    features.add(feature.deepCopy());
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(duplicateFeature));

    JsonObject ambiguousResource = document.deepCopy();
    JsonObject application = ambiguousResource.getAsJsonObject("spec").getAsJsonObject("instance")
        .getAsJsonObject("resources").getAsJsonObject("app");
    JsonObject registered = new JsonObject();
    registered.addProperty("namespace", "example");
    registered.addProperty("name", "application");
    registered.addProperty("version", "1.0.0");
    registered.addProperty("digest", application.get("digest").getAsString());
    application.add("registered", registered);
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(ambiguousResource));

    JsonObject nonCanonicalWeight = document.deepCopy();
    nonCanonicalWeight.getAsJsonObject("spec").getAsJsonObject("optimization")
        .getAsJsonArray("terms").get(0).getAsJsonObject().addProperty("weight", 2);
    assertThrows(IllegalArgumentException.class, () -> new BindingProblem(nonCanonicalWeight));
  }

  @Test void engineLongOptionsPreserveExactJsonIntegers() {
    JsonObject exact = new com.google.gson.JsonParser()
        .parse("{\"seed\":9007199254740993}").getAsJsonObject();
    assertEquals(9007199254740993L, EngineContract.longOption(exact, "seed", 0L));
    JsonObject fractional = new com.google.gson.JsonParser().parse("{\"seed\":1.5}").getAsJsonObject();
    assertThrows(IllegalArgumentException.class,
        () -> EngineContract.longOption(fractional, "seed", 0L));
    JsonObject overflow = new com.google.gson.JsonParser()
        .parse("{\"seed\":9223372036854775808}").getAsJsonObject();
    assertThrows(IllegalArgumentException.class,
        () -> EngineContract.longOption(overflow, "seed", 0L));
  }

  @Test void transportRejectsSourceDocumentsAndWrongProtocol() {
    String instance = "{\"apiVersion\":\"bim/v1\",\"kind\":\"Instance\",\"metadata\":{},\"spec\":{}}";
    assertThrows(IllegalArgumentException.class, () -> EngineContract.parse(
        "{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblemRequest\","
            + "\"protocol\":\"bim-engine/v1\",\"problem\":" + instance + "}"));
    assertThrows(IllegalArgumentException.class, () -> EngineContract.parse(
        TestProblems.envelope(TestProblems.twoCandidates(), "{}").replace("bim-engine/v1", "wrong/v1")));
  }

  private static JsonObject ref(String resource, String id) {
    JsonObject value = new JsonObject(); value.addProperty("resource", resource); value.addProperty("id", id); return value;
  }
  private static JsonObject routing(String resource, String id, double probability) {
    JsonObject value = new JsonObject(); value.add("target", ref(resource, id));
    value.addProperty("probability", probability); return value;
  }
  private static JsonObject literal(Object value) {
    JsonObject node = new JsonObject(); node.addProperty("kind", "literal");
    if (value instanceof Boolean) node.addProperty("value", (Boolean) value);
    else if (value instanceof Number) node.addProperty("value", (Number) value);
    else node.addProperty("value", String.valueOf(value));
    return node;
  }
  private static JsonObject path(String path) {
    JsonObject node = new JsonObject(); node.addProperty("kind", "path");
    JsonArray segments = new JsonArray();
    for (String segment : path.split("\\.")) segments.add(segment);
    node.add("segments", segments);
    return node;
  }
  private static JsonObject compare(String op, JsonObject left, JsonObject right) {
    JsonObject node = new JsonObject(); node.addProperty("kind", "compare"); node.addProperty("op", op); node.add("left", left); node.add("right", right); return node;
  }
  private static JsonObject branch(String id, String task) {
    JsonObject branch = new JsonObject(); branch.addProperty("id", id);
    JsonObject flow = new JsonObject(); flow.addProperty("kind", "task"); flow.add("task", ref("app", task));
    branch.add("flow", flow); return branch;
  }
  private static JsonObject task(String id) {
    JsonObject flow = new JsonObject(); flow.addProperty("kind", "task");
    flow.add("task", ref("app", id)); return flow;
  }
  private static JsonObject placementModel() {
    JsonObject placement = new JsonObject();
    placement.addProperty("resource", "placement");
    placement.add("pools", new JsonObject());
    placement.add("demands", new JsonArray());
    placement.add("network", new JsonArray());
    placement.add("events", new JsonObject());
    placement.add("transitions", new JsonArray());
    placement.add("capacityRules", new JsonArray());
    return placement;
  }
  private static JsonObject pool(String resource, String id, double cpu) {
    JsonObject pool = new JsonObject(); pool.add("ref", ref(resource, id));
    pool.addProperty("kind", "compute");
    JsonObject capacity = new JsonObject(); capacity.addProperty("cpu", cpu);
    pool.add("capacity", capacity); pool.add("properties", new JsonObject()); return pool;
  }
  private static JsonObject demand(String catalog, String candidate, String pool, double cpu) {
    JsonObject demand = new JsonObject(); demand.add("candidate", ref(catalog, candidate));
    demand.add("pool", ref("placement", pool));
    JsonObject resources = new JsonObject(); resources.addProperty("cpu", cpu);
    demand.add("resources", resources); return demand;
  }
  private static JsonObject link(String from, String to, double latency) {
    JsonObject link = new JsonObject(); link.add("from", ref("placement", from));
    link.add("to", ref("placement", to)); link.addProperty("latency", latency); return link;
  }
  private static JsonObject event(String id, String pool) {
    JsonObject event = new JsonObject(); event.add("ref", ref("placement", id));
    event.add("pool", ref("placement", pool)); event.add("latency", new JsonArray()); return event;
  }
  private static JsonObject capacityRule(String scope) {
    JsonObject rule = new JsonObject(); rule.add("ref", ref("placement", "capacityRules/0"));
    JsonArray resources = new JsonArray(); resources.add("cpu"); rule.add("resources", resources);
    rule.addProperty("scope", scope); return rule;
  }
  private static JsonObject placementLatencyProblem() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    application.getAsJsonObject("tasks").add("u",
        application.getAsJsonObject("tasks").get("t").deepCopy());
    JsonArray tEligible = new JsonArray(); tEligible.add(ref("catalog-a", "service"));
    JsonArray uEligible = new JsonArray(); uEligible.add(ref("catalog-b", "service"));
    spec.getAsJsonObject("eligibility").add("t", tEligible);
    spec.getAsJsonObject("eligibility").add("u", uEligible);
    JsonObject placement = placementModel();
    placement.getAsJsonObject("pools").add("left", pool("placement", "left", 10));
    placement.getAsJsonObject("pools").add("right", pool("placement", "right", 10));
    placement.getAsJsonArray("demands").add(demand("catalog-a", "service", "left", 1));
    placement.getAsJsonArray("demands").add(demand("catalog-b", "service", "right", 1));
    placement.getAsJsonArray("network").add(link("left", "right", 5));
    placement.getAsJsonArray("network").add(link("right", "left", 7));
    placement.getAsJsonObject("events").add("start", event("start", "left"));
    JsonObject global = new JsonObject(); global.add("metric", ref("app", "latency"));
    global.addProperty("includeExecution", true); global.addProperty("exclusive", "routing");
    global.addProperty("parallel", "max"); placement.add("globalLatency", global);
    spec.getAsJsonArray("placement").add(placement);
    return document;
  }
  private static Map<String, BindingProblem.Ref> placementDecision() {
    Map<String, BindingProblem.Ref> decision = new LinkedHashMap<String, BindingProblem.Ref>();
    decision.put("t", new BindingProblem.Ref("catalog-a", "service"));
    decision.put("u", new BindingProblem.Ref("catalog-b", "service"));
    return decision;
  }

  private static JsonObject twoTaskProblem(String kind) {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    application.getAsJsonObject("tasks").add("u",
        application.getAsJsonObject("tasks").get("t").deepCopy());
    JsonArray tEligible = new JsonArray(); tEligible.add(ref("catalog-a", "service"));
    JsonArray uEligible = new JsonArray(); uEligible.add(ref("catalog-b", "service"));
    spec.getAsJsonObject("eligibility").add("t", tEligible);
    spec.getAsJsonObject("eligibility").add("u", uEligible);
    if ("exclusive".equals(kind)) {
      JsonObject exclusive = new JsonObject(); exclusive.addProperty("kind", "exclusive");
      JsonArray branches = new JsonArray(); branches.add(branch("left", "t")); branches.add(branch("right", "u"));
      exclusive.add("branches", branches); application.add("workflow", exclusive);
    } else {
      JsonObject binary = new JsonObject(); binary.addProperty("kind", kind);
      JsonArray children = new JsonArray(); children.add(task("t")); children.add(task("u"));
      binary.add("sequence".equals(kind) ? "steps" : "branches", children);
      application.add("workflow", binary);
    }
    return document;
  }
}
