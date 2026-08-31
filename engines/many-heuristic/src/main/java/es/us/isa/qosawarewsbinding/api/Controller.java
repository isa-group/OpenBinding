package es.us.isa.qosawarewsbinding.api;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import es.us.isa.openbinding.core.EngineContract;
import es.us.isa.qosawarewsbinding.search.V1ManySearch;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** BIM Engine Protocol v1 HTTP adapter for the Pareto sampler. */
public final class Controller implements HttpHandler {
  private static final long MAX_BODY_BYTES = 64L * 1024L * 1024L;

  @Override public void handle(HttpExchange exchange) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      exchange.sendResponseHeaders(405, -1);
      exchange.close();
      return;
    }
    try {
      write(exchange, 200, solvePayload(readBody(exchange.getRequestBody())));
    } catch (PayloadTooLarge exception) {
      writeError(exchange, 413, exception.getMessage());
    } catch (IllegalArgumentException exception) {
      writeError(exchange, 422, exception.getMessage());
    } catch (RuntimeException exception) {
      writeError(exchange, 500, "Engine execution failed: " + exception.getMessage());
    }
  }

  public String solvePayload(String payload) {
    EngineContract.Request request = EngineContract.parse(payload);
    if (!"pareto".equals(request.problem().optimization().get("mode").getAsString())) {
      throw new IllegalArgumentException("pareto-sampling requires optimization.mode pareto");
    }
    JsonObject options = request.options();
    EngineContract.validateOptions(options, "iterations", "archive_size", "seed", "time_budget_ms");
    int iterations = EngineContract.integerOption(options, "iterations", 5000, 1, 1000000);
    int archiveSize = EngineContract.integerOption(options, "archive_size", 100, 1, 10000);
    long seed = EngineContract.longOption(options, "seed", 0L);
    Long budget = EngineContract.optionalPositiveLong(options, "time_budget_ms");
    V1ManySearch.Result result = V1ManySearch.run(request.problem(), iterations, budget, archiveSize, seed);
    JsonObject provenance = new JsonObject();
    provenance.addProperty("algorithm", "bounded-pareto-sampling");
    provenance.addProperty("evaluations", result.evaluations());
    provenance.addProperty("elapsed_ms", result.elapsedMs());
    provenance.addProperty("seed", seed);
    return EngineContract.json(EngineContract.response(
        result.solutions().isEmpty() ? "UNKNOWN" : "FEASIBLE", result.solutions(), provenance));
  }

  private static String readBody(InputStream input) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    long total = 0;
    int read;
    while ((read = input.read(buffer)) >= 0) {
      total += read;
      if (total > MAX_BODY_BYTES) throw new PayloadTooLarge("Request body exceeds 64 MiB");
      output.write(buffer, 0, read);
    }
    return new String(output.toByteArray(), StandardCharsets.UTF_8);
  }

  private static void writeError(HttpExchange exchange, int status, String detail) throws IOException {
    JsonObject problem = new JsonObject();
    problem.addProperty("type", "https://bim.dev/problems/engine-request");
    problem.addProperty("title", status == 422 ? "Invalid BIM engine request" : "BIM engine error");
    problem.addProperty("status", status);
    problem.addProperty("detail", detail == null ? "Unknown error" : detail);
    write(exchange, status, EngineContract.json(problem));
  }

  private static void write(HttpExchange exchange, int status, String payload) throws IOException {
    byte[] body = payload.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", status >= 400 ? "application/problem+json" : "application/json");
    exchange.sendResponseHeaders(status, body.length);
    OutputStream output = exchange.getResponseBody();
    output.write(body);
    output.close();
    exchange.close();
  }

  private static final class PayloadTooLarge extends RuntimeException {
    PayloadTooLarge(String message) { super(message); }
  }
}
