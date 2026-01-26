package es.us.isa.qosawarewsbinding.problem;

import es.us.isa.qosawarewsbinding.solution.Solution;


/** Esta interface representa el problem para el que queremos hallar una solucin ptima. Un objeto de tipo solucin no tendr sentido como tal si no est asociado a un problem concreto, y serï¿½ ï¿½ste, el que podrï¿½ evaluar la bondad de la soluciï¿½n en cuentiï¿½n. Por esta razï¿½n se ha ubicado la funciï¿½n evalua(Solution) en la clase problem, y el constructor de toda soluciï¿½n tomarï¿½ como parï¿½metro un objeto de la clase problem.
 * La clase problem adems habr de implementar todas las operaciones necesarias para la lectura de los "enunciados" de los mismos desde los ficheros en el formato en que estos estn representados.
 *
 * @author jose_antonio
 * @version
 */
public interface Problem {

    /** Esta funcin evalua para una {@link Solution} concreta que se le pasa como parmetro su bondad para el problem que este objeto representa. Adems esta clase. En caso de que la solucin no sea una solucin vï¿½lida para el problem se devolverï¿½ el value Double.MIN_VALUE (o Double.MAX_VALUE si el problem es de minimizaciï¿½n).
     */    
    public double fitness(Solution sol);
    
    /** Esta funcin indicar si una solucin es vlida para el problem concreto */
    public boolean feasible(Solution sol);    
    
    /** Esta funcin retornar una descripcin del problem lo suficientemente detallada
     * del problem como para crear una solucin válida por defecto.
     * Esta descripcin es la que ser utilizada por defecto en la llamada al contructor 
     * de soluciones de la calse GeneralfomFactory asociada con el problem concreto.
     * <br>
     *  NOTA: se recomienda que la descripcin contenga, los parmetros esenciales que 
     *    determinan el tamao concreto de la instancia del problem que el objeto representa
     *    y todos los parmetros ms que sean necesarios para describir el problem separados 
     *    por comas.
     */    
    public String getDescription();
    /** This method provides the name of the problem type e.g.: "TSP","SAT","QAP",etc.
     *  if you are creating your own problem you should ensure its problem is unique 
     *  in your FOM instance. 
     * @return name of the problem type as string.
     */
    public String getProblemType();
    
}
