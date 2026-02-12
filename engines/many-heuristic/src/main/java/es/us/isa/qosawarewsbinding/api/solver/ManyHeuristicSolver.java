package es.us.isa.qosawarewsbinding.api.solver;

import es.us.isa.qosawarewsbinding.api.dto.SolveResponse;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolution;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;

import java.util.ArrayList;
import java.util.List;
import java.util.Iterator;
import java.util.Random;

public class ManyHeuristicSolver {

    public List<QoSAwareWSCompositionSolution> solve(QoSAwareWSCompositionProblem problem, int iterations,
            int archiveSize) {
        List<QoSAwareWSCompositionSolution> archive = new ArrayList<>();

        for (int i = 0; i < iterations; i++) {
            QoSAwareWSCompositionSolution sol = (QoSAwareWSCompositionSolution) new QoSAwareWSCompositionVectorSolution(
                    problem).createRandom();

            // Should verify feasibility?
            // Existing logic: problem.feasibilityDistance(sol) <= 0
            if (problem.feasibilityDistance(sol) <= 0) {
                updateArchive(archive, sol, problem, archiveSize);
            }
        }
        return archive;
    }

    private void updateArchive(List<QoSAwareWSCompositionSolution> archive, QoSAwareWSCompositionSolution candidate,
            QoSAwareWSCompositionProblem problem, int maxSize) {
        boolean dominated = false;
        Iterator<QoSAwareWSCompositionSolution> it = archive.iterator();

        while (it.hasNext()) {
            QoSAwareWSCompositionSolution existing = it.next();
            int dom = compareDominance(candidate, existing, problem);

            if (dom == -1) { // Candidate is dominated by an existing solution
                dominated = true;
                break;
            } else if (dom == 1) { // Candidate dominates existing
                it.remove();
            } else {
                // Check if they are identical (duplicate objective values)
                if (isIdentical(candidate, existing, problem)) {
                    dominated = true; // Treat as dominated to avoid adding duplicate
                    break;
                }
            }
        }

        if (!dominated) {
            archive.add(candidate);
            // Pruning mechanism if archive is full
            // For now, if we exceed size, remove random or oldest to keep it simple as MVP
            if (archive.size() > maxSize) {
                archive.remove(0);
            }
        }
    }

    private boolean isIdentical(QoSAwareWSCompositionSolution a, QoSAwareWSCompositionSolution b,
            QoSAwareWSCompositionProblem problem) {
        for (QoSProperty<?> p : problem.getQosmodel().getQosProperties()) {
            Double va = problem.getQosmodel().evaluate(a, p, problem.getStructure());
            Double vb = problem.getQosmodel().evaluate(b, p, problem.getStructure());

            if (va == null || vb == null)
                continue;

            // Check for equality with small tolerance for floating point arithmetic
            if (Math.abs(va - vb) > 0.000001) {
                return false;
            }
        }
        return true;
    }

    // 1: a dominates b
    // -1: b dominates a
    // 0: non-dominated
    private int compareDominance(QoSAwareWSCompositionSolution a, QoSAwareWSCompositionSolution b,
            QoSAwareWSCompositionProblem problem) {
        boolean betterInAny = false;
        boolean worseInAny = false;

        for (QoSProperty<?> p : problem.getQosmodel().getQosProperties()) {
            // We need double values
            Double va = problem.getQosmodel().evaluate(a, p, problem.getStructure());
            Double vb = problem.getQosmodel().evaluate(b, p, problem.getStructure());

            if (va == null || vb == null)
                continue;

            boolean aBetter = false;
            boolean aWorse = false;

            if (p.getType() == QoSPropertyType.POSITIVE) {
                if (va > vb)
                    aBetter = true;
                if (va < vb)
                    aWorse = true;
            } else {
                if (va < vb)
                    aBetter = true;
                if (va > vb)
                    aWorse = true;
            }

            if (aBetter)
                betterInAny = true;
            if (aWorse)
                worseInAny = true;
        }

        if (betterInAny && !worseInAny)
            return 1;
        if (worseInAny && !betterInAny)
            return -1;
        return 0;
    }
}
