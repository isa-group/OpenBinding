package es.us.isa.qosawarewsbinding.api;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import es.us.isa.qosawarewsbinding.AbstractWebService;
import es.us.isa.qosawarewsbinding.ConcreteWebService;
import es.us.isa.qosawarewsbinding.api.dto.SolveRequest;
import es.us.isa.qosawarewsbinding.api.dto.SolveResponse;
import es.us.isa.qosawarewsbinding.api.mapping.ProblemBuildResult;
import es.us.isa.qosawarewsbinding.api.mapping.ProblemBuilder;
import es.us.isa.qosawarewsbinding.api.solver.RandomSearchSolver;
import es.us.isa.qosawarewsbinding.problem.QoSAwareWSCompositionProblem;
import es.us.isa.qosawarewsbinding.qos.QoSProperty;
import es.us.isa.qosawarewsbinding.solution.QoSAwareWSCompositionSolution;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;

public class Controller implements HttpHandler {
    private final Gson gson = new Gson();

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            return;
        }

        try {
            SolveRequest req = gson.fromJson(new InputStreamReader(exchange.getRequestBody()), SolveRequest.class);
            SolveResponse resp = process(req);

            String jsonResp = gson.toJson(resp);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, jsonResp.length());
            OutputStream os = exchange.getResponseBody();
            os.write(jsonResp.getBytes());
            os.close();
        } catch (IllegalArgumentException e) {
            String error = "{\"error\": \"" + e.getMessage() + "\"}";
            exchange.sendResponseHeaders(422, error.length());
            OutputStream os = exchange.getResponseBody();
            os.write(error.getBytes());
            os.close();
        } catch (Exception e) {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            e.printStackTrace(pw);
            String stackTrace = sw.toString().replace("\"", "'").replace("\n", "\\n");

            String error = "{\"error\": \"" + e.getMessage() + "\", \"stack\": \"" + stackTrace + "\"}";
            exchange.sendResponseHeaders(500, error.length());
            OutputStream os = exchange.getResponseBody();
            os.write(error.getBytes());
            os.close();
        }
    }

    private SolveResponse process(SolveRequest req) {
        ProblemBuilder builder = new ProblemBuilder();
        ProblemBuildResult mapped = builder.build(req);
        QoSAwareWSCompositionProblem problem = mapped.problem;

        int iterations = 1000;
        if (req.config != null && req.config.max_iterations > 0) {
            iterations = req.config.max_iterations;
        }

        long start = System.currentTimeMillis();
        RandomSearchSolver solver = new RandomSearchSolver();
        QoSAwareWSCompositionSolution bestSol = solver.solve(problem, iterations);
        long end = System.currentTimeMillis();

        if (problem.feasibilityDistance(bestSol) > 0) {
            throw new IllegalArgumentException(
                    "No feasible solution found after " + iterations + " iterations.");
        }

        SolveResponse resp = new SolveResponse();
        resp.execution_time = end - start;
        resp.iterations_count = iterations;
        resp.status = "optimized";
        resp.selection = new HashMap<String, String>();
        resp.aggregated_features = new HashMap<String, Double>();

        for (QoSProperty<Double> p : mapped.propertyMap.values()) {
            double val = mapped.qosModel.evaluate(bestSol, p, mapped.structure);
            resp.aggregated_features.put(p.getName(), val);
        }

        for (Map.Entry<String, AbstractWebService> entry : mapped.taskMap.entrySet()) {
            String taskId = entry.getKey();
            AbstractWebService aws = entry.getValue();
            ConcreteWebService cws = bestSol.getSelectedService(aws);
            if (cws != null) {
                resp.selection.put(taskId, cws.getName());
            }
        }

        return resp;
    }

}
