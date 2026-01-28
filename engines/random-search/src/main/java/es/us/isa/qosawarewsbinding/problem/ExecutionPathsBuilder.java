/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.util.Set;

/**
 *
 * @author japarejo
 */
public interface ExecutionPathsBuilder{
    public Set<ExecutionPath> buildPaths(QoSAwareWSCompositionProblem aThis);
}
