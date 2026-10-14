package es.us.isa.qosawarewsbinding.api;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import es.us.isa.openbinding.core.EngineHttp;
import es.us.isa.openbinding.core.EngineJobs;
import es.us.isa.openbinding.core.TestProblems;
import es.us.isa.openbinding.core.TestProblems.Reply;
import es.us.isa.openbinding.core.TestProblems.Rig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Asynchronous mode of the federated multi-objective sampler over real HTTP: a million iterations over
 * forty tasks with two criteria and a fixed seed cannot finish within a test, so only the cancel ends it.
 */
@Timeout(300)
class MultiHeuristicCancelTest {
  private static final String SOLVER = "V1MultiSearch";
  private static final String ALPHA = "alpha-token-0123456789";
  private static final String BETA = "beta-token-0123456789x";

  private static String slow() {
    return TestProblems.paretoRequest(TestProblems.withCriteria(TestProblems.heavy(40), 2), "MULTI",
        "{\"iterations\":1000000,\"archive_size\":100,\"seed\":42}");
  }

  private static String quick() {
    return TestProblems.paretoRequest(TestProblems.withCriteria(TestProblems.twoCandidates(), 2), "MULTI",
        "{\"iterations\":30,\"archive_size\":10,\"seed\":9}");
  }

  private static Rig rig(boolean async, String tokens) throws Exception {
    Controller controller = new Controller();
    return new Rig(controller, controller, async, tokens, TestProblems.oneSlot());
  }

  @Test void deleteStopsTheSolverThreadAndItsCpu() throws Exception {
    try (Rig rig = rig(true, null)) {
      TestProblems.stopsSolverAndCpu(rig, slow(), SOLVER);
    }
  }

  @Test void aQueuedJobLeavesWithoutRunningAndACancelFreesTheSlot() throws Exception {
    try (Rig rig = rig(true, null)) {
      TestProblems.queuedCancelAndSlotRelease(rig, slow(), quick(), SOLVER);
    }
  }

  @Test void tenantsCannotSeeOrCancelEachOthersJobs() throws Exception {
    try (Rig rig = rig(true, "alpha=" + ALPHA + ",beta=" + BETA)) {
      TestProblems.tenantIsolation(rig, slow(), SOLVER, ALPHA, BETA);
    }
  }

  @Test void deleteRacingTheEndOfAJobLeavesOneImmutableOutcome() throws Exception {
    try (Rig rig = rig(true, null)) {
      TestProblems.deleteVersusFinish(rig, quick());
    }
  }

  @Test void aRequestTheEngineRefusesIsA422BeforeAnyJobExists() throws Exception {
    try (Rig rig = rig(true, null)) {
      // Valid IR, but this engine only samples MULTI with pareto-front: refused up front, not as a failed job.
      TestProblems.invalidRequestIsRefusedBeforeAnyJobExists(rig,
          TestProblems.paretoRequest(TestProblems.withCriteria(TestProblems.twoCandidates(), 3), "MANY", "{}"));
    }
  }

  @Test void withoutTheAsyncModeThereIsNoJobEndpointAndTheAnswerIsStillSynchronous() throws Exception {
    try (Rig rig = rig(false, null)) {
      // This engine serves its pinned openapi.json in synchronous mode; nothing about it changes.
      TestProblems.synchronousEngineHasNoJobs(rig, quick());
    }
  }

  @Test void theSameSeedGivesTheSameResultThroughAJob() throws Exception {
    Controller controller = new Controller();
    TestProblems.sameResultSyncAndAsync(controller, controller, quick());
  }

  @Test void aRestartedEngineDoesNotKnowTheOldIds() throws Exception {
    Controller controller = new Controller();
    TestProblems.restartLosesIds(controller, controller, quick());
  }

  /**
   * The pinned {@code openapi.json} (shipped on the classpath) is what the synchronous deployment
   * serves; the asynchronous one serves the same document extended with the job endpoints and the
   * cancellation capability, and nothing already in it is removed.
   */
  @Test void theAsyncDeploymentExtendsThePinnedOpenApiWithoutChangingIt() throws Exception {
    byte[] pinned = classpath("/openapi.json");
    JsonObject original = new com.google.gson.JsonParser()
        .parse(new String(pinned, StandardCharsets.UTF_8)).getAsJsonObject();
    assertFalse(original.has("extensions"), "the pinned document has no extension");
    assertFalse(original.getAsJsonObject("paths").has(EngineHttp.JOBS_PATH + "{id}"));

    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    Controller controller = new Controller();
    EngineHttp.Settings settings = new EngineHttp.Settings(1, true, EngineHttp.Auth.disabled(),
        EngineJobs.Settings.defaults());
    EngineJobs jobs = EngineHttp.install(server, controller, controller, settings, "unused", pinned);
    server.start();
    try {
      Reply reply = TestProblems.http("GET",
          "http://127.0.0.1:" + server.getAddress().getPort() + EngineHttp.OPENAPI_PATH, null, null);
      assertEquals(200, reply.status);
      JsonObject served = reply.json();
      JsonObject cancellation = served.getAsJsonObject("extensions").getAsJsonObject("cancellation");
      assertTrue(cancellation.get("supported").getAsBoolean());
      assertEquals("attempt", cancellation.get("idScope").getAsString());
      JsonObject job = served.getAsJsonObject("paths").getAsJsonObject(EngineHttp.JOBS_PATH + "{id}");
      assertTrue(job.has("get"));
      assertTrue(job.has("delete"));
      assertEquals(original.get("x-bim-protocol-digest"), served.get("x-bim-protocol-digest"));
      assertEquals(original.getAsJsonObject("info"), served.getAsJsonObject("info"));
      for (Map.Entry<String, com.google.gson.JsonElement> schema
          : original.getAsJsonObject("components").getAsJsonObject("schemas").entrySet()) {
        assertEquals(schema.getValue(),
            served.getAsJsonObject("components").getAsJsonObject("schemas").get(schema.getKey()),
            "schema " + schema.getKey() + " is untouched");
      }
    } finally {
      server.stop(0);
      jobs.close();
    }
  }

  private static byte[] classpath(String path) throws Exception {
    InputStream input = MultiHeuristicCancelTest.class.getResourceAsStream(path);
    assertNotNull(input, path + " is on the classpath");
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int read;
    while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
    input.close();
    return output.toByteArray();
  }
}
