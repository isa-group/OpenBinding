package es.us.isa.openbinding.evolutionary;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import es.us.isa.openbinding.core.TestProblems;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class EvolutionarySolverTest {
  @Test void serverRunsRealGeneticSearchAndReturnsCanonicalRef() {
    String responsePayload = Server.solvePayload(TestProblems.envelope(TestProblems.twoCandidates(),
        "{\"algorithm\":\"elitist-genetic\",\"population_size\":10,"
            + "\"max_evaluations\":40,\"archive_size\":5,\"seed\":7}"));
    JsonObject response = new JsonParser().parse(responsePayload).getAsJsonObject();
    assertEquals("FEASIBLE", response.get("termination").getAsString());
    JsonObject candidate = response.getAsJsonArray("solutions").get(0).getAsJsonObject()
        .getAsJsonObject("decision").getAsJsonObject("binding").getAsJsonObject("t");
    assertEquals("catalog-a", candidate.get("resource").getAsString());
    assertEquals(40, response.getAsJsonObject("provenance").get("evaluations").getAsInt());
  }

  @Test void serverRejectsUnknownOptionAndSourceShape() {
    assertThrows(IllegalArgumentException.class, () -> Server.solvePayload(
        TestProblems.envelope(TestProblems.twoCandidates(), "{\"unsupported_option\":4}")));
    String source = "{\"apiVersion\":\"bim/v1\",\"kind\":\"Instance\",\"metadata\":{},\"spec\":{}}";
    assertThrows(IllegalArgumentException.class, () -> Server.solvePayload(
        "{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblemRequest\","
            + "\"protocol\":\"bim-engine/v1\",\"problem\":" + source + "}"));
  }

  @Test void paretoAlgorithmRequiresAndReturnsParetoSemantics() {
    JsonObject document = TestProblems.twoCandidates();
    document.getAsJsonObject("spec").getAsJsonObject("optimization").addProperty("mode", "pareto");
    assertThrows(IllegalArgumentException.class, () -> Server.solvePayload(
        TestProblems.envelope(document, "{\"algorithm\":\"elitist-genetic\"}")));

    JsonObject response = new JsonParser().parse(Server.solvePayload(TestProblems.envelope(document,
        "{\"algorithm\":\"pareto-genetic\",\"population_size\":10,"
            + "\"max_evaluations\":40,\"archive_size\":5,\"seed\":7}"))).getAsJsonObject();
    assertEquals("FEASIBLE", response.get("termination").getAsString());
    assertEquals("catalog-a", response.getAsJsonArray("solutions").get(0).getAsJsonObject()
        .getAsJsonObject("decision").getAsJsonObject("binding")
        .getAsJsonObject("t").get("resource").getAsString());
  }

  @Test void geneticHeuristicNeverClaimsInfeasibility() {
    JsonObject document = TestProblems.twoCandidates();
    document.getAsJsonObject("spec").getAsJsonArray("constraints").add(
        new JsonParser().parse("{\"ref\":{\"resource\":\"constraints\",\"id\":\"impossible\"},"
            + "\"when\":{\"kind\":\"literal\",\"value\":true},"
            + "\"assert\":{\"kind\":\"literal\",\"value\":false},\"enforcement\":\"hard\"}"));
    JsonObject response = new JsonParser().parse(Server.solvePayload(TestProblems.envelope(document,
        "{\"algorithm\":\"elitist-genetic\",\"population_size\":4,\"max_evaluations\":8}")))
        .getAsJsonObject();
    assertEquals("UNKNOWN", response.get("termination").getAsString());
    assertEquals(0, response.getAsJsonArray("solutions").size());
  }

  @Test void runtimeAcceptsEveryBudgetAllowedByThePublishedOptionsSchema() {
    JsonObject response = new JsonParser().parse(Server.solvePayload(TestProblems.envelope(
        TestProblems.twoCandidates(), "{\"algorithm\":\"elitist-genetic\","
            + "\"population_size\":10,\"max_evaluations\":2,\"seed\":3}")))
        .getAsJsonObject();
    assertEquals("FEASIBLE", response.get("termination").getAsString());
    assertEquals(2, response.getAsJsonObject("provenance").get("evaluations").getAsInt());
  }
}
