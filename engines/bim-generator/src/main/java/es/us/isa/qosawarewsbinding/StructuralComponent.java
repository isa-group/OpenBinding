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
public interface StructuralComponent extends Serializable {
    public String toStructuralString(String prefix);
    public boolean isEmpty();
}
