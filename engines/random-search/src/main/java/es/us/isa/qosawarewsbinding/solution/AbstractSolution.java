package es.us.isa.qosawarewsbinding.solution;

import es.us.isa.qosawarewsbinding.problem.Problem;

public abstract class AbstractSolution<T extends Problem> implements Solution {

	protected double fitness;
	protected T problem;

	public AbstractSolution(T problem) {
		this.problem = problem;
		fitness = Double.MAX_VALUE;
	}

	public double getFitness() {
		if (fitness == Double.MAX_VALUE && problem != null)
			fitness = problem.fitness(this);
		return fitness;
	}

	public abstract Solution createRandom();

	/**
	 * Getter for property problem.
	 * 
	 * @return Value of property problem.
	 */
	public T getProblem() {
		return problem;
	}

	/**
	 * Setter for property problem.
	 * 
	 * @param problem
	 *            New value of property problem.
	 */
	public void setProblem(T problem) {
		this.problem = problem;
	}

	/**
	 * Funcin de ordenacin natural en base al ndice de evaluacin. Por defecto,
	 * si el objeto no es una solucin se consideran iguales.
	 */

	public int compareTo(Object obj) {
		int result = 0;
		if (obj instanceof Solution) {
			if (this.fitness > ((Solution) obj).getFitness())
				result = 1;
			else if (this.fitness < ((Solution) obj).getFitness())
				result = -1;
		}
		return result;
	}

	@Override
	public String toString() {
		return "Fitness:" + fitness;
	}

}
