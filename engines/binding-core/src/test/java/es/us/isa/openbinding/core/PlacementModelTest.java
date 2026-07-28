package es.us.isa.openbinding.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The expected values are the ones the gateway reference evaluator produces for
 * the same instances. A divergence here means an engine would optimize a
 * different objective from the one that ends up being reported.
 */
class PlacementModelTest {

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < pairs.length; i += 2) {
            result.put((String) pairs[i], pairs[i + 1]);
        }
        return result;
    }

    private static List<Object> list(Object... items) {
        return new ArrayList<Object>(Arrays.asList(items));
    }

    private static Map<String, Object> task(String id) {
        return map("id", "n_" + id, "kind", "TASK", "task_id", id);
    }

    private static Map<String, Object> seq(Object... children) {
        return map("id", "n_seq", "kind", "SEQ", "children", list(children));
    }

    private static Map<String, Object> xor(double p1, Object child1, double p2, Object child2) {
        return map("id", "n_xor", "kind", "XOR", "branches",
                list(map("p", p1, "child", child1), map("p", p2, "child", child2)));
    }

    private static Map<String, Object> placementInstance() {
        return map(
                "composition", map("root", seq(task("T1"), xor(0.7, task("T2"), 0.3, task("T3")), task("T4"))),
                "objective", map("type", "MONO", "targets", list("latency"), "weights", map("latency", 1.0)),
                "aggregation_policies", map("latency", map(
                        "neutral", 0.0,
                        "normalize", map("type", "minmax", "bounds", map("min", 0.0, "max", 100.0)))),
                "resource_model", map(
                        "resources", list("cpu", "mem"),
                        "pools", list(
                                map("id", "edge", "name", "Edge", "kind", "EDGE",
                                        "capacity", map("cpu", 4.0, "mem", 1024.0)),
                                map("id", "cloud", "name", "Cloud", "kind", "CLOUD",
                                        "capacity", map("cpu", 64.0, "mem", 65536.0))),
                        "candidate_bindings", list(
                                map("candidate_id", "c1", "pool_id", "edge", "demand", map("cpu", 1.0, "mem", 256.0)),
                                map("candidate_id", "c2", "pool_id", "cloud", "demand", map("cpu", 2.0, "mem", 512.0))),
                        "constraints", list(
                                map("id", "cap_edge", "kind", "DEPENDENCY", "type", "RESOURCE_CAPACITY",
                                        "scope", "POOL_KIND", "pool_kinds", list("EDGE"),
                                        "resources", list("cpu"), "hard", Boolean.TRUE),
                                map("id", "cap_all", "kind", "DEPENDENCY", "type", "RESOURCE_CAPACITY",
                                        "scope", "ALL_POOLS", "resources", list("mem"), "hard", Boolean.TRUE),
                                map("id", "legacy", "kind", "RESOURCE_CAPACITY",
                                        "scope", "ALL_POOLS", "resources", list("cpu"), "hard", Boolean.TRUE),
                                map("id", "other", "kind", "DEPENDENCY", "type", "SOMETHING_ELSE",
                                        "scope", "ALL_POOLS", "resources", list("cpu"), "hard", Boolean.TRUE))),
                "latency_model", map(
                        "unit", "ms",
                        "pool_latency_matrix_ms", map(
                                "edge", map("edge", 0.0, "cloud", 20.0),
                                "cloud", map("cloud", 0.0)),
                        "event_generator_pools", map("sensor", "edge"),
                        "event_latency_matrix_ms", map("sensor", map("edge", 1.0)),
                        "transition_constraints", list(),
                        "global_latency", map(
                                "attribute_id", "latency",
                                "include_execution_latency_feature", Boolean.TRUE,
                                "xor_semantics", "EXPECTED",
                                "and_semantics", "MAX")));
    }

    @Test
    @DisplayName("an instance with no placement blocks yields an empty model")
    void emptyWithoutPlacementBlocks() {
        PlacementModel model = new PlacementModel(map("composition", map("root", task("T1"))));

        assertTrue(model.pools().isEmpty());
        assertTrue(model.poolOfCandidate().isEmpty());
        assertTrue(model.capacityConstraints().isEmpty());
        assertTrue(model.transitions().isEmpty());
        assertTrue(model.eventIds().isEmpty());
        assertNull(model.globalLatency());
        assertEquals(1, model.scenarios().size(), "the composition still has one trivial scenario");
    }

    @Test
    @DisplayName("candidate bindings become pool and demand lookups")
    void invertsCandidateBindings() {
        PlacementModel model = new PlacementModel(placementInstance());

        assertEquals("edge", model.poolOfCandidate().get("c1"));
        assertEquals(Double.valueOf(2.0), model.demandOfCandidate().get("c2").get("cpu"));
        assertEquals(Double.valueOf(512.0), model.demandOfCandidate().get("c2").get("mem"));
    }

    @Test
    @DisplayName("constraint scope is resolved to explicit pools")
    void resolvesConstraintScope() {
        PlacementModel model = new PlacementModel(placementInstance());
        Map<String, PlacementModel.CapacityConstraint> byId =
                new LinkedHashMap<String, PlacementModel.CapacityConstraint>();
        for (PlacementModel.CapacityConstraint constraint : model.capacityConstraints()) {
            byId.put(constraint.id, constraint);
        }

        assertEquals(Collections.singletonList("edge"), byId.get("cap_edge").pools);
        assertEquals(Arrays.asList("edge", "cloud"), byId.get("cap_all").pools);
        assertTrue(byId.containsKey("legacy"), "the legacy spelling is still accepted");
        assertTrue(!byId.containsKey("other"), "non-capacity dependencies are not capacity checks");
    }

    @Test
    @DisplayName("a missing latency direction falls back to the transposed entry")
    void poolLatencyFallsBackToTranspose() {
        PlacementModel model = new PlacementModel(placementInstance());

        assertEquals(20.0, model.poolLatency("edge", "cloud"), 1e-9);
        assertEquals(20.0, model.poolLatency("cloud", "edge"), 1e-9);
        assertEquals(0.0, model.poolLatency("cloud", "cloud"), 1e-9);
    }

    @Test
    @DisplayName("a missing event latency falls back to the generator pool")
    void eventLatencyFallsBackToGeneratorPool() {
        PlacementModel model = new PlacementModel(placementInstance());

        assertEquals(1.0, model.eventPoolLatency("sensor", "edge"), 1e-9);
        assertEquals(20.0, model.eventPoolLatency("sensor", "cloud"), 1e-9);
    }

    @Test
    @DisplayName("and_semantics other than MAX is rejected, not silently approximated")
    void rejectsUnsupportedAndSemantics() {
        Map<String, Object> instance = placementInstance();
        Map<String, Object> latencyModel = castMap(instance.get("latency_model"));
        castMap(latencyModel.get("global_latency")).put("and_semantics", "SUM");

        assertThrows(IllegalArgumentException.class, new org.junit.jupiter.api.function.Executable() {
            public void execute() {
                new PlacementModel(instance);
            }
        });
    }

    @Test
    @DisplayName("a composition without XOR has exactly one scenario")
    void singleScenarioWithoutXor() {
        List<PlacementModel.Scenario> scenarios =
                PlacementModel.buildScenarios(seq(task("T1"), task("T2")), Collections.<String>emptyList());

        assertEquals(1, scenarios.size());
        assertEquals(1.0, scenarios.get(0).prob, 1e-9);
        assertEquals(Arrays.asList("T1", "T2"), scenarios.get(0).order);
        assertTrue(scenarios.get(0).preds.get("T1").isEmpty());
        assertEquals("T1", scenarios.get(0).preds.get("T2").get(0).id);
        assertEquals(Collections.singletonList("T2"), scenarios.get(0).sinks);
    }

    @Test
    @DisplayName("each XOR branch becomes a scenario carrying its probability")
    void oneScenarioPerXorBranch() {
        PlacementModel model = new PlacementModel(placementInstance());
        List<PlacementModel.Scenario> scenarios = model.scenarios();

        assertEquals(2, scenarios.size());
        assertEquals(0.7, scenarios.get(0).prob, 1e-9);
        assertEquals(0.3, scenarios.get(1).prob, 1e-9);
        assertEquals(Arrays.asList("T1", "T2", "T4"), scenarios.get(0).order);
        assertEquals(Arrays.asList("T1", "T3", "T4"), scenarios.get(1).order);
        assertEquals("T2", scenarios.get(0).preds.get("T4").get(0).id);
        assertEquals("T3", scenarios.get(1).preds.get("T4").get(0).id);
    }

    @Test
    @DisplayName("an AND join waits for every branch")
    void andJoinWaitsForEveryBranch() {
        Map<String, Object> root = seq(
                task("T1"),
                map("id", "n_and", "kind", "AND", "children", list(task("T2"), task("T3"))),
                task("T4"));
        List<PlacementModel.Scenario> scenarios =
                PlacementModel.buildScenarios(root, Collections.<String>emptyList());

        assertEquals(1, scenarios.size());
        assertEquals(2, scenarios.get(0).preds.get("T4").size());
    }

    @Test
    @DisplayName("event generators are the entry points of the DAG")
    void eventsAreEntryPoints() {
        List<PlacementModel.Scenario> scenarios =
                PlacementModel.buildScenarios(seq(task("T1"), task("T2")), Collections.singletonList("sensor"));

        PlacementModel.Source source = scenarios.get(0).preds.get("T1").get(0);
        assertTrue(source.isEvent());
        assertEquals("sensor", source.id);
    }

    @Test
    @DisplayName("nested XOR nodes multiply out, and the probabilities still sum to one")
    void nestedXorMultipliesOut() {
        Map<String, Object> root = map("id", "n_seq", "kind", "SEQ", "children", list(
                map("id", "n_xor_a", "kind", "XOR", "branches",
                        list(map("p", 0.5, "child", task("A1")), map("p", 0.5, "child", task("A2")))),
                map("id", "n_xor_b", "kind", "XOR", "branches",
                        list(map("p", 0.5, "child", task("B1")), map("p", 0.5, "child", task("B2"))))));
        List<PlacementModel.Scenario> scenarios =
                PlacementModel.buildScenarios(root, Collections.<String>emptyList());

        assertEquals(4, scenarios.size());
        double total = 0.0;
        for (PlacementModel.Scenario scenario : scenarios) {
            total += scenario.prob;
        }
        assertEquals(1.0, total, 1e-9);
    }

    @Test
    @DisplayName("compositions the latency model cannot read as a DAG are rejected")
    void rejectsNonDagCompositions() {
        assertThrows(IllegalArgumentException.class, new org.junit.jupiter.api.function.Executable() {
            public void execute() {
                PlacementModel.buildScenarios(
                        map("id", "n_loop", "kind", "LOOP", "body", task("T1")),
                        Collections.<String>emptyList());
            }
        });
        assertThrows(IllegalArgumentException.class, new org.junit.jupiter.api.function.Executable() {
            public void execute() {
                PlacementModel.buildScenarios(seq(task("T1"), task("T1")), Collections.<String>emptyList());
            }
        });
    }

    @Test
    @DisplayName("normalization of every objective target is what selects the canonical objective")
    void declaresNormalizationRule() {
        Map<String, Object> instance = placementInstance();
        assertTrue(PlacementModel.declaresNormalization(instance));

        castMap(instance.get("objective")).put("targets", list("latency", "cost"));
        assertTrue(!PlacementModel.declaresNormalization(instance), "cost declares no bounds");

        assertTrue(!PlacementModel.declaresNormalization(map("objective", map("targets", list()))));
        assertTrue(!PlacementModel.declaresNormalization(map()));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
