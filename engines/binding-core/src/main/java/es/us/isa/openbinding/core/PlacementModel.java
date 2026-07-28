package es.us.isa.openbinding.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Placement view of an instance, derived here rather than received pre-built.
 *
 * <p>The resource and latency models are optional blocks of the instance. This
 * class turns them into what an engine needs to enforce placement: the pool of
 * each candidate and what it demands there, capacity constraints with their
 * scope resolved to explicit pools, latency matrices with their fallbacks, and
 * the XOR scenarios of the composition together with the precedence DAG of
 * each one.
 *
 * <p>An instance without those blocks yields an empty model: no pools, no
 * constraints, no scenarios, no global latency. Callers therefore never need to
 * ask whether an instance "is a placement instance" — they run the same code
 * and iterate over nothing.
 *
 * <p>The semantics mirror the gateway reference evaluator. Both are held to the
 * same numbers by the engine parity checks, since a divergence would show up as
 * the engine optimizing a different objective from the one that gets reported.
 *
 * <p>Works on plain maps so that it stays free of any JSON library, and targets
 * Java 8 so that every engine can use it.
 */
public final class PlacementModel {

    public static final String EVENT_SOURCE = "event";
    public static final String TASK_SOURCE = "task";

    /** A pool a candidate can run on. */
    public static final class Pool {
        public final String id;
        public final String kind;
        public final Map<String, Double> capacity;

        Pool(String id, String kind, Map<String, Double> capacity) {
            this.id = id;
            this.kind = kind;
            this.capacity = capacity;
        }
    }

    /** A capacity constraint whose scope has been resolved to explicit pools. */
    public static final class CapacityConstraint {
        public final String id;
        public final boolean hard;
        public final List<String> resources;
        public final List<String> pools;

        CapacityConstraint(String id, boolean hard, List<String> resources, List<String> pools) {
            this.id = id;
            this.hard = hard;
            this.resources = resources;
            this.pools = pools;
        }
    }

    /** A bound on the latency between the pools hosting two tasks, or an event and a task. */
    public static final class Transition {
        public final String id;
        public final boolean hard;
        public final String fromTask;
        public final String fromEvent;
        public final String toTask;
        public final String op;
        public final Object value;

        Transition(String id, boolean hard, String fromTask, String fromEvent,
                   String toTask, String op, Object value) {
            this.id = id;
            this.hard = hard;
            this.fromTask = fromTask;
            this.fromEvent = fromEvent;
            this.toTask = toTask;
            this.op = op;
            this.value = value;
        }
    }

    /** How the end-to-end latency of the composition is defined. */
    public static final class GlobalLatency {
        public final String attributeId;
        public final boolean includeExecutionLatencyFeature;
        public final String xorSemantics;

        GlobalLatency(String attributeId, boolean includeExecutionLatencyFeature, String xorSemantics) {
            this.attributeId = attributeId;
            this.includeExecutionLatencyFeature = includeExecutionLatencyFeature;
            this.xorSemantics = xorSemantics;
        }
    }

    /** Where a task's input comes from: another task's output, or an event. */
    public static final class Source {
        public final String kind;
        public final String id;

        Source(String kind, String id) {
            this.kind = kind;
            this.id = id;
        }

        public boolean isEvent() {
            return EVENT_SOURCE.equals(kind);
        }
    }

    /**
     * One combination of XOR branches: the tasks it activates, in topological
     * order, with their predecessors and the exit tasks.
     */
    public static final class Scenario {
        public final double prob;
        public final Map<String, List<Source>> preds;
        public final List<String> order;
        public final List<String> sinks;

        Scenario(double prob, Map<String, List<Source>> preds, List<String> order, List<String> sinks) {
            this.prob = prob;
            this.preds = preds;
            this.order = order;
            this.sinks = sinks;
        }
    }

    private final Map<String, Object> instance;
    private final List<Pool> pools;
    private final Map<String, Pool> poolsById;
    private final Map<String, String> poolOfCandidate;
    private final Map<String, Map<String, Double>> demandOfCandidate;
    private final List<CapacityConstraint> capacityConstraints;
    private final Map<String, Map<String, Double>> latencyMatrix;
    private final Map<String, Map<String, Double>> eventLatency;
    private final Map<String, String> eventPools;
    private final List<String> eventIds;
    private final List<Transition> transitions;
    private final GlobalLatency globalLatency;

    private List<Scenario> scenarioCache;

    public PlacementModel(Map<String, Object> instance) {
        this.instance = instance == null ? Collections.<String, Object>emptyMap() : instance;

        Map<String, Object> resourceModel = childMap(this.instance, "resource_model");
        Map<String, Object> latencyModel = childMap(this.instance, "latency_model");

        this.pools = new ArrayList<Pool>();
        this.poolsById = new LinkedHashMap<String, Pool>();
        for (Object entry : childList(resourceModel, "pools")) {
            Map<String, Object> pool = asMap(entry);
            Pool parsed = new Pool(str(pool.get("id")), str(pool.get("kind")), doubleMap(pool.get("capacity")));
            this.pools.add(parsed);
            this.poolsById.put(parsed.id, parsed);
        }

        this.poolOfCandidate = new LinkedHashMap<String, String>();
        this.demandOfCandidate = new LinkedHashMap<String, Map<String, Double>>();
        for (Object entry : childList(resourceModel, "candidate_bindings")) {
            Map<String, Object> binding = asMap(entry);
            String candidateId = str(binding.get("candidate_id"));
            this.poolOfCandidate.put(candidateId, str(binding.get("pool_id")));
            this.demandOfCandidate.put(candidateId, doubleMap(binding.get("demand")));
        }

        this.capacityConstraints = new ArrayList<CapacityConstraint>();
        for (Object entry : childList(resourceModel, "constraints")) {
            Map<String, Object> constraint = asMap(entry);
            if (!isCapacityConstraint(constraint)) {
                continue;
            }
            List<String> resources = new ArrayList<String>();
            for (Object resource : asList(constraint.get("resources"))) {
                resources.add(str(resource));
            }
            this.capacityConstraints.add(new CapacityConstraint(
                    str(constraint.get("id")),
                    !Boolean.FALSE.equals(constraint.get("hard")),
                    resources,
                    poolsInScope(constraint)));
        }

        this.latencyMatrix = nestedDoubleMap(latencyModel.get("pool_latency_matrix_ms"));
        this.eventLatency = nestedDoubleMap(latencyModel.get("event_latency_matrix_ms"));

        this.eventPools = new LinkedHashMap<String, String>();
        for (Map.Entry<String, Object> entry : asMap(latencyModel.get("event_generator_pools")).entrySet()) {
            this.eventPools.put(entry.getKey(), str(entry.getValue()));
        }
        this.eventIds = new ArrayList<String>(new TreeSet<String>(this.eventPools.keySet()));

        this.transitions = new ArrayList<Transition>();
        for (Object entry : childList(latencyModel, "transition_constraints")) {
            Map<String, Object> transition = asMap(entry);
            this.transitions.add(new Transition(
                    str(transition.get("id")),
                    !Boolean.FALSE.equals(transition.get("hard")),
                    str(transition.get("from_task")),
                    str(transition.get("from_event")),
                    str(transition.get("to_task")),
                    str(transition.get("op")),
                    transition.get("value")));
        }

        Object global = latencyModel.get("global_latency");
        if (global instanceof Map) {
            Map<String, Object> gl = asMap(global);
            String andSemantics = gl.get("and_semantics") == null
                    ? "MAX"
                    : str(gl.get("and_semantics")).toUpperCase();
            if (!"MAX".equals(andSemantics)) {
                throw new IllegalArgumentException(
                        "Unsupported and_semantics '" + andSemantics + "' (only MAX)");
            }
            String xorSemantics = gl.get("xor_semantics") == null
                    ? "EXPECTED"
                    : str(gl.get("xor_semantics")).toUpperCase();
            this.globalLatency = new GlobalLatency(
                    str(gl.get("attribute_id")),
                    Boolean.TRUE.equals(gl.get("include_execution_latency_feature")),
                    xorSemantics);
        } else {
            this.globalLatency = null;
        }
    }

    public List<Pool> pools() {
        return Collections.unmodifiableList(pools);
    }

    public Map<String, String> poolOfCandidate() {
        return Collections.unmodifiableMap(poolOfCandidate);
    }

    public Map<String, Map<String, Double>> demandOfCandidate() {
        return Collections.unmodifiableMap(demandOfCandidate);
    }

    public List<CapacityConstraint> capacityConstraints() {
        return Collections.unmodifiableList(capacityConstraints);
    }

    public Map<String, Map<String, Double>> latencyMatrix() {
        return Collections.unmodifiableMap(latencyMatrix);
    }

    public Map<String, Map<String, Double>> eventLatency() {
        return Collections.unmodifiableMap(eventLatency);
    }

    public Map<String, String> eventPools() {
        return Collections.unmodifiableMap(eventPools);
    }

    public List<String> eventIds() {
        return Collections.unmodifiableList(eventIds);
    }

    public List<Transition> transitions() {
        return Collections.unmodifiableList(transitions);
    }

    public GlobalLatency globalLatency() {
        return globalLatency;
    }

    /** Pool-to-pool latency, falling back to the transposed entry. */
    public double poolLatency(String a, String b) {
        Double value = lookup(latencyMatrix, a, b);
        if (value == null) {
            value = lookup(latencyMatrix, b, a);
        }
        if (value == null) {
            if (a != null && a.equals(b)) {
                return 0.0;
            }
            throw new IllegalArgumentException("Missing pool latency entry for '" + a + "' -> '" + b + "'");
        }
        return value;
    }

    /** Latency from an event generator to a pool, falling back to its own pool. */
    public double eventPoolLatency(String eventId, String pool) {
        Double value = lookup(eventLatency, eventId, pool);
        if (value != null) {
            return value;
        }
        String generatorPool = eventPools.get(eventId);
        if (generatorPool != null) {
            return poolLatency(generatorPool, pool);
        }
        throw new IllegalArgumentException("Missing event latency entry for '" + eventId + "' -> '" + pool + "'");
    }

    /** XOR scenarios of the composition, enumerated once and cached. */
    public List<Scenario> scenarios() {
        if (scenarioCache == null) {
            Map<String, Object> composition = childMap(instance, "composition");
            scenarioCache = buildScenarios(asMap(composition.get("root")), eventIds);
        }
        return Collections.unmodifiableList(scenarioCache);
    }

    private List<String> poolsInScope(Map<String, Object> constraint) {
        List<String> selected = new ArrayList<String>();
        String scope = constraint.get("scope") == null ? "ALL_POOLS" : str(constraint.get("scope")).toUpperCase();
        if ("POOL_KIND".equals(scope)) {
            Set<String> kinds = new HashSet<String>();
            for (Object kind : asList(constraint.get("pool_kinds"))) {
                kinds.add(str(kind));
            }
            for (Pool pool : pools) {
                if (kinds.contains(pool.kind)) {
                    selected.add(pool.id);
                }
            }
            return selected;
        }
        for (Pool pool : pools) {
            selected.add(pool.id);
        }
        return selected;
    }

    /**
     * Resource capacity is a dependency-type constraint: canonical form
     * {@code kind: DEPENDENCY} plus {@code type: RESOURCE_CAPACITY}; the legacy
     * spelling {@code kind: RESOURCE_CAPACITY} is still accepted.
     */
    private static boolean isCapacityConstraint(Map<String, Object> constraint) {
        String kind = constraint.get("kind") == null ? "" : str(constraint.get("kind")).toUpperCase();
        if ("RESOURCE_CAPACITY".equals(kind)) {
            return true;
        }
        String type = constraint.get("type") == null ? "" : str(constraint.get("type")).toUpperCase();
        return "DEPENDENCY".equals(kind) && "RESOURCE_CAPACITY".equals(type);
    }

    // -----------------------------------------------------------------------
    // Scenario enumeration and precedence DAG construction
    // -----------------------------------------------------------------------

    /** Enumerate the XOR scenarios of a composition tree. */
    public static List<Scenario> buildScenarios(Map<String, Object> root, List<String> eventIds) {
        List<Map<String, Object>> xorNodes = new ArrayList<Map<String, Object>>();
        collectXorNodes(root, xorNodes);

        List<Source> entries = new ArrayList<Source>();
        for (String eventId : eventIds) {
            entries.add(new Source(EVENT_SOURCE, eventId));
        }

        List<int[]> combos = cartesian(xorNodes);
        List<Scenario> scenarios = new ArrayList<Scenario>();
        for (int[] combo : combos) {
            double prob = 1.0;
            Map<Map<String, Object>, Integer> choice = new IdentityHashMap<Map<String, Object>, Integer>();
            for (int i = 0; i < xorNodes.size(); i++) {
                Map<String, Object> node = xorNodes.get(i);
                choice.put(node, combo[i]);
                Map<String, Object> branch = asMap(asList(node.get("branches")).get(combo[i]));
                prob *= number(branch.get("p"), 0.0);
            }

            Map<String, List<Source>> preds = new LinkedHashMap<String, List<Source>>();
            List<String> order = new ArrayList<String>();
            List<Source> exits = buildDag(root, entries, choice, preds, order);

            List<String> sinks = new ArrayList<String>();
            for (Source exit : exits) {
                if (TASK_SOURCE.equals(exit.kind)) {
                    sinks.add(exit.id);
                }
            }
            scenarios.add(new Scenario(prob, preds, order, sinks));
        }
        return scenarios;
    }

    private static void collectXorNodes(Map<String, Object> node, List<Map<String, Object>> acc) {
        String kind = str(node.get("kind"));
        if ("XOR".equals(kind)) {
            acc.add(node);
            for (Object branch : asList(node.get("branches"))) {
                collectXorNodes(asMap(asMap(branch).get("child")), acc);
            }
        } else if ("SEQ".equals(kind) || "AND".equals(kind)) {
            for (Object child : asList(node.get("children"))) {
                collectXorNodes(asMap(child), acc);
            }
        } else if ("LOOP".equals(kind)) {
            collectXorNodes(asMap(node.get("body")), acc);
        }
    }

    private static List<int[]> cartesian(List<Map<String, Object>> xorNodes) {
        List<int[]> combos = new ArrayList<int[]>();
        combos.add(new int[xorNodes.size()]);
        for (int i = 0; i < xorNodes.size(); i++) {
            int branches = asList(xorNodes.get(i).get("branches")).size();
            List<int[]> next = new ArrayList<int[]>();
            for (int[] combo : combos) {
                for (int b = 0; b < branches; b++) {
                    int[] extended = combo.clone();
                    extended[i] = b;
                    next.add(extended);
                }
            }
            combos = next;
        }
        return combos;
    }

    /**
     * Thread entry points through the tree, recording task predecessors.
     *
     * <p>Returns the exit points of {@code node}. Fork/join semantics emerge
     * from the entry sets: an AND joins because the next consumer receives the
     * exits of every branch and must wait for the slowest one.
     */
    private static List<Source> buildDag(Map<String, Object> node,
                                         List<Source> entries,
                                         Map<Map<String, Object>, Integer> choice,
                                         Map<String, List<Source>> preds,
                                         List<String> order) {
        String kind = str(node.get("kind"));

        if ("TASK".equals(kind)) {
            String taskId = str(node.get("task_id"));
            if (preds.containsKey(taskId)) {
                throw new IllegalArgumentException("Task '" + taskId
                        + "' appears more than once in the composition; "
                        + "the latency model requires a single occurrence per task");
            }
            preds.put(taskId, new ArrayList<Source>(entries));
            order.add(taskId);
            return Collections.singletonList(new Source(TASK_SOURCE, taskId));
        }

        if ("ELEMENT".equals(kind)) {
            return new ArrayList<Source>(entries);
        }

        if ("SEQ".equals(kind)) {
            List<Source> current = new ArrayList<Source>(entries);
            for (Object child : asList(node.get("children"))) {
                current = buildDag(asMap(child), current, choice, preds, order);
            }
            return current;
        }

        if ("AND".equals(kind)) {
            List<Source> exits = new ArrayList<Source>();
            for (Object child : asList(node.get("children"))) {
                exits.addAll(buildDag(asMap(child), new ArrayList<Source>(entries), choice, preds, order));
            }
            return exits;
        }

        if ("XOR".equals(kind)) {
            Integer index = choice.get(node);
            int chosen = index == null ? 0 : index;
            Map<String, Object> branch = asMap(asList(node.get("branches")).get(chosen));
            return buildDag(asMap(branch.get("child")), entries, choice, preds, order);
        }

        if ("LOOP".equals(kind)) {
            throw new IllegalArgumentException("LOOP nodes are not supported by the latency model");
        }

        throw new IllegalArgumentException("Unsupported composition node kind '" + kind + "'");
    }

    /**
     * Whether the instance normalizes every one of its objective targets, which
     * is what selects the canonical objective. Kept identical to the gateway
     * rule, and independent of whether the instance carries placement blocks.
     */
    public static boolean declaresNormalization(Map<String, Object> instance) {
        Map<String, Object> objective = childMap(instance, "objective");
        List<Object> targets = asList(objective.get("targets"));
        if (targets.isEmpty()) {
            return false;
        }
        Map<String, Object> policies = childMap(instance, "aggregation_policies");
        for (Object target : targets) {
            Map<String, Object> policy = asMap(policies.get(str(target)));
            if (!(policy.get("normalize") instanceof Map)) {
                return false;
            }
        }
        return true;
    }

    // -----------------------------------------------------------------------
    // Plain-map helpers
    // -----------------------------------------------------------------------

    private static Double lookup(Map<String, Map<String, Double>> matrix, String a, String b) {
        Map<String, Double> row = matrix.get(a);
        return row == null ? null : row.get(b);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return value instanceof Map
                ? (Map<String, Object>) value
                : Collections.<String, Object>emptyMap();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object value) {
        return value instanceof List ? (List<Object>) value : Collections.emptyList();
    }

    private static Map<String, Object> childMap(Map<String, Object> parent, String key) {
        return asMap(parent.get(key));
    }

    private static List<Object> childList(Map<String, Object> parent, String key) {
        return asList(parent.get(key));
    }

    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static double number(Object value, double fallback) {
        return value instanceof Number ? ((Number) value).doubleValue() : fallback;
    }

    private static Map<String, Double> doubleMap(Object value) {
        Map<String, Double> parsed = new LinkedHashMap<String, Double>();
        for (Map.Entry<String, Object> entry : asMap(value).entrySet()) {
            parsed.put(entry.getKey(), number(entry.getValue(), 0.0));
        }
        return parsed;
    }

    private static Map<String, Map<String, Double>> nestedDoubleMap(Object value) {
        Map<String, Map<String, Double>> parsed = new LinkedHashMap<String, Map<String, Double>>();
        for (Map.Entry<String, Object> entry : asMap(value).entrySet()) {
            parsed.put(entry.getKey(), doubleMap(entry.getValue()));
        }
        return parsed;
    }
}
