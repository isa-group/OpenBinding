package es.us.isa.qosawarewsbinding.api;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import es.us.isa.qosawarewsbinding.api.dto.SolveResponse;
import es.us.isa.openbinding.core.EngineModels;
import es.us.isa.openbinding.core.PlacementAdapter;
import es.us.isa.qosawarewsbinding.bimstar.ManyBindingSearch;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Controller implements HttpHandler {
    private static final long MAX_BODY_BYTES = 512L * 1024L * 1024L;
    private static final String PAYLOAD_TOO_LARGE_MESSAGE =
            "Request body is too large. Maximum allowed size is " + MAX_BODY_BYTES + " bytes.";
    private static final String ERROR_PREFIX = "{\"error\": \"";

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
            if (contentLength != null && isPayloadTooLarge(contentLength)) {
                throw new PayloadTooLargeException(PAYLOAD_TOO_LARGE_MESSAGE);
            }

            String requestBody = readBodyWithLimit(exchange.getRequestBody(), MAX_BODY_BYTES);
            com.google.gson.JsonObject raw =
                    com.google.gson.JsonParser.parseString(requestBody).getAsJsonObject();
            if (!raw.has("instance")) {
                throw new IllegalArgumentException("Missing OpenBinding instance");
            }

            EngineModels.SolveRequest req =
                    gson.fromJson(requestBody, EngineModels.SolveRequest.class);
            // Derived from the instance's optional resource_model / latency_model
            // blocks; empty when it carries neither, so the search is the same
            // either way.
            @SuppressWarnings("unchecked")
            Map<String, Object> instanceMap = gson.fromJson(raw.get("instance"), Map.class);
            req.placement = PlacementAdapter.from(instanceMap);

            SolveResponse resp = process(req);

            String jsonResp = gson.toJson(resp);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, jsonResp.length());
            OutputStream os = exchange.getResponseBody();
            os.write(jsonResp.getBytes());
            os.close();
        } catch (IllegalArgumentException e) {
            String error = ERROR_PREFIX + e.getMessage() + "\"}";
            exchange.sendResponseHeaders(422, error.length());
            OutputStream os = exchange.getResponseBody();
            os.write(error.getBytes());
            os.close();
        } catch (PayloadTooLargeException e) {
            String error = ERROR_PREFIX + e.getMessage() + "\"}";
            exchange.sendResponseHeaders(413, error.length());
            OutputStream os = exchange.getResponseBody();
            os.write(error.getBytes());
            os.close();
        } catch (Exception e) {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            e.printStackTrace(pw);
            String stackTrace = sw.toString().replace("\"", "'").replace("\n", "\\n");

            String error = ERROR_PREFIX + e.getMessage() + "\", \"stack\": \"" + stackTrace + "\"}";
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

    private boolean isPayloadTooLarge(String contentLength) {
        try {
            return Long.parseLong(contentLength) > MAX_BODY_BYTES;
        } catch (NumberFormatException ex) {
            return false;
        }
    }

    private SolveResponse process(EngineModels.SolveRequest req) {
        if (req.instance == null) {
            throw new IllegalArgumentException("Missing OpenBinding instance");
        }

        int iterations = req.options != null && req.options.max_iterations > 0
                ? req.options.max_iterations
                : 1000;
        int archiveSize = req.options != null && req.options.archive_size > 0
                ? req.options.archive_size
                : 20;
        Long timeBudgetMs = req.options != null ? req.options.time_budget_ms : null;
        long seed = req.options != null && req.options.seed != null ? req.options.seed : 1L;

        long start = System.currentTimeMillis();
        ManyBindingSearch.Result result = ManyBindingSearch.run(
                req.instance, req.placement, iterations, timeBudgetMs, archiveSize, seed);
        long end = System.currentTimeMillis();

        SolveResponse resp = new SolveResponse();
        resp.execution_time = end - start;
        resp.iterations_count = (int) Math.min(Integer.MAX_VALUE, result.evaluations);
        resp.status = "optimized";
        resp.solutions = new ArrayList<>();

        for (int i = 0; i < result.bindings.size(); i++) {
            SolveResponse.SolutionDTO dto = new SolveResponse.SolutionDTO();
            dto.selection = new HashMap<>(result.bindings.get(i));
            dto.aggregated_features = new HashMap<>(result.aggregated.get(i));
            dto.is_feasible = result.feasible.get(i).booleanValue();
            resp.solutions.add(dto);
        }

        if (!resp.solutions.isEmpty()) {
            resp.selection = resp.solutions.get(0).selection;
            resp.aggregated_features = resp.solutions.get(0).aggregated_features;
        }

        return resp;
    }
}
