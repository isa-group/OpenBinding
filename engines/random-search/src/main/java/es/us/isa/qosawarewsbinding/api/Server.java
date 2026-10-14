package es.us.isa.qosawarewsbinding.api;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import es.us.isa.openbinding.core.EngineHttp;
import es.us.isa.openbinding.core.EngineJobs;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

/**
 * Standalone HTTP deployment.  PORT (default 8080) and ENGINE_JOB_MODE select the port and the mode:
 * synchronous by default, asynchronous with cancellation when ENGINE_JOB_MODE=async.
 */
public class Server {
    public static void main(String[] args) throws IOException {
        EngineHttp.Settings settings = EngineHttp.Settings.fromEnvironment(System.getenv());
        HttpServer server = HttpServer.create(new InetSocketAddress(settings.port()), 0);
        server.createContext("/health", new HttpHandler() {
            @Override
            public void handle(HttpExchange exchange) throws IOException {
                byte[] body = "{\"status\":\"ok\"}".getBytes("UTF-8");
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            }
        });
        Controller controller = new Controller();
        final EngineJobs jobs = EngineHttp.install(server, controller, controller, settings,
            "Seeded Random Search BIM Engine", null);
        if (jobs != null) {
            Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
                @Override public void run() { jobs.close(); }
            }));
        }
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
    }
}
