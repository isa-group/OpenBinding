package es.us.isa.qosawarewsbinding.cli;

import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Random;

/** Deterministic generator for the validated UTF-8 --config properties protocol. */
final class ConfigGenerator {
    private final Properties config = new Properties();
    private final Random random;
    private final List<String> tasks = new ArrayList<String>();
    private final List<Map<String, Object>> features = new ArrayList<Map<String, Object>>();

    private ConfigGenerator(Path path) throws Exception {
        try (Reader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            config.load(reader);
        }
        random = new Random(Long.parseLong(config.getProperty("seed", "0")));
        int n = Integer.parseInt(config.getProperty("feature.count"));
        for (int i = 0; i < n; i++) {
            Map<String, Object> feature = new LinkedHashMap<String, Object>();
            feature.put("id", config.getProperty("feature." + i + ".id"));
            feature.put("index", i);
            features.add(feature);
        }
    }

    static String generate(Path path) throws Exception {
        return new ConfigGenerator(path).build();
    }

    private int integer(String key) { return Integer.parseInt(config.getProperty(key)); }
    private double number(String key) { return Double.parseDouble(config.getProperty(key)); }

    private double sample(String key, double defaultValue, boolean integer) {
        if (config.getProperty(key + ".kind") == null) return defaultValue;
        double low = number(key + ".minimum");
        double high = number(key + ".maximum");
        double value;
        if ("normal".equals(config.getProperty(key + ".kind"))) {
            value = number(key + ".mean") + random.nextGaussian() * number(key + ".stddev");
            if (integer) value = Math.round(value);
        } else if (integer) {
            return low + random.nextInt((int) (high - low + 1));
        } else {
            value = low + random.nextDouble() * (high - low);
        }
        return Math.max(low, Math.min(high, value));
    }

    private Map<String, Object> node(String kind) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("kind", kind);
        result.put("children", new ArrayList<Map<String, Object>>());
        return result;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> children(Map<String, Object> node) {
        return (List<Map<String, Object>>) node.get("children");
    }

    private Map<String, Object> task(String id) {
        Map<String, Object> node = node("task");
        node.put("id", id);
        return node;
    }

    private Map<String, Object> structure() {
        int activities = integer("tasks");
        int count = Math.max(2, activities * (100 - integer("control_flow")) / 100);
        for (int i = 0; i < count; i++) tasks.add("t" + (i + 1));
        int controls = Math.min((int) Math.round(activities * integer("control_flow") / 100.0), activities - count);
        double loop = number("loops"), branch = number("branches"), parallel = number("parallel");
        double total = loop + branch + parallel;
        Map<String, Object> root = node("sequence");
        List<Map<String, Object>> targets = new ArrayList<Map<String, Object>>();
        Map<Map<String, Object>, Integer> depth = new IdentityHashMap<Map<String, Object>, Integer>();
        targets.add(root);
        depth.put(root, 0);
        List<Map<String, Object>> controlsList = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < controls; i++) {
            double draw = random.nextDouble() * total;
            Map<String, Object> control;
            if (draw < loop) {
                control = node("loop");
                control.put("iterations", (int) sample("distribution.loop_iterations", integer("iterations_per_loop"), true));
            } else if (draw < loop + branch) {
                control = node("branch");
                int branches = (int) sample("distribution.branches_per_decision", 2, true);
                List<Double> probabilities = new ArrayList<Double>();
                for (int j = 0; j < branches; j++) {
                    children(control).add(node("sequence"));
                    probabilities.add(0.2 + random.nextDouble() * 0.6);
                }
                control.put("probabilities", probabilities);
            } else {
                control = node("flow");
                children(control).add(node("sequence"));
                children(control).add(node("sequence"));
            }
            List<Map<String, Object>> valid = new ArrayList<Map<String, Object>>();
            for (Map<String, Object> target : targets)
                if (depth.get(target) < integer("max_nesting")) valid.add(target);
            Map<String, Object> parent = valid.isEmpty() ? root : valid.get(random.nextInt(valid.size()));
            children(parent).add(control);
            int level = depth.get(parent) + 1;
            depth.put(control, level);
            if ("branch".equals(control.get("kind")) || "flow".equals(control.get("kind"))) {
                for (Map<String, Object> child : children(control)) {
                    targets.add(child);
                    depth.put(child, level + 1);
                }
            } else targets.add(control);
            controlsList.add(control);
        }
        int assigned = 0;
        for (Map<String, Object> control : controlsList) {
            String kind = (String) control.get("kind");
            if ("branch".equals(kind) || "flow".equals(kind)) {
                for (Map<String, Object> child : children(control)) {
                    String id = assigned < tasks.size() ? tasks.get(assigned++) : tasks.get(random.nextInt(tasks.size()));
                    children(child).add(task(id));
                }
            } else {
                String id = assigned < tasks.size() ? tasks.get(assigned++) : tasks.get(random.nextInt(tasks.size()));
                children(control).add(task(id));
            }
        }
        while (assigned < tasks.size()) children(targets.get(random.nextInt(targets.size()))).add(task(tasks.get(assigned++)));
        if (children(root).isEmpty()) for (String id : tasks) children(root).add(task(id));
        return root;
    }

    private String build() {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("structure", structure());
        result.put("tasks", tasks);
        Map<String, Object> candidates = new LinkedHashMap<String, Object>();
        for (String task : tasks) {
            int count = (int) sample("distribution.candidate_count", integer("candidates"), true);
            List<Map<String, Object>> services = new ArrayList<Map<String, Object>>();
            for (int i = 0; i < count; i++) {
                Map<String, Object> candidate = new LinkedHashMap<String, Object>();
                candidate.put("name", "s_" + task + "_" + (i + 1));
                Map<String, Object> values = new LinkedHashMap<String, Object>();
                for (Map<String, Object> feature : features) {
                    int index = (Integer) feature.get("index");
                    values.put((String) feature.get("id"), sample("feature." + index + ".distribution", 0, false));
                }
                candidate.put("features", values);
                services.add(candidate);
            }
            candidates.put(task, services);
        }
        result.put("candidates", candidates);
        List<Map<String, Object>> constraints = new ArrayList<Map<String, Object>>();
        int expected = integer("constraints");
        List<Map<String, Object>> selected = new ArrayList<Map<String, Object>>();
        if ("exact".equals(config.getProperty("constraint_count_mode"))) {
            selected.addAll(features);
            Collections.shuffle(selected, random);
            selected = selected.subList(0, expected);
        } else {
            for (Map<String, Object> feature : features)
                if (random.nextDouble() < ((double) expected / features.size())) selected.add(feature);
        }
        for (Map<String, Object> feature : selected) {
            Map<String, Object> constraint = new LinkedHashMap<String, Object>();
            constraint.put("id", feature.get("id"));
            constraint.put("percent", sample("distribution.constraint_optimality_percent", 50, false));
            constraints.add(constraint);
        }
        result.put("constraints", constraints);
        return json(result);
    }

    private static String json(Object value) {
        if (value instanceof Map) {
            List<String> parts = new ArrayList<String>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet())
                parts.add(json(entry.getKey().toString()) + ":" + json(entry.getValue()));
            return "{" + String.join(",", parts) + "}";
        }
        if (value instanceof List) {
            List<String> parts = new ArrayList<String>();
            for (Object item : (List<?>) value) parts.add(json(item));
            return "[" + String.join(",", parts) + "]";
        }
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        return "\"" + value.toString().replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
}
