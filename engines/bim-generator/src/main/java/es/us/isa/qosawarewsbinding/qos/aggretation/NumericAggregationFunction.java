/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.qos.aggretation;

import java.lang.reflect.TypeVariable;



/**
 *
 * @author José Antonio Parejo Maestre
 */
public abstract class NumericAggregationFunction<X extends Number> implements AggregationFunction {
     
    protected X obtainFromDouble(double value)
    {
        Class myclass=this.getClass();
        TypeVariable[] types=myclass.getTypeParameters();
        TypeVariable type=types[0];
        Class<X> paramTypeClass=(Class<X>)type.getGenericDeclaration();
        X result=null;
        Class c;
        if(Integer.TYPE.isAssignableFrom(paramTypeClass))
        {
            result=(X)(new Integer((int)Math.round(value)));
        }else if(Double.TYPE.isAssignableFrom(paramTypeClass))
        {
            result=(X)(new Double(value));
        }else if(Long.TYPE.isAssignableFrom(paramTypeClass))
        {
            result=(X)(new Long((long)Math.round(value)));
        }else if(Float.TYPE.isAssignableFrom(paramTypeClass))
        {
            result=(X)(new Float(value));
        }
        return result;
    }

}
