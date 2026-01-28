/*
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */

package es.us.isa.qosawarewsbinding.problem;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.PrintWriter;
import java.util.Collection;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.Branch;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.Flow;
import es.us.isa.qosawarewsbinding.Loop;
import es.us.isa.qosawarewsbinding.Sequence;
import es.us.isa.qosawarewsbinding.StructuralComponent;
import es.us.isa.qosawarewsbinding.WSCompositionStructure;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.qos.aggretation.AggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.AverageAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MaxAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MaxAverageAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MinAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.MinAverageAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ProductoryAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.ProductoryPowAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.SumatoryAggregationFunction;
import es.us.isa.qosawarewsbinding.qos.aggretation.SumatoryPowAggregationFunction;
import es.us.isa.qosawarewsbinding.util.MyStringTokenizer;

/**
 *
 * @author japarejo
 */
public class ProblemReaderAndWriter {
   
   public static QoSAwareWSCompositionProblem load(String fileName) 
   {
       File f=new File(fileName);
       return load(f);
   }
   public static void write(String FileName, QoSAwareWSCompositionProblem problem)
   {
        File f=new File(FileName);
        write(f,problem);   
   }

    private static AbstractWebService getAbstractWebService(String serviceName, QoSAwareWSCompositionProblem result) {
        AbstractWebService aws=null;
        Set<AbstractWebService> services=result.getStructure().getComponents();
        for(AbstractWebService candidate:services)
            if(serviceName.equalsIgnoreCase(candidate.toString()))
                aws=candidate;
        return aws;
    }

    private static AggregationFunction getAggregationFunction(String functionName) {
        AggregationFunction result=null;
        if(functionName.equalsIgnoreCase("MAX"))
            result=MaxAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("MIN"))
            result=MinAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("SUM"))
            result=SumatoryAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("PRODUCT"))
            result=ProductoryAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("POW"))
            result=ProductoryPowAggregationFunction.getInstance();
        // New aggregation functions
        else if(functionName.equalsIgnoreCase("SUMPOW"))
            result=SumatoryPowAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("AVG"))
            result=AverageAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("MAXAVG"))
            result=MaxAverageAggregationFunction.getInstance();
        else if(functionName.equalsIgnoreCase("MINAVG"))
            result=MinAverageAggregationFunction.getInstance();
        return result;
    }

    private static Class getStructuralClass(String className) {
        Class result=null;
        if(className.equalsIgnoreCase("LOOP"))
            result=Loop.class;
        else if(className.equalsIgnoreCase("BRANCH"))
            result=Branch.class;
        else if(className.equalsIgnoreCase("SEQUENCE"))
            result=Sequence.class;
        else if(className.equalsIgnoreCase("FLOW"))
            result=Flow.class;
        return result;
    }

    private static StructuralComponent loadAWS(String line, BufferedReader reader, List<AbstractWebService> awsList) {
        StructuralComponent component=null;
        line=line.trim();
        if(!line.equals(""))
        {
            component=searchAWS(line,awsList);
        }
        return component;
    }

    private static StructuralComponent loadBranch(String substring, BufferedReader reader, List<AbstractWebService> awsList) throws IOException {
        
        StructuralComponent subComponent;
        Branch result=new Branch();
        MyStringTokenizer strtok=null;
        strtok=new MyStringTokenizer(substring,";",'(',')');
        List<Double> probabilities=new LinkedList<Double>();
        String value;
        while(strtok.hasMoreTokens())
        {
            value=strtok.nextToken();
            if(!value.equals(")["))
                probabilities.add(Double.valueOf(value));
        }
        int index=0;
        do{
            
            strtok=new MyStringTokenizer(substring,",",'[',']');
            while(strtok.hasMoreTokens())
            {
                subComponent=loadStructureComponent(strtok.nextToken(),reader,awsList);
                if(subComponent!=null){
                    result.addBranch(subComponent, probabilities.get(index));
                    index++;
                }
            } 
            if(substring.length()==0 || !(substring.charAt(substring.length()-1)==']'))
                substring=reader.readLine();
        }while(substring.length()==0 || !(substring.charAt(substring.length()-1)==']'));
        return result;
    }

    private static void loadConstraints(QoSAwareWSCompositionProblem result, BufferedReader reader) throws IOException {
        String line=reader.readLine();
        while(line.charAt(0)=='%')            
                    line=reader.readLine();
        int nConstraints=Integer.valueOf(line.trim());
        line=reader.readLine();
        if(line.charAt(0)=='%')
            line=reader.readLine();
        String stroperator;
        BinaryOperator operator;
        String propertyName;
        QoSProperty property;
        String value;
        while(line.charAt(0)!='%')
        {
            line=line.trim();
            MyStringTokenizer strtok=new MyStringTokenizer(line, "(),");
            stroperator=strtok.nextToken("(");  
            operator=BinaryOperator.valueOf(stroperator);
            propertyName=strtok.nextToken(",");
            property=result.getQosmodel().getQoSProperty(propertyName);
            value=strtok.nextToken(")");
            result.getConstraints().add(new GlobalQoSWSCompositionConstraint(result, property, Double.valueOf(value), operator));
            line=reader.readLine();
        }
    }

    private static StructuralComponent loadFlow(String substring, BufferedReader reader, List<AbstractWebService> awsList) {
        throw new UnsupportedOperationException("Not yet implemented");
    }

    private static StructuralComponent loadLoop(String substring, BufferedReader reader, List<AbstractWebService> awsList) throws IOException {        
        String number=substring.substring(0,substring.lastIndexOf(")"));
        Integer averageNumberOfIterations=Integer.valueOf(number);
        StructuralComponent subComponent;
        Loop result=new Loop(averageNumberOfIterations);
        substring=substring.substring(substring.lastIndexOf(")")+2);
        MyStringTokenizer strtok=null;
        do{
            strtok=new MyStringTokenizer(substring,",",'[',']');
            while(strtok.hasMoreTokens())
            {
                subComponent=loadStructureComponent(strtok.nextToken(),reader,awsList);
                if(subComponent!=null)
                    result.getSubComponents().add(subComponent);
            } 
            if(substring.length()==0 || !(substring.charAt(substring.length()-1)==']'))
                substring=reader.readLine();
        }while(substring.length()==0 || !(substring.charAt(substring.length()-1)==']'));
        return result;
    }

    private static void loadMarket(QoSAwareWSCompositionProblem result, BufferedReader reader) throws IOException {
        Map<AbstractWebService, Set<ConcreteWebService>> market=result.getMarket();
        market.clear();
        String line=reader.readLine();
        while(line.charAt(0)=='%')            
                    line=reader.readLine();
        line=reader.readLine();
        String serviceName=line.trim();
        String cwsName;
        String propertyName;
        String propertyValue;
        AbstractWebService aws=null;
        MyStringTokenizer strtok=null;
        Set<ConcreteWebService> awsSet=null;;
        ConcreteWebService cws=null;
        while(line.charAt(0)!='%')
        {            
            serviceName=line.trim();
            aws=getAbstractWebService(serviceName,result);        
            awsSet=new HashSet<ConcreteWebService>();
            line=reader.readLine();                        
            line=reader.readLine();
            while(line.charAt(0)!='-')
            {                
                strtok=new MyStringTokenizer(line, "():,");
                cwsName=strtok.nextToken("(");
                cws=new ConcreteWebService(cwsName, aws);
                while(strtok.hasMoreTokens())
                {
                    propertyName=strtok.nextToken(":");
                    if(!propertyName.equals(")")){
                        propertyValue=strtok.nextToken(",");
                        try{
                            cws.setQoSValue(result.getQosmodel().getQoSProperty(propertyName), Double.valueOf(propertyValue));
                        }catch(Exception ex){
                            System.out.println(ex);
                            System.out.println("ON LINE: "+line);
                            System.out.println("VALUE CAUSING ERROR:"+propertyValue);
                        }
                    }
                }
                awsSet.add(cws);
                line=reader.readLine();
            }
            market.put(aws, awsSet);
            line=reader.readLine();
        }
    }

    private static WSCompositionQoSModel loadQoSModel(BufferedReader reader) throws IOException {        
        WSCompositionQoSModel result=null;
        String line=reader.readLine();
        while(line.length()==0 || line.charAt(0)=='%')            
                    line=reader.readLine();
        line=line.trim();
        Set<QoSProperty> properties;
        if(line.equals("QoSModel{")){
            properties=loadQoSModelProperties(reader);
            result=new WSCompositionQoSModel(properties);
            loadQoSModelAggregationFunctions(reader,result);
            loadQoSModelWeights(reader,result);
            line=reader.readLine();
        }
        return result;
    }

    private static void loadQoSModelAggregationFunctions(BufferedReader reader, WSCompositionQoSModel result) throws IOException {
        String line=reader.readLine();
        line=line.trim();
        String name;
        String function;
        QoSProperty property;
        String className;
        Class myclass;
        String functionName;
        AggregationFunction aggregationf;
        
        if(line.equals("AggregationFunctions("))
        {
            line=reader.readLine();
            line=line.trim();
            while((!line.equals(")")))
            {
                if(line.charAt(line.length()-1)=='{')
                {
                    name=line.substring(0, line.length()-1);
                    property=result.getQoSProperty(name);
                    line=reader.readLine();
                    line=line.trim();
                    while(!line.equals("}"))
                    {
                        MyStringTokenizer strtok=new MyStringTokenizer(line,":");
                        className=strtok.nextToken();
                        functionName=strtok.nextToken();
                        myclass=getStructuralClass(className);
                        aggregationf=getAggregationFunction(functionName);
                        result.setAggregationFunction(property, myclass, aggregationf);
                        line=reader.readLine();
                        line=line.trim();
                    }
                }
                line=reader.readLine();
                line=line.trim();
            }
        }
    }

    private static Set<QoSProperty> loadQoSModelProperties(BufferedReader reader) throws IOException {
        Set<QoSProperty> result=new HashSet<QoSProperty>();
        QoSProperty property=null;
        String line=reader.readLine();
        line=line.trim();
        String name;
        String type;        
        
        if(line.equals("Properties{"))
        {
            line=reader.readLine();
            line=line.trim();
            while((!line.equals("}")))
            {
                MyStringTokenizer strtok=new MyStringTokenizer(line, ":-"); // TODO Change the separator € (problems in linux!) 
                if(strtok.hasMoreTokens()){
                    name=strtok.nextToken(":");
                    if(strtok.hasMoreTokens()){
                        type=strtok.nextToken("-");	// TODO Change the separator € (problems in linux!) 
                        property=new QoSProperty(name,QoSPropertyType.valueOf(type));
                        result.add(property);
                    }                
                }
                line=reader.readLine();
                line=line.trim();
            }
        }
        return result;
    }

    private static void loadQoSModelWeights(BufferedReader reader, WSCompositionQoSModel result) throws IOException {
        String line=reader.readLine();
        line=line.trim();
        String name;
        String value;
        Map<QoSProperty,Double> qosPropertiesWeights=new HashMap<QoSProperty, Double>();
        if(line.equals("Weights("))
        {
            line=reader.readLine();
            line=line.trim();
            while((!line.equals(")")))
            {
                MyStringTokenizer strtok=new MyStringTokenizer(line,":");
                name=strtok.nextToken();
                value=strtok.nextToken();
                qosPropertiesWeights.put(result.getQoSProperty(name),Double.valueOf(value));
                line=reader.readLine();
                line=line.trim();
            }
        }
        result.setQosPropertiesWeights(qosPropertiesWeights);
    }
    

    private static StructuralComponent loadSequence(String substring, BufferedReader reader, List<AbstractWebService> awsList) throws IOException {
        Sequence result=new Sequence();
        StructuralComponent subComponent;
        substring=substring.trim();
        
        MyStringTokenizer strtok=null;
        do
        {
            strtok=new MyStringTokenizer(substring,",",'[',']');
            while(strtok.hasMoreTokens())
            {
                subComponent=loadStructureComponent(strtok.nextToken(),reader,awsList);
                if(subComponent!=null)
                    result.getSubComponents().add(subComponent);
            }
            if(substring.length()==0 || !(substring.charAt(substring.length()-1)==']'))
                substring=reader.readLine();
        }while(substring.length()==0 || !(substring.charAt(substring.length()-1)==']'));
        return result;
    }

    private static WSCompositionStructure loadStructure(BufferedReader reader) {
        WSCompositionStructure result=null;
        String line;
        List<AbstractWebService> awsList=new LinkedList<AbstractWebService>();
        try {
            line = reader.readLine();
            while(line.charAt(0)=='%')
                line=reader.readLine();
            int nAbstractServices=Integer.parseInt(line);        
            for(int i=0;i<nAbstractServices;i++){
                line=reader.readLine();
                awsList.add(new AbstractWebService(line));
            }            
            line=reader.readLine();
            while(line.charAt(0)=='%')
                line=reader.readLine();
            StructuralComponent component=loadStructureComponent(line,reader, awsList);
            result=new WSCompositionStructure(component);
        } catch (IOException ex) {
            Logger.getLogger(ProblemReaderAndWriter.class.getName()).log(Level.SEVERE, null, ex);
        }                
        return result;
    }

    private static StructuralComponent loadStructureComponent(String line,BufferedReader reader, List<AbstractWebService> awsList) throws IOException 
    {
        StructuralComponent result=null;
        line=line.trim();
        if(line.substring(0, Math.min(3, line.length())).equalsIgnoreCase("SEC"))
        {
            result=loadSequence(line.substring(4),reader,awsList);
        }else if(line.substring(0,Math.min(4, line.length())).equalsIgnoreCase("LOOP")){
            result=loadLoop(line.substring(5),reader,awsList);
        }else if(line.substring(0,Math.min(6, line.length())).equalsIgnoreCase("BRANCH")){
            result=loadBranch(line.substring(7),reader,awsList);
        }else if(line.substring(0,Math.min(3, line.length())).equalsIgnoreCase("FLOW")){
            result=loadFlow(line.substring(5),reader,awsList);
        }else{
            result=loadAWS(line,reader,awsList);
        }
        return result;   
    }

    private static void printConstraints(PrintWriter writer, List<WSCompositionConstraint> constraints) {
        writer.println("%#======================= CONSTRAINTS =============================#");
        writer.println(constraints.size());
        writer.println("% ----------------------");
        for(WSCompositionConstraint constraint:constraints)
        {
            writer.println(constraint);
        }
        writer.println("% ----------------------");
    }

    private static void printHeader(PrintWriter writer, String fileName, QoSAwareWSCompositionProblem problem) {
        writer.println("%#============================= HEADER ======================================#");
        writer.println("% This file contains an instance of the QoS-Aware Web Services Composition Problem  ");
        writer.println("% FILE: "+fileName);
        writer.println("% Created by: José Antonio Parejo Mestre");
        writer.println("% "+new Date());
        writer.println("% ----------------------");
        writer.println("% Problem Statistics: ");
        writer.println("% ----------------------");
        writer.println("% Number of activities: "+problem.getStructure().numberOfActivities());
        int nServices=0;
        Collection<Set<ConcreteWebService>> values=problem.getMarket().values();
        for(Set<ConcreteWebService> services:values)
            nServices+=services.size();        
        writer.println("% Number of Candidate Services: "+nServices);
        writer.println("% Number of Constraints: "+problem.getConstraints().size());
    }

    private static void printMarket(PrintWriter writer, Map<AbstractWebService, Set<ConcreteWebService>> market,WSCompositionQoSModel qosModel) {
        writer.println("%#======================= CANDIDATE SERVICES =============================#");
        writer.println("------------------------");
        Set<ConcreteWebService> cwservices;
        for(AbstractWebService aws:market.keySet())
        {            
            writer.println(aws);
            writer.println("------------------------");
            cwservices=market.get(aws);
            for(ConcreteWebService cws:cwservices)
            {
                writer.print(cws+"(");
                for (QoSProperty property : qosModel.getQosProperties()) {
                    writer.print(property.getName() + ":" + cws.getQoSValue(property) + ",");
                }
                writer.println(")");                
            }
            writer.println("------------------------");
        }
    }

    private static void printQoSModel(PrintWriter writer, WSCompositionQoSModel qosmodel) {
        writer.println("%#======================= QOS MODEL =============================#");
        writer.println(qosmodel);        
    }

    private static void printStructure(PrintWriter writer, WSCompositionStructure structure) {
        writer.println("%#======================= COMPOSITION STRUCTURE =============================#");
        writer.println("% Abstract Services:");
        writer.println("%----------------------");
        writer.println(structure.getComponents().size());
        for(AbstractWebService aws:structure.getComponents())
            writer.println(aws);
        writer.println("% CompositionStructure:");
        writer.println("%----------------------");
        writer.println(structure.getStructure().toStructuralString(""));
    }

    public static QoSAwareWSCompositionProblem load(File f) {
       QoSAwareWSCompositionProblem result=null;
       WSCompositionStructure structure=null;
       WSCompositionQoSModel qosmodel=null;
       Map<AbstractWebService, Set<ConcreteWebService>> market=null;
       List<WSCompositionConstraint> constraints;
       BufferedReader reader;
       String line;
        try {
            reader = new BufferedReader(new FileReader(f));                   
            line=reader.readLine();             
            line=reader.readLine();             
            if(line.equals("% This file contains an instance of the QoS-Aware Web Services Composition Problem  "))
            {   
                // We skip the header:
                while(line.charAt(0)=='%' && line.charAt(1)==' ')            
                    line=reader.readLine();
                structure=loadStructure(reader);
                qosmodel=loadQoSModel(reader);
                result=new QoSAwareWSCompositionProblem(structure, qosmodel);
                loadMarket(result,reader);
                loadConstraints(result,reader);                                            
            }
       } catch (FileNotFoundException ex) {
            Logger.getLogger(ProblemReaderAndWriter.class.getName()).log(Level.SEVERE, null, ex);
       }catch (IOException ex) {
                Logger.getLogger(ProblemReaderAndWriter.class.getName()).log(Level.SEVERE, null, ex);
       }
       if(result!=null)
           result.scale();
       return result;
    }

    private static StructuralComponent searchAWS(String line, List<AbstractWebService> awsList) {
        StructuralComponent result=null;
        for(AbstractWebService aws:awsList)
        {
            if(aws.toString().equals(line))
                result=aws;
        }
        return result;
    }

    private static void write(File f, QoSAwareWSCompositionProblem problem)  {
        PrintWriter writer;
        try {
            writer = new PrintWriter(new BufferedOutputStream(new FileOutputStream(f)));        
            printHeader(writer,f.getName(),problem);
            printStructure(writer,problem.getStructure());
            printQoSModel(writer,problem.getQosmodel());                
            printMarket(writer,problem.getMarket(),problem.getQosmodel());
            printConstraints(writer,problem.getConstraints());            
            writer.close();
        } catch (FileNotFoundException ex) {
            Logger.getLogger(ProblemReaderAndWriter.class.getName()).log(Level.SEVERE, null, ex);
        }
    }
   
   
   
}
