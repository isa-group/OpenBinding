package es.us.isa.qosawarewsbinding.problem;

public interface UnfeasibilityPenalizator {

    public double penalize(double fitness,double feasibilityDistance);

}
