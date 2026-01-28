/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */
package es.us.isa.qosawarewsbinding.qos;

import java.io.Serializable;

import es.us.isa.qosawarewsbinding.util.Domain;

/**
 *
 * @author japarejo
 */
public class QoSProperty<X extends Serializable> implements Serializable {

    private String name;
    private Domain<X> domain;
    private QoSPropertyType type;

    public QoSProperty(String name, Domain<X> domain, QoSPropertyType type) {
        this.name = name;
        this.domain = domain;
        this.type = type;
    }

    public QoSProperty(String name, QoSPropertyType type) {
        this(name, new Domain<X>(), type);
    }

    public String getName() {
        return name;
    }

    public Domain<X> getDomain() {
        return domain;
    }

    public QoSPropertyType getType() {
        return type;
    }
    
    @Override
    public boolean equals(Object value)
    {
        boolean result=false;
        if(value instanceof QoSProperty)
        {
            QoSProperty vproperty=(QoSProperty)value;
            result=(vproperty.name.equalsIgnoreCase(name)) ;
        }
        return result;
    }

    @Override
    public int hashCode() {
        int hash = 7;
        hash = 23 * hash + (this.name != null ? this.name.hashCode() : 0);        
        return hash;
    }
    
    @Override
    public String toString()
    {
        return name+":"+type+"-"+domain; // TODO Change the separator € (problems in linux!) 
    }
}
