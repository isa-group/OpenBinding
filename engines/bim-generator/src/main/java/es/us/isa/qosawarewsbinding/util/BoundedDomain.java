package es.us.isa.qosawarewsbinding.util;


public class BoundedDomain <ComparableType extends Number> extends IntensionDomain<ComparableType> {

     
    private ComparableType minBound;

     
    private ComparableType maxBound;

     
    public BoundedDomain () {
        super();
    }
    
    public BoundedDomain(ComparableType valuemin, ComparableType valuemax)
    {
        minBound=valuemin;
        maxBound=valuemax;
    }

 
    public ComparableType getMaxBound () {
        return maxBound;
    }

    public void setMaxBound (ComparableType val) {
        this.maxBound = val;
    }

    public ComparableType getMinBound () {
        return minBound;
    }

    public void setMinBound (ComparableType val) {
        this.minBound = val;
    }

    @Override
    public boolean predicate (ComparableType value) {
        return minBound.doubleValue()<=value.doubleValue() && maxBound.doubleValue()>=value.doubleValue();
    }
    
    @Override
    public boolean equals(Object value)
    {
        boolean result=false;
        if(value instanceof BoundedDomain)
        {
            BoundedDomain dom=(BoundedDomain)value;
            result=minBound.equals(dom.getMinBound()) && maxBound.equals(dom.getMaxBound());
        }
        return result;
    }

    @Override
    public int hashCode() {
        int hash = 3;
        hash = 17 * hash + (this.minBound != null ? this.minBound.hashCode() : 0);
        hash = 17 * hash + (this.maxBound != null ? this.maxBound.hashCode() : 0);
        return hash;
    }

    @Override
    public String toString()
    {
        return minBound.getClass().getSimpleName()+"["+minBound.toString()+","+maxBound.toString()+"]";
    }
}


