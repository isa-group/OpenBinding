package es.us.isa.qosawarewsbinding.search;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import es.us.isa.openbinding.core.BindingProblem;
import es.us.isa.openbinding.core.TestProblems;
import es.us.isa.qosawarewsbinding.api.Controller;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class V1MultiSearchTest {
  @Test void paretoModeReturnsCanonicalArchive() {
    V1MultiSearch.Result result = V1MultiSearch.run(
        new BindingProblem(multiProblem()), 30, null, 10, 9L);
    assertEquals(1, result.solutions().size());
    assertEquals("catalog-a", result.solutions().get(0).binding().get("t").resource());
    assertEquals(30, result.evaluations());
  }

  @Test void controllerReturnsContractAndRejectsOtherObjectiveClasses() {
    Controller controller = new Controller();
    JsonObject document = multiProblem();
    JsonObject response = new JsonParser().parse(controller.solvePayload(
        TestProblems.envelope(document,
            "{\"iterations\":30,\"archive_size\":10,\"seed\":9}"))).getAsJsonObject();
    assertEquals("FEASIBLE", response.get("termination").getAsString());
    assertTrue(response.getAsJsonArray("solutions").get(0).getAsJsonObject().has("decision"));

    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.envelope(document, "{\"debug\":true}")));

    JsonObject many = multiProblem();
    JsonObject optimization = many.getAsJsonObject("spec").getAsJsonObject("optimization");
    optimization.addProperty("type", "MANY");
    optimization.getAsJsonArray("terms").add(optimization.getAsJsonArray("terms").get(0).deepCopy());
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.envelope(many, "{}")));

    JsonObject mono = TestProblems.twoCandidates();
    mono.getAsJsonObject("spec").getAsJsonObject("optimization").addProperty("mode", "pareto");
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.envelope(mono, "{}")));
  }

  @Test void emptyFeasibleArchiveIsUnknown() {
    JsonObject document = multiProblem();
    document.getAsJsonObject("spec").getAsJsonArray("constraints").add(
        new JsonParser().parse("{\"ref\":{\"resource\":\"constraints\",\"id\":\"impossible\"},"
            + "\"when\":{\"kind\":\"literal\",\"value\":true},"
            + "\"assert\":{\"kind\":\"literal\",\"value\":false},\"enforcement\":\"hard\"}"));
    JsonObject response = new JsonParser().parse(new Controller().solvePayload(
        TestProblems.envelope(document, "{\"iterations\":10}"))).getAsJsonObject();
    assertEquals("UNKNOWN", response.get("termination").getAsString());
    assertEquals(0, response.getAsJsonArray("solutions").size());
  }

  private static JsonObject multiProblem() {
    JsonObject document = TestProblems.twoCandidates();
    JsonObject optimization = document.getAsJsonObject("spec").getAsJsonObject("optimization");
    optimization.addProperty("mode", "pareto");
    optimization.addProperty("type", "MULTI");
    optimization.getAsJsonArray("terms").add(optimization.getAsJsonArray("terms").get(0).deepCopy());
    return document;
  }
}
