package es.us.isa.qosawarewsbinding.search;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.TestProblems;
import es.us.isa.qosawarewsbinding.api.Controller;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

class V1RandomSearchTest {
  @Test void searchUsesCanonicalObjectiveAndPreservesCatalogRef() {
    BindingProblem problem = new BindingProblem(TestProblems.twoCandidates());
    V1RandomSearch.Result result = V1RandomSearch.run(problem, 20, null, 7L);
    assertTrue(result.best().feasible());
    assertEquals("catalog-a", result.best().binding().get("t").resource());
    assertEquals(20, result.evaluations());
  }

  @Test void httpAcceptsOnlyBimIrAndReturnsCanonicalDecision() throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/internal/v1/binding-problems", new Controller());
    server.start();
    try {
      String payload = TestProblems.envelope(TestProblems.twoCandidates(), "{\"iterations\":20,\"seed\":7}");
      HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:"
          + server.getAddress().getPort() + "/internal/v1/binding-problems").openConnection();
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");
      try (OutputStream output = connection.getOutputStream()) {
        output.write(payload.getBytes(StandardCharsets.UTF_8));
      }
      assertEquals(200, connection.getResponseCode());
      JsonObject response = new JsonParser().parse(new String(
          readFully(connection.getInputStream()), StandardCharsets.UTF_8)).getAsJsonObject();
      assertEquals("FEASIBLE", response.get("termination").getAsString());
      JsonObject selected = response.getAsJsonArray("solutions").get(0).getAsJsonObject()
          .getAsJsonObject("decision").getAsJsonObject("binding").getAsJsonObject("t");
      assertEquals("catalog-a", selected.get("resource").getAsString());
      assertEquals("service", selected.get("id").getAsString());
    } finally {
      server.stop(0);
    }
  }

  @Test void controllerRejectsSourceInstanceAndUnknownOptions() {
    Controller controller = new Controller();
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.envelope(TestProblems.twoCandidates(), "{\"notAnOption\":true}")));
    String source = "{\"apiVersion\":\"bim/v1\",\"kind\":\"Instance\",\"metadata\":{},\"spec\":{}}";
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        "{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblemRequest\","
            + "\"protocol\":\"bim-engine/v1\",\"problem\":" + source + "}"));
  }

  @Test void heuristicNeverInfersInfeasibleFromAnEmptySample() {
    JsonObject document = TestProblems.twoCandidates();
    document.getAsJsonObject("spec").getAsJsonArray("constraints").add(
        new JsonParser().parse("{\"ref\":{\"resource\":\"constraints\",\"id\":\"impossible\"},"
            + "\"when\":{\"kind\":\"literal\",\"value\":true},"
            + "\"assert\":{\"kind\":\"literal\",\"value\":false},\"enforcement\":\"hard\"}"));
    JsonObject response = new JsonParser().parse(new Controller().solvePayload(
        TestProblems.envelope(document, "{\"iterations\":10,\"seed\":1}"))).getAsJsonObject();
    assertEquals("UNKNOWN", response.get("termination").getAsString());
    assertEquals(0, response.getAsJsonArray("solutions").size());
  }

  private static byte[] readFully(InputStream input) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[1024];
    int read;
    while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
    return output.toByteArray();
  }
}
