/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.solution.vector;

import java.util.ArrayList;
import java.util.List;

import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.solution.Solution;

/**
 *
 * @author japarejo
 */
/**
 * 
 * @author japarejo
 */
public class QoSAwareWSCompositionVectorSolutionNavigable extends
		QoSAwareWSCompositionVectorSolution {

	protected int taskNeighbourhoodIndex;
	protected int candidateServiceNeighbourhoodIndex;
	protected long neighboursToExplore;
	protected QoSAwareWSCompositionVectorMovement movement;

	public QoSAwareWSCompositionVectorSolutionNavigable(
			QoSAwareWSCompositionProblem problem) {
		super(problem);
		resetNeighbourhood();
		randomize();
	}

	
	public QoSAwareWSCompositionVectorSolutionNavigable getNeighbour() {
		QoSAwareWSCompositionProblem theproblem = (QoSAwareWSCompositionProblem) problem;
		QoSAwareWSCompositionVectorSolutionNavigable result = new QoSAwareWSCompositionVectorSolutionNavigable(
				theproblem);
		System.arraycopy(selectedServicesIndexes, 0,
				result.selectedServicesIndexes, 0,
				selectedServicesIndexes.length);
		result.selectedServicesIndexes[movement.getAbstractWebService()] = movement
				.getNewConcreteService();
		movement = movement.nextMovement(this);
		neighboursToExplore = neighboursToExplore - 1;
		return result;
	}

	
	public QoSAwareWSCompositionVectorMovement getMovement() {
		return movement;
	}

	public long neighboursToExplore() {
		return neighboursToExplore;
	}

	public QoSAwareWSCompositionVectorSolutionNavigable getRandomNeighbour() {

		QoSAwareWSCompositionProblemInteger theproblem = (QoSAwareWSCompositionProblemInteger) problem;
		QoSAwareWSCompositionVectorSolutionNavigable result = this;
		int tasks = selectedServicesIndexes.length;
		List<Integer> listTasks = new ArrayList<Integer>(tasks);
		for (int i = 0; i < tasks; i++)
			if (theproblem.numberOfCandidates(i) > 1)
				listTasks.add(new Integer(i));
		int randomAWS = (int) Math.floor(Math.random()
				* ((double) listTasks.size()));
		int tries = 0;
		while (theproblem.numberOfCandidates(randomAWS) < 2 && tries < 5) {
			randomAWS = (int) Math.floor(Math.random()
					* ((double) listTasks.size()));
			tries++;
		}
		int nCandidates = theproblem.numberOfCandidates(randomAWS);
		if (nCandidates > 1) {
			List<Integer> listCandidates = new ArrayList<Integer>(
					nCandidates - 2);
			for (int i = 0; i < nCandidates; i++)
				if (selectedServicesIndexes[randomAWS] != i)
					listCandidates.add(new Integer(i));
			int randomCandidateIndex = (int) Math.floor(Math.random()
					* ((double) listCandidates.size()));
			result = new QoSAwareWSCompositionVectorSolutionNavigable(
					theproblem);
			System.arraycopy(selectedServicesIndexes, 0,
					result.selectedServicesIndexes, 0,
					selectedServicesIndexes.length);
			result.selectedServicesIndexes[randomAWS] = listCandidates
					.get(randomCandidateIndex);
		}
		return result;
	}

	@Override
	public Solution createRandom() {
		return new QoSAwareWSCompositionVectorSolutionNavigable(
				(QoSAwareWSCompositionProblem) problem);
	}

	public void resetNeighbourhood() {
		QoSAwareWSCompositionProblemInteger theproblem = (QoSAwareWSCompositionProblemInteger) problem;
		int tasks = selectedServicesIndexes.length;
		movement = new QoSAwareWSCompositionVectorMovement(this);
		neighboursToExplore = 0;
		for (int i = 0; i < tasks; i++) {
			neighboursToExplore += theproblem.numberOfCandidates(i) - 1;
		}
	}

	@Override
	public String toString() {
		return super.toString();
	}

}
