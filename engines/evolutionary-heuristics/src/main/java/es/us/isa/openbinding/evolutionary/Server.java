package es.us.isa.openbinding.evolutionary;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import es.us.isa.openbinding.core.EngineContract;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

/** BIM Engine Protocol v1 service for evolutionary search. */
public final class Server {
  private static final int MAX_BODY_BYTES = 64 * 1024 * 1024;
  private Server() {}

  public static void main(String[] args) throws IOException {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.createContext("/health", exchange -> write(exchange, 200, "{\"status\":\"ok\"}"));
    server.createContext("/internal/v1/binding-problems", Server::solve);
    server.setExecutor(Executors.newCachedThreadPool());
    server.start();
  }

  static String solvePayload(String payload) {
    EngineContract.Request request = EngineContract.parse(payload);
    EvolutionarySolver.Result result = new EvolutionarySolver().evaluate(request);
    JsonObject provenance = new JsonObject();
    provenance.addProperty("algorithm", EngineContract.stringOption(
        request.options(), "algorithm", "elitist-genetic"));
    provenance.addProperty("evaluations", result.evaluations);
    provenance.addProperty("elapsed_ms", result.elapsedMs);
    return EngineContract.json(EngineContract.response(
        result.solutions.isEmpty() ? "UNKNOWN" : "FEASIBLE", result.solutions, provenance));
  }

  private static void solve(HttpExchange exchange) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      exchange.sendResponseHeaders(405, -1);
      exchange.close();
      return;
    }
    try {
      byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
      if (body.length > MAX_BODY_BYTES) {
        writeProblem(exchange, 413, "Request body exceeds 64 MiB");
        return;
      }
      write(exchange, 200, solvePayload(new String(body, StandardCharsets.UTF_8)));
    } catch (IllegalArgumentException exception) {
      writeProblem(exchange, 422, exception.getMessage());
    } catch (RuntimeException exception) {
      writeProblem(exchange, 500, "Engine execution failed: " + exception.getMessage());
    }
  }

  private static void writeProblem(HttpExchange exchange, int status, String detail) throws IOException {
    JsonObject problem = new JsonObject();
    problem.addProperty("type", "https://bim.dev/problems/engine-request");
    problem.addProperty("title", status == 422 ? "Invalid BIM engine request" : "BIM engine error");
    problem.addProperty("status", status);
    problem.addProperty("detail", detail == null ? "Unknown error" : detail);
    exchange.getResponseHeaders().set("Content-Type", "application/problem+json");
    write(exchange, status, EngineContract.json(problem));
  }

  private static void write(HttpExchange exchange, int status, String payload) throws IOException {
    byte[] body = payload.getBytes(StandardCharsets.UTF_8);
    if (exchange.getResponseHeaders().getFirst("Content-Type") == null) {
      exchange.getResponseHeaders().set("Content-Type", "application/json");
    }
    exchange.sendResponseHeaders(status, body.length);
    exchange.getResponseBody().write(body);
    exchange.close();
  }
}
