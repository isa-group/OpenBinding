import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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

export class MiniZincRunner {
  /**
   * Flatten the model, widen the FlatZinc float domains, solve with fzn-gecode
   * and format the incumbents with the model's output item (solns2out).
   *
   * `extraArgs` keeps the historical shape `['--time-limit', ms, ...]`; the
   * time budget covers flattening and solving together.
   */
  async run(
    solverName: string,
    modelPath: string,
    dznContent: string,
    tmpDir: string,
    extraArgs: string[] = []
  ): Promise<MiniZincRunResult> {
    if (solverName !== 'gecode') throw new Error(`Unsupported solver '${solverName}'`);
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const timeLimitMs = this.timeLimit(extraArgs);
    const stem = path.join(tmpDir, `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const dznPath = `${stem}.dzn`;
    const fznPath = `${stem}.fzn`;
    const oznPath = `${stem}.ozn`;
    const widenedPath = `${stem}.widened.fzn`;
    const env = { ...process.env, TMPDIR: tmpDir };
    const startTime = Date.now();
    try {
      fs.writeFileSync(dznPath, dznContent);
      const flatten = await this.spawn(this.executable('MINIZINC', 'minizinc'),
        ['--solver', 'gecode', '-c', modelPath, dznPath, '--fzn', fznPath, '--ozn', oznPath],
        env, timeLimitMs, startTime);
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
      const solve = await this.spawn(this.executable('FZN_GECODE', 'fzn-gecode'),
        ['-a', '-time', String(Math.round(remainingMs)), widenedPath], env, remainingMs + 2000, startTime);
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
        const output = await this.spawn(this.executable('MINIZINC', 'minizinc'), ['--ozn-file', oznPath], env,
          OZN_RENDER_TIMEOUT_MS, startTime, solve.stdout);
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

  private executable(variable: string, fallback: string): string {
    const value = process.env[variable];
    return value && value.trim() ? value.trim() : fallback;
  }

  private timeLimit(extraArgs: string[]): number {
    const index = extraArgs.indexOf('--time-limit');
    const value = index >= 0 ? Number(extraArgs[index + 1]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : 30000;
  }

  private spawn(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number,
      startTime: number, stdin?: string): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const events: MiniZincStdoutEvent[] = [];
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        events.push({ atMs: Date.now() - startTime, text });
      });
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, events, timedOut }); });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
