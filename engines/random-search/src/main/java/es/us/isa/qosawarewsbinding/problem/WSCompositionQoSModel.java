/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.io.Serializable;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;



import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.CompositeStructuralComponent;
import es.us.isa.qosawarewsbinding.StructuralComponent;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.aggretation.AggregationFunction;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;

/**
 *
 * @author japarejo
 */
public class WSCompositionQoSModel implements Serializable{
    private Set<QoSProperty> qosProperties;
    Map<QoSProperty, Map<Class,AggregationFunction>> aggregationFunctions;
    private Map<QoSProperty, Double>  qosPropertiesWeights;
    
    public WSCompositionQoSModel(Set<QoSProperty> qosProperties)
    {
        this.qosProperties=qosProperties;
        aggregationFunctions=new HashMap<QoSProperty, Map<Class,AggregationFunction>>();
        qosPropertiesWeights=new HashMap<QoSProperty, Double>();
        Double value=1.0/((double)qosProperties.size());
        for(QoSProperty property:qosProperties)
            qosPropertiesWeights.put(property, value);
    }
    
    public WSCompositionQoSModel(Map<QoSProperty, Map<Class,AggregationFunction>> aggregationFunctions)
    {
        this.qosProperties=aggregationFunctions.keySet();
        this.aggregationFunctions=aggregationFunctions;
        Double value=1.0/((double)this.qosProperties.size());
        for(QoSProperty property:qosProperties)
            qosPropertiesWeights.put(property, value);
    }
    
    public AggregationFunction getAggregationFunction(QoSProperty property,Class pclass)
    {
        AggregationFunction result=null;
        Map<Class, AggregationFunction> functions=aggregationFunctions.get(property);
        if(functions!=null)
            result=functions.get(pclass);
        return result;
    }
    
    public void setAggregationFunction(QoSProperty property,Class pclass, AggregationFunction aggregationFunction)
    {
        Map<Class, AggregationFunction> functions=aggregationFunctions.get(property);
        if(functions==null)
        {
            functions=new HashMap<Class, AggregationFunction>();
            aggregationFunctions.put(property, functions);
        }
        functions.put(pclass, aggregationFunction);
    }
    
    public Double getQoSPropertyWeight(QoSProperty property)
    {
        return qosPropertiesWeights.get(property);
    }        

    public Set<QoSProperty> getQosProperties() {
        return qosProperties;
    }

    public void setQosPropertiesWeights(Map<QoSProperty, Double> qosPropertiesWeights) {
        this.qosPropertiesWeights = qosPropertiesWeights;
    }
    
    public QoSProperty getQoSProperty(String name)
    {
        QoSProperty result=null;
        for(QoSProperty property:qosProperties)
            if(property.getName().equals(name))
                result=property;
        return result;        
    }
    
    public Double evaluate(QoSAwareWSCompositionSolution solution,WSCompositionStructure compositionStructure)
    {
        double result=0;
        double qosPropertyAportation;
        for(QoSProperty property:qosProperties){
            qosPropertyAportation=evaluate(solution,property,compositionStructure);
            result+=qosPropertiesWeights.get(property).doubleValue()*qosPropertyAportation;
        }
        return result;
    }
    
    public Double evaluate(QoSAwareWSCompositionSolution solution, QoSProperty property,WSCompositionStructure compositionStructure)
    {
        return evaluate(solution,property,compositionStructure.getStructure());
    }
    
    public Double evaluate(QoSAwareWSCompositionSolution solution, QoSProperty property, StructuralComponent component)
    {
        Double result=null;
        if(component instanceof AbstractWebService)
            result=(Double)solution.getSelectedService((AbstractWebService)component).getQoSValue(property);
        else{
            AggregationFunction aggregationFunction=getAggregationFunction(property,component.getClass());            
            List<Double> partialResults=new LinkedList<Double>();
            List<Double> ponderations=new LinkedList<Double>();
            CompositeStructuralComponent compositeComponent=(CompositeStructuralComponent)component;
            Collection<StructuralComponent> subcomponents=compositeComponent.getSubComponents();
            for(StructuralComponent subcomponent:subcomponents){
                if(subcomponent!=null && !subcomponent.isEmpty()){
                    partialResults.add(evaluate(solution,property,subcomponent));
                    ponderations.add(compositeComponent.getPonderation(subcomponent));
                }
            }
            result=aggregationFunction.aggregation(partialResults,ponderations);
        }
        return result;
    }
    
    @Override
    public String toString()
    {
        StringBuffer buffer=new StringBuffer();
        Map<Class,AggregationFunction> functionsPerProperty;
        String newline = System.getProperty("line.separator");
        buffer.append("QoSModel{"+newline);
        //buffer.append("    "+qosProperties+newline);
        buffer.append("    "+"Properties{"+newline);
        for(QoSProperty property:qosProperties)
            buffer.append("         "+property.toString()+newline);
        buffer.append("    }"+newline);
        buffer.append("    AggregationFunctions("+newline);
        for(QoSProperty property:aggregationFunctions.keySet()){
            buffer.append("         "+property.getName()+"{"+newline);
            functionsPerProperty=aggregationFunctions.get(property);
            for(Class structureClass:functionsPerProperty.keySet())
            {
                buffer.append("             "+structureClass.getSimpleName()+":"+functionsPerProperty.get(structureClass)+newline);
            }
            buffer.append("         }"+newline);
        }
        buffer.append("    )"+newline);
        buffer.append("    "+"Weights("+newline);
        for(QoSProperty property:qosPropertiesWeights.keySet())
        {
            buffer.append("         "+property.getName()+":"+qosPropertiesWeights.get(property).doubleValue()+newline);
        }
        buffer.append("    )"+newline);
        buffer.append("}");
        return buffer.toString();
                
    }
    
}
