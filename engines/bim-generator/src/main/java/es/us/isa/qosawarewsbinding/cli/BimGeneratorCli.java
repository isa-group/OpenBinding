package es.us.isa.qosawarewsbinding.cli;

import java.io.File;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Random;
import java.util.Set;

import es.us.isa.qosawarewsbinding.problem.ProblemReaderAndWriter;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.problem.WSCompositionQoSModel;
import es.us.isa.qosawarewsbinding.problem.generator.QoSAwareWSCompositionProblemGenerator;
import es.us.isa.qosawarewsbinding.problem.model.GlobalQoSConstraintsModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemConstraintsModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemQoSModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemServicesMarketModel;
import es.us.isa.qosawarewsbinding.problem.model.QoSAwareWSCompositionProblemStructuralModel;
import es.us.isa.qosawarewsbinding.problem.model.ServiceDependencesConstraintsModel;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.qos.QoSPropertyType;
import es.us.isa.qosawarewsbinding.util.BoundedDomain;
import es.us.isa.qosawarewsbinding.util.DistributionFunction;
import es.us.isa.qosawarewsbinding.util.DoubleUniformDistributionFunction;
import es.us.isa.qosawarewsbinding.util.IntegerGausssianDistributionFunction;
import es.us.isa.qosawarewsbinding.util.IntegerUniformDistributionFunction;

public class BimGeneratorCli {

    public static void main(String[] args) {
        int tasks = 10;
        int candidates = 5;
        int controlFlow = 50;
        double loops = 30.0;
        int maxNesting = 3;
        int iterationsPerLoop = 10;
        int constraints = 1;
        double optimalityPercentage = 65.0;
        String outputPath = null;
        Long seed = null;

        try {
            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                if ((arg.equals("--tasks") || arg.equals("-t")) && i + 1 < args.length) {
                    tasks = Integer.parseInt(args[++i]);
                    if (tasks <= 0) throw new IllegalArgumentException("tasks must be > 0");
                } else if ((arg.equals("--candidates") || arg.equals("-c")) && i + 1 < args.length) {
                    candidates = Integer.parseInt(args[++i]);
                    if (candidates <= 0) throw new IllegalArgumentException("candidates must be > 0");
                } else if ((arg.equals("--control-flow") || arg.equals("-cf")) && i + 1 < args.length) {
                    controlFlow = Integer.parseInt(args[++i]);
                    if (controlFlow < 0 || controlFlow > 100) throw new IllegalArgumentException("control-flow must be [0,100]");
                } else if ((arg.equals("--loops") || arg.equals("-l")) && i + 1 < args.length) {
                    loops = Double.parseDouble(args[++i]);
                    if (loops < 0.0 || loops > 100.0) throw new IllegalArgumentException("loops must be [0,100]");
                } else if (arg.equals("--max-nesting") && i + 1 < args.length) {
                    maxNesting = Integer.parseInt(args[++i]);
                    if (maxNesting < 0) throw new IllegalArgumentException("max-nesting must be >= 0");
                } else if (arg.equals("--iterations") && i + 1 < args.length) {
                    iterationsPerLoop = Integer.parseInt(args[++i]);
                    if (iterationsPerLoop <= 0) throw new IllegalArgumentException("iterations must be > 0");
                } else if (arg.equals("--constraints") && i + 1 < args.length) {
                    constraints = Integer.parseInt(args[++i]);
                    if (constraints < 0) throw new IllegalArgumentException("constraints must be >= 0");
                } else if (arg.equals("--optimality") && i + 1 < args.length) {
                    optimalityPercentage = Double.parseDouble(args[++i]);
                    if (optimalityPercentage < 0.0 || optimalityPercentage > 100.0) throw new IllegalArgumentException("optimality must be [0,100]");
                } else if ((arg.equals("--output") || arg.equals("-o")) && i + 1 < args.length) {
                    outputPath = args[++i];
                } else if (arg.equals("--seed") && i + 1 < args.length) {
                    seed = Long.parseLong(args[++i]);
                }
            }
        } catch (Exception e) {
            System.err.println("Invalid parameter: " + e.getMessage());
            System.exit(1);
        }

        // Structural Model
        QoSAwareWSCompositionProblemStructuralModel structuralModel = new QoSAwareWSCompositionProblemStructuralModel();
        structuralModel.setNumberOfActivities(tasks);
        structuralModel.setPercentageOfControlFlowActivities(controlFlow);
        structuralModel.setPercentageLoops(loops);
        structuralModel.setMaxNestingLevel(maxNesting);
        structuralModel.setIterationsPerLoop(new IntegerUniformDistributionFunction(Math.max(1, iterationsPerLoop - 2), iterationsPerLoop + 2));
        structuralModel.setBranchesPerIf(new IntegerUniformDistributionFunction(2, 2));

        // QoS properties
        Set<QoSProperty> qosProperties = new HashSet<QoSProperty>();
        QoSProperty cost = new QoSProperty<Double>("Cost", new BoundedDomain<Double>(0.0, 1.0), QoSPropertyType.NEGATIVE);
        QoSProperty execTime = new QoSProperty<Double>("ExecTime", new BoundedDomain<Double>(0.0, 1.0), QoSPropertyType.NEGATIVE);
        QoSProperty reliability = new QoSProperty<Double>("Reliability", new BoundedDomain<Double>(0.0, 1.0), QoSPropertyType.POSITIVE);
        QoSProperty availability = new QoSProperty<Double>("Availability", new BoundedDomain<Double>(0.0, 1.0), QoSPropertyType.POSITIVE);
        QoSProperty security = new QoSProperty<Double>("Security", new BoundedDomain(0.0, 1.0), QoSPropertyType.POSITIVE);
        qosProperties.add(cost);
        qosProperties.add(execTime);
        qosProperties.add(reliability);
        qosProperties.add(availability);
        qosProperties.add(security);

        // Market Model
        Map<QoSProperty, DistributionFunction<Double>> marketValues = new HashMap<QoSProperty, DistributionFunction<Double>>();
        for (QoSProperty prop : qosProperties) {
            marketValues.put(prop, new DoubleUniformDistributionFunction(0.0, 1.0));
        }
        QoSAwareWSCompositionProblemServicesMarketModel marketModel = new QoSAwareWSCompositionProblemServicesMarketModel(
                new IntegerUniformDistributionFunction(candidates, candidates),
                marketValues
        );

        // Constraints Model
        DistributionFunction<Integer> dfOptimality = new IntegerGausssianDistributionFunction((int) Math.round(optimalityPercentage), 10.0);
        GlobalQoSConstraintsModel globalConstraintsModel = new GlobalQoSConstraintsModel(constraints, dfOptimality);
        ServiceDependencesConstraintsModel serviceDependencesConstraintsModel = new ServiceDependencesConstraintsModel();
        QoSAwareWSCompositionProblemConstraintsModel constraintsModel = new QoSAwareWSCompositionProblemConstraintsModel(
                globalConstraintsModel,
                serviceDependencesConstraintsModel
        );

        QoSAwareWSCompositionProblemModel problemModel = new QoSAwareWSCompositionProblemModel(
                structuralModel,
                null,
                marketModel,
                constraintsModel
        );

        QoSAwareWSCompositionProblemGenerator generator = new QoSAwareWSCompositionProblemGenerator(problemModel);
        QoSAwareWSCompositionProblem problem = generator.generate();

        try {
            if (outputPath != null && !outputPath.equals("-")) {
                File targetFile = new File(outputPath);
                if (targetFile.getParentFile() != null) {
                    targetFile.getParentFile().mkdirs();
                }
                ProblemReaderAndWriter.write(outputPath, problem);
            } else {
                File temp = File.createTempFile("bim_gen_", ".txt");
                temp.deleteOnExit();
                ProblemReaderAndWriter.write(temp.getAbsolutePath(), problem);
                String content = new String(Files.readAllBytes(temp.toPath()));
                System.out.print(content);
                temp.delete();
            }
        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }
}
