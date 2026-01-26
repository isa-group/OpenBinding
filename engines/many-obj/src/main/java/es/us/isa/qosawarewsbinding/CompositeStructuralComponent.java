/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.util.List;

/**
 *
 * @author japarejo
 */
public interface CompositeStructuralComponent extends StructuralComponent {    

    public List<StructuralComponent> getSubComponents();    
    public Double getPonderation(StructuralComponent subcomponent);
    
}
