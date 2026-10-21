import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Job life cycle of the engine.
 *
 *   queued ──> running ──> completed | failed
 *      │          │
 *      │          └──> cancelling ──> cancelled | failed
 *      └──────────────> cancelled
 *
 * `completed`, `failed` and `cancelled` are terminal and immutable: a late result of the
 * work (or a late timer) never reopens or overwrites them. `cancelled` is only ever set
 * once the work has settled, i.e. once the solver process is reaped; abandoning the HTTP
 * connection or merely signalling the process is not a cancellation.
 */
export type JobStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['completed', 'failed', 'cancelled']);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Owner of every job when `ENGINE_AUTH_TOKENS` is not configured (the documented open mode). */
export const ANONYMOUS_TENANT = '*';

export interface Job {
  id: string;
  owner: string;
  status: JobStatus;
  result?: any;
  error?: string;
  /** Why the job ended as `cancelled`. */
  reason?: string;
  created_at: number;
  started_at?: number;
  finished_at?: number;
  cancel_requested_at?: number;
}

/** The work of a job. It must stop (and release every resource) when `signal` aborts. */
export type JobWork = (signal: AbortSignal) => Promise<any>;

/** The work stopped because its signal aborted and everything it started is gone. */
export class AbortedError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** The work was asked to stop and could not prove that its process is gone. */
export class NotTerminatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotTerminatedError';
  }
}

export class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueFullError';
  }
}

export type CancelOutcome =
  | { kind: 'not_found' }
  | { kind: 'final'; job: Job }
  | { kind: 'pending'; job: Job };

export interface JobManagerOptions {
  /** Jobs that run at once (semaphore). */
  maxConcurrent?: number;
  /** Jobs allowed to wait for a slot; a submission beyond it is refused. */
  maxQueued?: number;
  /** How long a terminal job stays readable. */
  ttlMs?: number;
  /** Cap on retained terminal jobs, oldest first. */
  maxRetained?: number;
  /** How long one DELETE waits for the work to stop before answering `cancelling`. */
  cancelWaitMs?: number;
  /** After this long a cancellation (or timeout) that has not stopped the work makes the job `failed`. */
  cancelDeadlineMs?: number;
  now?: () => number;
  newId?: () => string;
}

interface Entry {
  job: Job;
  work: JobWork;
  controller: AbortController;
  timeoutMs?: number;
  timedOut: boolean;
  timer?: NodeJS.Timeout;
  backstop?: NodeJS.Timeout;
  settled: Promise<void>;
  resolveSettled: () => void;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function messageOf(error: unknown): string {
  return String((error as any)?.message || error);
}

/** Resolves `true` when `promise` settles first, `false` when `ms` elapse. The timer never outlives the wait. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

export class JobManager {
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: Entry[] = [];
  private active = 0;
  private closed = false;
  private readonly sweeper?: NodeJS.Timeout;

  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly ttlMs: number;
  private readonly maxRetained: number;
  private readonly cancelWaitMs: number;
  private readonly cancelDeadlineMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: JobManagerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.maxQueued = Math.max(0, options.maxQueued ?? 64);
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.maxRetained = Math.max(1, options.maxRetained ?? 1000);
    this.cancelWaitMs = options.cancelWaitMs ?? 2500;
    this.cancelDeadlineMs = options.cancelDeadlineMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    if (Number.isFinite(this.ttlMs)) {
      this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(60_000, this.ttlMs / 4)));
      this.sweeper.unref();
    }
  }

  /**
   * Accepts a job and starts it when a slot is free. Every submission is a new job with a new
   * unguessable id: the engine does not deduplicate by `X-Openbinding-Job-Id`, so a resubmission
   * of a cancelled job is a different job and the cancelled one is never reopened.
   */
  submit(owner: string, work: JobWork, options: { timeoutMs?: number } = {}): Job {
    if (this.closed) throw new QueueFullError('engine is shutting down');
    this.sweep();
    if (this.active >= this.maxConcurrent && this.waiting.length >= this.maxQueued) {
      throw new QueueFullError(`engine queue is full (${this.maxQueued} waiting)`);
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const entry: Entry = {
      job: { id: this.newId(), owner, status: 'queued', created_at: this.now() },
      work,
      controller: new AbortController(),
      timeoutMs: options.timeoutMs,
      timedOut: false,
      settled,
      resolveSettled,
    };
    this.entries.set(entry.job.id, entry);
    this.waiting.push(entry);
    this.pump();
    return { ...entry.job };
  }

  /** A copy of the job, or `undefined` if it does not exist OR belongs to another tenant (indistinguishable). */
  get(id: string, owner: string): Job | undefined {
    this.sweep();
    const entry = this.lookup(id, owner);
    return entry ? { ...entry.job } : undefined;
  }

  /**
   * Cancels a job. Idempotent: a terminal job is returned as it is. A queued job leaves the queue
   * without running. A running job is aborted and the answer waits (bounded) for the work to
   * settle; only then is it `cancelled`. If it does not settle in time the job stays `cancelling`
   * (`pending`) and later becomes `cancelled` or, past the deadline, `failed` with the reason.
   */
  async cancel(id: string, owner: string, reason = 'cancelled by request'): Promise<CancelOutcome> {
    this.sweep();
    const entry = this.lookup(id, owner);
    if (!entry) return { kind: 'not_found' };
    const job = entry.job;
    if (isTerminal(job.status)) return { kind: 'final', job: { ...job } };
    if (job.status === 'queued') {
      const position = this.waiting.indexOf(entry);
      if (position >= 0) this.waiting.splice(position, 1);
      this.finish(job, 'cancelled', { reason: `${reason} before it started` });
      entry.resolveSettled();
      return { kind: 'final', job: { ...job } };
    }
    if (job.status === 'running') {
      job.status = 'cancelling';
      job.reason = reason;
      job.cancel_requested_at = this.now();
      this.armBackstop(entry, `cancel did not stop the work within ${this.cancelDeadlineMs} ms`);
      entry.controller.abort(new AbortedError(reason));
    }
    await settlesWithin(entry.settled, this.cancelWaitMs);
    return isTerminal(job.status)
      ? { kind: 'final', job: { ...job } }
      : { kind: 'pending', job: { ...job } };
  }

  /** Stops accepting work, cancels what is queued and aborts what runs, waiting (bounded) for it to stop. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const entry of this.waiting.splice(0)) {
      this.finish(entry.job, 'cancelled', { reason: 'engine shutting down' });
      entry.resolveSettled();
    }
    const stopping: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      const job = entry.job;
      if (job.status === 'running') {
        job.status = 'cancelling';
        job.reason = 'engine shutting down';
        job.cancel_requested_at = this.now();
        entry.controller.abort(new AbortedError('engine shutting down'));
      }
      if (job.status === 'cancelling') stopping.push(entry.settled);
    }
    if (stopping.length > 0) await settlesWithin(Promise.all(stopping), this.cancelDeadlineMs);
  }

  /** Counters for tests and diagnostics. */
  stats(): { active: number; waiting: number; retained: number } {
    return { active: this.active, waiting: this.waiting.length, retained: this.entries.size };
  }

  private lookup(id: string, owner: string): Entry | undefined {
    const entry = this.entries.get(id);
    return entry && entry.job.owner === owner ? entry : undefined;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.waiting.length > 0) {
      this.start(this.waiting.shift()!);
    }
  }

  private start(entry: Entry): void {
    const job = entry.job;
    job.status = 'running';
    job.started_at = this.now();
    this.active += 1;
    if (entry.timeoutMs !== undefined && entry.timeoutMs > 0) {
      entry.timer = setTimeout(() => this.expire(entry), entry.timeoutMs);
    }
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(entry.work(entry.controller.signal));
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      (value) => this.settle(entry, { ok: true, value }),
      (error) => this.settle(entry, { ok: false, error }),
    );
  }

  private expire(entry: Entry): void {
    if (entry.job.status !== 'running') return;
    entry.timedOut = true;
    this.armBackstop(entry, `execution timeout after ${entry.timeoutMs} ms and the work did not stop within ${this.cancelDeadlineMs} ms`);
    entry.controller.abort(new AbortedError(`execution timeout after ${entry.timeoutMs} ms`));
  }

  private armBackstop(entry: Entry, reason: string): void {
    if (entry.backstop) return;
    entry.backstop = setTimeout(() => this.finish(entry.job, 'failed', { error: reason }), this.cancelDeadlineMs);
  }

  private settle(entry: Entry, outcome: Outcome): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.backstop) clearTimeout(entry.backstop);
    this.active -= 1;
    const job = entry.job;
    const notTerminated = !outcome.ok && outcome.error instanceof NotTerminatedError;
    if (isTerminal(job.status)) {
      // Immutable: a late result never reopens or overwrites a terminal job.
    } else if (job.status === 'cancelling') {
      // Once a cancellation was accepted its only outcomes are cancelled (the work stopped, whatever
      // it returned is discarded) or failed (it could not be proven stopped).
      if (notTerminated) this.finish(job, 'failed', { error: `cancel failed: ${messageOf((outcome as any).error)}` });
      else this.finish(job, 'cancelled', { reason: job.reason ?? 'cancelled by request' });
    } else if (entry.timedOut) {
      this.finish(job, 'failed', {
        error: notTerminated
          ? `execution timeout after ${entry.timeoutMs} ms; ${messageOf((outcome as any).error)}`
          : `execution timeout after ${entry.timeoutMs} ms`,
      });
    } else if (outcome.ok) {
      this.finish(job, 'completed', { result: outcome.value });
    } else {
      this.finish(job, 'failed', { error: messageOf(outcome.error) });
    }
    entry.resolveSettled();
    this.pump();
  }

  private finish(job: Job, status: 'completed' | 'failed' | 'cancelled', fields: Partial<Job>): void {
    if (isTerminal(job.status)) return;
    Object.assign(job, fields);
    job.status = status;
    job.finished_at = this.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      const job = entry.job;
      if (isTerminal(job.status) && now - (job.finished_at ?? job.created_at) >= this.ttlMs) {
        this.entries.delete(id);
      }
    }
    if (this.entries.size > this.maxRetained) {
      for (const [id, entry] of this.entries) {
        if (this.entries.size <= this.maxRetained) break;
        if (isTerminal(entry.job.status)) this.entries.delete(id);
      }
    }
  }
}

/**
 * The job as `bim-engine/v1` (`EngineJob`) knows it: states are queued|running|completed|failed, with
 * exactly the fields of each. `cancelling` is still `running`, and `cancelled` is a `failed` job whose
 * error starts with `cancelled:`.
 */
export function projectJob(job: Job): Record<string, unknown> {
  const base = { id: job.id, created_at: job.created_at };
  switch (job.status) {
    case 'queued':
      return { ...base, status: 'queued' };
    case 'running':
    case 'cancelling':
      return { ...base, status: 'running' };
    case 'completed':
      return { ...base, status: 'completed', result: job.result };
    case 'cancelled':
      return { ...base, status: 'failed', error: `cancelled: ${job.reason ?? 'cancelled by request'}` };
    default:
      return { ...base, status: 'failed', error: job.error ?? 'failed' };
  }
}

/** Bearer tokens → tenants. Without configured tokens every caller is the anonymous tenant (open mode). */
export class TokenAuth {
  private readonly entries: Array<{ tenant: string; digest: Buffer }> = [];

  /** `spec` is `ENGINE_AUTH_TOKENS`: `tenant=token[,tenant=token...]`. A malformed value throws (never silently opens). */
  constructor(spec?: string) {
    const items = (spec ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    const seen = new Set<string>();
    items.forEach((item, position) => {
      const separator = item.indexOf('=');
      const tenant = separator > 0 ? item.slice(0, separator).trim() : '';
      const token = separator > 0 ? item.slice(separator + 1).trim() : '';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(tenant)) {
        throw new Error(`ENGINE_AUTH_TOKENS entry ${position + 1} needs a tenant name of 1-64 characters [A-Za-z0-9._-]`);
      }
      if (token.length < 16 || /\s/.test(token)) {
        throw new Error(`ENGINE_AUTH_TOKENS entry ${position + 1} needs a token of at least 16 characters without spaces`);
      }
      if (seen.has(token)) throw new Error(`ENGINE_AUTH_TOKENS entry ${position + 1} repeats a token`);
      seen.add(token);
      this.entries.push({ tenant, digest: createHash('sha256').update(token).digest() });
    });
  }

  get enabled(): boolean {
    return this.entries.length > 0;
  }

  /** The tenant of an `Authorization` header, or `null` when the caller is not recognised. */
  authenticate(header: string | undefined): string | null {
    if (!this.enabled) return ANONYMOUS_TENANT;
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!match) return null;
    const presented = createHash('sha256').update(match[1]).digest();
    let tenant: string | null = null;
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, presented)) tenant = entry.tenant;
    }
    return tenant;
  }
}

export function envInteger(
  env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min},${max}]`);
  }
  return value;
}

export function jobManagerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): JobManagerOptions {
  return {
    maxConcurrent: envInteger(env, 'ENGINE_MAX_CONCURRENCY', 2, 1, 64),
    maxQueued: envInteger(env, 'ENGINE_MAX_QUEUED', 64, 0, 10_000),
    ttlMs: envInteger(env, 'ENGINE_JOB_TTL_MS', 3_600_000, 1000, 7 * 24 * 3_600_000),
    cancelWaitMs: envInteger(env, 'ENGINE_CANCEL_WAIT_MS', 2500, 0, 60_000),
    cancelDeadlineMs: envInteger(env, 'ENGINE_CANCEL_DEADLINE_MS', 30_000, 1000, 600_000),
  };
}
