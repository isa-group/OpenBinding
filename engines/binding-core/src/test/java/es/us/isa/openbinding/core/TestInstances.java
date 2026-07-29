package es.us.isa.openbinding.core;

import es.us.isa.openbinding.core.model.AggregationFunction;
import es.us.isa.openbinding.core.model.AggregationPolicy;
import es.us.isa.openbinding.core.model.Candidate;
import es.us.isa.openbinding.core.model.Composition;
import es.us.isa.openbinding.core.model.Constraint;
import es.us.isa.openbinding.core.model.Feature;
import es.us.isa.openbinding.core.model.Node;
import es.us.isa.openbinding.core.model.NumericRange;
import es.us.isa.openbinding.core.model.Objective;

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
    public static EngineModels.Instance twoTasksTwoCandidates() {
        EngineModels.Instance instance = new EngineModels.Instance();

        Feature cost = new Feature();
        cost.id = "cost";
        cost.direction = "MINIMIZE";
        cost.scale = "RATIO";
        cost.valid_range = range(0.0, 1000.0);

        Feature quality = new Feature();
        quality.id = "quality";
        quality.direction = "MAXIMIZE";
        quality.scale = "RATIO";
        quality.valid_range = range(0.0, 1.0);

        instance.features = new ArrayList<Feature>(Arrays.asList(cost, quality));

        instance.candidates = new ArrayList<Candidate>(Arrays.asList(
                candidate("A1", "T1", 1.0, 0.2),
                candidate("A2", "T1", 50.0, 0.9),
                candidate("B1", "T2", 1.0, 0.3),
                candidate("B2", "T2", 50.0, 0.8)));

        Node t1 = new Node();
        t1.id = "n1";
        t1.kind = "TASK";
        t1.task_id = "T1";
        Node t2 = new Node();
        t2.id = "n2";
        t2.kind = "TASK";
        t2.task_id = "T2";
        Node seq = new Node();
        seq.id = "s";
        seq.kind = "SEQ";
        seq.children = new ArrayList<Node>(Arrays.asList(t1, t2));

        instance.composition = new Composition();
        instance.composition.type = "STRUCTURED";
        instance.composition.root = seq;

        instance.aggregation_policies.put("cost", policy(0.0, "SUM"));
        instance.aggregation_policies.put("quality", policy(1.0, "MIN"));

        Objective objective = new Objective();
        objective.type = "MONO";
        objective.targets = new ArrayList<String>(Arrays.asList("cost", "quality"));
        objective.weights.put("cost", Double.valueOf(0.5));
        objective.weights.put("quality", Double.valueOf(0.5));
        instance.objective = objective;

        return instance;
    }

    /** The same instance with a hard global bound on the total cost. */
    public static EngineModels.Instance withGlobalCostBound(double bound) {
        EngineModels.Instance instance = twoTasksTwoCandidates();
        Constraint constraint = new Constraint();
        constraint.id = "c_cost";
        constraint.kind = "ATTRIBUTE_BOUND";
        constraint.scope = "GLOBAL";
        constraint.attribute_id = "cost";
        constraint.op = "<=";
        constraint.value = Double.valueOf(bound);
        constraint.hard = Boolean.TRUE;
        instance.constraints =
                new ArrayList<Constraint>(Collections.singletonList(constraint));
        return instance;
    }

    private static Candidate candidate(String id, String taskId, double cost, double quality) {
        Candidate candidate = new Candidate();
        candidate.id = id;
        candidate.task_ids = new ArrayList<String>(Collections.singletonList(taskId));
        candidate.provider_id = "P1";
        candidate.features.put("cost", Double.valueOf(cost));
        candidate.features.put("quality", Double.valueOf(quality));
        return candidate;
    }

    private static AggregationPolicy policy(double neutral, String fn) {
        AggregationPolicy policy = new AggregationPolicy();
        policy.neutral = Double.valueOf(neutral);
        AggregationFunction function = new AggregationFunction();
        function.fn = fn;
        policy.compose.put("seq", function);
        policy.compose.put("and", function);
        return policy;
    }

    private static NumericRange range(double min, double max) {
        NumericRange range = new NumericRange();
        range.min = min;
        range.max = max;
        return range;
    }
}
