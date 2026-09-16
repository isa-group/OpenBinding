package es.us.isa.qosawarewsbinding.mains;

import java.util.HashMap;
import java.util.Map;

import es.us.isa.qosawarewsbinding.problem.ProblemReaderAndWriter;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.solution.vector.QoSAwareWSCompositionVectorSolutionNavigable;

public class PruebaObjFunctions implements Runnable{
 
	public static void main(String[] args) {
		PruebaObjFunctions program=new PruebaObjFunctions();
		program.run();
	}

	public void run() {
		// We load the problem:
		System.out.println("===========================================");
		String problemPath="..\\datasets\\qws\\procesamiento\\problemInstance-10.txt";
		System.out.println("Loading problem: "+problemPath);
		QoSAwareWSCompositionProblem problem=ProblemReaderAndWriter.load(problemPath);
		System.out.println("Problem Loaded!!!. Showing loaded info:");
		System.out.println(problem.toString());
		// We create a random solution:
		QoSAwareWSCompositionVectorSolutionNavigable initial=new QoSAwareWSCompositionVectorSolutionNavigable(problem);
		System.out.println("===========================================");
		System.out.println("Randomly generated solution:"+initial.toString());
		System.out.println("===========================================");
		System.out.println("QoS Values:");
		Map<String,Double> values=new HashMap<String, Double>();
		Double value;
		for(QoSProperty property:problem.getQosmodel().getQosProperties())
		{
			value=problem.getQosmodel().evaluate(initial, property,problem.getStructure());
			System.out.println(property.getName()+" :"+value);
			values.put(property.getName(),value);
		}
		for(QoSProperty property:problem.getQosmodel().getQosProperties())
		{
			System.out.println(property.getName()+" :"+problem.getQosmodel().evaluate(initial, property,problem.getStructure()));
		}
	}
}
