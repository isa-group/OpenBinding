package es.us.isa.qosawarewsbinding.bimstar;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import es.us.isa.openbinding.core.EngineModels;
import es.us.isa.openbinding.core.TestInstances;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The search strategy itself: budget, determinism, and the feasibility rule.
 *
 * <p>This engine had no unit tests at all, so `mvn test` passed vacuously and
 * CI proved nothing about it.
 */
class BimStarRandomSearchTest {

    private static final int ITERATIONS = 500;

    @Test
    @DisplayName("the same seed gives the same answer, a different one need not")
    void seedDecidesTheAnswer() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        BimStarRandomSearch.Result first =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 42L);
        BimStarRandomSearch.Result again =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 42L);

        assertEquals(first.binding, again.binding);
        assertEquals(first.objective, again.objective, 1e-12);
    }

    @Test
    @DisplayName("the evaluation budget is honoured exactly when no time budget is set")
    void evaluationBudgetIsHonoured() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        BimStarRandomSearch.Result result =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 1L);

        assertEquals(ITERATIONS, result.evaluations);
    }

    @Test
    @DisplayName("a binding is returned for every task the composition reaches")
    void everyReachableTaskIsBound() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        BimStarRandomSearch.Result result =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 1L);

        assertEquals(2, result.binding.size());
        assertTrue(result.binding.containsKey("T1"));
        assertTrue(result.binding.containsKey("T2"));
    }

    @Test
    @DisplayName("a feasible candidate always beats an infeasible one")
    void feasibilityComesFirst() {
        // Bound of 60 admits every binding except A2+B2 (cost 100).
        EngineModels.Instance instance = TestInstances.withGlobalCostBound(60.0);

        BimStarRandomSearch.Result result =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 7L);

        assertTrue(result.feasible, "a feasible binding exists and the search must find it");
        assertTrue(result.aggregated.get("cost").doubleValue() <= 60.0 + 1e-6,
                "the returned binding respects the bound it was searched under");
    }

    @Test
    @DisplayName("with nothing feasible, the best infeasible binding comes back marked as such")
    void infeasibleBestIsStillReturned() {
        // No pair of candidates can total less than 2.
        EngineModels.Instance instance = TestInstances.withGlobalCostBound(1.0);

        BimStarRandomSearch.Result result =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 3L);

        assertFalse(result.feasible);
        assertEquals(2, result.binding.size(), "an answer is still returned, not an empty one");
        assertFalse(result.violations.isEmpty(), "and it names what it breaks");
    }

    @Test
    @DisplayName("the best-so-far trace only ever improves")
    void traceIsMonotone() {
        EngineModels.Instance instance = TestInstances.twoTasksTwoCandidates();

        BimStarRandomSearch.Result result =
                BimStarRandomSearch.run(instance, null, ITERATIONS, null, 11L);

        double previous = Double.POSITIVE_INFINITY;
        for (java.util.Map<String, Object> entry : result.trace) {
            double objective = ((Number) entry.get("best_objective")).doubleValue();
            assertTrue(objective <= previous + 1e-12, "trace went backwards: " + objective);
            previous = objective;
        }
        assertFalse(result.trace.isEmpty());
    }
}
