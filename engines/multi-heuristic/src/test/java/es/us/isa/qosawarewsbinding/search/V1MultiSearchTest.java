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
        TestProblems.paretoRequest(document, "MULTI",
            "{\"iterations\":30,\"archive_size\":10,\"seed\":9}"))).getAsJsonObject();
    assertEquals("FEASIBLE", response.get("termination").getAsString());
    assertTrue(response.getAsJsonArray("solutions").get(0).getAsJsonObject().has("decision"));

    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.paretoRequest(document, "MULTI", "{\"debug\":true}")));

    // A MANY execution is not this engine's class even when the IR has enough criteria.
    JsonObject many = TestProblems.withCriteria(multiProblem(), 3);
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.paretoRequest(many, "MANY", "{}")));
    // MULTI is two or three criteria: one criterion, or a SINGLE weighted-sum run, is refused.
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.paretoRequest(TestProblems.twoCandidates(), "MULTI", "{}")));
    assertThrows(IllegalArgumentException.class, () -> controller.solvePayload(
        TestProblems.envelope(document, "{}")));
  }

  @Test void emptyFeasibleArchiveIsUnknown() {
    JsonObject document = multiProblem();
    document.getAsJsonObject("spec").getAsJsonArray("constraints").add(
        new JsonParser().parse("{\"ref\":{\"resource\":\"constraints\",\"id\":\"impossible\"},"
            + "\"when\":{\"kind\":\"literal\",\"value\":true},"
            + "\"assert\":{\"kind\":\"literal\",\"value\":false},\"enforcement\":\"hard\"}"));
    JsonObject response = new JsonParser().parse(new Controller().solvePayload(
        TestProblems.paretoRequest(document, "MULTI", "{\"iterations\":10}"))).getAsJsonObject();
    assertEquals("UNKNOWN", response.get("termination").getAsString());
    assertEquals(0, response.getAsJsonArray("solutions").size());
  }

  /** Two criteria over the same feature: the IR carries no objective type of its own. */
  private static JsonObject multiProblem() {
    return TestProblems.withCriteria(TestProblems.twoCandidates(), 2);
  }
}
