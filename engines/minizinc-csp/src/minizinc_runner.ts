import { spawn } from 'child_process';
import * as fs from 'fs';
import { AbortedError, NotTerminatedError, envInteger } from './job_manager';

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
}

export interface RunnerOptions {
  /** Executable to run; `minizinc` by default. */
  command?: string;
  /** Arguments placed before the MiniZinc ones (e.g. a script when `command` is `node`). */
  commandArgs?: string[];
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

/** `MINIZINC_COMMAND` is a program path or a JSON array `["program","arg",...]`. */
export function commandFromEnv(env: NodeJS.ProcessEnv): { command: string; commandArgs: string[] } {
  const raw = env.MINIZINC_COMMAND;
  if (raw === undefined || raw.trim() === '') return { command: 'minizinc', commandArgs: [] };
  if (raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0
        || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error('MINIZINC_COMMAND must be a program path or a JSON array of non-empty strings');
    }
    return { command: parsed[0], commandArgs: parsed.slice(1) };
  }
  return { command: raw.trim(), commandArgs: [] };
}

export function runnerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerOptions {
  return {
    ...commandFromEnv(env),
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
  private readonly extraEnv: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly reapWaitMs: number;
  private readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void;

  constructor(options: RunnerOptions = {}) {
    const merged = { ...runnerOptionsFromEnv(), ...options };
    this.command = merged.command ?? 'minizinc';
    this.commandArgs = merged.commandArgs ?? [];
    this.extraEnv = merged.env ?? {};
    this.killGraceMs = merged.killGraceMs ?? 2000;
    this.reapWaitMs = merged.reapWaitMs ?? 3000;
    this.signalGroup = merged.signalGroup ?? signalProcessGroup;
  }

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
    const args = [...this.commandArgs, '--solver', solverName, ...extraArgs, modelPath, '-'];

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const env = { ...process.env, ...this.extraEnv, TMPDIR: tmpDir };
    const startTime = Date.now();

    return new Promise<MiniZincRunResult>((resolve, reject) => {
      // Its own process group: pid === pgid, so the solver and whatever it starts can be signalled together.
      const minizinc = spawn(this.command, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const pgid = minizinc.pid;
      if (pgid !== undefined) {
        installExitHook();
        liveGroups.add(pgid);
      }

      let stdout = '';
      let stderr = '';
      const stdoutEvents: MiniZincStdoutEvent[] = [];
      let done = false;
      let aborting = false;
      let markClosed!: () => void;
      const closed = new Promise<void>((resolveClosed) => { markClosed = resolveClosed; });

      const settle = (action: () => void, forget = true): void => {
        if (done) return;
        done = true;
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

      minizinc.stdout!.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        stdoutEvents.push({ atMs: Date.now() - startTime, text });
      });
      minizinc.stderr!.on('data', (data) => {
        stderr += data.toString();
      });
      // A solver that dies before reading its input closes the pipe: 'close' reports the outcome.
      minizinc.stdin!.on('error', () => undefined);

      minizinc.on('error', (err) => {
        markClosed();
        settle(() => reject(err));
      });

      minizinc.on('close', (code) => {
        markClosed();
        if (aborting) return; // the termination routine decides the outcome
        const durationMs = Date.now() - startTime;
        settle(() => resolve({ code, stdout, stderr, durationMs, stdoutEvents }));
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      minizinc.stdin!.write(dznContent);
      minizinc.stdin!.end();
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
