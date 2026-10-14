package es.us.isa.openbinding.core;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(60)
class EngineJobsTest {
  private static final String RESULT = "{\"termination\":\"UNKNOWN\",\"solutions\":[]}";

  private EngineJobs jobs;

  @AfterEach void stop() {
    if (jobs != null) jobs.close();
  }

  private EngineJobs jobs(int concurrent, int queued, long stopGraceMs) {
    jobs = new EngineJobs(new EngineJobs.Settings(concurrent, queued, 64, 60000L, stopGraceMs));
    return jobs;
  }

  private static EngineJobs.Snapshot await(EngineJobs jobs, String tenant, String id,
      EngineJobs.State... states) throws Exception {
    List<EngineJobs.State> wanted = Arrays.asList(states);
    long deadline = System.nanoTime() + 20000000000L;
    EngineJobs.Snapshot last = null;
    while (System.nanoTime() < deadline) {
      last = jobs.get(tenant, id);
      if (last != null && wanted.contains(last.state())) return last;
      Thread.sleep(5);
    }
    fail("job never reached " + wanted + ", last " + (last == null ? "null" : last.state()));
    return null;
  }

  /** A solver that honours cancellation: it counts its iterations and stops at the next checkpoint. */
  private static final class Cooperative implements EngineJobs.Work {
    final AtomicLong iterations = new AtomicLong();
    final AtomicReference<Thread> thread = new AtomicReference<Thread>();
    volatile boolean inside;

    @Override public String run() {
      thread.set(Thread.currentThread());
      inside = true;
      try {
        while (true) {
          Cancellation.checkpoint();
          iterations.incrementAndGet();
        }
      } finally {
        inside = false;
      }
    }
  }

  /** A solver that ignores cancellation until released, then returns a perfectly valid result. */
  private static final class Stubborn implements EngineJobs.Work {
    final CountDownLatch started = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);

    @Override public String run() {
      started.countDown();
      try {
        release.await();
      } catch (InterruptedException ignored) {
        // Deliberately keeps going: this solver does not honour interruption either.
        try { release.await(); } catch (InterruptedException again) { /* still keeps going */ }
      }
      return RESULT;
    }
  }

  @Test void cooperativeSolverStopsAtTheNextCheckpointAndCancelledIsConfirmed() throws Exception {
    EngineJobs jobs = jobs(1, 1, 5000L);
    Cooperative work = new Cooperative();
    EngineJobs.Snapshot accepted = jobs.submit("t", work);
    assertEquals(EngineJobs.State.QUEUED, accepted.state());
    await(jobs, "t", accepted.id(), EngineJobs.State.RUNNING);
    assertTrue(TestProblems.awaitTrue(5000, () -> work.iterations.get() > 1000));

    EngineJobs.CancelOutcome outcome = jobs.cancel("t", accepted.id());
    assertTrue(outcome.stopped());
    assertEquals(EngineJobs.State.CANCELLED, outcome.snapshot().state());
    assertFalse(work.inside, "cancelled is only reported once the solver left its loop");
    long frozen = work.iterations.get();
    Thread.sleep(150);
    assertEquals(frozen, work.iterations.get(), "the solver does not iterate after cancel");
    assertNull(outcome.snapshot().result());
    assertEquals(0, jobs.active());
  }

  @Test void aSolverThatIgnoresCancelIsCancellingNeverCancelledAndItsLateResultIsDiscarded() throws Exception {
    EngineJobs jobs = jobs(1, 1, 150L);
    Stubborn work = new Stubborn();
    String id = jobs.submit("t", work).id();
    assertTrue(work.started.await(10, TimeUnit.SECONDS));

    EngineJobs.CancelOutcome first = jobs.cancel("t", id);
    assertFalse(first.stopped(), "the solver is still alive");
    assertEquals(EngineJobs.State.CANCELLING, first.snapshot().state());
    EngineJobs.CancelOutcome repeated = jobs.cancel("t", id);
    assertEquals(EngineJobs.State.CANCELLING, repeated.snapshot().state());
    assertEquals(EngineJobs.State.CANCELLING, jobs.get("t", id).state());
    assertEquals(1, jobs.active(), "a still-running solver keeps its slot");

    work.release.countDown();
    EngineJobs.Snapshot done = await(jobs, "t", id, EngineJobs.State.CANCELLED, EngineJobs.State.COMPLETED);
    assertEquals(EngineJobs.State.CANCELLED, done.state(), "a result that arrives late does not reopen it");
    assertNull(done.result());
    assertEquals(EngineJobs.State.CANCELLED, jobs.cancel("t", id).snapshot().state());
    Thread.sleep(100);
    assertEquals(EngineJobs.State.CANCELLED, jobs.get("t", id).state());
    assertNull(jobs.get("t", id).result());
    assertEquals(0, jobs.active());
  }

  @Test void aCancelThatWaitsForAStubbornSolverAnswersCancellingWithinTheGrace() throws Exception {
    EngineJobs jobs = jobs(1, 0, 100L);
    Stubborn work = new Stubborn();
    String id = jobs.submit("t", work).id();
    assertTrue(work.started.await(10, TimeUnit.SECONDS));
    long started = System.nanoTime();
    EngineJobs.CancelOutcome outcome = jobs.cancel("t", id);
    long elapsedMs = (System.nanoTime() - started) / 1000000L;
    assertFalse(outcome.stopped());
    assertTrue(elapsedMs >= 90 && elapsedMs < 4000, "bounded wait, was " + elapsedMs);
    work.release.countDown();
    await(jobs, "t", id, EngineJobs.State.CANCELLED);
  }

  @Test void aQueuedJobIsCancelledWithoutEverRunningAndTheNextOneUsesTheSlot() throws Exception {
    EngineJobs jobs = jobs(1, 2, 5000L);
    Cooperative blocker = new Cooperative();
    String blocking = jobs.submit("t", blocker).id();
    await(jobs, "t", blocking, EngineJobs.State.RUNNING);

    AtomicBoolean ran = new AtomicBoolean();
    String skipped = jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { ran.set(true); return RESULT; }
    }).id();
    String next = jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { return RESULT; }
    }).id();
    assertEquals(EngineJobs.State.QUEUED, jobs.get("t", skipped).state());

    EngineJobs.CancelOutcome outcome = jobs.cancel("t", skipped);
    assertTrue(outcome.stopped());
    assertEquals(EngineJobs.State.CANCELLED, outcome.snapshot().state());
    assertEquals(EngineJobs.State.QUEUED, jobs.get("t", next).state(), "still waiting for the slot");

    assertTrue(jobs.cancel("t", blocking).stopped());
    EngineJobs.Snapshot done = await(jobs, "t", next, EngineJobs.State.COMPLETED);
    assertEquals(RESULT, done.result());
    assertFalse(ran.get(), "a job cancelled in the queue never executes");
    assertEquals(EngineJobs.State.CANCELLED, jobs.get("t", skipped).state());
  }

  @Test void aFinishedJobIsNotCancelledAndDeleteIsIdempotent() throws Exception {
    EngineJobs jobs = jobs(1, 1, 5000L);
    String id = jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { return RESULT; }
    }).id();
    EngineJobs.Snapshot done = await(jobs, "t", id, EngineJobs.State.COMPLETED);
    for (int attempt = 0; attempt < 3; attempt++) {
      EngineJobs.CancelOutcome outcome = jobs.cancel("t", id);
      assertTrue(outcome.stopped());
      assertEquals(EngineJobs.State.COMPLETED, outcome.snapshot().state());
      assertEquals(RESULT, outcome.snapshot().result());
      assertNull(outcome.snapshot().cancelReason());
    }
    assertEquals(done.createdAtSeconds(), jobs.get("t", id).createdAtSeconds());
  }

  @Test void cancelRacingTheEndLeavesExactlyOneFinalStateThatNeverChanges() throws Exception {
    EngineJobs jobs = jobs(2, 8, 5000L);
    int completed = 0;
    int cancelled = 0;
    for (int attempt = 0; attempt < 60; attempt++) {
      final int spins = (attempt % 6) * 400;
      String id = jobs.submit("t", new EngineJobs.Work() {
        @Override public String run() {
          for (int index = 0; index < spins; index++) Cancellation.checkpoint();
          return RESULT;
        }
      }).id();
      if (attempt % 2 == 0) Thread.sleep(0, 200000);
      EngineJobs.CancelOutcome outcome = jobs.cancel("t", id);
      assertTrue(outcome.stopped());
      EngineJobs.State state = outcome.snapshot().state();
      assertTrue(state == EngineJobs.State.COMPLETED || state == EngineJobs.State.CANCELLED, state.name());
      if (state == EngineJobs.State.COMPLETED) {
        completed++;
        assertEquals(RESULT, outcome.snapshot().result());
      } else {
        cancelled++;
        assertNull(outcome.snapshot().result());
      }
      Thread.sleep(2);
      EngineJobs.Snapshot later = jobs.get("t", id);
      assertEquals(state, later.state());
      assertEquals(outcome.snapshot().result(), later.result());
    }
    assertEquals(60, completed + cancelled);
    assertEquals(0, jobs.active());
  }

  @Test void aForeignOrUnknownIdIsNotFoundAndNothingIsCancelledForAnotherTenant() throws Exception {
    EngineJobs jobs = jobs(1, 1, 5000L);
    Cooperative work = new Cooperative();
    String id = jobs.submit("alpha", work).id();
    await(jobs, "alpha", id, EngineJobs.State.RUNNING);

    assertNull(jobs.get("beta", id));
    assertNull(jobs.cancel("beta", id));
    assertNull(jobs.get("beta", "00000000-0000-0000-0000-000000000000"));
    assertNull(jobs.cancel("alpha", "00000000-0000-0000-0000-000000000000"));
    assertNull(jobs.get("", id), "the anonymous tenant is a tenant like any other");
    assertEquals(EngineJobs.State.RUNNING, jobs.get("alpha", id).state());
    assertTrue(work.inside);
    assertTrue(jobs.cancel("alpha", id).stopped());
  }

  @Test void terminalJobsExpireAfterTheTtlAndRunningOnesNeverDo() throws Exception {
    final AtomicLong now = new AtomicLong(1000000L);
    LongSupplier clock = new LongSupplier() {
      @Override public long getAsLong() { return now.get(); }
    };
    jobs = new EngineJobs(new EngineJobs.Settings(2, 2, 64, 5000L, 1000L), clock);
    String quick = jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { return RESULT; }
    }).id();
    Cooperative live = new Cooperative();
    String running = jobs.submit("t", live).id();
    await(jobs, "t", quick, EngineJobs.State.COMPLETED);
    await(jobs, "t", running, EngineJobs.State.RUNNING);

    now.addAndGet(4999L);
    assertNotNull(jobs.get("t", quick));
    now.addAndGet(1L);
    assertNull(jobs.get("t", quick), "expired: indistinguishable from unknown");
    assertNull(jobs.cancel("t", quick));
    now.addAndGet(10 * 3600 * 1000L);
    assertEquals(EngineJobs.State.RUNNING, jobs.get("t", running).state());
    assertEquals(1, jobs.retained());
    assertTrue(jobs.cancel("t", running).stopped());
    now.addAndGet(5000L);
    assertNull(jobs.get("t", running));
    assertEquals(0, jobs.retained());
  }

  @Test void capacityIsBoundedAndFreesUpWhenJobsEnd() throws Exception {
    EngineJobs jobs = jobs(1, 1, 5000L);
    String first = jobs.submit("t", new Cooperative()).id();
    String second = jobs.submit("t", new Cooperative()).id();
    assertThrows(EngineJobs.Rejected.class, () -> jobs.submit("t", new Cooperative()));
    assertTrue(jobs.cancel("t", second).stopped());
    String third = jobs.submit("t", new Cooperative()).id();
    assertTrue(jobs.cancel("t", first).stopped());
    assertTrue(jobs.cancel("t", third).stopped());
    assertEquals(0, jobs.active());
    assertNotNull(jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { return RESULT; }
    }));
  }

  @Test void retainedJobsAreBounded() throws Exception {
    jobs = new EngineJobs(new EngineJobs.Settings(1, 1, 2, 60000L, 1000L));
    for (int index = 0; index < 2; index++) {
      String id = jobs.submit("t", new EngineJobs.Work() {
        @Override public String run() { return RESULT; }
      }).id();
      await(jobs, "t", id, EngineJobs.State.COMPLETED);
    }
    assertThrows(EngineJobs.Rejected.class, () -> jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { return RESULT; }
    }));
    assertEquals(2, jobs.retained());
  }

  @Test void failuresAreRecordedOnceAndNeverBecomeCompleted() throws Exception {
    EngineJobs jobs = jobs(1, 2, 5000L);
    String bad = jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { throw new IllegalArgumentException("bad input"); }
    }).id();
    String broken = jobs.submit("t", new EngineJobs.Work() {
      @Override public String run() { throw new IllegalStateException("boom"); }
    }).id();
    EngineJobs.Snapshot invalid = await(jobs, "t", bad, EngineJobs.State.FAILED);
    assertEquals("bad input", invalid.error());
    assertNull(invalid.result());
    EngineJobs.Snapshot failed = await(jobs, "t", broken, EngineJobs.State.FAILED);
    assertEquals("Engine execution failed: boom", failed.error());
    assertEquals(EngineJobs.State.FAILED, jobs.cancel("t", bad).snapshot().state());
  }

  @Test void idsAreRandomUuidsAndAreLostWithTheProcess() throws Exception {
    EngineJobs jobs = jobs(2, 8, 5000L);
    Set<String> seen = new HashSet<String>();
    String last = null;
    for (int index = 0; index < 20; index++) {
      last = jobs.submit("t", new EngineJobs.Work() {
        @Override public String run() { return RESULT; }
      }).id();
      assertTrue(last.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), last);
      assertTrue(seen.add(last));
    }
    await(jobs, "t", last, EngineJobs.State.COMPLETED);
    jobs.close();
    EngineJobs restarted = new EngineJobs(EngineJobs.Settings.defaults());
    try {
      for (String id : seen) {
        assertNull(restarted.get("t", id), "a restarted engine knows no previous ids");
        assertNull(restarted.cancel("t", id));
      }
    } finally {
      restarted.close();
    }
  }

  @Test void resubmittingAfterACancelIsANewIndependentJob() throws Exception {
    EngineJobs jobs = jobs(1, 2, 5000L);
    Cooperative original = new Cooperative();
    String first = jobs.submit("t", original).id();
    await(jobs, "t", first, EngineJobs.State.RUNNING);
    assertTrue(jobs.cancel("t", first).stopped());

    Cooperative retry = new Cooperative();
    String second = jobs.submit("t", retry).id();
    assertNotEquals(first, second);
    await(jobs, "t", second, EngineJobs.State.RUNNING);
    assertEquals(EngineJobs.State.CANCELLED, jobs.get("t", first).state(), "the old attempt stays cancelled");
    assertTrue(jobs.cancel("t", first).stopped());
    assertEquals(EngineJobs.State.RUNNING, jobs.get("t", second).state(), "cancelling the old id leaves the new job");
    assertTrue(jobs.cancel("t", second).stopped());
  }

  @Test void closeCancelsLiveJobsAndRefusesNewOnes() throws Exception {
    EngineJobs jobs = jobs(1, 1, 2000L);
    Cooperative work = new Cooperative();
    String id = jobs.submit("t", work).id();
    await(jobs, "t", id, EngineJobs.State.RUNNING);
    jobs.close();
    assertFalse(work.inside);
    assertEquals(EngineJobs.State.CANCELLED, jobs.get("t", id).state());
    assertThrows(EngineJobs.Rejected.class, () -> jobs.submit("t", work));
  }

  @Test void checkpointDoesNothingWithoutAJobAndThrowsInsideACancelledOne() {
    assertNull(Cancellation.current());
    Cancellation.checkpoint();
    Cancellation.Token token = new Cancellation.Token();
    try (Cancellation.Scope scope = Cancellation.bind(token)) {
      Cancellation.checkpoint();
      assertEquals(1, token.checkpoints());
      token.cancel("first");
      token.cancel("second");
      assertEquals("first", token.reason());
      assertTrue(Cancellation.isCancelled());
      assertThrows(Cancellation.Cancelled.class, Cancellation::checkpoint);
    }
    assertNull(Cancellation.current());
    Cancellation.checkpoint();
  }

  @Test void interruptedThreadsAreTreatedAsCancelled() {
    Cancellation.Token token = new Cancellation.Token();
    try (Cancellation.Scope scope = Cancellation.bind(token)) {
      Thread.currentThread().interrupt();
      assertThrows(Cancellation.Cancelled.class, Cancellation::checkpoint);
      assertEquals("interrupted", token.reason());
    } finally {
      Thread.interrupted();
    }
  }

  @Test void limitsComeFromTheEnvironmentAndMalformedValuesAreStartupErrors() {
    EngineJobs.Settings defaults = EngineJobs.Settings.fromEnvironment(new HashMap<String, String>());
    assertEquals(2, defaults.maxConcurrent());
    assertEquals(16, defaults.maxQueued());
    assertEquals(900000L, defaults.terminalTtlMs());
    assertEquals(5000L, defaults.stopGraceMs());

    Map<String, String> env = new HashMap<String, String>();
    env.put("ENGINE_JOB_MAX_CONCURRENT", "3");
    env.put("ENGINE_JOB_MAX_QUEUED", "5");
    env.put("ENGINE_JOB_TTL_SECONDS", "60");
    env.put("ENGINE_JOB_STOP_GRACE_MS", "250");
    EngineJobs.Settings custom = EngineJobs.Settings.fromEnvironment(env);
    assertEquals(3, custom.maxConcurrent());
    assertEquals(5, custom.maxQueued());
    assertEquals(60000L, custom.terminalTtlMs());
    assertEquals(250L, custom.stopGraceMs());

    for (String name : new String[] {"ENGINE_JOB_MAX_CONCURRENT", "ENGINE_JOB_MAX_QUEUED",
        "ENGINE_JOB_MAX_RETAINED", "ENGINE_JOB_TTL_SECONDS", "ENGINE_JOB_STOP_GRACE_MS"}) {
      for (String bad : new String[] {"abc", "-1", "0.5", "99999999999"}) {
        Map<String, String> broken = new HashMap<String, String>();
        broken.put(name, bad);
        assertThrows(IllegalStateException.class, () -> EngineJobs.Settings.fromEnvironment(broken),
            name + "=" + bad);
      }
    }
    Map<String, String> tooFewRetained = new HashMap<String, String>();
    tooFewRetained.put("ENGINE_JOB_MAX_RETAINED", "3");
    assertThrows(IllegalStateException.class, () -> EngineJobs.Settings.fromEnvironment(tooFewRetained));
  }
}
