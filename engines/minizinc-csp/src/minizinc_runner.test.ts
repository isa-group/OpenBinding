import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

import { AbortedError, NotTerminatedError } from './job_manager';
import {
  MiniZincRunner, RunnerOptions, commandFromEnv, extractGecodeStatistics, gecodeCommandFromEnv, groupAlive, runnerOptionsFromEnv,
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
    command: process.execPath, commandArgs: [FAKE], gecodeCommand: process.execPath, gecodeCommandArgs: [FAKE],
    killGraceMs: 300, reapWaitMs: 2000, ...options,
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

/** The command line of a process ('' when it is gone). */
function cmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
}

/** Zombie children of THIS process: leaders the runner failed to reap. */
const zombieChildren = () => allProcesses().filter((p) => p.ppid === process.pid && p.state === 'Z').map((p) => p.pid);
const liveMembers = (pgid: number) => allProcesses().filter((p) => p.pgrp === pgid && p.state !== 'Z' && p.state !== 'X');
const ticksOf = (...pids: number[]) => pids.reduce((sum, pid) => sum + (procStat(pid)?.ticks ?? 0), 0);

/** CPU time (clock ticks, 10 ms each) a fake grandchild must have used before a test relies on its SIGTERM handler. */
const GRANDCHILD_READY_TICKS = 50;

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
  if (env.FAKE_MINIZINC_GRANDCHILD_IGNORE_TERM === '1' && env.FAKE_MINIZINC_CPU !== '0') {
    // The pidfile is written as soon as the grandchild is spawned, but it only ignores SIGTERM once node has started
    // and run its script; a SIGTERM before that kills it with the default action and the run settles early (seen in a
    // CPU-constrained container: 66 ms with a 500 ms grace). Its start-up costs a bounded amount of CPU time, whatever
    // the load, while the busy loop that follows keeps adding ticks, so enough CPU time proves the loop is running.
    await until(() => (procStat(grandchild)?.ticks ?? 0) >= GRANDCHILD_READY_TICKS, 30_000,
      'the grandchild to be past its start-up and busy');
  }
  return { pid, grandchild, controller, run };
}

async function assertGroupIsGone(hang: Hang): Promise<void> {
  assert.equal(procStat(hang.pid), null, 'the leader was reaped (no zombie left for the engine to reap)');
  assert.deepEqual(liveMembers(hang.pid).map((p) => p.pid), [], 'no live process of the group remains');
  assert.equal(groupAlive(hang.pid), false);
  assert.deepEqual(zombieChildren(), [], 'no zombie child of the engine');
}

// A `fzn-gecode -s` block as Gecode 6.3 prints it (names and layout as recalled from its FlatZinc
// front-end; the parser keeps the raw lines, so a different layout is never lost).
const GECODE_STATS = [
  '%%  runtime:       29.436 (29436.000 ms)',
  '%%  solvetime:     29.100 (29100.000 ms)',
  '%%  solutions:     2',
  '%%  variables:     1532',
  '%%  propagators:   4210',
  '%%  propagations:  98765432',
  '%%  nodes:         123456',
  '%%  failures:      61000',
  '%%  restarts:      0',
  '%%  peak depth:    17',
];

describe('MiniZincRunner with a real child process', () => {
  it('flattens with MiniZinc, solves the widened FlatZinc with fzn-gecode, with the data file and TMPDIR', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'solve-'));
    const argsFile = path.join(dir, 'args.json');
    const stdoutFile = path.join(dir, 'stdout.txt');
    fs.writeFileSync(stdoutFile, 'selected_candidate = array1d(1..1, [2]);\nobjective_value = 9;\n----------\n==========\n');
    const result = await withEnv({ FAKE_MINIZINC_ARGS_FILE: argsFile, FAKE_MINIZINC_STDOUT_FILE: stdoutFile }, () =>
      fakeRunner().run('gecode', '/m/model.mzn', 'n_tasks = 1;\n', path.join(dir, 'tmp'), ['--time-limit', '1234']));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^\{"selected_cand":\[2\],"objective_value":9\}$/m);
    assert.match(result.stdout, /==========/);
    assert.equal(result.oznRendered, false);
    const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(seen.map((call: { phase: string }) => call.phase), ['flatten', 'solve']);
    const [flatten, solve] = seen;
    assert.deepEqual(flatten.argv.slice(0, 3), ['--solver', 'gecode', '-c']);
    assert.equal(flatten.argv[3], '/m/model.mzn');
    assert.match(flatten.argv[4], /\.dzn$/);
    assert.deepEqual([flatten.argv[5], flatten.argv[7]], ['--fzn', '--ozn']);
    assert.equal(flatten.dznBytes, 'n_tasks = 1;\n'.length);
    assert.equal(solve.argv[0], '-a');
    assert.equal(solve.argv[1], '-time');
    assert.ok(Number(solve.argv[2]) > 0 && Number(solve.argv[2]) <= 1234, `time budget ${solve.argv[2]}`);
    assert.equal(solve.argv[3], '-s', 'fzn-gecode is asked for its search statistics');
    assert.match(solve.argv[4], /\.widened\.fzn$/);
    assert.equal(result.gecodeStatistics, undefined, 'a solver that prints no statistics yields none');
    for (const call of seen) assert.equal(call.tmpdir, path.join(dir, 'tmp'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'the run removes its intermediate files');
    assert.equal(zombieChildren().length, 0);
  });

  it('renders blocks without output variables through the .ozn pass', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'ozn-'));
    const argsFile = path.join(dir, 'args.json');
    const stdoutFile = path.join(dir, 'stdout.txt');
    fs.writeFileSync(stdoutFile, '{"selected_cand":[2],"objective_value":9}\n----------\n==========\n');
    const result = await withEnv({ FAKE_MINIZINC_ARGS_FILE: argsFile, FAKE_MINIZINC_STDOUT_FILE: stdoutFile }, () =>
      fakeRunner().run('gecode', '/m/model.mzn', '', path.join(dir, 'tmp'), ['--time-limit', '1234']));
    assert.equal(result.code, 0);
    assert.equal(result.oznRendered, true);
    assert.match(result.stdout, /"selected_cand":\[2\]/);
    const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(seen.map((call: { phase: string }) => call.phase), ['flatten', 'solve', 'render']);
  });

  it('parses the fzn-gecode -s statistics and leaves the solution stream and its markers intact', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'stats-'));
    const stdoutFile = path.join(dir, 'stdout.txt');
    fs.writeFileSync(stdoutFile, [
      'selected_candidate = array1d(1..1, [2]);', 'objective_value = 9;', '----------',
      'selected_candidate = array1d(1..1, [1]);', 'objective_value = 4;', '----------',
      '==========', ...GECODE_STATS, '',
    ].join('\n'));
    const result = await withEnv({ FAKE_MINIZINC_STDOUT_FILE: stdoutFile }, () =>
      fakeRunner().run('gecode', '/m/model.mzn', '', path.join(dir, 'tmp'), ['--time-limit', '1234']));
    assert.equal(result.code, 0);
    assert.equal(result.stdout,
      '{"selected_cand":[2],"objective_value":9}\n----------\n{"selected_cand":[1],"objective_value":4}\n----------\n==========\n');
    assert.doesNotMatch(result.stdout, /%/);
    assert.equal(result.oznRendered, false);
    assert.equal(result.gecodeStatistics?.values.nodes, 123456);
    assert.equal(result.gecodeStatistics?.values.failures, 61000);
    assert.equal(result.gecodeStatistics?.values.peak_depth, 17);
    assert.equal(result.gecodeStatistics?.values.runtime_ms, 29436);
    assert.equal(result.gecodeStatistics?.raw.length, GECODE_STATS.length);
    assert.match(result.stdoutEvents.map((event) => event.text).join(''), /%%  nodes:\s+123456/, 'the raw events are untouched');
  });

  it('parses the statistics of a proof that finishes without incumbents (=====UNSATISFIABLE=====)', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'stats-unsat-'));
    const stdoutFile = path.join(dir, 'stdout.txt');
    fs.writeFileSync(stdoutFile, ['=====UNSATISFIABLE=====', ...GECODE_STATS, ''].join('\n'));
    const result = await withEnv({ FAKE_MINIZINC_STDOUT_FILE: stdoutFile }, () =>
      fakeRunner().run('gecode', '/m/model.mzn', '', path.join(dir, 'tmp'), ['--time-limit', '1234']));
    assert.match(result.stdout, /=====UNSATISFIABLE=====/);
    assert.doesNotMatch(result.stdout, /%/);
    assert.equal(result.gecodeStatistics?.values.nodes, 123456);
  });

  it('does not send the statistics block to the .ozn rendering pass', async () => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'stats-ozn-'));
    const argsFile = path.join(dir, 'args.json');
    const stdoutFile = path.join(dir, 'stdout.txt');
    const stream = '{"selected_cand":[2],"objective_value":9}\n----------\n==========\n';
    fs.writeFileSync(stdoutFile, `${stream}${GECODE_STATS.join('\n')}\n`);
    const result = await withEnv({ FAKE_MINIZINC_ARGS_FILE: argsFile, FAKE_MINIZINC_STDOUT_FILE: stdoutFile }, () =>
      fakeRunner().run('gecode', '/m/model.mzn', '', path.join(dir, 'tmp'), ['--time-limit', '1234']));
    assert.equal(result.oznRendered, true);
    assert.equal(result.stdout, stream);
    const render = JSON.parse(fs.readFileSync(argsFile, 'utf8')).find((call: { phase: string }) => call.phase === 'render');
    assert.equal(render.stdinBytes, Buffer.byteLength(stream));
    assert.equal(result.gecodeStatistics?.values.nodes, 123456);
  });
});

describe('extractGecodeStatistics', () => {
  it('reads the Gecode block, normalising names and splitting times with a millisecond figure', () => {
    const { stdout, statistics } = extractGecodeStatistics(`----------\n${GECODE_STATS.join('\n')}\n`);
    assert.equal(stdout, '----------\n');
    assert.deepEqual(statistics?.values, {
      runtime_ms: 29436, solvetime_ms: 29100, solutions: 2, variables: 1532, propagators: 4210,
      propagations: 98765432, nodes: 123456, failures: 61000, restarts: 0, peak_depth: 17,
    });
    assert.deepEqual(statistics?.raw, GECODE_STATS.map((line) => line.trim()));
  });

  it('is absent when the solver printed no statistics, and leaves the stream byte for byte', () => {
    const stream = '{"selected_cand":[1],"objective_value":1}\n----------\n==========\n';
    assert.deepEqual(extractGecodeStatistics(stream), { stdout: stream });
    assert.deepEqual(extractGecodeStatistics(''), { stdout: '' });
  });

  it('reads the %%%mzn-stat form and keeps values it cannot read as numbers as text', () => {
    const { stdout, statistics } = extractGecodeStatistics(
      ['=====UNKNOWN=====', '%%%mzn-stat: nodes=77', '%%%mzn-stat: method="gecode"', '%%  runtime:       1:02.5', '%%%mzn-stat-end', ''].join('\n'));
    assert.equal(stdout, '=====UNKNOWN=====\n');
    assert.deepEqual(statistics?.values, { nodes: 77, method: '"gecode"', runtime: '1:02.5' });
    assert.equal(statistics?.raw.length, 4);
  });

  it('removes statistics wherever they are and never touches solution lines or markers', () => {
    const { stdout, statistics } = extractGecodeStatistics([
      '%%  nodes:         5', 'selected_candidate = array1d(1..1, [2]);', 'objective_value = 9;', '----------',
      '%% a free comment', '==========', '%%  failures:      1', '',
    ].join('\n'));
    assert.equal(stdout, 'selected_candidate = array1d(1..1, [2]);\nobjective_value = 9;\n----------\n%% a free comment\n==========\n');
    assert.deepEqual(statistics?.values, { nodes: 5, failures: 1 });
  });
});

describe('MiniZincRunner failure handling', () => {
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
    assert.deepEqual(commandFromEnv({ MINIZINC: '/opt/minizinc/bin/minizinc' }),
      { command: '/opt/minizinc/bin/minizinc', commandArgs: [] });
  });

  it('reads the FlatZinc solver from FZN_GECODE as a path or as a JSON array', () => {
    assert.deepEqual(gecodeCommandFromEnv({}), { gecodeCommand: 'fzn-gecode', gecodeCommandArgs: [] });
    assert.deepEqual(gecodeCommandFromEnv({ FZN_GECODE: '["node","/x/fake.mjs"]' }),
      { gecodeCommand: 'node', gecodeCommandArgs: ['/x/fake.mjs'] });
    assert.throws(() => gecodeCommandFromEnv({ FZN_GECODE: '[]' }), /FZN_GECODE/);
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
      // the group leader is the fzn-gecode process we spawned: a child of this process (the
      // short MiniZinc flattening phase before it is a different, earlier group)
      const child = allProcesses().find((p) => p.ppid === process.pid && p.pgrp === p.pid && p.state !== 'Z'
        && /fzn-gecode/.test(cmdline(p.pid)));
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
