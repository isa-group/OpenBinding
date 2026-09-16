package es.us.isa.qosawarewsbinding.problem;

public interface Constraint<X> {   
    public boolean meets (X solution);
    public double meetingDistance (X solution);

}

