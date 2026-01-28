package es.us.isa.qosawarewsbinding.util;


public abstract class IntensionDomain <T> extends Domain<T> {    
     
    public IntensionDomain () {      
    }
     
    public boolean belongs (T value) {
        return predicate(value);
    }
     
    public abstract boolean predicate (T value);

}

