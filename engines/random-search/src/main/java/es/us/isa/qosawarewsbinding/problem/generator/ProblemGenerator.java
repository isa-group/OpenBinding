package es.us.isa.qosawarewsbinding.problem.generator;

import es.us.isa.qosawarewsbinding.problem.Problem;

public interface ProblemGenerator<X extends Problem> {
    public X generate();
}