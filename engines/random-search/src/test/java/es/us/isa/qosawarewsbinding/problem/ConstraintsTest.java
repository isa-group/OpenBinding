
package es.us.isa.qosawarewsbinding.problem;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.*;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;

public class ConstraintsTest {

    @Test
    public void testRangeGlobalConstraint() {
        // Setup Problem & QoS Model
        QoSProperty<Double> cost = new QoSProperty<Double>("cost", null, QoSPropertyType.NEGATIVE);
        Set<QoSProperty> properties = new HashSet<>();
        properties.add(cost);
        WSCompositionQoSModel qosModel = new WSCompositionQoSModel(properties);

        // Mock Problem to return our QoS Model
        QoSAwareWSCompositionProblem problem = new QoSAwareWSCompositionProblem(null, qosModel);

        RangeGlobalQoSWSCompositionConstraint c = new RangeGlobalQoSWSCompositionConstraint(problem, cost, 10.0, 20.0,
                true);

        // Mock Solution with mocked evaluation
        WSCompositionQoSModel mockModel = new WSCompositionQoSModel(properties) {
            @Override
            public Double evaluate(QoSAwareWSCompositionSolution solution, QoSProperty property,
                    es.us.isa.qosawarewsbinding.WSCompositionStructure structure) {
                return ((MockSolution) solution).getAggregatedValue(property);
            }
        };
        problem.setQosmodel(mockModel);
        // ... rest of test ... use existing var names
        MockSolution val15 = new MockSolution(problem);
        val15.setAggregatedValue(cost, 15.0);
        assertTrue("Should be satisfied inside range", c.meets(val15));

        MockSolution val10 = new MockSolution(problem);
        val10.setAggregatedValue(cost, 10.0);
        assertTrue("Should be satisfied at lower bound", c.meets(val10));

        MockSolution val20 = new MockSolution(problem);
        val20.setAggregatedValue(cost, 20.0);
        assertTrue("Should be satisfied at upper bound", c.meets(val20));

        MockSolution val9 = new MockSolution(problem);
        val9.setAggregatedValue(cost, 9.9);
        assertFalse("Should fail below range", c.meets(val9));

        assertEquals(0.1, c.meetingDistance(val9), 0.001);

        MockSolution val21 = new MockSolution(problem);
        val21.setAggregatedValue(cost, 20.1);
        assertFalse("Should fail above range", c.meets(val21));
        assertEquals(0.1, c.meetingDistance(val21), 0.001);
    }

    @Test
    public void testLocalConstraint() {
        QoSProperty<Double> cost = new QoSProperty<Double>("cost", null, QoSPropertyType.NEGATIVE);
        QoSAwareWSCompositionProblem problem = new QoSAwareWSCompositionProblem(null, null);
        AbstractWebService task1 = new AbstractWebService("T1");

        LocalQoSWSCompositionConstraint c = new LocalQoSWSCompositionConstraint(problem, cost,
                BinaryOperator.LOWEREQUAL, 10.0, task1, true);

        MockSolution sol = new MockSolution(problem);
        ConcreteWebService s1 = new ConcreteWebService("S1", task1);
        s1.setQoSValue(cost, 5.0);
        sol.setSelectedService(task1, s1);

        assertTrue("5.0 <= 10.0", c.meets(sol));

        s1.setQoSValue(cost, 15.0);
        assertFalse("15.0 <= 10.0 should fail", c.meets(sol));
        assertEquals(5.0, c.meetingDistance(sol), 0.001);
    }

    @Test
    public void testDependencyConstraint() {
        QoSAwareWSCompositionProblem problem = new QoSAwareWSCompositionProblem(null, null);
        AbstractWebService t1 = new AbstractWebService("T1");
        AbstractWebService t2 = new AbstractWebService("T2");
        List<AbstractWebService> tasks = Arrays.asList(t1, t2);

        // Different Providers
        ProviderRelationWSCompositionConstraint cDiff = new ProviderRelationWSCompositionConstraint(
                problem,
                ProviderRelationWSCompositionConstraint.Type.DIFFERENT_PROVIDER,
                tasks,
                true);

        MockSolution sol = new MockSolution(problem);
        ConcreteWebService s1 = new ConcreteWebService("s1_P1", t1);
        ConcreteWebService s2 = new ConcreteWebService("s2_P2", t2);

        sol.setSelectedService(t1, s1);
        sol.setSelectedService(t2, s2);

        assertTrue("Different providers", cDiff.meets(sol));

        ConcreteWebService s3 = new ConcreteWebService("s3_P1", t2); // Same provider P1
        sol.setSelectedService(t2, s3);

        assertFalse("Same provider but expected different", cDiff.meets(sol));

        // Same Provider
        ProviderRelationWSCompositionConstraint cSame = new ProviderRelationWSCompositionConstraint(
                problem,
                ProviderRelationWSCompositionConstraint.Type.SAME_PROVIDER,
                tasks,
                true);

        assertTrue("Same provider P1", cSame.meets(sol));

        sol.setSelectedService(t2, s2); // P2
        assertFalse("Different provider but expected same", cSame.meets(sol));
    }

    // Stub Solution
    static class MockSolution extends QoSAwareWSCompositionSolution {
        private Map<AbstractWebService, ConcreteWebService> selection = new HashMap<>();
        private Map<QoSProperty, Double> aggregated = new HashMap<>();

        public MockSolution(QoSAwareWSCompositionProblem problem) {
            super(problem);
        }

        @Override
        public ConcreteWebService getSelectedService(AbstractWebService aws) {
            return selection.get(aws);
        }

        @Override
        public void setSelectedService(AbstractWebService aws, ConcreteWebService cws) {
            selection.put(aws, cws);
        }

        public void setAggregatedValue(QoSProperty p, Double v) {
            aggregated.put(p, v);
        }

        public Double getAggregatedValue(QoSProperty p) {
            return aggregated.get(p);
        }

        @Override
        public es.us.isa.qosawarewsbinding.solution.Solution createRandom() {
            return null; // Not needed
        }

    }
}
