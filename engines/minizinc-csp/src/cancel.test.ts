import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { DznBuildResult } from './dzn_builder';
import { buildServer, engineOpenApi, PROTOCOL_DIGEST, ServerOptions } from './index';
import { JobManager, JobManagerOptions, TokenAuth } from './job_manager';
import { MiniZincRunner, RunnerOptions, groupAlive } from './minizinc_runner';
import { Solver } from './solver';

// HTTP level tests of remote cancellation. The solver is a REAL child process
// (tests/fake_minizinc.mjs) and every claim about processes is read back from /proc.
const FAKE = path.resolve(__dirname, '../tests/fake_minizinc.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-test-'));
const REAL = process.env.MINIZINC_REAL === '1';
const URL = '/internal/v1/jobs';
const JSON_HEADERS = { 'content-type': 'application/json' };
const ALPHA = 'alpha-secret-token-0123456789';
const BETA = 'beta-secret-token-0123456789x';

const harnesses: Harness[] = [];
const leaked = new Set<number>();

after(async () => {
  for (const harness of harnesses) await harness.app.close().catch(() => undefined);
  for (const pgid of leaked) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(25);
  }
}

interface ProcStat { state: string; ppid: number; pgrp: number; ticks: number }

function procStat(pid: number): ProcStat | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), ticks: Number(fields[11]) + Number(fields[12]) };
  } catch {
    return null;
  }
}

function allProcesses(): Array<ProcStat & { pid: number }> {
  const found: Array<ProcStat & { pid: number }> = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const stat = procStat(Number(name));
    if (stat) found.push({ pid: Number(name), ...stat });
  }
  return found;
}

/** The command line of a process ('' when it is gone). */
function cmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
}

const liveMembers = (pgid: number) => allProcesses().filter((p) => p.pgrp === pgid && p.state !== 'Z' && p.state !== 'X');
const zombieChildren = () => allProcesses().filter((p) => p.ppid === process.pid && p.state === 'Z').map((p) => p.pid);
const ticksOf = (...pids: number[]) => pids.reduce((sum, pid) => sum + (procStat(pid)?.ticks ?? 0), 0);

/** Runs MiniZinc (the fake, or the real one) over a fixed model, ignoring the BIM problem it is given. */
class ProcessSolver {
  calls = 0;
  constructor(private readonly runner: MiniZincRunner, private readonly dir: string,
    private readonly model = 'model.mzn', private readonly extra: string[] = [], private readonly dzn = 'n = 1;') {}

  validate(): DznBuildResult {
    return { dznContent: '', features: [], metrics: [], tasks: [], candidates: [] };
  }

  async solve(_problem: unknown, _options: unknown, _optimization?: unknown, signal?: AbortSignal): Promise<any> {
    this.calls += 1;
    const run = await this.runner.run('gecode', this.model, this.dzn, path.join(this.dir, 'tmp'), this.extra, { signal });
    if (run.code !== 0) throw new Error(`MiniZinc execution failed: ${run.stderr || run.stdout}`);
    return { termination: 'UNKNOWN', solutions: [], provenance: { algorithm: 'minizinc-csp' } };
  }
}

interface Harness {
  app: FastifyInstance;
  jobs: JobManager;
  solver: ProcessSolver;
  dir: string;
  pidfile: string;
  argsfile: string;
}

interface HarnessOptions {
  env?: Record<string, string>;
  runner?: RunnerOptions;
  jobs?: JobManagerOptions;
  server?: ServerOptions;
  tokens?: string;
  runnerOverride?: MiniZincRunner;
  model?: string;
  extra?: string[];
  dzn?: string;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'h-'));
  const pidfile = path.join(dir, 'pids.json');
  const argsfile = path.join(dir, 'args.json');
  const runner = options.runnerOverride ?? new MiniZincRunner({
    command: process.execPath,
    commandArgs: [FAKE],
    gecodeCommand: process.execPath,
    gecodeCommandArgs: [FAKE],
    killGraceMs: 300,
    reapWaitMs: 2000,
    env: { FAKE_MINIZINC_MODE: 'hang', FAKE_MINIZINC_PIDFILE: pidfile, FAKE_MINIZINC_ARGS_FILE: argsfile, ...options.env },
    ...options.runner,
  });
  const solver = new ProcessSolver(runner, dir, options.model, options.extra, options.dzn);
  const jobs = new JobManager({ cancelWaitMs: 4000, ...options.jobs });
  const app = buildServer(solver, {
    jobs, auth: new TokenAuth(options.tokens), timeoutGraceMs: 600_000, ...options.server,
  });
  const harness = { app, jobs, solver, dir, pidfile, argsfile };
  harnesses.push(harness);
  return harness;
}

const envelope = (options: Record<string, unknown> = {}) => ({
  apiVersion: 'bim/v1', kind: 'BindingProblemRequest', protocol: 'bim-engine/v1',
  problem: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  optimization: { type: 'SINGLE', scalarization: 'weighted-sum', weights: [] },
  options,
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function post(harness: Harness, headers: Record<string, string> = {}, options: Record<string, unknown> = {}) {
  const response = await harness.app.inject({
    method: 'POST', url: '/internal/v1/binding-problems', headers, payload: envelope(options),
  });
  return { status: response.statusCode, body: response.json() as any, headers: response.headers };
}

async function read(harness: Harness, id: string, headers: Record<string, string> = {}) {
  const response = await harness.app.inject({ method: 'GET', url: `${URL}/${id}`, headers });
  return { status: response.statusCode, body: response.json() as any, headers: response.headers };
}

/** DELETE the way the gateway sends it: content-type json and no body. */
async function remove(harness: Harness, id: string, headers: Record<string, string> = {}) {
  const response = await harness.app.inject({
    method: 'DELETE', url: `${URL}/${id}`, headers: { ...JSON_HEADERS, ...headers },
  });
  return { status: response.statusCode, body: response.json() as any, headers: response.headers };
}

interface Pids { pid: number; grandchild: number }

async function started(harness: Harness): Promise<Pids> {
  await until(() => fs.existsSync(harness.pidfile), 15_000, 'the solver to start');
  const pids = JSON.parse(fs.readFileSync(harness.pidfile, 'utf8')) as Pids;
  leaked.add(pids.pid);
  await until(() => procStat(pids.grandchild) !== null, 5000, 'the grandchild');
  return pids;
}

function assertGone(pids: Pids): void {
  assert.equal(procStat(pids.pid), null, 'the leader was reaped');
  assert.deepEqual(liveMembers(pids.pid).map((p) => p.pid), [], 'no live process of the solver group');
  assert.equal(groupAlive(pids.pid), false);
  assert.deepEqual(zombieChildren(), [], 'no zombie child of the engine');
}

describe('remote cancellation over HTTP with a real solver process', () => {
  it('accepts a job with a random UUID and reads it in the bim-engine/v1 shape', { timeout: 60_000 }, async () => {
    const harness = makeHarness();
    const accepted = await post(harness);
    assert.equal(accepted.status, 202);
    assert.deepEqual(Object.keys(accepted.body).sort(), ['id', 'status']);
    assert.equal(accepted.body.status, 'queued');
    assert.match(accepted.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await started(harness);
    const running = await read(harness, accepted.body.id);
    assert.equal(running.status, 200);
    assert.deepEqual(Object.keys(running.body).sort(), ['created_at', 'id', 'status']);
    assert.equal(running.body.status, 'running');
    assert.equal(Number.isInteger(running.body.created_at), true);
    await remove(harness, accepted.body.id);
  });

  it('DELETE terminates the solver group, reaps it and frees the CPU before saying cancelled', { timeout: 60_000 }, async () => {
    const harness = makeHarness();
    const accepted = await post(harness);
    const pids = await started(harness);
    const before = ticksOf(pids.pid, pids.grandchild);
    await pause(500);
    assert.ok(ticksOf(pids.pid, pids.grandchild) > before, 'the solver is burning CPU');

    const cancelled = await remove(harness, accepted.body.id);

    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { id: accepted.body.id, status: 'cancelled' });
    assertGone(pids);
    const afterwards = await read(harness, accepted.body.id);
    assert.equal(afterwards.status, 200);
    assert.equal(afterwards.body.status, 'failed', 'the contract has no cancelled state');
    assert.match(afterwards.body.error, /^cancelled: /);
    assert.deepEqual(Object.keys(afterwards.body).sort(), ['created_at', 'error', 'id', 'status']);
  });

  it('is idempotent: repeating DELETE gives the same answer and changes nothing', { timeout: 60_000 }, async () => {
    const harness = makeHarness();
    const accepted = await post(harness);
    const pids = await started(harness);
    const first = await remove(harness, accepted.body.id);
    const finishedAt = harness.jobs.get(accepted.body.id, '*')?.finished_at;
    const second = await remove(harness, accepted.body.id);
    const third = await remove(harness, accepted.body.id);
    assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
    assert.deepEqual(first.body, second.body);
    assert.deepEqual(second.body, third.body);
    assert.equal(harness.jobs.get(accepted.body.id, '*')?.finished_at, finishedAt);
    assertGone(pids);
  });

  it('DELETE of a job that already completed answers 200 completed and keeps its result', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve' } });
    const accepted = await post(harness);
    await until(async () => (await read(harness, accepted.body.id)).body.status === 'completed');
    const answer = await remove(harness, accepted.body.id);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { id: accepted.body.id, status: 'completed' });
    const job = await read(harness, accepted.body.id);
    assert.equal(job.body.status, 'completed');
    assert.equal(job.body.result.termination, 'UNKNOWN');
  });

  it('DELETE of a job that failed on its own answers 200 failed', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_MODE: 'reject' } });
    const accepted = await post(harness);
    await until(async () => (await read(harness, accepted.body.id)).body.status === 'failed');
    const answer = await remove(harness, accepted.body.id);
    assert.deepEqual([answer.status, answer.body], [200, { id: accepted.body.id, status: 'failed' }]);
    const job = await read(harness, accepted.body.id);
    assert.match(job.body.error, /MiniZinc execution failed/);
  });

  it('race cancel vs finish: a result that arrives after the cancellation never reopens the job', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve', FAKE_MINIZINC_DELAY_MS: '1500' } });
    const accepted = await post(harness);
    await until(() => fs.existsSync(harness.argsfile), 15_000, 'the solver to read its input');
    const cancelled = await remove(harness, accepted.body.id);
    assert.equal(cancelled.body.status, 'cancelled');
    await pause(2000); // longer than the solver would have needed
    const job = await read(harness, accepted.body.id);
    assert.equal(job.body.status, 'failed');
    assert.match(job.body.error, /^cancelled: /);
    assert.equal('result' in job.body, false);
    assert.equal((await remove(harness, accepted.body.id)).body.status, 'cancelled');
  });

  it('race cancel vs start: a queued job leaves the queue and its solver never starts', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ jobs: { maxConcurrent: 1 } });
    const first = await post(harness);
    const pids = await started(harness);
    const second = await post(harness);
    assert.equal((await read(harness, second.body.id)).body.status, 'queued');

    const cancelled = await remove(harness, second.body.id);
    assert.deepEqual(cancelled.body, { id: second.body.id, status: 'cancelled' });
    assert.equal(harness.solver.calls, 1, 'the cancelled job never ran');

    await remove(harness, first.body.id);
    await pause(200);
    assert.equal(harness.solver.calls, 1, 'and it does not run when the slot frees');
    assertGone(pids);
  });

  it('limits concurrency: the next job starts when a running one is cancelled', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ jobs: { maxConcurrent: 1 } });
    const first = await post(harness);
    const pids = await started(harness);
    fs.rmSync(harness.pidfile);
    const second = await post(harness);
    assert.equal((await read(harness, second.body.id)).body.status, 'queued');
    await remove(harness, first.body.id);
    assertGone(pids);
    const next = await started(harness);
    assert.notEqual(next.pid, pids.pid);
    assert.equal((await read(harness, second.body.id)).body.status, 'running');
    await remove(harness, second.body.id);
    assertGone(next);
  });

  it('answers 503 with Retry-After when the queue is full', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ jobs: { maxConcurrent: 1, maxQueued: 0 } });
    const first = await post(harness);
    await started(harness);
    const refused = await post(harness);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers['retry-after'], '1');
    await remove(harness, first.body.id);
  });

  it('a resubmission with the same X-Openbinding-Job-Id is a new job and the cancelled one stays cancelled', { timeout: 60_000 }, async () => {
    const harness = makeHarness();
    const headers = { 'x-openbinding-job-id': 'gateway-job-1', 'x-openbinding-attempt': '1' };
    const first = await post(harness, headers);
    const firstPids = await started(harness);
    fs.rmSync(harness.pidfile);
    const second = await post(harness, { ...headers, 'x-openbinding-attempt': '2' });
    const secondPids = await started(harness);
    assert.notEqual(first.body.id, second.body.id, 'the engine does not deduplicate by the gateway job id');

    const cancelled = await remove(harness, first.body.id);
    assert.equal(cancelled.body.status, 'cancelled');
    assertGone(firstPids);
    assert.equal((await read(harness, first.body.id)).body.status, 'failed');
    assert.equal((await read(harness, second.body.id)).body.status, 'running');
    assert.equal(groupAlive(secondPids.pid), true, 'cancelling the first id leaves the second job running');
    assert.equal((await remove(harness, first.body.id)).body.status, 'cancelled', 'and repeating it still does');
    assert.equal(groupAlive(secondPids.pid), true);
    await remove(harness, second.body.id);
    assertGone(secondPids);
  });

  it('after an engine restart the old id is simply unknown (404); jobs are in memory', { timeout: 60_000 }, async () => {
    const before = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve' } });
    const accepted = await post(before);
    await until(async () => (await read(before, accepted.body.id)).body.status === 'completed');
    const restarted = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve' } });
    assert.equal((await read(restarted, accepted.body.id)).status, 404);
    assert.equal((await remove(restarted, accepted.body.id)).status, 404);
  });

  it('forgets terminal jobs after the TTL (404) without touching running ones', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve' }, jobs: { ttlMs: 150 } });
    const accepted = await post(harness);
    await until(async () => (await read(harness, accepted.body.id)).body.status === 'completed');
    await pause(300);
    assert.equal((await read(harness, accepted.body.id)).status, 404);
    assert.equal((await remove(harness, accepted.body.id)).status, 404);
  });

  it('a job past time_budget_ms + grace is stopped like a cancel and ends failed with the timeout reason', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_CPU: '0' }, server: { timeoutGraceMs: 0 } });
    const accepted = await post(harness, {}, { time_budget_ms: 1500 });
    const pids = await started(harness);
    await until(async () => (await read(harness, accepted.body.id)).body.status === 'failed', 20_000, 'the timeout');
    const job = await read(harness, accepted.body.id);
    assert.match(job.body.error, /^execution timeout after 1500 ms/);
    assertGone(pids);
    assert.deepEqual((await remove(harness, accepted.body.id)).body, { id: accepted.body.id, status: 'failed' });
  });

  it('answers 202 cancelling while the solver ignores SIGTERM, then cancelled once SIGKILL reaped it', { timeout: 60_000 }, async () => {
    const harness = makeHarness({
      env: { FAKE_MINIZINC_IGNORE_TERM: '1' }, runner: { killGraceMs: 1500 }, jobs: { cancelWaitMs: 200 },
    });
    const accepted = await post(harness);
    const pids = await started(harness);

    const pending = await remove(harness, accepted.body.id);
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.body, { id: accepted.body.id, status: 'cancelling' });
    assert.equal(pending.headers['retry-after'], '1');
    assert.equal(groupAlive(pids.pid), true, 'not cancelled: the solver is still there');
    assert.equal((await read(harness, accepted.body.id)).body.status, 'running', 'the contract shows cancelling as running');
    assert.equal((await remove(harness, accepted.body.id)).status, 202, 'repeating it does not invent progress');

    await until(async () => (await remove(harness, accepted.body.id)).status === 200, 20_000, 'the solver to be reaped');
    assert.deepEqual((await remove(harness, accepted.body.id)).body, { id: accepted.body.id, status: 'cancelled' });
    assertGone(pids);
  });

  it('never says cancelled for a solver it could not stop: 202, then failed with the reason', { timeout: 60_000 }, async () => {
    const harness = makeHarness({
      runner: { killGraceMs: 100, reapWaitMs: 400, signalGroup: () => undefined }, jobs: { cancelWaitMs: 100 },
    });
    const accepted = await post(harness);
    const pids = await started(harness);

    const pending = await remove(harness, accepted.body.id);
    assert.equal(pending.status, 202);
    await until(async () => (await read(harness, accepted.body.id)).body.status === 'failed', 20_000, 'the verdict');
    const job = await read(harness, accepted.body.id);
    assert.match(job.body.error, /cancel failed: solver process group \d+ is still alive/);
    assert.doesNotMatch(job.body.error, /^cancelled:/);
    assert.deepEqual((await remove(harness, accepted.body.id)).body, { id: accepted.body.id, status: 'failed' });
    assert.equal(groupAlive(pids.pid), true, 'and that is the truth: it is still running');
    process.kill(-pids.pid, 'SIGKILL'); // cleanup by the test
    await until(() => !groupAlive(pids.pid), 10_000, 'the test cleanup');
  });

  it('closing the engine stops every running solver', { timeout: 60_000 }, async () => {
    const harness = makeHarness();
    await post(harness);
    const pids = await started(harness);
    await harness.app.close();
    assertGone(pids);
  });
});

describe('ownership and authentication', () => {
  const tokens = `tenant-a=${ALPHA},tenant-b=${BETA}`;

  it('answers the identical 404 for an unknown id and for a job of another tenant, and does not cancel it', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ tokens });
    const accepted = await post(harness, bearer(ALPHA));
    assert.equal(accepted.status, 202);
    const pids = await started(harness);

    const missingId = '00000000-0000-4000-8000-000000000000';
    const foreignGet = await read(harness, accepted.body.id, bearer(BETA));
    const missingGet = await read(harness, missingId, bearer(BETA));
    const foreignDelete = await remove(harness, accepted.body.id, bearer(BETA));
    const missingDelete = await remove(harness, missingId, bearer(BETA));
    assert.deepEqual([foreignGet.status, missingGet.status, foreignDelete.status, missingDelete.status], [404, 404, 404, 404]);
    assert.deepEqual(foreignGet.body, missingGet.body);
    assert.deepEqual(foreignDelete.body, missingDelete.body);
    assert.deepEqual(foreignGet.body, foreignDelete.body);
    assert.equal(groupAlive(pids.pid), true, 'the other tenant did not stop the job');
    assert.equal((await read(harness, accepted.body.id, bearer(ALPHA))).body.status, 'running');

    assert.equal((await remove(harness, accepted.body.id, bearer(ALPHA))).status, 200);
    assertGone(pids);
  });

  it('rejects a missing or wrong token with 401 on every job endpoint and never reveals existence', { timeout: 60_000 }, async () => {
    const harness = makeHarness({ tokens });
    const accepted = await post(harness, bearer(ALPHA));
    await started(harness);
    for (const headers of [{}, bearer('wrong-token-0123456789'), { authorization: `Basic ${ALPHA}` }]) {
      assert.equal((await post(harness, headers)).status, 401);
      const probe = await read(harness, accepted.body.id, headers);
      const missing = await read(harness, '00000000-0000-4000-8000-000000000000', headers);
      assert.equal(probe.status, 401);
      assert.deepEqual(probe.body, missing.body);
      assert.equal(probe.headers['www-authenticate'], 'Bearer');
      assert.equal((await remove(harness, accepted.body.id, headers)).status, 401);
    }
    assert.equal((await read(harness, accepted.body.id, bearer(ALPHA))).body.status, 'running');
    await remove(harness, accepted.body.id, bearer(ALPHA));
  });

  it('keeps /health open for the orchestrator and authenticates /internal/v1/health', async () => {
    const harness = makeHarness({ tokens });
    assert.equal((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await harness.app.inject({ method: 'GET', url: '/internal/v1/health' })).statusCode, 401);
    assert.equal((await harness.app.inject({ method: 'GET', url: '/internal/v1/health', headers: bearer(BETA) })).statusCode, 200);
  });

  it('without configured tokens the engine stays open: one shared tenant (the documented current behaviour)', { timeout: 60_000 }, async () => {
    const harness = makeHarness();
    const accepted = await post(harness);
    const pids = await started(harness);
    assert.equal((await read(harness, accepted.body.id, bearer('whatever-token-0123456789'))).status, 200);
    assert.equal((await remove(harness, accepted.body.id, bearer('another-token-0123456789'))).status, 200);
    assertGone(pids);
  });

  it('refuses to start with a malformed ENGINE_AUTH_TOKENS instead of silently opening up', () => {
    assert.throws(() => buildServer(new ProcessSolver(new MiniZincRunner(), SCRATCH), { env: { ENGINE_AUTH_TOKENS: 'oops' } }),
      /ENGINE_AUTH_TOKENS/);
  });
});

describe('transport details', () => {
  it('accepts a DELETE or GET that carries a JSON content-type and no body', async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve' } });
    const response = await harness.app.inject({
      method: 'DELETE', url: `${URL}/00000000-0000-4000-8000-000000000000`, headers: JSON_HEADERS,
    });
    assert.equal(response.statusCode, 404);
  });

  it('answers 400 for a malformed JSON body and 422 for a body that is not a BindingProblemRequest', async () => {
    const harness = makeHarness({ env: { FAKE_MINIZINC_MODE: 'solve' } });
    const malformed = await harness.app.inject({
      method: 'POST', url: '/internal/v1/binding-problems', headers: JSON_HEADERS, payload: '{"apiVersion":',
    });
    assert.equal(malformed.statusCode, 400);
    const wrong = await harness.app.inject({
      method: 'POST', url: '/internal/v1/binding-problems', headers: JSON_HEADERS, payload: '{"a":1}',
    });
    assert.equal(wrong.statusCode, 422);
  });
});

describe('what the engine publishes about cancellation', () => {
  it('serves a deployment OpenAPI that describes DELETE on the job path with 200, 202 and 404', async () => {
    const harness = makeHarness();
    const served = (await harness.app.inject({ method: 'GET', url: '/openapi.json' })).json() as any;
    assert.equal(served.openapi, '3.1.0');
    assert.equal(served['x-bim-protocol'], 'bim-engine/v1');
    assert.equal(served['x-bim-protocol-digest'], PROTOCOL_DIGEST);
    const operation = served.paths['/internal/v1/jobs/{id}'].delete;
    assert.deepEqual(Object.keys(operation.responses).sort(), ['200', '202', '404']);
    assert.equal(served.security, undefined, 'open mode declares no security');
    assert.deepEqual(Object.keys(served.paths['/internal/v1/binding-problems'].post.responses).sort(),
      ['202', '413', '422', '500', '503']);
  });

  it('declares bearer security on every operation of a registration except the orchestrator probe', () => {
    const served = engineOpenApi(true) as any;
    assert.deepEqual(served.components.securitySchemes, { bearerAuth: { type: 'http', scheme: 'bearer' } });
    for (const [route, operations] of Object.entries<any>(served.paths)) {
      for (const operation of Object.values<any>(operations)) {
        if (route === '/health') assert.deepEqual(operation.security, []);
        else assert.deepEqual(operation.security, [{ bearerAuth: [] }], route);
      }
    }
    assert.ok(served.paths['/internal/v1/jobs/{id}'].delete.responses['401']);
  });

  it('is the same document the harness embeds: the engine pins the digest of the installed protocol', () => {
    assert.match(PROTOCOL_DIGEST, /^sha256-[0-9a-f]{64}$/);
  });
});

// --- Real MiniZinc: lab only. Without MINIZINC_REAL=1 each test is listed as NO EJECUTADO.
const real = (name: string, fn: () => Promise<void>) => it(
  name,
  { skip: REAL ? false : 'NO EJECUTADO: MINIZINC_REAL!=1 (needs the real minizinc executable)', timeout: 180_000 },
  fn,
);

function ref(resource: string, id: string) { return { resource, id }; }
function digestOf(seed: string): string { return `sha256-${seed.charCodeAt(0).toString(16).repeat(64).slice(0, 64)}`; }
function identity(role: string, kind: string, file: string) {
  return { role, apiVersion: 'qos-binding/v1', kind, path: file, digest: digestOf(file) };
}
function metric() {
  return {
    type: 'number', unit: '1', domain: { kind: 'real' }, direction: 'minimize', scope: 'invocation', neutral: 0,
    aggregation: { sequence: 'sum', parallel: 'sum', exclusive: 'weightedSum', repeat: 'scale', selection: 'sum' },
  };
}
function catalog(resource: string, cost: number, latency: number) {
  const candidate = {
    ref: ref(resource, 'same-id'), provider: ref(resource, 'provider'),
    provides: [{ type: 'compute', properties: {} }], properties: {},
    features: { price: cost, response: latency }, metrics: { price: cost, response: latency },
  };
  return {
    providers: { provider: { properties: {} } },
    featureBindings: { price: ref('app', 'cost'), response: ref('app', 'latency') },
    metricBindings: { price: ref('app', 'cost'), response: ref('app', 'latency') },
    candidates: { 'same-id': candidate },
  };
}
function tinyProblem(): any {
  const features = { cost: metric(), latency: metric() };
  const required = ['cost', 'latency'];
  return {
    apiVersion: 'bim/v1', kind: 'BindingProblem', metadata: { name: 'tiny' },
    spec: {
      profile: {
        namespace: 'bim.builtin', id: 'qos-binding/v1', version: '1.0.0',
        output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: digestOf('schema') },
        deterministic: true, digest: digestOf('profile'),
        adapter: { id: 'qos-binding-profile', version: '1.0.0', digest: digestOf('adapter') },
      },
      dialects: [{
        namespace: 'bim.builtin', id: 'qos-binding/v1', version: '1.0.0', digest: digestOf('dialect'), irFeatures: [],
        adapter: { id: 'bim-core', version: '1.0.0', digest: digestOf('dialect-adapter') },
      }],
      instance: {
        digest: digestOf('instance'),
        resources: {
          app: identity('application', 'Application', 'application.json'),
          'catalog-a': identity('candidates', 'CandidateCatalog', 'catalog-a.json'),
          'catalog-b': identity('candidates', 'CandidateCatalog', 'catalog-b.json'),
          optimization: identity('optimization', 'Optimization', 'optimization.json'),
        },
      },
      application: {
        resource: 'app', tasks: { t: { kind: 'service', requires: { type: 'compute' } } },
        features, metrics: features, requiredFeatures: required, requiredMetrics: required,
        taskRequiredFeatures: {}, taskRequiredMetrics: {}, workflow: { kind: 'task', task: ref('app', 't') },
      },
      candidates: { 'catalog-a': catalog('catalog-a', 1, 10), 'catalog-b': catalog('catalog-b', 9, 1) },
      eligibility: { t: [ref('catalog-a', 'same-id'), ref('catalog-b', 'same-id')] },
      routing: [], constraints: [], placement: [],
      optimization: {
        resource: 'optimization', type: 'SINGLE',
        criteria: [{ id: 'cost-criterion', feature: ref('app', 'cost'), direction: 'minimize' }], penalties: [],
      },
      extensions: {}, sourceMap: {},
    },
  };
}

const PIGEONHOLE = [
  'int: n = 26;', 'array[1..n] of var 1..n-1: x;',
  'constraint forall(i, j in 1..n where i < j)(x[i] != x[j]);', 'solve satisfy;', '',
].join('\n');

describe('real MiniZinc over HTTP (MINIZINC_REAL=1)', () => {
  real('real minizinc: the BIM model solves a tiny problem to OPTIMAL through POST and GET', async () => {
    const jobs = new JobManager();
    const app = buildServer(new Solver(), { jobs, auth: new TokenAuth(undefined) });
    harnesses.push({ app, jobs } as unknown as Harness);
    const accepted = await app.inject({
      method: 'POST', url: '/internal/v1/binding-problems',
      payload: {
        apiVersion: 'bim/v1', kind: 'BindingProblemRequest', protocol: 'bim-engine/v1', problem: tinyProblem(),
        options: { time_budget_ms: 20_000 },
        optimization: { type: 'SINGLE', scalarization: 'weighted-sum', weights: [{ criteria: 'cost-criterion', value: 1 }] },
      },
    });
    assert.equal(accepted.statusCode, 202);
    const id = accepted.json().id as string;
    let job: any;
    await until(async () => {
      job = (await app.inject({ method: 'GET', url: `${URL}/${id}` })).json();
      return job.status === 'completed' || job.status === 'failed';
    }, 60_000, 'the real solve');
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(job.result.termination, 'OPTIMAL');
    assert.deepEqual(job.result.solutions[0].decision.binding.t, ref('catalog-a', 'same-id'));
  });

  real('real minizinc: DELETE kills minizinc and its solver backend, frees the CPU and leaves no zombie', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'real-'));
    const model = path.join(dir, 'pigeonhole.mzn');
    fs.writeFileSync(model, PIGEONHOLE);
    const harness = makeHarness({
      runnerOverride: new MiniZincRunner({ killGraceMs: 2000, reapWaitMs: 3000 }),
      model, extra: ['--time-limit', '600000'], dzn: '',
    });
    const accepted = await post(harness);
    assert.equal(accepted.status, 202);
    let leader = 0;
    await until(() => {
      // the fzn-gecode group, not the short MiniZinc flattening phase that precedes it
      const child = allProcesses().find((p) => p.ppid === process.pid && p.pgrp === p.pid && p.state !== 'Z'
        && /fzn-gecode/.test(cmdline(p.pid)));
      leader = child?.pid ?? 0;
      return leader > 0;
    }, 15_000, 'the real minizinc to start');
    leaked.add(leader);
    await pause(1500);
    const members = liveMembers(leader).map((p) => p.pid);
    assert.ok(ticksOf(...members) > 0, 'the real solver burns CPU');

    const cancelled = await remove(harness, accepted.body.id);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.deepEqual(liveMembers(leader).map((p) => p.pid), []);
    assert.equal(procStat(leader), null);
    assert.deepEqual(zombieChildren(), []);
  });
});
