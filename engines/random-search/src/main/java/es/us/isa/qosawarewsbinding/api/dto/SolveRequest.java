package es.us.isa.qosawarewsbinding.api.dto;

import java.util.List;
import java.util.Map;

public class SolveRequest {
    public String id;
    public CompositionStructure composition;
    public Map<String, ServiceCandidates> market;
    public QoSModel features;
    public SolvingConfig config;
    public List<Constraint> constraints;

    public static class CompositionStructure {
        public String type; // "structured"
        public Node root;
    }

    public static class Node {
        public String id;
        public String kind; // TASK, SEQ, AND, XOR, LOOP
        public String task_id; // if TASK
        public List<Node> children; // if SEQ, AND
        public List<Branch> branches; // if XOR
        public Node body; // if LOOP
        public Double expected_iterations; // if LOOP
    }

    public static class Branch {
        public double p;
        public Node child;
    }

    public static class ServiceCandidates {
        public List<Service> services;
    }

    public static class Service {
        public String id; // service concrete ID (e.g. "s11")
        public String name;
        public Map<String, Double> features;
    }

    public static class QoSModel {
        public Map<String, QoSPropertyDef> properties;
        public Map<String, Double> weights;
        public Map<String, AggregationPolicy> aggregation;
    }

    public static class QoSPropertyDef {
        public String direction; // "minimize", "maximize"
    }

    public static class AggregationPolicy {
        // Simple map from operator (seq, flow, etc.) to function name (sum, max, etc.)
        public String seq;
        public String flow; // "and" in request mapped to "flow" in engine
        public String branch; // "xor"
        public String loop;
    }

    public static class SolvingConfig {
        public int max_iterations;
        public int population_size;
    }

    public static class Constraint {
        public String id;
        public String kind; // "attribute_bound"
        public String scope; // "global"
        public String attribute_id;
        public String op; // <=, <, >=, >, ==, !=
        public Double value;
        public Boolean hard;
    }
}
