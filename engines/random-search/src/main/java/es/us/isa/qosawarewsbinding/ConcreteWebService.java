/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

import es.us.isa.qosawarewsbinding.qos.QoSProperty;

/**
 *
 * @author japarejo
 */
public class ConcreteWebService implements Serializable {
    private String name;
    private AbstractWebService abstractWebService;
    protected Map<QoSProperty, Object> qosmodel;
    
    
    public ConcreteWebService(String name, AbstractWebService aws)
    {
        this.name=name;
        this.abstractWebService=aws;
        qosmodel=new HashMap<QoSProperty, Object>();
    }
    
    public Object getQoSValue(QoSProperty property){
        return qosmodel.get(property);
    }
    
    public void setQoSValue(QoSProperty property, Object value){
        qosmodel.put(property, value);
    }

    public String getName() {
        return name;
    }

    public AbstractWebService getAbstractWebService() {
        return abstractWebService;
    }
    
    @Override
    public String toString()
    {
        return name;
    }    
    
}
