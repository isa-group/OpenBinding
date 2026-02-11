package es.us.isa.qosawarewsbinding.api.mapping;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.Branch;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.EmptyComponent;
import es.us.isa.qosawarewsbinding.Flow;
import es.us.isa.qosawarewsbinding.Loop;
import es.us.isa.qosawarewsbinding.Sequence;
import es.us.isa.qosawarewsbinding.StructuralComponent;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.api.dto.SolveRequest;
import es.us.isa.qosawarewsbinding.problem.BinaryOperator;
import es.us.isa.qosawarewsbinding.problem.GlobalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.LocalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.ProviderRelationWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.RangeGlobalQoSWSCompositionConstraint;
import es.us.isa.qosawarewsbinding.problem.SimpleUnfeasibilityPenalizator;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.qos.aggretation.AggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MaxAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MinAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ProductoryAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ScaledSumAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.SumatoryAggregationFunction;
import es.us.isa.qosawarewsbinding.util.BoundedDomain;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class ProblemBuilder {
    public ProblemBuildResult build(SolveRequest req) {
        Map<String, AbstractWebService> taskMap = new HashMap<String, AbstractWebService>();
        Map<String, String> serviceProviderMap = new HashMap<String, String>();

        StructuralComponent root = mapNode(req.composition.root, taskMap);
        WSCompositionStructure structure = new WSCompositionStructure(root);

        Map<String, QoSProperty<Double>> propertyMap = new HashMap<String, QoSProperty<Double>>();
        Set<QoSProperty> qosProperties = new HashSet<QoSProperty>();

        for (Map.Entry<String, SolveRequest.QoSPropertyDef> entry : req.features.properties.entrySet()) {
            QoSPropertyType type = "maximize".equals(entry.getValue().direction)
                    ? QoSPropertyType.POSITIVE
                    : QoSPropertyType.NEGATIVE;

            Double min = entry.getValue().min != null ? entry.getValue().min : 0.0;
            Double max = entry.getValue().max != null ? entry.getValue().max : 1.0;

            QoSProperty<Double> prop = new QoSProperty<Double>(
                    entry.getKey(),
                    new BoundedDomain<Double>(min, max),
                    type
            );
            qosProperties.add(prop);
            propertyMap.put(entry.getKey(), prop);
        }
        WSCompositionQoSModel qosModel = new WSCompositionQoSModel(qosProperties);

        Map<QoSProperty, Double> weights = new HashMap<QoSProperty, Double>();
        for (Map.Entry<String, Double> entry : req.features.weights.entrySet()) {
            QoSProperty<Double> prop = propertyMap.get(entry.getKey());
            if (prop != null) {
                weights.put(prop, entry.getValue());
            }
        }
        qosModel.setQosPropertiesWeights(weights);

        for (Map.Entry<String, SolveRequest.AggregationPolicy> entry : req.features.aggregation.entrySet()) {
            QoSProperty<Double> prop = propertyMap.get(entry.getKey());
            SolveRequest.AggregationPolicy policy = entry.getValue();

            qosModel.setAggregationFunction(prop, Sequence.class, getAggFunc(policy.seq));
            qosModel.setAggregationFunction(prop, Flow.class, getAggFunc(policy.flow));
            qosModel.setAggregationFunction(prop, Branch.class, getAggFunc(policy.branch));
            qosModel.setAggregationFunction(prop, Loop.class, getAggFunc(policy.loop));
        }

        Map<AbstractWebService, Set<ConcreteWebService>> market = new HashMap<AbstractWebService, Set<ConcreteWebService>>();
        for (Map.Entry<String, AbstractWebService> entry : taskMap.entrySet()) {
            String taskId = entry.getKey();
            AbstractWebService aws = entry.getValue();
            Set<ConcreteWebService> candidates = new HashSet<ConcreteWebService>();

            SolveRequest.ServiceCandidates sc = req.market.get(taskId);
            if (sc != null && sc.services != null) {
                for (SolveRequest.Service s : sc.services) {
                    ConcreteWebService cws = new ConcreteWebService(s.id, aws);

                    if (s.provider_id != null) {
                        serviceProviderMap.put(s.id, s.provider_id);
                    }

                    for (QoSProperty<Double> p : propertyMap.values()) {
                        Double val = s.features.get(p.getName());
                        if (val == null) {
                            if (p.getType() == QoSPropertyType.POSITIVE) {
                                val = 0.0;
                            } else {
                                val = 999999.0;
                            }
                        }
                        cws.setQoSValue(p, val);
                    }
                    candidates.add(cws);
                }
            }
            market.put(aws, candidates);
        }

        QoSAwareWSCompositionProblem problem = new QoSAwareWSCompositionProblem(
                structure,
                market,
                qosModel,
                new LinkedList<es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint>()
        );
        problem.setPenalizator(new SimpleUnfeasibilityPenalizator());

        applyConstraints(req, problem, taskMap, propertyMap, serviceProviderMap);

        return new ProblemBuildResult(problem, structure, qosModel, taskMap, propertyMap, market);
    }

    private void applyConstraints(
            SolveRequest req,
            QoSAwareWSCompositionProblem problem,
            Map<String, AbstractWebService> taskMap,
            Map<String, QoSProperty<Double>> propertyMap,
            Map<String, String> serviceProviderMap
    ) {
        if (req.constraints == null) {
            return;
        }

        for (SolveRequest.Constraint c : req.constraints) {
            boolean hard = c.hard != null ? c.hard : true;

            if ("dependency".equalsIgnoreCase(c.kind)) {
                List<AbstractWebService> relatedTasks = new ArrayList<AbstractWebService>();
                if (c.tasks != null) {
                    for (String tid : c.tasks) {
                        AbstractWebService t = taskMap.get(tid);
                        if (t != null) {
                            relatedTasks.add(t);
                        }
                    }
                }
                ProviderRelationWSCompositionConstraint.Type type =
                        "SAME_PROVIDER".equalsIgnoreCase(c.type)
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
                if (prop == null) {
                    continue;
                }

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
        return SumatoryAggregationFunction.getInstance();
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
