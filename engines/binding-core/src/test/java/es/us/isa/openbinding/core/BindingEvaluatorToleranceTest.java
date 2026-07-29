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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * Feasibility must be decided with the same tolerance as the gateway.
 *
 * <p>This evaluator used to admit a bound at 1e-12 while the reference
 * evaluator admits it at 1e-6. A binding sitting between the two was feasible
 * for the engine, which optimized it and returned it, and infeasible for the
 * gateway, which reported it as such: the two disagreed about the answer, not
 * about rounding.
 *
 * <p>The values below mirror `test_constraint_scopes.py` on the Python side.
 */
class BindingEvaluatorToleranceTest {

    /** One task, one candidate whose cost the test sets, and one global bound. */
    private static EngineModelsFixture fixture(String op, double candidateCost, double bound) {
        return new EngineModelsFixture(op, candidateCost, bound);
    }

    private static final class EngineModelsFixture {
        final BindingEvaluator evaluator;

        EngineModelsFixture(String op, double candidateCost, double bound) {
            EngineModels.Instance instance = new EngineModels.Instance();

            Feature cost = new Feature();
            cost.id = "cost";
            cost.direction = "MINIMIZE";
            cost.scale = "RATIO";
            cost.valid_range = range(0.0, 1000.0);
            instance.features = new ArrayList<Feature>(Collections.singletonList(cost));

            Candidate candidate = new Candidate();
            candidate.id = "C1";
            candidate.task_ids = new ArrayList<String>(Collections.singletonList("T1"));
            candidate.provider_id = "P1";
            candidate.features.put("cost", Double.valueOf(candidateCost));
            instance.candidates =
                    new ArrayList<Candidate>(Collections.singletonList(candidate));

            Node task = new Node();
            task.id = "n1";
            task.kind = "TASK";
            task.task_id = "T1";
            instance.composition = new Composition();
            instance.composition.type = "STRUCTURED";
            instance.composition.root = task;

            AggregationPolicy policy = new AggregationPolicy();
            policy.neutral = Double.valueOf(0.0);
            AggregationFunction sum = new AggregationFunction();
            sum.fn = "SUM";
            policy.compose.put("seq", sum);
            instance.aggregation_policies.put("cost", policy);

            Constraint constraint = new Constraint();
            constraint.id = "c";
            constraint.kind = "ATTRIBUTE_BOUND";
            constraint.scope = "GLOBAL";
            constraint.attribute_id = "cost";
            constraint.op = op;
            constraint.value = Double.valueOf(bound);
            constraint.hard = Boolean.TRUE;
            instance.constraints =
                    new ArrayList<Constraint>(Collections.singletonList(constraint));

            Objective objective = new Objective();
            objective.type = "MONO";
            objective.targets = new ArrayList<String>(Collections.singletonList("cost"));
            objective.weights.put("cost", Double.valueOf(1.0));
            instance.objective = objective;

            this.evaluator = new BindingEvaluator(instance, null);
        }

        boolean feasible() {
            List<Integer> chromosome = Arrays.asList(Integer.valueOf(0));
            return evaluator.evaluate(chromosome).constraints().hardViolation() <= 0.0;
        }
    }

    private static NumericRange range(double min, double max) {
        NumericRange range = new NumericRange();
        range.min = min;
        range.max = max;
        return range;
    }

    @ParameterizedTest(name = "{0} {2}: cost {1} -> feasible={3}")
    @DisplayName("a bound is satisfied within 1e-6, as the reference evaluator decides it")
    @CsvSource({
        // Just inside the tolerance: the gateway calls these feasible, so must we.
        "<=, 10.0000001,  10.0, true",
        ">=,  9.9999999,  10.0, true",
        "<,   9.9999999,  10.0, false",
        ">,  10.0000001,  10.0, false",
        // Clearly outside it: broken for both.
        "<=, 10.00001,    10.0, false",
        ">=,  9.99999,    10.0, false",
        // Clearly inside: satisfied for both.
        "<=,  9.0,        10.0, true",
        ">=, 11.0,        10.0, true",
        "<,   9.0,        10.0, true",
        ">,  11.0,        10.0, true",
        // Equality and its negation share the same tolerance.
        "==, 10.0000001,  10.0, true",
        "==, 10.00001,    10.0, false",
        "!=, 10.0000001,  10.0, false",
        "!=, 10.00001,    10.0, true",
    })
    void boundsAreDecidedWithTheReferenceTolerance(
            String op, double candidateCost, double bound, boolean expectedFeasible) {
        assertEquals(expectedFeasible, fixture(op, candidateCost, bound).feasible());
    }

    @org.junit.jupiter.api.Test
    @DisplayName("a satisfied bound contributes no violation magnitude at all")
    void satisfiedBoundsHaveZeroMagnitude() {
        assertTrue(fixture("<=", 10.0000001, 10.0).feasible());
        assertFalse(fixture("<=", 10.5, 10.0).feasible());
    }
}
