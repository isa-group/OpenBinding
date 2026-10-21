import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AbortedError, NotTerminatedError, envInteger } from './job_manager';
import { FLOAT_DOMAIN_SLACK, slackOf } from './numeric';

export { FLOAT_DOMAIN_SLACK };

export interface MiniZincStdoutEvent {
  atMs: number;
  text: string;
}

export interface MiniZincRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutEvents: MiniZincStdoutEvent[];
  /** Wall time spent flattening (MiniZinc -> FlatZinc) before the solver started. */
  flattenMs?: number;
  /** Number of FlatZinc float domains that were widened before solving. */
  widenedDomains?: number;
  suppressedFloatBranchers?: number;
  /** True when the solver stream had to be rendered through the `.ozn` output specification. */
  oznRendered?: boolean;
}

/** Budget for the (rare) `.ozn` rendering pass; it reads an already complete solver stream. */
const OZN_RENDER_TIMEOUT_MS = 60000;

type ProcessResult = { code: number | null; stdout: string; stderr: string; events: MiniZincStdoutEvent[]; timedOut: boolean };

/**
 * Relative/absolute slack applied to every bounded FlatZinc float domain.
 *
 * MiniZinc derives the domain of every introduced float variable from the
 * parameter data (sums, products, logarithms and normalisations of candidate
 * values) and prints it with finite precision; Gecode then propagates the same
 * arithmetic with outward rounding. Whenever the optimum sits exactly on such a
 * derived bound -- the best candidate of every task, a product that attains its
 * maximum, a normalised loss of exactly 0 or 1 -- the attainable value can land
 * one ulp outside the printed domain and the solver reports a false
 * UNSATISFIABLE or a false optimum. Widening the domains by a slack several
 * orders of magnitude above double rounding (and far below any benchmark
 * tolerance) makes the lowering robust without changing the model semantics:
 * domains are relaxations, so no solution is lost, and every returned decision
 * is re-evaluated exactly by the engine and by the gateway anyway.
 *
 * The slack itself (`FLOAT_DOMAIN_SLACK`, `slackOf`) lives in `numeric.ts`
 * because the lowering applies the same slack to the technical bounds and to
 * the comparison literals it prints into the data file: MiniZinc prints float
 * literals with 16 significant digits, so a bound that leaves the lowering
 * tight can become an explicit `float_le` with a constant one ulp below the
 * attainable value, which this post-processing does not (and must not,
 * since it cannot tell technical bounds from user constraints) rewrite.
 */

const FLOAT_LITERAL = '(-?(?:\\d+\\.\\d+(?:[eE][-+]?\\d+)?|\\d+[eE][-+]?\\d+))';
const FLOAT_DOMAIN = new RegExp(`var ${FLOAT_LITERAL}\\.\\.${FLOAT_LITERAL}:`, 'g');

export function widenFloatDomains(flatzinc: string): { text: string; count: number; dropped: number; suppressed: number } {
  // Variables that no constraint, solve item or output annotation references are
  // dead flattening residue (e.g. a normalised loss whose term is constant). They
  // are harmless while their domain is a single value, but once widened the
  // solver would have to branch on them; drop them instead.
  const lines = flatzinc.split('\n');
  const referenced = new Set<string>();
  const identifier = /[A-Za-z_][A-Za-z0-9_]*/g;
  for (const line of lines) {
    if (line.startsWith('constraint') || line.startsWith('solve')) {
      for (const match of line.matchAll(identifier)) referenced.add(match[0]);
    }
  }
  let dropped = 0;
  const kept = lines.filter((line) => {
    const declaration = line.match(/^(?:array \[[^\]]*\] of )?var [^:]*: ([A-Za-z_][A-Za-z0-9_]*)\s*(::[^=;]*)?(=[^;]*)?;\s*$/);
    if (!declaration) return true;
    const [, name, annotations = '', assignment = ''] = declaration;
    if (assignment || referenced.has(name) || /output_(var|array)/.test(annotations)) return true;
    // Keep variables that other declarations use (e.g. an alias array built from them).
    if (lines.some((other) => other !== line && !other.startsWith('constraint') && other.includes(name))) return true;
    dropped += 1;
    return false;
  });
  let count = 0;
  let suppressed = 0;
  const text = kept.map((line) => {
    const widened = line.replace(FLOAT_DOMAIN, (_match, lowText: string, highText: string) => {
      const low = Number(lowText);
      const high = Number(highText);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return _match;
      const slack = slackOf(Math.max(Math.abs(low), Math.abs(high)));
      count += 1;
      return `var ${formatFloat(low - slack)}..${formatFloat(high + slack)}:`;
    });
    // Every float of the model is a function of the slot variables. Gecode's FlatZinc
    // front-end nevertheless appends a default float brancher for any float that is
    // neither introduced-and-defined nor searched, and splitting intervals that
    // propagation keeps a few ulps wide multiplies the search tree (millions of nodes
    // on instances that need a hundred). Declaring each float functionally defined
    // removes that brancher; the int_search on the slots alone decides every value.
    const declaration = widened.match(/^var (float|-?[0-9][^:]*):\s*([A-Za-z_][A-Za-z0-9_]*)\s*((?:::[^=;]*)?)(=[^;]*)?;\s*$/);
    if (declaration) {
      const [, type, name, annotations, assignment] = declaration;
      const isFloat = type === 'float' || /\d\.\d|\de[+-]?\d/.test(type);
      if (isFloat && !assignment && !/is_defined_var/.test(annotations)) {
        suppressed += 1;
        const kept = annotations.trim();
        return `var ${type}: ${name}${kept ? ` ${kept}` : ''} :: is_defined_var;`;
      }
    }
    return widened;
  }).join('\n');
  return { text, count, dropped, suppressed };
}

/**
 * Convert raw FlatZinc solution blocks (`selected_candidate = array1d(1..n, [...]);`
 * and `objective_value = x;`) into the JSON lines the solver adapter consumes,
 * preserving the `----------` / `==========` / `=====UNSATISFIABLE=====` markers.
 */
export function renderSolverOutput(raw: string): string {
  return renderSolverOutputDetailed(raw).text;
}

/**
 * Fast rendering of the solver stream. `incomplete` counts the solution blocks
 * that could not be rendered because the solver printed neither
 * `selected_candidate` nor `objective_value` for them: MiniZinc moves output
 * variables that are fixed at flattening time (every candidate decided by
 * propagation, an objective that is a constant) into the `.ozn` output
 * specification instead of the FlatZinc, so the solver has nothing to print
 * for them. Such blocks are rendered by the `.ozn` pass of `MiniZincRunner`.
 */
export function renderSolverOutputDetailed(raw: string): { text: string; incomplete: number } {
  const lines: string[] = [];
  let selected: string | null = null;
  let objective: string | null = null;
  let incomplete = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const candidates = text.match(/^selected_candidate\s*=\s*array1d\([^,]*,\s*\[([^\]]*)\]\);$/);
    if (candidates) { selected = candidates[1].replace(/\s+/g, ''); continue; }
    const objectiveMatch = text.match(/^objective_value\s*=\s*([^;]+);$/);
    if (objectiveMatch) { objective = objectiveMatch[1].trim(); continue; }
    if (text === '----------') {
      if (selected !== null && objective !== null) lines.push(`{"selected_cand":[${selected}],"objective_value":${objective}}`);
      else incomplete += 1;
      lines.push(text);
      selected = null; objective = null;
      continue;
    }
    if (text.startsWith('=====') || text.startsWith('%')) { lines.push(text); continue; }
    lines.push(text);
  }
  return { text: `${lines.join('\n')}\n`, incomplete };
}

function formatFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export interface RunnerOptions {
  /** MiniZinc executable (flattening and `.ozn` rendering); `minizinc` by default. */
  command?: string;
  /** Arguments placed before the MiniZinc ones (e.g. a script when `command` is `node`). */
  commandArgs?: string[];
  /** FlatZinc solver executable; `fzn-gecode` by default. */
  gecodeCommand?: string;
  /** Arguments placed before the fzn-gecode ones. */
  gecodeCommandArgs?: string[];
  /** Extra environment for the solver process (on top of the engine's own). */
  env?: Record<string, string>;
  /** After SIGTERM the process group gets this long before SIGKILL. */
  killGraceMs?: number;
  /** After the grace, how long to wait for the process to be reaped before giving up. */
  reapWaitMs?: number;
  /** Test hook: how a signal reaches the process group. */
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
}

export interface RunControl {
  /** Aborting it terminates the whole process group and settles the run only once it is gone. */
  signal?: AbortSignal;
}

/** A program path or a JSON array `["program","arg",...]` read from `variable`. */
function parseCommand(raw: string | undefined, variable: string, fallback: string): { command: string; commandArgs: string[] } {
  if (raw === undefined || raw.trim() === '') return { command: fallback, commandArgs: [] };
  if (raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0
        || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error(`${variable} must be a program path or a JSON array of non-empty strings`);
    }
    return { command: parsed[0], commandArgs: parsed.slice(1) };
  }
  return { command: raw.trim(), commandArgs: [] };
}

/**
 * `MINIZINC_COMMAND` (or the older `MINIZINC`) is a program path or a JSON array `["program","arg",...]`.
 */
export function commandFromEnv(env: NodeJS.ProcessEnv): { command: string; commandArgs: string[] } {
  if (env.MINIZINC_COMMAND !== undefined && env.MINIZINC_COMMAND.trim() !== '') {
    return parseCommand(env.MINIZINC_COMMAND, 'MINIZINC_COMMAND', 'minizinc');
  }
  return parseCommand(env.MINIZINC, 'MINIZINC', 'minizinc');
}

/** `FZN_GECODE` is the FlatZinc solver: a program path or a JSON array `["program","arg",...]`. */
export function gecodeCommandFromEnv(env: NodeJS.ProcessEnv): { gecodeCommand: string; gecodeCommandArgs: string[] } {
  const { command, commandArgs } = parseCommand(env.FZN_GECODE, 'FZN_GECODE', 'fzn-gecode');
  return { gecodeCommand: command, gecodeCommandArgs: commandArgs };
}

export function runnerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerOptions {
  return {
    ...commandFromEnv(env),
    ...gecodeCommandFromEnv(env),
    killGraceMs: envInteger(env, 'ENGINE_KILL_GRACE_MS', 2000, 0, 60_000),
    reapWaitMs: envInteger(env, 'ENGINE_REAP_WAIT_MS', 3000, 0, 60_000),
  };
}

/** Sends a signal to a whole process group. A group that is already gone is not an error. */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Whether any live process belongs to the group. Zombies do not count: they use no CPU and only
 * wait for their parent (or init) to reap them. Reads /proc where it exists.
 */
export function groupAlive(pgid: number): boolean {
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    const end = stat.lastIndexOf(')');
    if (end < 0) continue;
    const fields = stat.slice(end + 2).split(' ');
    // fields: state, ppid, pgrp, ...
    if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
  }
  return false;
}

// Solver groups are detached from the engine's own, so they would outlive it if it exited. They are
// killed when the engine exits normally; if the engine itself is killed (SIGKILL, OOM) nothing can run,
// which is a documented failure mode (the container runtime ends the whole cgroup).
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pgid of liveGroups) {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonOf(signal?: AbortSignal): string {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason.message : 'aborted';
}

export class MiniZincRunner {
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly gecodeCommand: string;
  private readonly gecodeCommandArgs: string[];
  private readonly extraEnv: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly reapWaitMs: number;
  private readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void;

  constructor(options: RunnerOptions = {}) {
    const merged = { ...runnerOptionsFromEnv(), ...options };
    this.command = merged.command ?? 'minizinc';
    this.commandArgs = merged.commandArgs ?? [];
    this.gecodeCommand = merged.gecodeCommand ?? 'fzn-gecode';
    this.gecodeCommandArgs = merged.gecodeCommandArgs ?? [];
    this.extraEnv = merged.env ?? {};
    this.killGraceMs = merged.killGraceMs ?? 2000;
    this.reapWaitMs = merged.reapWaitMs ?? 3000;
    this.signalGroup = merged.signalGroup ?? signalProcessGroup;
  }

  /**
   * Flatten the model, widen the FlatZinc float domains, solve with fzn-gecode
   * and format the incumbents with the model's output item (solns2out).
   *
   * `extraArgs` keeps the historical shape `['--time-limit', ms, ...]`; the
   * time budget covers flattening and solving together. Every phase runs in its
   * own process group; aborting `control.signal` terminates the group of the
   * phase that is running and the run rejects only once that group is gone.
   */
  async run(
    solverName: string,
    modelPath: string,
    dznContent: string,
    tmpDir: string,
    extraArgs: string[] = [],
    control: RunControl = {},
  ): Promise<MiniZincRunResult> {
    const signal = control.signal;
    if (signal?.aborted) throw new AbortedError(reasonOf(signal));
    if (solverName !== 'gecode') throw new Error(`Unsupported solver '${solverName}'`);
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const timeLimitMs = this.timeLimit(extraArgs);
    const stem = path.join(tmpDir, `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const dznPath = `${stem}.dzn`;
    const fznPath = `${stem}.fzn`;
    const oznPath = `${stem}.ozn`;
    const widenedPath = `${stem}.widened.fzn`;
    const env = { ...process.env, ...this.extraEnv, TMPDIR: tmpDir };
    const startTime = Date.now();
    try {
      fs.writeFileSync(dznPath, dznContent);
      const flatten = await this.spawn(this.command, this.commandArgs,
        ['--solver', 'gecode', '-c', modelPath, dznPath, '--fzn', fznPath, '--ozn', oznPath],
        env, timeLimitMs, startTime, signal);
      const flattenMs = Date.now() - startTime;
      if (flatten.timedOut) {
        return { code: 0, stdout: '', stderr: flatten.stderr, durationMs: Date.now() - startTime, stdoutEvents: [], flattenMs };
      }
      const inconsistent = flatten.stdout.includes('=====UNSATISFIABLE=====')
        || flatten.stderr.includes('model inconsistency detected');
      if (inconsistent) {
        return { code: 0, stdout: '=====UNSATISFIABLE=====\n', stderr: flatten.stderr, durationMs: Date.now() - startTime, stdoutEvents: [], flattenMs };
      }
      if (flatten.code !== 0 || !fs.existsSync(fznPath) || !fs.existsSync(oznPath)) {
        return { code: flatten.code === 0 ? 1 : flatten.code, stdout: flatten.stdout, stderr: flatten.stderr || 'MiniZinc produced no FlatZinc',
          durationMs: Date.now() - startTime, stdoutEvents: [], flattenMs };
      }
      const widened = widenFloatDomains(fs.readFileSync(fznPath, 'utf8'));
      fs.writeFileSync(widenedPath, widened.text);
      const remainingMs = Math.max(1, timeLimitMs - flattenMs);
      const solve = await this.spawn(this.gecodeCommand, this.gecodeCommandArgs,
        ['-a', '-time', String(Math.round(remainingMs)), widenedPath], env, remainingMs + 2000, startTime, signal);
      if (solve.code !== 0 && !solve.timedOut) {
        return { code: solve.code, stdout: solve.stdout, stderr: solve.stderr, durationMs: Date.now() - startTime,
          stdoutEvents: solve.events, flattenMs, widenedDomains: widened.count, suppressedFloatBranchers: widened.suppressed };
      }
      // The FlatZinc output variables are rendered from the solver stream directly. When a
      // solution block carries no `selected_candidate` or `objective_value` line, MiniZinc
      // fixed that output at flattening time (every candidate decided by propagation, a
      // constant objective) and only the `.ozn` output specification can render it: that
      // is the one case where the stream goes through MiniZinc's own solns2out pass.
      const rendered = renderSolverOutputDetailed(solve.stdout);
      let stdout = rendered.text;
      let oznRendered = false;
      if (rendered.incomplete > 0) {
        const output = await this.spawn(this.command, this.commandArgs, ['--ozn-file', oznPath], env,
          OZN_RENDER_TIMEOUT_MS, startTime, signal, solve.stdout);
        if (output.code !== 0 || output.timedOut) {
          return { code: output.code === 0 ? 1 : output.code, stdout: solve.stdout,
            stderr: output.stderr || 'MiniZinc could not render the solver output with the .ozn specification',
            durationMs: Date.now() - startTime, stdoutEvents: solve.events, flattenMs,
            widenedDomains: widened.count, suppressedFloatBranchers: widened.suppressed };
        }
        stdout = output.stdout;
        oznRendered = true;
      }
      return { code: 0, stdout, stderr: solve.stderr, durationMs: Date.now() - startTime,
        stdoutEvents: solve.events, flattenMs, widenedDomains: widened.count, suppressedFloatBranchers: widened.suppressed,
        oznRendered };
    } finally {
      for (const file of [dznPath, fznPath, oznPath, widenedPath]) {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
      }
    }
  }

  private timeLimit(extraArgs: string[]): number {
    const index = extraArgs.indexOf('--time-limit');
    const value = index >= 0 ? Number(extraArgs[index + 1]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : 30000;
  }

  /**
   * One phase of a run (flatten, solve or render). The process is the leader of
   * its own group (pid === pgid), so MiniZinc, fzn-gecode and whatever they start
   * are signalled together: on the phase timeout the group is killed, and on an
   * abort it is terminated (SIGTERM, then SIGKILL) and the promise rejects with
   * `AbortedError` once nothing of it is alive, or `NotTerminatedError` otherwise.
   */
  private spawn(command: string, commandArgs: string[], args: string[], env: NodeJS.ProcessEnv,
      timeoutMs: number, startTime: number, signal?: AbortSignal, stdin?: string): Promise<ProcessResult> {
    if (signal?.aborted) return Promise.reject(new AbortedError(reasonOf(signal)));
    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, [...commandArgs, ...args], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const pgid = child.pid;
      if (pgid !== undefined) {
        installExitHook();
        liveGroups.add(pgid);
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const events: MiniZincStdoutEvent[] = [];
      let done = false;
      let aborting = false;
      let markClosed!: () => void;
      const closed = new Promise<void>((resolveClosed) => { markClosed = resolveClosed; });

      const timer = setTimeout(() => {
        if (done || aborting || pgid === undefined) return;
        timedOut = true;
        try { this.signalGroup(pgid, 'SIGKILL'); } catch { /* 'close' reports the outcome */ }
      }, timeoutMs);

      const settle = (action: () => void, forget = true): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (forget && pgid !== undefined) liveGroups.delete(pgid);
        action();
      };

      const onAbort = (): void => {
        if (done || aborting) return;
        aborting = true;
        void this.terminate(pgid, closed).then((dead) => {
          if (dead) settle(() => reject(new AbortedError(reasonOf(signal))));
          else {
            settle(() => reject(new NotTerminatedError(
              `solver process group ${pgid} is still alive ${this.killGraceMs + this.reapWaitMs} ms after SIGTERM/SIGKILL`)), false);
          }
        });
      };

      child.stdout!.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        events.push({ atMs: Date.now() - startTime, text });
      });
      child.stderr!.on('data', (data) => { stderr += data.toString(); });
      // A process that dies before reading its input closes the pipe: 'close' reports the outcome.
      child.stdin!.on('error', () => undefined);
      child.on('error', (error) => {
        markClosed();
        settle(() => reject(error));
      });
      child.on('close', (code) => {
        markClosed();
        if (aborting) return; // the termination routine decides the outcome
        settle(() => resolve({ code, stdout, stderr, events, timedOut }));
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      if (stdin !== undefined) child.stdin!.write(stdin);
      child.stdin!.end();
    });
  }

  /**
   * SIGTERM to the group, SIGKILL after the grace, then wait for the leader to be reaped (the 'close'
   * event) and for every other member of the group to be gone. `true` only when nothing of the group
   * is alive any more.
   */
  private async terminate(pgid: number | undefined, closed: Promise<void>): Promise<boolean> {
    if (pgid === undefined) return true;
    const deadline = Date.now() + this.killGraceMs + this.reapWaitMs;
    const send = (signal: NodeJS.Signals): void => {
      try { this.signalGroup(pgid, signal); } catch { /* the liveness check below tells the truth */ }
    };
    send('SIGTERM');
    const killer = setTimeout(() => send('SIGKILL'), this.killGraceMs);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        void closed.then(() => { clearTimeout(timer); resolve(); });
      });
      while (groupAlive(pgid) && Date.now() < deadline) await sleep(20);
    } finally {
      clearTimeout(killer);
    }
    if (!groupAlive(pgid)) return true;
    send('SIGKILL');
    return false;
  }
}
