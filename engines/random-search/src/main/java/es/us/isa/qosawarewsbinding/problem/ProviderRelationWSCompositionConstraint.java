/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.AbstractWebService;

import es.us.isa.qosawarewsbinding.problem.WSCompositionConstraint;
import java.io.Serializable;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.Map;

/**
 *
 * @author antigravity
 */
public class ProviderRelationWSCompositionConstraint extends WSCompositionConstraint implements Serializable {

    public enum Type {
        SAME_PROVIDER, DIFFERENT_PROVIDER
    }

    private Type type;
    private List<AbstractWebService> tasks;

    public ProviderRelationWSCompositionConstraint(QoSAwareWSCompositionProblem problem, Type type,
            List<AbstractWebService> tasks, boolean hard) {
        super(problem);
        this.type = type;
        this.tasks = tasks;
        this.setHard(hard);
    }

    @Override
    public boolean meets(QoSAwareWSCompositionSolution solution) {
        return meetingDistance(solution) <= 0;
    }

    @Override
    public double meetingDistance(QoSAwareWSCompositionSolution solution) {
        if (tasks == null || tasks.size() < 2)
            return 0.0;

        Set<String> providers = new HashSet<String>();
        for (AbstractWebService task : tasks) {
            es.us.isa.qosawarewsbinding.ConcreteWebService cws = solution.getSelectedService(task);
            if (cws != null) {
                String provider = getProviderFromServiceId(cws.getName());
                providers.add(provider);
            }
        }

        if (type == Type.SAME_PROVIDER) {
            // We want 1 provider. Constraints failed by (size - 1)
            return Math.max(0.0, providers.size() - 1);
        } else if (type == Type.DIFFERENT_PROVIDER) {
            // We want N distinct providers (where N = tasks.size())
            // If providers.size() < tasks.size(), we have collisions.
            // Distance = tasks.size() - providers.size()
            // Note: This assumes all tasks executed.
            return Math.max(0.0, tasks.size() - providers.size());
        }
        return 0.0;
    }

    private String getProviderFromServiceId(String sid) {
        // HACK: Extract provider from ID "s{i}_{Provider}" or "s{i},{Provider}"
        if (sid == null)
            return "unknown";
        if (sid.contains("_")) {
            return sid.substring(sid.lastIndexOf("_") + 1);
        }
        if (sid.contains(",")) {
            return sid.substring(sid.lastIndexOf(",") + 1);
        }
        return sid;
    }

    public Type getType() {
        return type;
    }

    public void setType(Type type) {
        this.type = type;
    }

    public List<AbstractWebService> getTasks() {
        return tasks;
    }

    public void setTasks(List<AbstractWebService> tasks) {
        this.tasks = tasks;
    }
}
