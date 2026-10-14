import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AbortedError, ANONYMOUS_TENANT, Job, JobManager, JobWork, NotTerminatedError, QueueFullError, TokenAuth,
  envInteger, projectJob,
} from './job_manager';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Work that stops (rejecting with AbortedError) as soon as it is aborted, like the MiniZinc runner. */
function cooperative() {
  const finished = deferred<any>();
  let calls = 0;
  let aborted = false;
  const work: JobWork = (signal) => {
    calls += 1;
    signal.addEventListener('abort', () => {
      aborted = true;
      finished.reject(new AbortedError('stopped'));
    }, { once: true });
    return finished.promise;
  };
  return { work, finish: finished.resolve, crash: finished.reject, calls: () => calls, aborted: () => aborted };
}

/** Work that notices the abort but keeps running until it is released, then resolves with a value. */
function stubborn() {
  const gate = deferred<any>();
  let aborted = false;
  const work: JobWork = (signal) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return gate.promise;
  };
  return { work, release: gate.resolve, reject: gate.reject, aborted: () => aborted };
}

function status(manager: JobManager, id: string, owner = 'a'): string | undefined {
  return manager.get(id, owner)?.status;
}

describe('job manager: identity and ownership', () => {
  it('hands out random UUIDs, never guessable short ids', () => {
    const manager = new JobManager();
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const job = manager.submit('a', cooperative().work);
      assert.match(job.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      ids.add(job.id);
    }
    assert.equal(ids.size, 50);
    return manager.shutdown();
  });

  it('answers the same absence for an unknown id and for the job of another tenant', async () => {
    const manager = new JobManager();
    const job = manager.submit('a', cooperative().work);
    assert.equal(manager.get(job.id, 'b'), undefined);
    assert.equal(manager.get('00000000-0000-4000-8000-000000000000', 'a'), undefined);
    assert.deepEqual(await manager.cancel(job.id, 'b'), { kind: 'not_found' });
    assert.deepEqual(await manager.cancel('00000000-0000-4000-8000-000000000000', 'a'), { kind: 'not_found' });
    assert.equal(status(manager, job.id), 'running', 'the foreign cancel touched nothing');
    await manager.shutdown();
  });
});

describe('job manager: concurrency and queue', () => {
  it('runs at most maxConcurrent jobs and starts the next one when a slot frees', async () => {
    const manager = new JobManager({ maxConcurrent: 1, maxQueued: 5 });
    const first = cooperative();
    const second = cooperative();
    const a = manager.submit('a', first.work);
    const b = manager.submit('a', second.work);
    assert.equal(status(manager, a.id), 'running');
    assert.equal(status(manager, b.id), 'queued');
    assert.equal(second.calls(), 0);
    first.finish('one');
    await tick();
    assert.equal(status(manager, a.id), 'completed');
    assert.equal(status(manager, b.id), 'running');
    assert.equal(second.calls(), 1);
    second.finish('two');
    await tick();
    assert.equal(manager.get(b.id, 'a')?.result, 'two');
    await manager.shutdown();
  });

  it('refuses a submission when the queue is full', async () => {
    const manager = new JobManager({ maxConcurrent: 1, maxQueued: 1 });
    manager.submit('a', cooperative().work);
    manager.submit('a', cooperative().work);
    assert.throws(() => manager.submit('a', cooperative().work), QueueFullError);
    await manager.shutdown();
  });
});

describe('job manager: cancellation', () => {
  it('takes a queued job out of the queue without ever running it', async () => {
    const manager = new JobManager({ maxConcurrent: 1 });
    const running = cooperative();
    const queued = cooperative();
    manager.submit('a', running.work);
    const job = manager.submit('a', queued.work);
    const outcome = await manager.cancel(job.id, 'a');
    assert.equal(outcome.kind, 'final');
    assert.equal(status(manager, job.id), 'cancelled');
    assert.equal(queued.calls(), 0, 'the work of a job cancelled in the queue never starts');
    running.finish('x');
    await tick();
    assert.equal(queued.calls(), 0, 'and it does not start when the slot frees');
    assert.equal(status(manager, job.id), 'cancelled');
    await manager.shutdown();
  });

  it('aborts a running job and reports cancelled only after the work has stopped', async () => {
    const manager = new JobManager();
    const work = cooperative();
    const job = manager.submit('a', work.work);
    const outcome = await manager.cancel(job.id, 'a');
    assert.equal(work.aborted(), true);
    assert.equal(outcome.kind, 'final');
    assert.equal(status(manager, job.id), 'cancelled');
    assert.equal(manager.get(job.id, 'a')?.finished_at !== undefined, true);
    await manager.shutdown();
  });

  it('is idempotent: repeating a cancel changes nothing and a terminal job stays as it is', async () => {
    const manager = new JobManager();
    const job = manager.submit('a', cooperative().work);
    const first = await manager.cancel(job.id, 'a');
    const finishedAt = manager.get(job.id, 'a')?.finished_at;
    const second = await manager.cancel(job.id, 'a');
    assert.deepEqual(first, second);
    assert.equal(manager.get(job.id, 'a')?.finished_at, finishedAt);

    const done = cooperative();
    const completed = manager.submit('a', done.work);
    done.finish('value');
    await tick();
    const outcome = await manager.cancel(completed.id, 'a');
    assert.equal(outcome.kind, 'final');
    assert.equal((outcome as { job: Job }).job.status, 'completed');
    assert.equal(done.aborted(), false, 'a finished job is not aborted');
    await manager.shutdown();
  });

  it('keeps cancelling while the work has not stopped and answers pending', async () => {
    const manager = new JobManager({ cancelWaitMs: 20, cancelDeadlineMs: 5000 });
    const work = stubborn();
    const job = manager.submit('a', work.work);
    const outcome = await manager.cancel(job.id, 'a');
    assert.equal(outcome.kind, 'pending');
    assert.equal(status(manager, job.id), 'cancelling');
    assert.equal(work.aborted(), true);
    const again = await manager.cancel(job.id, 'a');
    assert.equal(again.kind, 'pending', 'repeating it does not invent progress');
    work.release('late');
    await tick();
    assert.equal(status(manager, job.id), 'cancelled');
    await manager.shutdown();
  });

  it('discards the late result of a cancelled job: it is never reopened or overwritten', async () => {
    const manager = new JobManager({ cancelWaitMs: 5 });
    const work = stubborn();
    const job = manager.submit('a', work.work);
    await manager.cancel(job.id, 'a');
    work.release({ termination: 'OPTIMAL' });
    await tick();
    const read = manager.get(job.id, 'a')!;
    assert.equal(read.status, 'cancelled');
    assert.equal(read.result, undefined);
    assert.deepEqual(projectJob(read).status, 'failed');
    await manager.shutdown();
  });

  it('ends as failed with the reason when the process could not be proven gone', async () => {
    const manager = new JobManager({ cancelWaitMs: 1000 });
    const work = stubborn();
    const job = manager.submit('a', work.work);
    const pending = manager.cancel(job.id, 'a');
    work.reject(new NotTerminatedError('solver process group 1 is still alive'));
    const outcome = await pending;
    const read = manager.get(job.id, 'a')!;
    assert.equal(outcome.kind, 'final');
    assert.equal(read.status, 'failed');
    assert.match(read.error!, /cancel failed: solver process group 1 is still alive/);
    await manager.shutdown();
  });

  it('gives up honestly when the work never settles, and the late settle does not reopen the job', async () => {
    const manager = new JobManager({ cancelWaitMs: 5, cancelDeadlineMs: 40 });
    const work = stubborn();
    const job = manager.submit('a', work.work);
    await manager.cancel(job.id, 'a');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const read = manager.get(job.id, 'a')!;
    assert.equal(read.status, 'failed');
    assert.match(read.error!, /cancel did not stop the work within 40 ms/);
    work.release('very late');
    await tick();
    assert.equal(manager.get(job.id, 'a')!.status, 'failed');
    assert.equal(manager.get(job.id, 'a')!.result, undefined);
    await manager.shutdown();
  });

  it('race cancel vs finish: whichever transition comes first wins and the other changes nothing', async () => {
    const manager = new JobManager();
    // finish first
    const early = stubborn();
    const a = manager.submit('a', early.work);
    early.release('done');
    await tick();
    assert.equal((await manager.cancel(a.id, 'a')).kind, 'final');
    assert.equal(status(manager, a.id), 'completed');
    assert.equal(early.aborted(), false);
    // cancel first, then the work resolves in the same turn
    const late = stubborn();
    const b = manager.submit('a', late.work);
    const cancelling = manager.cancel(b.id, 'a');
    late.release('done');
    const outcome = await cancelling;
    assert.equal(outcome.kind, 'final');
    assert.equal(status(manager, b.id), 'cancelled');
    assert.equal(manager.get(b.id, 'a')!.result, undefined);
    await manager.shutdown();
  });

  it('race cancel vs start: a job that has just been accepted can be cancelled before it makes progress', async () => {
    const manager = new JobManager({ maxConcurrent: 1 });
    const blocker = cooperative();
    manager.submit('a', blocker.work);
    const waiting = cooperative();
    const job = manager.submit('a', waiting.work);
    const cancelling = manager.cancel(job.id, 'a');
    blocker.finish('x');
    await cancelling;
    await tick();
    assert.equal(waiting.calls(), 0);
    assert.equal(status(manager, job.id), 'cancelled');
    await manager.shutdown();
  });

  it('a resubmission is a new job: the cancelled one is not reopened and the old id never reaches the new one', async () => {
    const manager = new JobManager();
    const first = manager.submit('a', cooperative().work);
    await manager.cancel(first.id, 'a');
    const second = cooperative();
    const again = manager.submit('a', second.work);
    assert.notEqual(again.id, first.id);
    assert.equal(status(manager, first.id), 'cancelled');
    assert.equal(status(manager, again.id), 'running');
    await manager.cancel(first.id, 'a');
    assert.equal(second.aborted(), false, 'cancelling the old id leaves the new job alone');
    assert.equal(status(manager, again.id), 'running');
    await manager.shutdown();
  });

  it('aborts every running job and cancels the queued ones on shutdown', async () => {
    const manager = new JobManager({ maxConcurrent: 1 });
    const running = cooperative();
    const queued = cooperative();
    const a = manager.submit('a', running.work);
    const b = manager.submit('a', queued.work);
    await manager.shutdown();
    assert.equal(running.aborted(), true);
    assert.equal(queued.calls(), 0);
    assert.equal(status(manager, a.id), 'cancelled');
    assert.equal(status(manager, b.id), 'cancelled');
    assert.throws(() => manager.submit('a', cooperative().work), QueueFullError);
  });
});

describe('job manager: execution timeout and expiry', () => {
  it('aborts a job that runs past its timeout and marks it failed, not cancelled', async () => {
    const manager = new JobManager();
    const work = cooperative();
    const job = manager.submit('a', work.work, { timeoutMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const read = manager.get(job.id, 'a')!;
    assert.equal(work.aborted(), true);
    assert.equal(read.status, 'failed');
    assert.match(read.error!, /execution timeout after 30 ms/);
    await manager.shutdown();
  });

  it('expires terminal jobs after the TTL and never an active one', async () => {
    let now = 1_000_000;
    const manager = new JobManager({ ttlMs: 10_000, now: () => now });
    const done = cooperative();
    const finished = manager.submit('a', done.work);
    done.finish('v');
    await tick();
    const active = manager.submit('a', cooperative().work);
    now += 9_999;
    assert.equal(status(manager, finished.id), 'completed');
    now += 1;
    assert.equal(manager.get(finished.id, 'a'), undefined, 'a terminal job past the TTL is gone (404 for the client)');
    now += 1_000_000;
    assert.equal(status(manager, active.id), 'running', 'a running job never expires');
    await manager.shutdown();
  });

  it('keeps at most maxRetained terminal jobs, oldest first', async () => {
    const manager = new JobManager({ maxRetained: 2, maxConcurrent: 5 });
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const work = cooperative();
      ids.push(manager.submit('a', work.work).id);
      work.finish(index);
      await tick();
    }
    manager.get(ids[0], 'a'); // sweeps
    assert.equal(manager.stats().retained, 2);
    assert.equal(manager.get(ids[0], 'a'), undefined);
    assert.equal(status(manager, ids[3]), 'completed');
    await manager.shutdown();
  });
});

describe('job projection onto bim-engine/v1', () => {
  const base = { id: 'j', owner: 'a', created_at: 7 };
  it('shows only queued|running|completed|failed with exactly the fields of each', () => {
    assert.deepEqual(projectJob({ ...base, status: 'queued' }), { id: 'j', created_at: 7, status: 'queued' });
    assert.deepEqual(projectJob({ ...base, status: 'running' }), { id: 'j', created_at: 7, status: 'running' });
    assert.deepEqual(projectJob({ ...base, status: 'cancelling', reason: 'x' }), { id: 'j', created_at: 7, status: 'running' });
    assert.deepEqual(projectJob({ ...base, status: 'completed', result: { termination: 'UNKNOWN' } }),
      { id: 'j', created_at: 7, status: 'completed', result: { termination: 'UNKNOWN' } });
    assert.deepEqual(projectJob({ ...base, status: 'failed', error: 'boom' }),
      { id: 'j', created_at: 7, status: 'failed', error: 'boom' });
    assert.deepEqual(projectJob({ ...base, status: 'cancelled', reason: 'cancelled by request' }),
      { id: 'j', created_at: 7, status: 'failed', error: 'cancelled: cancelled by request' });
  });
});

describe('bearer tokens and tenants', () => {
  const alpha = 'alpha-token-0123456789';
  const beta = 'beta-token-0123456789x';

  it('is open (one anonymous tenant) when no token is configured', () => {
    for (const spec of [undefined, '', '  ']) {
      const auth = new TokenAuth(spec);
      assert.equal(auth.enabled, false);
      assert.equal(auth.authenticate(undefined), ANONYMOUS_TENANT);
      assert.equal(auth.authenticate('Bearer anything'), ANONYMOUS_TENANT);
    }
  });

  it('maps each bearer token to its tenant and recognises nobody else', () => {
    const auth = new TokenAuth(`tenant-a=${alpha}, tenant-b=${beta}`);
    assert.equal(auth.enabled, true);
    assert.equal(auth.authenticate(`Bearer ${alpha}`), 'tenant-a');
    assert.equal(auth.authenticate(`bearer ${beta}`), 'tenant-b');
    assert.equal(auth.authenticate(undefined), null);
    assert.equal(auth.authenticate('Bearer nope'), null);
    assert.equal(auth.authenticate(`Basic ${alpha}`), null);
    assert.equal(auth.authenticate(`Bearer ${alpha}x`), null);
  });

  it('refuses a malformed configuration instead of opening the engine, and never echoes a token', () => {
    for (const spec of ['no-separator', '=tokentokentokentoken', 'a=short', `a=${alpha},b=${alpha}`, 'bad name=tokentokentokentoken']) {
      assert.throws(() => new TokenAuth(spec), (thrown: Error) => {
        assert.match(thrown.message, /ENGINE_AUTH_TOKENS/);
        assert.equal(thrown.message.includes(alpha), false);
        assert.equal(thrown.message.includes('tokentokentokentoken'), false);
        return true;
      });
    }
  });

  it('validates the integer settings of the environment', () => {
    assert.equal(envInteger({}, 'X', 5, 1, 9), 5);
    assert.equal(envInteger({ X: '7' }, 'X', 5, 1, 9), 7);
    assert.throws(() => envInteger({ X: '70' }, 'X', 5, 1, 9), /X must be an integer in \[1,9\]/);
    assert.throws(() => envInteger({ X: 'abc' }, 'X', 5, 1, 9), /X must be an integer/);
  });
});
