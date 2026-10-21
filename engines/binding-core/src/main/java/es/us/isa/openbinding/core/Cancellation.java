package es.us.isa.openbinding.core;

import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Cooperative cancellation for the JVM engines.
 *
 * <p>A search loop calls {@link #checkpoint()} once per iteration (and the evaluator once per
 * evaluation).  When no {@link Token} is bound to the calling thread, which is every synchronous
 * request and every library caller, the call does nothing, so the synchronous mode keeps its exact
 * behaviour.  When {@link EngineJobs} runs a job it binds the job's token to the solver thread; a
 * cancel request then makes the next checkpoint throw {@link Cancelled}, which unwinds the solver
 * and ends the thread's work.</p>
 *
 * <p>This is cooperative: a solver that stops calling {@code checkpoint()} cannot be stopped, and the
 * job stays {@code cancelling} instead of being reported as cancelled.</p>
 */
public final class Cancellation {
  private static final ThreadLocal<Token> CURRENT = new ThreadLocal<Token>();
  private static final AtomicLong TOTAL_CHECKPOINTS = new AtomicLong();

  private Cancellation() {}

  /** Thrown by {@link #checkpoint()} on a thread whose token was cancelled. */
  public static final class Cancelled extends RuntimeException {
    private static final long serialVersionUID = 1L;

    Cancelled(String reason) {
      // Control flow, not an error: no stack trace and no suppression.
      super(reason, null, false, false);
    }
  }

  /** The cancellation state of one job. */
  public static final class Token {
    private final AtomicReference<String> reason = new AtomicReference<String>();
    private final AtomicLong checkpoints = new AtomicLong();

    /** Requests cancellation.  The first reason wins; later calls change nothing. */
    public void cancel(String why) {
      reason.compareAndSet(null, why == null || why.isEmpty() ? "cancelled" : why);
    }

    public boolean isCancelled() { return reason.get() != null; }
    public String reason() { return reason.get(); }

    /** Number of checkpoints the bound solver thread has passed. */
    public long checkpoints() { return checkpoints.get(); }
  }

  /** Binding of a token to the current thread; {@link #close()} restores the previous one. */
  public static final class Scope implements AutoCloseable {
    private final Token previous;
    private boolean closed;

    Scope(Token previous) { this.previous = previous; }

    @Override public void close() {
      if (closed) return;
      closed = true;
      if (previous == null) CURRENT.remove();
      else CURRENT.set(previous);
    }
  }

  /** Binds {@code token} to the calling thread until the returned scope is closed. */
  public static Scope bind(Token token) {
    if (token == null) throw new IllegalArgumentException("A cancellation token is required");
    Token previous = CURRENT.get();
    CURRENT.set(token);
    return new Scope(previous);
  }

  /** The token bound to the calling thread, or {@code null} outside a job. */
  public static Token current() { return CURRENT.get(); }

  /** Whether the calling thread's job was asked to stop.  Never throws. */
  public static boolean isCancelled() {
    Token token = CURRENT.get();
    return token != null && token.isCancelled();
  }

  /**
   * Cheap cancellation point for solver loops.  Throws {@link Cancelled} when the job bound to this
   * thread was cancelled or the thread was interrupted; does nothing when no job is bound.
   */
  public static void checkpoint() {
    Token token = CURRENT.get();
    if (token == null) return;
    token.checkpoints.incrementAndGet();
    TOTAL_CHECKPOINTS.incrementAndGet();
    if (Thread.currentThread().isInterrupted()) token.cancel("interrupted");
    String why = token.reason.get();
    if (why != null) throw new Cancelled(why);
  }

  /**
   * Checkpoints passed by every job thread since the JVM started.  A diagnostic: while a solver is
   * running it grows, and once the solver has stopped it stops growing.
   */
  public static long totalCheckpoints() { return TOTAL_CHECKPOINTS.get(); }
}
