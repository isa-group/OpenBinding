import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

import { AbortedError, NotTerminatedError } from './job_manager';
import {
  MiniZincRunner, RunnerOptions, commandFromEnv, groupAlive, runnerOptionsFromEnv,
} from './minizinc_runner';

// Everything below runs REAL child processes (tests/fake_minizinc.mjs) and reads /proc.
const FAKE = path.resolve(__dirname, '../tests/fake_minizinc.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
const REAL = process.env.MINIZINC_REAL === '1';
const leaked = new Set<number>();

after(() => {
  for (const pgid of leaked) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function fakeRunner(options: RunnerOptions = {}): MiniZincRunner {
  return new MiniZincRunner({
    command: process.execPath, commandArgs: [FAKE], killGraceMs: 300, reapWaitMs: 2000, ...options,
  });
}

/** Sets variables for the process started during `start()` (spawn is synchronous), then restores them. */
function withEnv<T>(vars: Record<string, string>, start: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return start();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function until(predicate: () => boolean, timeoutMs = 15_000, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

/** Zombie children of THIS process: leaders the runner failed to reap. */
const zombieChildren = () => allProcesses().filter((p) => p.ppid === process.pid && p.state === 'Z').map((p) => p.pid);
const liveMembers = (pgid: number) => allProcesses().filter((p) => p.pgrp === pgid && p.state !== 'Z' && p.state !== 'X');
const ticksOf = (...pids: number[]) => pids.reduce((sum, pid) => sum + (procStat(pid)?.ticks ?? 0), 0);

interface Hang {
  pid: number;
  grandchild: number;
  controller: AbortController;
  run: Promise<unknown>;
}

async function startHang(env: Record<string, string> = {}, options: RunnerOptions = {}): Promise<Hang> {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'hang-'));
  const pidfile = path.join(dir, 'pids.json');
  const controller = new AbortController();
  const run = withEnv({ FAKE_MINIZINC_MODE: 'hang', FAKE_MINIZINC_PIDFILE: pidfile, ...env }, () =>
    fakeRunner(options).run('gecode', 'model.mzn', 'n = 1;', path.join(dir, 'tmp'), [], { signal: controller.signal }));
  run.catch(() => undefined); // each test awaits the outcome it expects
  await until(() => fs.existsSync(pidfile), 15_000, 'the fake solver to start');
  const { pid, grandchild } = JSON.parse(fs.readFileSync(pidfile, 'utf8'));
  leaked.add(pid);
  await until(() => procStat(grandchild) !== null, 5000, 'the grandchild');
  return { pid, grandchild, controller, run };
}

async function assertGroupIsGone(hang: Hang): Promise<void> {
  assert.equal(procStat(hang.pid), null, 'the leader was reaped (no zombie left for the engine to reap)');
  assert.deepEqual(liveMembers(hang.pid).map((p) => p.pid), [], 'no live process of the group remains');
  assert.equal(groupAlive(hang.pid), false);
  assert.deepEqual(zombieChildren(), [], 'no zombie child of the engine');
}

describe('MiniZincRunner with a real child process', () => {
  it('runs the command with the MiniZinc arguments, the data on stdin and TMPDIR', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'solve-'));
    const argsFile = path.join(dir, 'args.json');
    const stdoutFile = path.join(dir, 'stdout.txt');
    fs.writeFileSync(stdoutFile, '{"selected_cand":[2],"objective_value":9}\n----------\n==========\n');
    const result = await withEnv({ FAKE_MINIZINC_ARGS_FILE: argsFile, FAKE_MINIZINC_STDOUT_FILE: stdoutFile }, () =>
      fakeRunner().run('gecode', '/m/model.mzn', 'n_tasks = 1;\n', path.join(dir, 'tmp'), ['--time-limit', '1234']));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /==========/);
    const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(seen.argv, ['--solver', 'gecode', '--time-limit', '1234', '/m/model.mzn', '-']);
    assert.equal(seen.stdinBytes, 'n_tasks = 1;\n'.length);
    assert.equal(seen.tmpdir, path.join(dir, 'tmp'));
    assert.equal(zombieChildren().length, 0);
  });

  it('returns the exit code and stderr of a solver that rejects the model', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'reject-'));
    const result = await withEnv({ FAKE_MINIZINC_MODE: 'reject' }, () =>
      fakeRunner().run('gecode', 'm.mzn', '', path.join(dir, 'tmp')));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /rejects this model/);
  });

  it('rejects when the executable does not exist and leaves nothing behind', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'missing-'));
    await assert.rejects(
      () => new MiniZincRunner({ command: path.join(dir, 'no-such-minizinc'), commandArgs: [] })
        .run('gecode', 'm.mzn', '', path.join(dir, 'tmp')),
      /ENOENT/,
    );
    assert.deepEqual(zombieChildren(), []);
  });

  it('does not even start when the signal is already aborted', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'preabort-'));
    const argsFile = path.join(dir, 'args.json');
    const controller = new AbortController();
    controller.abort(new AbortedError('cancelled before start'));
    await withEnv({ FAKE_MINIZINC_ARGS_FILE: argsFile }, async () => {
      await assert.rejects(
        () => fakeRunner().run('gecode', 'm.mzn', '', path.join(dir, 'tmp'), [], { signal: controller.signal }),
        (thrown: Error) => thrown instanceof AbortedError && /cancelled before start/.test(thrown.message),
      );
    });
    await pause(200);
    assert.equal(fs.existsSync(argsFile), false, 'no process was spawned');
  });

  it('ignores an abort that arrives after the run completed', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'late-'));
    const controller = new AbortController();
    const result = await fakeRunner().run('gecode', 'm.mzn', '', path.join(dir, 'tmp'), [], { signal: controller.signal });
    controller.abort(new AbortedError('too late'));
    assert.equal(result.code, 0);
  });
});

describe('MiniZincRunner abort: the whole process group dies, is reaped and frees the CPU', () => {
  it('burns CPU before the abort and nothing of the group is alive after it', { timeout: 60_000 }, async () => {
    const hang = await startHang();
    const before = ticksOf(hang.pid, hang.grandchild);
    await pause(600);
    const during = ticksOf(hang.pid, hang.grandchild);
    assert.ok(during > before, `the fake solver and its grandchild use CPU (${before} -> ${during} ticks)`);
    assert.equal(procStat(hang.grandchild)?.pgrp, hang.pid, 'the grandchild is in the solver process group');

    hang.controller.abort(new AbortedError('cancelled by request'));
    await assert.rejects(hang.run, (thrown: Error) => thrown instanceof AbortedError);

    await assertGroupIsGone(hang);
    assert.equal(procStat(hang.grandchild)?.state === 'Z' || procStat(hang.grandchild) === null, true);
  });

  it('escalates to SIGKILL when the group ignores SIGTERM', { timeout: 60_000 }, async () => {
    const hang = await startHang({ FAKE_MINIZINC_IGNORE_TERM: '1' }, { killGraceMs: 400 });
    const started = Date.now();
    hang.controller.abort(new AbortedError('cancelled by request'));
    await assert.rejects(hang.run, AbortedError);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 350, `SIGTERM was ignored, so the run lasted until the SIGKILL (${elapsed} ms)`);
    assert.ok(elapsed < 5000);
    await assertGroupIsGone(hang);
  });

  it('kills a grandchild that outlives the leader and has left the pipes', { timeout: 60_000 }, async () => {
    // The leader exits on SIGTERM and its 'close' fires, but the grandchild ignores SIGTERM and holds no pipe.
    const hang = await startHang(
      { FAKE_MINIZINC_GRANDCHILD_IGNORE_TERM: '1', FAKE_MINIZINC_GRANDCHILD_STDIO: 'ignore' },
      { killGraceMs: 500 },
    );
    const started = Date.now();
    hang.controller.abort(new AbortedError('cancelled by request'));
    await assert.rejects(hang.run, AbortedError);
    assert.ok(Date.now() - started >= 450, 'the run did not settle while the grandchild was still alive');
    await assertGroupIsGone(hang);
  });

  it('stops an idle solver (no CPU) the same way', { timeout: 60_000 }, async () => {
    const hang = await startHang({ FAKE_MINIZINC_CPU: '0' });
    hang.controller.abort(new AbortedError('cancelled by request'));
    await assert.rejects(hang.run, AbortedError);
    await assertGroupIsGone(hang);
  });

  it('reports NotTerminatedError, never an abort, when the group cannot be stopped', { timeout: 60_000 }, async () => {
    const hang = await startHang({}, { killGraceMs: 100, reapWaitMs: 300, signalGroup: () => undefined });
    hang.controller.abort(new AbortedError('cancelled by request'));
    await assert.rejects(hang.run, (thrown: Error) => {
      assert.ok(thrown instanceof NotTerminatedError, `got ${thrown.name}`);
      assert.match(thrown.message, new RegExp(`solver process group ${hang.pid} is still alive`));
      return true;
    });
    assert.equal(groupAlive(hang.pid), true, 'the honest answer: it is still running');
    process.kill(-hang.pid, 'SIGKILL'); // test cleanup, done by the test itself
    await until(() => !groupAlive(hang.pid), 10_000, 'the test cleanup');
  });
});

describe('runner configuration', () => {
  it('reads the program from MINIZINC_COMMAND as a path or as a JSON array', () => {
    assert.deepEqual(commandFromEnv({}), { command: 'minizinc', commandArgs: [] });
    assert.deepEqual(commandFromEnv({ MINIZINC_COMMAND: '/opt/mzn/minizinc' }), { command: '/opt/mzn/minizinc', commandArgs: [] });
    assert.deepEqual(commandFromEnv({ MINIZINC_COMMAND: '["node","/x/fake.mjs"]' }),
      { command: 'node', commandArgs: ['/x/fake.mjs'] });
    assert.throws(() => commandFromEnv({ MINIZINC_COMMAND: '[]' }), /MINIZINC_COMMAND/);
    assert.throws(() => commandFromEnv({ MINIZINC_COMMAND: '[1]' }), /MINIZINC_COMMAND/);
  });

  it('bounds the kill timings', () => {
    assert.equal(runnerOptionsFromEnv({}).killGraceMs, 2000);
    assert.equal(runnerOptionsFromEnv({ ENGINE_KILL_GRACE_MS: '50' }).killGraceMs, 50);
    assert.throws(() => runnerOptionsFromEnv({ ENGINE_KILL_GRACE_MS: '-1' }), /ENGINE_KILL_GRACE_MS/);
  });

  it('knows that a group that never existed is not alive', () => {
    assert.equal(groupAlive(2 ** 22 - 3), false);
  });
});

// --- Real MiniZinc: only where it is installed (the lab image). Never a silent skip: without
// MINIZINC_REAL=1 each test is listed as NO EJECUTADO (and `pnpm test` prints the list again).
const real = (name: string, fn: () => Promise<void>) => it(
  name,
  { skip: REAL ? false : 'NO EJECUTADO: MINIZINC_REAL!=1 (needs the real minizinc executable)', timeout: 120_000 },
  fn,
);

const PIGEONHOLE = [
  'int: n = 26;',
  'array[1..n] of var 1..n-1: x;',
  'constraint forall(i, j in 1..n where i < j)(x[i] != x[j]);',
  'solve satisfy;',
  '',
].join('\n');

describe('real MiniZinc (MINIZINC_REAL=1)', () => {
  real('real minizinc: the executable is installed and answers --version', async () => {
    const answer = spawnSync('minizinc', ['--version'], { encoding: 'utf8' });
    assert.equal(answer.status, 0);
    assert.match(`${answer.stdout}${answer.stderr}`, /MiniZinc/i);
  });

  real('real minizinc: a search with a time limit ends by itself without claiming a proof', async () => {
    const model = path.join(SCRATCH, 'pigeonhole.mzn');
    fs.writeFileSync(model, PIGEONHOLE);
    const started = Date.now();
    const result = await new MiniZincRunner().run('gecode', model, '', path.join(SCRATCH, 'tmp-real'), ['--time-limit', '1500']);
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started < 30_000);
    assert.doesNotMatch(result.stdout, /=====UNSATISFIABLE=====/);
    assert.doesNotMatch(result.stdout, /^==========$/m);
    assert.match(result.stdout, /=====UNKNOWN=====/);
  });

  real('real minizinc: aborting kills minizinc and its solver backend, frees the CPU and leaves no zombie', async () => {
    const model = path.join(SCRATCH, 'pigeonhole-abort.mzn');
    fs.writeFileSync(model, PIGEONHOLE);
    const controller = new AbortController();
    const run = new MiniZincRunner().run('gecode', model, '', path.join(SCRATCH, 'tmp-real'),
      ['--time-limit', '600000'], { signal: controller.signal });
    run.catch(() => undefined);
    let leader = 0;
    await until(() => {
      // the group leader is the minizinc driver we spawned: a child of this process
      const child = allProcesses().find((p) => p.ppid === process.pid && p.pgrp === p.pid && p.state !== 'Z');
      leader = child?.pid ?? 0;
      return leader > 0 && liveMembers(leader).length >= 1;
    }, 15_000, 'minizinc to start');
    leaked.add(leader);
    await pause(1500);
    const members = liveMembers(leader).map((p) => p.pid);
    assert.ok(ticksOf(...members) > 0, 'the real solver is using CPU');

    controller.abort(new AbortedError('cancelled by request'));
    await assert.rejects(run, AbortedError);
    assert.deepEqual(liveMembers(leader).map((p) => p.pid), []);
    assert.equal(procStat(leader), null);
    assert.deepEqual(zombieChildren(), []);
  });
});
