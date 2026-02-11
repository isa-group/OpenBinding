/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.io.Serializable;

import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;

/**
 *
 * @author japarejo
 */
public class GlobalQoSWSCompositionConstraint extends WSCompositionConstraint implements Serializable {
    private QoSProperty property;
    private BinaryOperator operator;
    private Double value;
    
    public GlobalQoSWSCompositionConstraint(QoSAwareWSCompositionProblem problem, QoSProperty property, Double value, BinaryOperator operator)
    {
        super(problem);
        if(problem!=null){
            if(problem.getQosmodel().getQosProperties().contains(property))
            {                
                this.property=property;
                this.operator=operator;
                this.value=value;
            }else
                throw new IllegalArgumentException("Property must be part of the QoS model of the problem at hand.");
        }else{
            this.property=property;
            this.operator=operator;
            this.value=value;
        }
    }
    
    @Override
    public boolean meets(QoSAwareWSCompositionSolution solution) {
        return meetingDistance(solution)==0;
    }

    @Override
    public double meetingDistance(QoSAwareWSCompositionSolution solution) {        
        Double currentValue=problem.getQosmodel().evaluate(solution,getProperty(),problem.getStructure());
        return meetingDistance(currentValue);
    }

    private double meetingDistance(Double currentValue) {
        double result=getValue().doubleValue()-currentValue.doubleValue();
        if(getOperator()==BinaryOperator.EQUAL){
            result=Math.abs(result);
        }else if(getOperator()==BinaryOperator.DISTINCT){
            if(result==0)
                result=1;
            else
                result=0;
        }else if(getOperator()==BinaryOperator.GREATER){
            if(result<0)
                    result=0;            
            else if(result==0)
                    result=Double.MIN_VALUE;
        }else if(getOperator()==BinaryOperator.GREATEREQUAL){
            if(result<0)
                    result=0;            
        }else if(getOperator()==BinaryOperator.LOWER){
            if(result>0)
                result=0;
            else if(result<0)
                result=Math.abs(result);
            else 
                result=Double.MIN_VALUE;
        }else if(getOperator()==BinaryOperator.LOWEREQUAL){
            if(result>0)
                result=0;
            else if(result<0)
                result=Math.abs(result);
        }
        return result;
    }
    
    public String toString()
    {
        String result=getOperator()+"("+getProperty().getName()+","+getValue()+")";
        return result;
    }

    public QoSProperty getProperty() {
        return property;
    }

    public void setProperty(QoSProperty property) {
        this.property = property;
    }

    public BinaryOperator getOperator() {
        return operator;
    }

    public void setOperator(BinaryOperator operator) {
        this.operator = operator;
    }

    public Double getValue() {
        return value;
    }

    public void setValue(Double value) {
        this.value = value;
    }
}
