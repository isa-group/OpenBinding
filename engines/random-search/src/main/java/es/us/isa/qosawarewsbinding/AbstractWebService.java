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
            
}
