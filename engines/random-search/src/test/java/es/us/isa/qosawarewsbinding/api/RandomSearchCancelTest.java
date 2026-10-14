package es.us.isa.qosawarewsbinding.api;

import es.us.isa.openbinding.core.TestProblems;
import es.us.isa.openbinding.core.TestProblems.Rig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Asynchronous mode of the random search over real HTTP: the budget below (a million iterations over
 * forty tasks, fixed seed) cannot finish within a test, so the only way the job ends is the cancel.
 */
@Timeout(300)
class RandomSearchCancelTest {
  private static final String SOLVER = "V1RandomSearch";
  private static final String ALPHA = "alpha-token-0123456789";
  private static final String BETA = "beta-token-0123456789x";

  private static String slow() {
    return TestProblems.envelope(TestProblems.heavy(40), "{\"iterations\":1000000,\"seed\":42}");
  }

  private static String quick() {
    return TestProblems.envelope(TestProblems.twoCandidates(), "{\"iterations\":20,\"seed\":7}");
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
      TestProblems.invalidRequestIsRefusedBeforeAnyJobExists(rig,
          TestProblems.envelope(TestProblems.twoCandidates(), "{\"notAnOption\":true}"));
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
