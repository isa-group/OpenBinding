/** Structural input: what the gateway evaluated or what the engine claimed for one run. */
export interface RunValues {
  termination: string | null;
  solutions: Array<{
    features?: Record<string, unknown>;
    metrics?: Record<string, unknown>; // older shape, read when `features` is not an object
    score?: unknown; // number | number[]
    objectives?: { score?: unknown } & Record<string, unknown>; // canonical place of the score
  }>;
}

export type DiffValue =
  | { kind: 'number'; value: number }
  | { kind: 'list'; values: number[] }
  | { kind: 'text'; text: string | null }
  | { kind: 'absent' }
  | { kind: 'invalid' };

export type DiffField =
  | { kind: 'termination' }
  | { kind: 'solutions' }
  | { kind: 'feature'; name: string }
  | { kind: 'score'; component: number | null };

export interface DiffRow {
  solution: number | null;
  field: DiffField;
  claimed: DiffValue;
  evaluated: DiffValue;
}

export interface EvaluationDiffView {
  status: 'no-claim' | 'agrees' | 'differs';
  evaluated: { termination: string | null; solutions: number };
  claimed: { termination: string | null; solutions: number } | null;
  paired: boolean;
  rows: DiffRow[];
}

export const TOLERANCE = 1e-9;
export const MAX_ROWS = 100;
export const MAX_NOTES = 20;
export const MAX_TEXT = 500;

interface ReadSolution {
  features: Record<string, unknown> | null;
  score: unknown;
}
interface ReadRun {
  termination: string | null;
  solutions: ReadSolution[];
}

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

function readRun(run: unknown): ReadRun {
  const r = isPlain(run) ? run : {};
  const termination = typeof r.termination === 'string' ? r.termination : null;
  const list = Array.isArray(r.solutions) ? (r.solutions as unknown[]) : [];
  const solutions = list.map((s): ReadSolution => {
    if (!isPlain(s)) return { features: null, score: undefined };
    const features = isPlain(s.features) ? s.features : isPlain(s.metrics) ? s.metrics : null;
    const score = s.score !== undefined ? s.score : isPlain(s.objectives) ? s.objectives.score : undefined;
    return { features, score };
  });
  return { termination, solutions };
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function valueOf(raw: unknown, allowList: boolean): DiffValue {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (isNum(raw)) return { kind: 'number', value: raw };
  if (allowList && Array.isArray(raw) && raw.every(isNum)) return { kind: 'list', values: raw as number[] };
  return { kind: 'invalid' };
}

function same(a: DiffValue, b: DiffValue): boolean {
  if (a.kind === 'absent' && b.kind === 'absent') return true;
  if (a.kind === 'number' && b.kind === 'number') return Math.abs(a.value - b.value) <= TOLERANCE;
  return false;
}

/** Compares what an engine claimed with what the gateway evaluated; solutions are paired by position. */
// [impl->req~frontend-rendering-evaluation-diff~1]
export function evaluationDiffOf(evaluated: RunValues, claimed?: RunValues | null): EvaluationDiffView {
  const ev = readRun(evaluated);
  const evSide = { termination: ev.termination, solutions: ev.solutions.length };
  if (claimed === undefined || claimed === null) {
    return { status: 'no-claim', evaluated: evSide, claimed: null, paired: false, rows: [] };
  }
  const cl = readRun(claimed);
  const rows: DiffRow[] = [];
  if (cl.termination !== ev.termination) {
    rows.push({
      solution: null,
      field: { kind: 'termination' },
      claimed: { kind: 'text', text: cl.termination },
      evaluated: { kind: 'text', text: ev.termination },
    });
  }
  const paired = cl.solutions.length === ev.solutions.length;
  if (!paired) {
    rows.push({
      solution: null,
      field: { kind: 'solutions' },
      claimed: { kind: 'number', value: cl.solutions.length },
      evaluated: { kind: 'number', value: ev.solutions.length },
    });
  } else {
    ev.solutions.forEach((e, i) => {
      const c = cl.solutions[i];
      const solution = i + 1;
      const eKeys = e.features ? Object.keys(e.features) : [];
      const cKeys = c.features ? Object.keys(c.features) : [];
      const names = [...eKeys, ...cKeys.filter((k) => !eKeys.includes(k))];
      for (const name of names) {
        const cv = valueOf(c.features ? own(c.features, name) : undefined, false);
        const ev2 = valueOf(e.features ? own(e.features, name) : undefined, false);
        if (!same(cv, ev2)) rows.push({ solution, field: { kind: 'feature', name }, claimed: cv, evaluated: ev2 });
      }
      const cs = valueOf(c.score, true);
      const es = valueOf(e.score, true);
      if (cs.kind === 'list' && es.kind === 'list' && cs.values.length === es.values.length) {
        es.values.forEach((v, k) => {
          const a: DiffValue = { kind: 'number', value: cs.values[k] };
          const b: DiffValue = { kind: 'number', value: v };
          if (!same(a, b)) rows.push({ solution, field: { kind: 'score', component: k + 1 }, claimed: a, evaluated: b });
        });
      } else if (!same(cs, es)) {
        rows.push({ solution, field: { kind: 'score', component: null }, claimed: cs, evaluated: es });
      }
    });
  }
  return {
    status: rows.length === 0 ? 'agrees' : 'differs',
    evaluated: evSide,
    claimed: { termination: cl.termination, solutions: cl.solutions.length },
    paired,
    rows,
  };
}

/** Keeps the first MAX_TEXT code points of engine text and marks the cut with an ellipsis. */
// [impl->req~frontend-rendering-evaluation-diff~1]
export function shortText(text: string): string {
  const points = Array.from(text);
  return points.length <= MAX_TEXT ? text : `${points.slice(0, MAX_TEXT).join('')}…`;
}
