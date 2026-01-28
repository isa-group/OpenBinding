package es.us.isa.qosawarewsbinding.api;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

public class Server {
    public static void main(String[] args) throws IOException {
        int port = 8080;
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/solve", new Controller());
        server.setExecutor(Executors.newCachedThreadPool());
        System.out.println("Many-OBJ Service started on port " + port);
        server.start();
    }
}
