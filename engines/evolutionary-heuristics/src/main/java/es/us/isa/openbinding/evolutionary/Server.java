package es.us.isa.openbinding.evolutionary;

import static es.us.isa.openbinding.evolutionary.ApiModels.*;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.Executors;

public final class Server {
  private static final Gson GSON = new GsonBuilder().serializeNulls().create();
  private static final int MAX_BODY_BYTES = 512 * 1024 * 1024;

  private Server() {}

  public static void main(String[] args) throws IOException {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.createContext("/health", exchange -> writeJson(exchange, 200, Map.of("status", "ok")));
    server.createContext("/solve", Server::solve);
    server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    server.start();
  }

  private static void solve(HttpExchange exchange) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      writeJson(exchange, 405, Map.of("error", "Method not allowed"));
      return;
    }
    try {
      byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
      if (body.length > MAX_BODY_BYTES) {
        writeJson(exchange, 413, Map.of("error", "Request body is too large"));
        return;
      }
      String payload = new String(body, StandardCharsets.UTF_8);
      SolveRequest request = GSON.fromJson(payload, SolveRequest.class);
      if (request == null || request.instance == null) {
        throw new IllegalArgumentException("Missing OpenBinding instance");
      }
      // Derived from the instance's optional resource_model / latency_model
      // blocks: empty when it carries neither, so the search is the same
      // either way.
      @SuppressWarnings("unchecked")
      Map<String, Object> instanceMap =
          GSON.fromJson(GSON.toJsonTree(GSON.fromJson(payload, Map.class).get("instance")), Map.class);
      request.placement = PlacementAdapter.from(instanceMap);
      writeJson(exchange, 200, new EvolutionarySolver().solve(request));
    } catch (IllegalArgumentException exception) {
      writeJson(exchange, 422, Map.of("error", exception.getMessage()));
    } catch (Exception exception) {
      writeJson(exchange, 500, Map.of("error", exception.getMessage()));
    }
  }

  private static void writeJson(HttpExchange exchange, int status, Object payload) throws IOException {
    byte[] body = GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(status, body.length);
    exchange.getResponseBody().write(body);
    exchange.close();
  }
}
