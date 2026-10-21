package es.us.isa.openbinding.core;

import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongSupplier;

/**
 * In-memory asynchronous jobs for the JVM engines (opt-in, {@code ENGINE_JOB_MODE=async}).
 *
 * <p>A job is one attempt: a submitted request gets a random UUID, runs on a bounded pool and can be
 * read or cancelled by the tenant that submitted it.  Nothing is persisted: after a restart every id
 * answers "not found", and a client has to submit again (there is no exactly-once delivery).</p>
 *
 * <p>States: {@code queued -> running -> completed | failed}, and {@code cancelling -> cancelled}
 * once a cancel was requested.  Terminal states never change.  {@code cancelled} is only ever set
 * after the job's work can no longer run: the solver thread has returned from the work (or the job
 * was removed from the queue before it started).  A solver that does not honour the cancel request
 * leaves the job {@code cancelling}; it is never reported as cancelled while it is still running.
 * If a cancel is recorded first, a result that arrives afterwards is discarded.</p>
 */
public final class EngineJobs {
  /** The solving work of one job: returns the {@code BindingResult} JSON. */
  public interface Work {
    String run();
  }

  /** Raised by {@link #submit} when the engine cannot take another job. */
  public static final class Rejected extends RuntimeException {
    private static final long serialVersionUID = 1L;
    public Rejected(String message) { super(message); }
  }

  public enum State {
    QUEUED("queued"), RUNNING("running"), CANCELLING("cancelling"),
    COMPLETED("completed"), FAILED("failed"), CANCELLED("cancelled");

    private final String wire;
    State(String wire) { this.wire = wire; }
    public String wire() { return wire; }
    public boolean terminal() { return this == COMPLETED || this == FAILED || this == CANCELLED; }
  }

  /** Limits and timings; all of them bounded so the engine cannot be exhausted by clients. */
  public static final class Settings {
    private final int maxConcurrent;
    private final int maxQueued;
    private final int maxRetained;
    private final long terminalTtlMs;
    private final long stopGraceMs;

    public Settings(int maxConcurrent, int maxQueued, int maxRetained, long terminalTtlMs, long stopGraceMs) {
      if (maxConcurrent < 1 || maxQueued < 0 || maxRetained < maxConcurrent + maxQueued
          || terminalTtlMs < 1 || stopGraceMs < 0) {
        throw new IllegalArgumentException("Invalid engine job limits");
      }
      this.maxConcurrent = maxConcurrent;
      this.maxQueued = maxQueued;
      this.maxRetained = maxRetained;
      this.terminalTtlMs = terminalTtlMs;
      this.stopGraceMs = stopGraceMs;
    }

    public static Settings defaults() { return new Settings(2, 16, 1024, 900000L, 5000L); }

    /**
     * Reads {@code ENGINE_JOB_MAX_CONCURRENT}, {@code ENGINE_JOB_MAX_QUEUED},
     * {@code ENGINE_JOB_MAX_RETAINED}, {@code ENGINE_JOB_TTL_SECONDS} and
     * {@code ENGINE_JOB_STOP_GRACE_MS}.  A malformed value is a startup error, never a silent default.
     */
    public static Settings fromEnvironment(Map<String, String> env) {
      int concurrent = bounded(env, "ENGINE_JOB_MAX_CONCURRENT", 2, 1, 64);
      int queued = bounded(env, "ENGINE_JOB_MAX_QUEUED", 16, 0, 4096);
      int retained = bounded(env, "ENGINE_JOB_MAX_RETAINED", 1024, 1, 100000);
      long ttlSeconds = bounded(env, "ENGINE_JOB_TTL_SECONDS", 900, 1, 604800);
      long graceMs = bounded(env, "ENGINE_JOB_STOP_GRACE_MS", 5000, 0, 600000);
      if (retained < concurrent + queued) {
        throw new IllegalStateException("ENGINE_JOB_MAX_RETAINED must be at least "
            + "ENGINE_JOB_MAX_CONCURRENT + ENGINE_JOB_MAX_QUEUED");
      }
      return new Settings(concurrent, queued, retained, ttlSeconds * 1000L, graceMs);
    }

    public int maxConcurrent() { return maxConcurrent; }
    public int maxQueued() { return maxQueued; }
    public int maxRetained() { return maxRetained; }
    public long terminalTtlMs() { return terminalTtlMs; }
    public long stopGraceMs() { return stopGraceMs; }

    private static int bounded(Map<String, String> env, String name, int fallback, int min, int max) {
      String raw = env.get(name);
      if (raw == null || raw.isEmpty()) return fallback;
      try {
        long value = Long.parseLong(raw.trim());
        if (value < min || value > max) throw new NumberFormatException();
        return (int) value;
      } catch (NumberFormatException exception) {
        throw new IllegalStateException(name + " must be an integer in [" + min + "," + max + "]");
      }
    }
  }

  /** An immutable view of a job at one instant. */
  public static final class Snapshot {
    private final String id;
    private final State state;
    private final long createdAtSeconds;
    private final String result;
    private final String error;
    private final String cancelReason;

    Snapshot(String id, State state, long createdAtSeconds, String result, String error, String cancelReason) {
      this.id = id;
      this.state = state;
      this.createdAtSeconds = createdAtSeconds;
      this.result = result;
      this.error = error;
      this.cancelReason = cancelReason;
    }

    public String id() { return id; }
    public State state() { return state; }
    public long createdAtSeconds() { return createdAtSeconds; }
    /** The {@code BindingResult} JSON of a completed job, otherwise {@code null}. */
    public String result() { return result; }
    /** The failure of a failed job, otherwise {@code null}. */
    public String error() { return error; }
    /** Why the job was cancelled, once a cancel was requested. */
    public String cancelReason() { return cancelReason; }
  }

  /** What a cancel request found. {@link #stopped()} means the solver is confirmed stopped. */
  public static final class CancelOutcome {
    private final Snapshot snapshot;
    CancelOutcome(Snapshot snapshot) { this.snapshot = snapshot; }
    public Snapshot snapshot() { return snapshot; }
    public boolean stopped() { return snapshot.state().terminal(); }
  }

  private static final class Job implements Runnable {
    final EngineJobs owner;
    final String id;
    final String tenant;
    final long createdAtMs;
    final Cancellation.Token token = new Cancellation.Token();
    /** Counted down once the work can no longer run: after the state is final. */
    final CountDownLatch stopped = new CountDownLatch(1);

    // Everything below is guarded by 'this'.  The work (and the request it holds) is dropped as
    // soon as the job is final so that retained jobs only keep their result.
    Work work;
    State state = State.QUEUED;
    boolean cancelRequested;
    String cancelReason;
    String result;
    String error;
    long finishedAtMs;
    Thread runner;

    Job(EngineJobs owner, String id, String tenant, long createdAtMs, Work work) {
      this.owner = owner;
      this.id = id;
      this.tenant = tenant;
      this.createdAtMs = createdAtMs;
      this.work = work;
    }

    @Override public void run() { owner.execute(this); }
  }

  private final Settings settings;
  private final LongSupplier clock;
  private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<String, Job>();
  private final Semaphore admission;
  private final ThreadPoolExecutor executor;
  private volatile boolean closed;

  public EngineJobs(Settings settings) { this(settings, new LongSupplier() {
    @Override public long getAsLong() { return System.currentTimeMillis(); }
  }); }

  EngineJobs(Settings settings, LongSupplier clock) {
    this.settings = settings;
    this.clock = clock;
    this.admission = new Semaphore(settings.maxConcurrent() + settings.maxQueued());
    final AtomicInteger counter = new AtomicInteger();
    this.executor = new ThreadPoolExecutor(settings.maxConcurrent(), settings.maxConcurrent(),
        0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<Runnable>(Math.max(1, settings.maxQueued())),
        new ThreadFactory() {
          @Override public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "engine-job-" + counter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
          }
        });
  }

  public Settings settings() { return settings; }

  /** Accepts a job for {@code tenant}.  The returned snapshot is {@code queued}. */
  public Snapshot submit(String tenant, Work work) {
    if (tenant == null || work == null) throw new IllegalArgumentException("tenant and work are required");
    if (closed) throw new Rejected("The engine is shutting down");
    sweep();
    if (!admission.tryAcquire()) throw new Rejected("The engine is at capacity; retry later");
    Job job = null;
    boolean queued = false;
    try {
      if (jobs.size() >= settings.maxRetained()) throw new Rejected("The engine retains too many jobs; retry later");
      do {
        job = new Job(this, UUID.randomUUID().toString(), tenant, clock.getAsLong(), work);
      } while (jobs.putIfAbsent(job.id, job) != null);
      Snapshot accepted = snapshot(job);
      executor.execute(job);
      queued = true;
      return accepted;
    } catch (RejectedExecutionException exception) {
      throw new Rejected("The engine is at capacity; retry later");
    } finally {
      if (!queued) {
        if (job != null) jobs.remove(job.id);
        admission.release();
      }
    }
  }

  /** The job, or {@code null} when it does not exist, expired or belongs to another tenant. */
  public Snapshot get(String tenant, String id) {
    sweep();
    Job job = owned(tenant, id);
    return job == null ? null : snapshot(job);
  }

  /**
   * Asks the job to stop and waits up to the stop grace for the solver to confirm.  Returns
   * {@code null} for an unknown, expired or foreign id.  Idempotent: a repeated request, or a request
   * for a job that already finished, only reports its state.
   */
  public CancelOutcome cancel(String tenant, String id) {
    sweep();
    Job job = owned(tenant, id);
    if (job == null) return null;
    boolean removedFromQueue = false;
    boolean wait;
    synchronized (job) {
      if (!job.state.terminal() && !job.cancelRequested) {
        job.cancelRequested = true;
        job.cancelReason = "requested by DELETE";
        job.token.cancel(job.cancelReason);
        if (job.state == State.QUEUED && executor.remove(job)) {
          // Never started and never will: nothing is running on its behalf.
          job.state = State.CANCELLED;
          job.work = null;
          job.finishedAtMs = clock.getAsLong();
          removedFromQueue = true;
        } else {
          job.state = State.CANCELLING;
          if (job.runner != null) job.runner.interrupt();
        }
      }
      wait = !job.state.terminal();
    }
    if (removedFromQueue) {
      admission.release();
      job.stopped.countDown();
    } else if (wait) {
      try {
        job.stopped.await(settings.stopGraceMs(), TimeUnit.MILLISECONDS);
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
      }
    }
    return new CancelOutcome(snapshot(job));
  }

  /** Jobs that are queued, running or cancelling. */
  public int active() {
    int count = 0;
    for (Job job : jobs.values()) {
      synchronized (job) { if (!job.state.terminal()) count++; }
    }
    return count;
  }

  /** Number of jobs held in memory, terminal ones included. */
  public int retained() { return jobs.size(); }

  /** Cancels every live job and stops the pool. */
  public void close() {
    closed = true;
    for (Job job : jobs.values()) {
      synchronized (job) {
        if (!job.state.terminal() && !job.cancelRequested) {
          job.cancelRequested = true;
          job.cancelReason = "engine shutdown";
          job.token.cancel(job.cancelReason);
        }
      }
    }
    executor.shutdownNow();
    try {
      executor.awaitTermination(settings.stopGraceMs(), TimeUnit.MILLISECONDS);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
    }
  }

  private void execute(Job job) {
    boolean start;
    Work work;
    synchronized (job) {
      start = job.state == State.QUEUED && !job.cancelRequested;
      work = job.work;
      if (start) {
        job.state = State.RUNNING;
        job.runner = Thread.currentThread();
      }
    }
    String result = null;
    Throwable failure = null;
    if (start) {
      Cancellation.Scope scope = Cancellation.bind(job.token);
      try {
        result = work.run();
      } catch (Cancellation.Cancelled cancelled) {
        // Outcome is decided below from the recorded request, not from this exception.
      } catch (Throwable throwable) {
        failure = throwable;
      } finally {
        scope.close();
      }
    }
    work = null;
    synchronized (job) {
      job.runner = null;
      job.work = null;
      if (!job.state.terminal()) {
        if (job.cancelRequested) {
          // Whatever the solver produced after the cancel was recorded is discarded.
          job.state = State.CANCELLED;
        } else if (failure != null) {
          job.state = State.FAILED;
          job.error = failureMessage(failure);
        } else if (result == null) {
          job.state = State.FAILED;
          job.error = job.token.isCancelled() ? "Engine execution interrupted" : "Engine produced no result";
        } else {
          job.state = State.COMPLETED;
          job.result = result;
        }
        job.finishedAtMs = clock.getAsLong();
      }
    }
    // An interrupt that raced with the end of the work must not leak into the pooled thread.
    Thread.interrupted();
    admission.release();
    job.stopped.countDown();
  }

  private static String failureMessage(Throwable failure) {
    String message = failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
    return failure instanceof IllegalArgumentException ? message : "Engine execution failed: " + message;
  }

  private Job owned(String tenant, String id) {
    if (tenant == null || id == null) return null;
    Job job = jobs.get(id);
    // A foreign id is indistinguishable from an unknown one.
    return job != null && job.tenant.equals(tenant) ? job : null;
  }

  private static Snapshot snapshot(Job job) {
    synchronized (job) {
      return new Snapshot(job.id, job.state, job.createdAtMs / 1000L, job.result, job.error, job.cancelReason);
    }
  }

  private void sweep() {
    long now = clock.getAsLong();
    for (Iterator<Job> iterator = jobs.values().iterator(); iterator.hasNext(); ) {
      Job job = iterator.next();
      synchronized (job) {
        if (job.state.terminal() && now - job.finishedAtMs >= settings.terminalTtlMs()) iterator.remove();
      }
    }
  }
}
