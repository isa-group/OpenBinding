package es.us.isa.qosawarewsbinding.api.solver;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

public class LexicographicSelector {
    public List<AbstractWebService> getTaskOrder(QoSAwareWSCompositionProblem problem) {
        List<AbstractWebService> tasks = new ArrayList<AbstractWebService>(problem.getMarket().keySet());
        Collections.sort(tasks, new Comparator<AbstractWebService>() {
            @Override
            public int compare(AbstractWebService a, AbstractWebService b) {
                String aId = a != null ? a.toString() : "";
                String bId = b != null ? b.toString() : "";
                return aId.compareTo(bId);
            }
        });
        return tasks;
    }

    public boolean isLexicographicallySmaller(
            QoSAwareWSCompositionSolution candidate,
            QoSAwareWSCompositionSolution currentBest,
            List<AbstractWebService> taskOrder
    ) {
        for (AbstractWebService aws : taskOrder) {
            ConcreteWebService cand = candidate.getSelectedService(aws);
            ConcreteWebService best = currentBest.getSelectedService(aws);
            String candId = cand != null ? cand.getName() : "";
            String bestId = best != null ? best.getName() : "";
            int cmp = candId.compareTo(bestId);
            if (cmp < 0) {
                return true;
            }
            if (cmp > 0) {
                return false;
            }
        }
        return false;
    }
}
