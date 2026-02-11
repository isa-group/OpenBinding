/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.io.Serializable;

/**
 *
 * @author japarejo
 */
public class AbstractWebService implements StructuralComponent, Serializable {
    private String name;
    public AbstractWebService(String name)
    {
        this.name=name;
    }
    
    @Override
    public String toString()
    {
        return name;
    }

    
    public String toStructuralString(String prefix) {
        return prefix+name;
    }
    
    public boolean isEmpty() {		
		return false;
	}
            
    @Override
    public boolean equals(Object obj) {
        if (this == obj)
            return true;
        if (obj == null)
            return false;
        if (getClass() != obj.getClass())
            return false;
        AbstractWebService other = (AbstractWebService) obj;
        if (name == null) {
            if (other.name != null)
                return false;
        } else if (!name.equals(other.name))
            return false;
        return true;
    }

    @Override
    public int hashCode() {
        final int prime = 31;
        int result = 1;
        result = prime * result + ((name == null) ? 0 : name.hashCode());
        return result;
    }
}
