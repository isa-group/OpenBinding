package es.us.isa.qosawarewsbinding.solution;


public interface Solution extends Comparable,Cloneable {	   
    public double getFitness();
    public Solution createRandom();    
    public int compareTo(Object obj);    
}