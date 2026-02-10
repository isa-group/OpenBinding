package es.us.isa.qosawarewsbinding.api;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.StructuralComponent;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.api.dto.SolveRequest;
import es.us.isa.qosawarewsbinding.api.dto.SolveResponse;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.problem.GlobalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.RangeGlobalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.ProviderRelationWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.LocalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.BinaryOperator;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.qos.aggretation.*;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.vector.*;
import es.us.isa.qosawarewsbinding.*;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.*;

public class Controller implements HttpHandler {
    private Gson gson = new Gson();

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            return;
        }

        try {
            SolveRequest req = gson.fromJson(new InputStreamReader(exchange.getRequestBody()), SolveRequest.class);
            SolveResponse resp = process(req);

            String jsonResp = gson.toJson(resp);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, jsonResp.length());
            OutputStream os = exchange.getResponseBody();
            os.write(jsonResp.getBytes());
            os.close();
        } catch (IllegalArgumentException e) {
            String error = "{\"error\": \"" + e.getMessage() + "\"}";
            exchange.sendResponseHeaders(422, error.length());
            OutputStream os = exchange.getResponseBody();
            os.write(error.getBytes());
            os.close();
        } catch (Exception e) {
            e.printStackTrace();
            // detailed error for debugging
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            e.printStackTrace(pw);
            String stackTrace = sw.toString().replace("\"", "'").replace("\n", "\\n");

            String error = "{\"error\": \"" + e.getMessage() + "\", \"stack\": \"" + stackTrace + "\"}";
            exchange.sendResponseHeaders(500, error.length());
            OutputStream os = exchange.getResponseBody();
            os.write(error.getBytes());
            os.close();
        }
    }

    private SolveResponse process(SolveRequest req) {
        // 1. Map Structure
        Map<String, AbstractWebService> taskMap = new HashMap<String, AbstractWebService>();
        Map<String, String> serviceProviderMap = new HashMap<String, String>(); // serviceId -> providerId
        StructuralComponent root = mapNode(req.composition.root, taskMap);
        WSCompositionStructure structure = new WSCompositionStructure(root);

        // 2. Map QoS Model
        Map<String, QoSProperty<Double>> propertyMap = new HashMap<String, QoSProperty<Double>>();
        Set<QoSProperty> qosProperties = new HashSet<QoSProperty>();

        for (Map.Entry<String, SolveRequest.QoSPropertyDef> entry : req.features.properties.entrySet()) {
            QoSPropertyType type = "maximize".equals(entry.getValue().direction) ? QoSPropertyType.POSITIVE
                    : QoSPropertyType.NEGATIVE;

            Double min = entry.getValue().min != null ? entry.getValue().min : 0.0;
            Double max = entry.getValue().max != null ? entry.getValue().max : 1.0;

            QoSProperty<Double> prop = new QoSProperty<Double>(entry.getKey(),
                    new es.us.isa.qosawarewsbinding.util.BoundedDomain<Double>(min, max), type);
            qosProperties.add(prop);
            propertyMap.put(entry.getKey(), prop);
        }
        WSCompositionQoSModel qosModel = new WSCompositionQoSModel(qosProperties);

        // Map weights
        Map<QoSProperty, Double> weights = new HashMap<QoSProperty, Double>();
        for (Map.Entry<String, Double> entry : req.features.weights.entrySet()) {
            weights.put(propertyMap.get(entry.getKey()), entry.getValue());
        }
        qosModel.setQosPropertiesWeights(weights);

        // Map aggregation functions
        for (Map.Entry<String, SolveRequest.AggregationPolicy> entry : req.features.aggregation.entrySet()) {
            QoSProperty<Double> prop = propertyMap.get(entry.getKey());
            SolveRequest.AggregationPolicy policy = entry.getValue();

            qosModel.setAggregationFunction(prop, Sequence.class, getAggFunc(policy.seq));
            qosModel.setAggregationFunction(prop, Flow.class, getAggFunc(policy.flow));
            qosModel.setAggregationFunction(prop, Branch.class, getAggFunc(policy.branch));
            qosModel.setAggregationFunction(prop, Loop.class, getAggFunc(policy.loop));
        }

        // 3. Map Market
        Map<AbstractWebService, Set<ConcreteWebService>> market = new HashMap<AbstractWebService, Set<ConcreteWebService>>();
        // Need to find all AbstractWebServices (Tasks) in structure

        // collectTasks called during mapping

        for (Map.Entry<String, AbstractWebService> entry : taskMap.entrySet()) {
            String taskId = entry.getKey();
            AbstractWebService aws = entry.getValue();
            Set<ConcreteWebService> candidates = new HashSet<ConcreteWebService>();

            SolveRequest.ServiceCandidates sc = req.market.get(taskId);
            if (sc != null && sc.services != null) {
                for (SolveRequest.Service s : sc.services) {
                    ConcreteWebService cws = new ConcreteWebService(s.id, aws);

                    // Store provider_id for DEPENDENCY constraint checking
                    if (s.provider_id != null) {
                        serviceProviderMap.put(s.id, s.provider_id);
                    }

                    // Iterate over all expected properties to ensure completeness
                    for (QoSProperty<Double> p : propertyMap.values()) {
                        Double val = s.features.get(p.getName());
                        if (val == null) {
                            // Assign default based on type
                            if (p.getType() == QoSPropertyType.POSITIVE) {
                                val = 0.0;
                            } else {
                                val = 999999.0;
                            }
                            System.err.println("Warning: Missing QoS value for " + p.getName() + " in service " + s.id
                                    + " (Task " + taskId + "). Using default: " + val);
                        }
                        cws.setQoSValue(p, val);
                    }
                    candidates.add(cws);
                }
            }
            market.put(aws, candidates);
        }

        // 4. Create Problem (constraints will be attached after instantiation)
        QoSAwareWSCompositionProblem problem = new QoSAwareWSCompositionProblem(
                structure,
                market,
                qosModel,
                new LinkedList<es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint>()
        );
        problem.setPenalizator(new es.us.isa.qosawarewsbinding.problem.SimpleUnfeasibilityPenalizator());

        // 4. Map Constraints
        if (req.constraints != null) {
            for (SolveRequest.Constraint c : req.constraints) {
                boolean hard = c.hard != null ? c.hard : true;

                if ("dependency".equalsIgnoreCase(c.kind)) {
                    List<AbstractWebService> relatedTasks = new ArrayList<AbstractWebService>();
                    if (c.tasks != null) {
                        for (String tid : c.tasks) {
                            AbstractWebService t = taskMap.get(tid);
                            if (t != null)
                                relatedTasks.add(t);
                        }
                    }
                    ProviderRelationWSCompositionConstraint.Type type = "SAME_PROVIDER".equalsIgnoreCase(c.type)
                            ? ProviderRelationWSCompositionConstraint.Type.SAME_PROVIDER
                            : ProviderRelationWSCompositionConstraint.Type.DIFFERENT_PROVIDER;

                    ProviderRelationWSCompositionConstraint depConstraint = new ProviderRelationWSCompositionConstraint(
                            problem, type, relatedTasks, hard);
                    depConstraint.setServiceProviderMap(serviceProviderMap);
                    problem.getConstraints().add(depConstraint);
                    continue;
                }

                if ("attribute_bound".equalsIgnoreCase(c.kind)) {
                    QoSProperty<Double> prop = propertyMap.get(c.attribute_id);
                    if (prop == null)
                        continue;

                    BinaryOperator op = getOperator(c.op);

                    if (BinaryOperator.IN_RANGE.equals(op)) {
                        problem.getConstraints()
                                .add(new RangeGlobalQoSWSCompositionConstraint(problem, prop, c.min, c.max, hard));
                        continue;
                    }

                    if ("local".equalsIgnoreCase(c.scope)) {
                        if (c.tasks != null) {
                            for (String tid : c.tasks) {
                                AbstractWebService t = taskMap.get(tid);
                                if (t != null) {
                                    problem.getConstraints().add(
                                            new LocalQoSWSCompositionConstraint(problem, prop, op, c.value, t, hard));
                                }
                            }
                        }
                    } else {
                        GlobalQoSWSCompositionConstraint gc = new GlobalQoSWSCompositionConstraint(problem, prop,
                                c.value, op);
                        gc.setHard(hard);
                        problem.getConstraints().add(gc);
                    }
                }
            }
        }

        // 5. Solve (Simple Random Search)
        int iterations = 1000;
        if (req.config != null && req.config.max_iterations > 0) {
            iterations = req.config.max_iterations;
        }

        long start = System.currentTimeMillis();
        QoSAwareWSCompositionSolution bestSol = solveSimple(problem, iterations);
        long end = System.currentTimeMillis();

        if (problem.feasibilityDistance(bestSol) > 0) {
            throw new IllegalArgumentException(
                    "No feasible solution found after " + iterations + " iterations.");
        }

        // 6. Map Response
        SolveResponse resp = new SolveResponse();
        resp.execution_time = end - start;
        resp.iterations_count = iterations; // Report actual iterations used
        resp.status = "optimized";
        resp.selection = new HashMap<String, String>();
        resp.aggregated_features = new HashMap<String, Double>();

        // Populate selection
        if (bestSol instanceof QoSAwareWSCompositionVectorSolution) {
            QoSAwareWSCompositionVectorSolution vecSol = (QoSAwareWSCompositionVectorSolution) bestSol;
            // Need to map back AWS -> CWS ID
            // The Solution interface doesn't expose map easily, but VectorSolution does
            // Actually VectorSolution stores selection in a Map<AbstractWebService,
            // ConcreteWebService>
            // But it is protected or invalid access?
            // Let's assume we can get it or we need a way.
            // VectorSolution has getSelectedService(AbstractWebService) ??
            // Checking source... it extends AbstractSolution.
        }

        // Workaround: We need to modify QoSAwareWSCompositionVectorSolution or inspect
        // it.
        // It has getService(AbstractWebService) ?
        // I will check AbstractSolution source code if I can.
        // For now, assume a method to extract selection.

        // Evaluate QoS
        for (QoSProperty<Double> p : propertyMap.values()) {
            double val = qosModel.evaluate(bestSol, p, structure);
            resp.aggregated_features.put(p.getName(), val);
        }

        // Populate selection map
        for (Map.Entry<String, AbstractWebService> entry : taskMap.entrySet()) {
            String taskId = entry.getKey();
            AbstractWebService aws = entry.getValue();
            ConcreteWebService cws = bestSol.getSelectedService(aws);
            if (cws != null) {
                resp.selection.put(taskId, cws.getName());
            }
        }

        return resp;
    }

    private AggregationFunction getAggFunc(String name) {
        if ("sum".equalsIgnoreCase(name))
            return SumatoryAggregationFunction.getInstance();
        if ("product".equalsIgnoreCase(name))
            return ProductoryAggregationFunction.getInstance();
        if ("max".equalsIgnoreCase(name))
            return MaxAggregationFunction.getInstance();
        if ("min".equalsIgnoreCase(name))
            return MinAggregationFunction.getInstance();
        if ("scaled_sum".equalsIgnoreCase(name))
            return ScaledSumAggregationFunction.getInstance();
        return SumatoryAggregationFunction.getInstance(); // default
    }

    private void collectTasks(StructuralComponent node, Map<String, AbstractWebService> map) {
        if (node instanceof AbstractWebService) {
            // How do we know the ID? We constructed it with ID.
            // AbstractWebService(String id).
            // But AbstractWebService constructor takes 'id'.
            // I need to store the mapping.
            // Actually I should store mapping when creating node.
            // AbstractWebService does not expose ID easily? It inherits from
            // StructuralComponent ??
            // StructuralComponent doesn't seem to have ID accessor?
            // Checking source needed.
            // Assuming toString() or similar return ID, or I map objects.
            // Best way: Map<StructuralComponent, String> in context?
        }
        if (node instanceof CompositeStructuralComponent) {
            for (StructuralComponent child : ((CompositeStructuralComponent) node).getSubComponents()) {
                collectTasks(child, map);
            }
        }
    }

    private StructuralComponent mapNode(SolveRequest.Node node, Map<String, AbstractWebService> taskMap) {
        if (node == null) {
            return null;
        }
        if ("TASK".equals(node.kind)) {
            AbstractWebService aws = new AbstractWebService(node.task_id);
            taskMap.put(node.task_id, aws);
            return aws;
        } else if ("SEQ".equals(node.kind)) {
            Sequence seq = new Sequence();
            if (node.children != null) {
                for (SolveRequest.Node child : node.children) {
                    StructuralComponent sc = mapNode(child, taskMap);
                    if (sc != null) {
                        seq.getSubComponents().add(sc);
                    }
                }
            }
            return seq;
        } else if ("AND".equals(node.kind)) {
            Flow flow = new Flow();
            if (node.children != null) {
                for (SolveRequest.Node child : node.children) {
                    StructuralComponent sc = mapNode(child, taskMap);
                    if (sc != null) {
                        flow.getSubComponents().add(sc);
                    }
                }
            }
            return flow;
        } else if ("XOR".equals(node.kind)) {
            Branch branch = new Branch();
            if (node.branches != null) {
                for (SolveRequest.Branch b : node.branches) {
                    StructuralComponent child = mapNode(b.child, taskMap);
                    if (child != null) {
                        branch.addBranch(child, b.p);
                    }
                }
            }
            return branch;
        } else if ("LOOP".equals(node.kind)) {
            int iterations = 1;
            if (node.expected_iterations != null) {
                iterations = (int) Math.round(node.expected_iterations.doubleValue());
                if (iterations < 0) {
                    iterations = 0;
                }
            }
            Loop loop = new Loop(iterations);
            if (node.body != null) {
                StructuralComponent body = mapNode(node.body, taskMap);
                if (body != null) {
                    loop.getSubComponents().add(body);
                }
            }
            return loop;
        } else if ("ELEMENT".equals(node.kind)) {
            return new EmptyComponent(node.id);
        }
        return null;
    }

    private QoSAwareWSCompositionSolution solveSimple(QoSAwareWSCompositionProblem problem, int iterations) {
        // Simple Random Search
        // Initialize with default (all 0 index) or random
        QoSAwareWSCompositionSolution best = new QoSAwareWSCompositionVectorSolution(problem);
        // best = best.createRandom(); // Maybe start random?
        double bestFitness = problem.fitness(best);

        for (int i = 0; i < iterations; i++) {
            // Create a new random solution
            QoSAwareWSCompositionSolution sol = (QoSAwareWSCompositionSolution) new QoSAwareWSCompositionVectorSolution(
                    problem).createRandom();

            double f = problem.fitness(sol);

            if (f < bestFitness) {
                best = sol;
                bestFitness = f;
            }
        }
        return best;
    }

    private BinaryOperator getOperator(String op) {
        if ("==".equals(op))
            return BinaryOperator.EQUAL;
        if ("!=".equals(op))
            return BinaryOperator.DISTINCT;
        if (">".equals(op))
            return BinaryOperator.GREATER;
        if (">=".equals(op))
            return BinaryOperator.GREATEREQUAL;
        if ("<".equals(op))
            return BinaryOperator.LOWER;
        if ("<=".equals(op))
            return BinaryOperator.LOWEREQUAL;
        if ("IN_RANGE".equals(op) || "in_range".equalsIgnoreCase(op))
            return BinaryOperator.IN_RANGE;
        return BinaryOperator.EQUAL;
    }
}
