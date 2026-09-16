/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.mains;

import es.us.isa.qosawarewsbinding.problem.ProblemReaderAndWriter;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;

/**
 *
 * @author japarejo
 */
public class PruebaLectura {
    public static void main(String [] args)
    {
        QoSAwareWSCompositionProblem problem=ProblemReaderAndWriter.load(".\\data\\ConstrainedProblem462.qawscp");
        ProblemReaderAndWriter.write(".\\data\\Problem4-0-loaded.qawscp", problem);
    }
}
