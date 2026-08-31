package es.us.isa.qosawarewsbinding.api;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

/** Standalone HTTP deployment used by the federation example. */
public final class Server {
  private Server() {}

  public static void main(String[] args) throws IOException {
    HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
    server.createContext("/health", new StaticHandler(
        "application/json", "{\"status\":\"ok\"}".getBytes("UTF-8")));
    server.createContext("/openapi.json", new StaticHandler(
        "application/json", resource("/openapi.json")));
    server.createContext("/internal/v1/binding-problems", new Controller());
    server.setExecutor(Executors.newCachedThreadPool());
    server.start();
  }

  private static byte[] resource(String path) throws IOException {
    InputStream input = Server.class.getResourceAsStream(path);
    if (input == null) throw new IOException("Missing classpath resource " + path);
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int read;
    while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
    input.close();
    return output.toByteArray();
  }

  private static final class StaticHandler implements HttpHandler {
    private final String contentType;
    private final byte[] body;

    StaticHandler(String contentType, byte[] body) {
      this.contentType = contentType;
      this.body = body;
    }

    @Override public void handle(HttpExchange exchange) throws IOException {
      if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
        exchange.sendResponseHeaders(405, -1);
      } else {
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.sendResponseHeaders(200, body.length);
        exchange.getResponseBody().write(body);
      }
      exchange.close();
    }
  }
}
