package es.us.isa.qosawarewsbinding.bimstar;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import es.us.isa.openbinding.core.EngineModels;
import es.us.isa.openbinding.core.TestInstances;

import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The Pareto archive: what it keeps, what it drops, and what it returns when
 * nothing is feasible.
 *
 * <p>This engine had no unit tests at all, so `mvn test` passed vacuously and
 * CI proved nothing about it.
 */
class ManyBindingSearchTest {

    private static final int ITERATIONS = 800;
    private static final int ARCHIVE = 20;

    @Test
    @DisplayName("the archive holds a front, not a single answer")
    void archiveHoldsAFront() {
        // cost and quality pull in opposite directions, so several bindings
        // are non-dominated.
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        ManyBindingSearch.Result result =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 5L);

        assertTrue(result.bindings.size() > 1, "expected a trade-off front, got " + result.bindings.size());
        assertTrue(result.bindings.size() <= ARCHIVE);
        assertEquals(result.bindings.size(), result.aggregated.size());
        assertEquals(result.bindings.size(), result.feasible.size());
    }

    @Test
    @DisplayName("no member of the archive dominates another")
    void archiveMembersAreMutuallyNonDominated() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        ManyBindingSearch.Result result =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 5L);

        List<java.util.Map<String, Double>> points = result.aggregated;
        for (int i = 0; i < points.size(); i++) {
            for (int j = 0; j < points.size(); j++) {
                if (i == j) {
                    continue;
                }
                assertFalse(dominates(points.get(i), points.get(j)),
                        "solution " + i + " dominates " + j + " but both are in the archive");
            }
        }
    }

    @Test
    @DisplayName("the same seed gives the same front")
    void seedDecidesTheFront() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        ManyBindingSearch.Result first =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 9L);
        ManyBindingSearch.Result again =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 9L);

        assertEquals(first.bindings, again.bindings);
    }

    @Test
    @DisplayName("only feasible bindings enter the archive")
    void infeasibleBindingsAreKeptOut() {
        // Bound of 60 rules out A2+B2 (cost 100).
        EngineModels.Instance instance = TestInstances.withGlobalCostBound(60.0);

        ManyBindingSearch.Result result =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 4L);

        assertFalse(result.bindings.isEmpty());
        for (int i = 0; i < result.bindings.size(); i++) {
            assertTrue(result.feasible.get(i).booleanValue(), "an infeasible binding reached the front");
            assertTrue(result.aggregated.get(i).get("cost").doubleValue() <= 60.0 + 1e-6);
        }
    }

    @Test
    @DisplayName("with nothing feasible, the best infeasible binding comes back instead of an empty front")
    void emptyFrontFallsBackToTheBestInfeasible() {
        // No pair of candidates can total less than 2.
        EngineModels.Instance instance = TestInstances.withGlobalCostBound(1.0);

        ManyBindingSearch.Result result =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 6L);

        assertEquals(1, result.bindings.size(), "an empty front used to become a 422");
        assertFalse(result.feasible.get(0).booleanValue());
        assertFalse(result.violations.get(0).isEmpty(), "and it names what it breaks");
    }

    @Test
    @DisplayName("the evaluation budget is honoured exactly when no time budget is set")
    void evaluationBudgetIsHonoured() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        ManyBindingSearch.Result result =
                ManyBindingSearch.run(instance, null, ITERATIONS, null, ARCHIVE, 1L);

        assertEquals(ITERATIONS, result.evaluations);
    }

    /** Lower is better on cost, higher on quality, per the instance's directions. */
    private static boolean dominates(
            java.util.Map<String, Double> a, java.util.Map<String, Double> b) {
        boolean betterSomewhere = false;
        if (a.get("cost").doubleValue() > b.get("cost").doubleValue() + 1e-12) {
            return false;
        }
        if (a.get("cost").doubleValue() < b.get("cost").doubleValue() - 1e-12) {
            betterSomewhere = true;
        }
        if (a.get("quality").doubleValue() < b.get("quality").doubleValue() - 1e-12) {
            return false;
        }
        if (a.get("quality").doubleValue() > b.get("quality").doubleValue() + 1e-12) {
            betterSomewhere = true;
        }
        return betterSomewhere;
    }
}
