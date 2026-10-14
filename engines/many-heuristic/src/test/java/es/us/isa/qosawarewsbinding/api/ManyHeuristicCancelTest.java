package es.us.isa.qosawarewsbinding.api;

import es.us.isa.openbinding.core.TestProblems;
import es.us.isa.openbinding.core.TestProblems.Rig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Asynchronous mode of the many-objective sampler over real HTTP: a million iterations over forty
 * tasks with three criteria and a fixed seed cannot finish within a test, so only the cancel ends it.
 */
@Timeout(300)
class ManyHeuristicCancelTest {
  private static final String SOLVER = "V1ManySearch";
  private static final String ALPHA = "alpha-token-0123456789";
  private static final String BETA = "beta-token-0123456789x";

  private static String slow() {
    return TestProblems.paretoRequest(TestProblems.withCriteria(TestProblems.heavy(40), 3), "MANY",
        "{\"iterations\":1000000,\"archive_size\":100,\"seed\":42}");
  }

  private static String quick() {
    return TestProblems.paretoRequest(TestProblems.withCriteria(TestProblems.twoCandidates(), 3), "MANY",
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
      // Valid IR, but this engine only samples MANY with pareto-front: refused up front, not as a failed job.
      TestProblems.invalidRequestIsRefusedBeforeAnyJobExists(rig,
          TestProblems.request(TestProblems.withCriteria(TestProblems.twoCandidates(), 3), "SINGLE",
              "weighted-sum", "[{\"criteria\":\"cost\",\"value\":0.5},{\"criteria\":\"cost-2\",\"value\":0.25},"
                  + "{\"criteria\":\"cost-3\",\"value\":0.25}]", "{}"));
    }
  }

  @Test void withoutTheAsyncModeThereIsNoJobEndpointAndTheAnswerIsStillSynchronous() throws Exception {
    try (Rig rig = rig(false, null)) {
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
}
