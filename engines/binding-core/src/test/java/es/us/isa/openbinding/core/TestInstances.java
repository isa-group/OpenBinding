package es.us.isa.openbinding.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;

/**
 * Small instances the engine test suites build on.
 *
 * <p>Lives in the shared core so that random-search and many-heuristic test
 * their searches against the same problem, which is what makes their results
 * comparable at all.
 */
public final class TestInstances {

    private TestInstances() {
    }

    /**
     * Two tasks in sequence, two candidates each, one cost feature.
     *
     * <p>Costs are 1 and 50 per task, so the optimum is 2 and the worst is
     * 100, and a bound of 60 splits the space into feasible and infeasible
     * halves.
     */
    public static BimStarModels.Instance twoTasksTwoCandidates() {
        BimStarModels.Instance instance = new BimStarModels.Instance();

        BimStarModels.Feature cost = new BimStarModels.Feature();
        cost.id = "cost";
        cost.direction = "MINIMIZE";
        cost.scale = "RATIO";
        cost.valid_range = range(0.0, 1000.0);

        BimStarModels.Feature quality = new BimStarModels.Feature();
        quality.id = "quality";
        quality.direction = "MAXIMIZE";
        quality.scale = "RATIO";
        quality.valid_range = range(0.0, 1.0);

        instance.features = new ArrayList<BimStarModels.Feature>(Arrays.asList(cost, quality));

        instance.candidates = new ArrayList<BimStarModels.Candidate>(Arrays.asList(
                candidate("A1", "T1", 1.0, 0.2),
                candidate("A2", "T1", 50.0, 0.9),
                candidate("B1", "T2", 1.0, 0.3),
                candidate("B2", "T2", 50.0, 0.8)));

        BimStarModels.Node t1 = new BimStarModels.Node();
        t1.id = "n1";
        t1.kind = "TASK";
        t1.task_id = "T1";
        BimStarModels.Node t2 = new BimStarModels.Node();
        t2.id = "n2";
        t2.kind = "TASK";
        t2.task_id = "T2";
        BimStarModels.Node seq = new BimStarModels.Node();
        seq.id = "s";
        seq.kind = "SEQ";
        seq.children = new ArrayList<BimStarModels.Node>(Arrays.asList(t1, t2));

        instance.composition = new BimStarModels.Composition();
        instance.composition.type = "STRUCTURED";
        instance.composition.root = seq;

        instance.aggregation_policies.put("cost", policy(0.0, "SUM"));
        instance.aggregation_policies.put("quality", policy(1.0, "MIN"));

        BimStarModels.Objective objective = new BimStarModels.Objective();
        objective.type = "MONO";
        objective.targets = new ArrayList<String>(Arrays.asList("cost", "quality"));
        objective.weights.put("cost", Double.valueOf(0.5));
        objective.weights.put("quality", Double.valueOf(0.5));
        instance.objective = objective;

        return instance;
    }

    /** The same instance with a hard global bound on the total cost. */
    public static BimStarModels.Instance withGlobalCostBound(double bound) {
        BimStarModels.Instance instance = twoTasksTwoCandidates();
        BimStarModels.Constraint constraint = new BimStarModels.Constraint();
        constraint.id = "c_cost";
        constraint.kind = "ATTRIBUTE_BOUND";
        constraint.scope = "GLOBAL";
        constraint.attribute_id = "cost";
        constraint.op = "<=";
        constraint.value = Double.valueOf(bound);
        constraint.hard = Boolean.TRUE;
        instance.constraints =
                new ArrayList<BimStarModels.Constraint>(Collections.singletonList(constraint));
        return instance;
    }

    private static BimStarModels.Candidate candidate(String id, String taskId, double cost, double quality) {
        BimStarModels.Candidate candidate = new BimStarModels.Candidate();
        candidate.id = id;
        candidate.task_id = taskId;
        candidate.provider_id = "P1";
        candidate.features.put("cost", Double.valueOf(cost));
        candidate.features.put("quality", Double.valueOf(quality));
        return candidate;
    }

    private static BimStarModels.AggregationPolicy policy(double neutral, String fn) {
        BimStarModels.AggregationPolicy policy = new BimStarModels.AggregationPolicy();
        policy.neutral = Double.valueOf(neutral);
        BimStarModels.AggregationFunction function = new BimStarModels.AggregationFunction();
        function.fn = fn;
        policy.compose.put("seq", function);
        policy.compose.put("and", function);
        return policy;
    }

    private static BimStarModels.NumericRange range(double min, double max) {
        BimStarModels.NumericRange range = new BimStarModels.NumericRange();
        range.min = min;
        range.max = max;
        return range;
    }
}
