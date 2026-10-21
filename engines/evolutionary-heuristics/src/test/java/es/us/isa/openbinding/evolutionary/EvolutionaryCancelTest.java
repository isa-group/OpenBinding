package es.us.isa.openbinding.evolutionary;

import es.us.isa.openbinding.core.EngineHttp;
import es.us.isa.openbinding.core.TestProblems;
import es.us.isa.openbinding.core.TestProblems.Rig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;

/**
 * Asynchronous mode of the evolutionary search over real HTTP: ten million evaluations over forty
 * tasks with a fixed seed cannot finish within a test, so only the cancel ends it.
 */
@Timeout(300)
class EvolutionaryCancelTest {
  private static final String SOLVER = "EvolutionarySolver";
  private static final String ALPHA = "alpha-token-0123456789";
  private static final String BETA = "beta-token-0123456789x";

  private static String slow() {
    return TestProblems.envelope(TestProblems.heavy(40), "{\"algorithm\":\"elitist-genetic\","
        + "\"population_size\":50,\"max_evaluations\":10000000,\"seed\":42}");
  }

  private static String quick() {
    return TestProblems.envelope(TestProblems.twoCandidates(), "{\"algorithm\":\"elitist-genetic\","
        + "\"population_size\":10,\"max_evaluations\":40,\"archive_size\":5,\"seed\":7}");
  }

  private static Rig rig(boolean async, String tokens) throws IOException {
    EngineHttp.Engine engine = Server::prepare;
    return new Rig(engine, exchange -> {
      // The synchronous deployment: the same preparation, answered at once.
      byte[] body = Server.solvePayload(new String(exchange.getRequestBody().readAllBytes(),
          java.nio.charset.StandardCharsets.UTF_8)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    }, async, tokens, TestProblems.oneSlot());
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
      // Valid IR; pareto-genetic with a weighted-sum scalarization is refused up front, not as a failed job.
      TestProblems.invalidRequestIsRefusedBeforeAnyJobExists(rig, TestProblems.envelope(
          TestProblems.twoCandidates(), "{\"algorithm\":\"pareto-genetic\"}"));
    }
  }

  @Test void withoutTheAsyncModeThereIsNoJobEndpointAndTheAnswerIsStillSynchronous() throws Exception {
    try (Rig rig = rig(false, null)) {
      TestProblems.synchronousEngineHasNoJobs(rig, quick());
    }
  }

  @Test void theSameSeedGivesTheSameResultThroughAJob() throws Exception {
    EngineHttp.Engine engine = Server::prepare;
    TestProblems.sameResultSyncAndAsync(engine, exchange -> {
      byte[] body = Server.solvePayload(new String(exchange.getRequestBody().readAllBytes(),
          java.nio.charset.StandardCharsets.UTF_8)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    }, quick());
  }

  @Test void aRestartedEngineDoesNotKnowTheOldIds() throws Exception {
    EngineHttp.Engine engine = Server::prepare;
    TestProblems.restartLosesIds(engine, exchange -> exchange.close(), quick());
  }
}
