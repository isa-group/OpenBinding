package es.us.isa.qosawarewsbinding.api;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import es.us.isa.qosawarewsbinding.api.dto.SolveResponse;
import es.us.isa.openbinding.core.EngineModels;
import es.us.isa.openbinding.core.PlacementAdapter;
import es.us.isa.qosawarewsbinding.bimstar.BimStarRandomSearch;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.util.Map;

public class Controller implements HttpHandler {
    private static final long MAX_BODY_BYTES = 512L * 1024L * 1024L;
    private static final String PAYLOAD_TOO_LARGE_MESSAGE =
            "Request body is too large. Maximum allowed size is " + MAX_BODY_BYTES + " bytes.";

    private final Gson gson = new Gson();

    private static class PayloadTooLargeException extends RuntimeException {
        PayloadTooLargeException(String message) {
            super(message);
        }
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            return;
        }

        try {
            String contentLength = exchange.getRequestHeaders().getFirst("Content-Length");
            if (contentLength != null) {
                try {
                    if (Long.parseLong(contentLength) > MAX_BODY_BYTES) {
                        throw new PayloadTooLargeException(PAYLOAD_TOO_LARGE_MESSAGE);
                    }
                } catch (NumberFormatException ignored) {
                }
            }

            String requestBody = readBodyWithLimit(exchange.getRequestBody(), MAX_BODY_BYTES);

            com.google.gson.JsonObject raw =
                    com.google.gson.JsonParser.parseString(requestBody).getAsJsonObject();
            if (!raw.has("instance")) {
                throw new IllegalArgumentException("Missing OpenBinding instance");
            }

            EngineModels.SolveRequest req =
                    gson.fromJson(requestBody, EngineModels.SolveRequest.class);
            // The placement view is derived from the instance's optional
            // resource_model / latency_model blocks; it comes back empty when
            // the instance carries neither, and the search is the same either way.
            @SuppressWarnings("unchecked")
            Map<String, Object> instanceMap = gson.fromJson(raw.get("instance"), Map.class);
            req.placement = PlacementAdapter.from(instanceMap);

            SolveResponse resp = processBimStar(req);

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
        } catch (PayloadTooLargeException e) {
            String error = "{\"error\": \"" + e.getMessage() + "\"}";
            exchange.sendResponseHeaders(413, error.length());
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

    private String readBodyWithLimit(InputStream inputStream, long maxBytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        long total = 0;

        int bytesRead;
        while ((bytesRead = inputStream.read(buffer)) != -1) {
            total += bytesRead;
            if (total > maxBytes) {
                throw new PayloadTooLargeException(PAYLOAD_TOO_LARGE_MESSAGE);
            }
            output.write(buffer, 0, bytesRead);
        }

        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private SolveResponse processBimStar(EngineModels.SolveRequest req) {
        if (req == null || req.instance == null) {
            throw new IllegalArgumentException("Missing OpenBinding instance");
        }
        int iterations = req.options != null && req.options.max_iterations > 0
                ? req.options.max_iterations
                : 1000;
        Long timeBudgetMs = req.options != null ? req.options.time_budget_ms : null;
        long seed = req.options != null && req.options.seed != null ? req.options.seed : 1L;

        long start = System.currentTimeMillis();
        BimStarRandomSearch.Result result =
                BimStarRandomSearch.run(req.instance, req.placement, iterations, timeBudgetMs, seed);
        long end = System.currentTimeMillis();

        // Unlike the legacy path, infeasible bests are returned (not a 422):
        // the gateway reference evaluator marks them feasible=false, and the
        // best-so-far trace documents the progress towards feasibility.
        SolveResponse resp = new SolveResponse();
        resp.status = "optimized";
        resp.execution_time = end - start;
        resp.iterations_count = (int) Math.min(Integer.MAX_VALUE, result.evaluations);
        resp.seed = seed;
        resp.trace = result.trace;
        resp.selection = result.binding;
        resp.aggregated_features = result.aggregated;
        resp.objective_value = result.binding.isEmpty() ? null : result.objective;
        resp.feasible = result.binding.isEmpty() ? null : result.feasible;
        return resp;
    }

}
