export type BoundOp = 'lt' | 'lte' | 'gt' | 'gte';

export interface QoSBound {
  /** The constraint's `ref.id`. */
  rule: string;
  /** The quality: `latency` for the path `features.latency`. */
  feature: string;
  /** As read with the quality on the left (flipped when the number is on the left). */
  op: BoundOp;
  limit: number;
  /** `features[feature]` when a finite number, else null. */
  value: number | null;
  unit: string | null;
  enforcement: 'hard' | 'soft';
  /** From the gateway's violations only; the browser never compares value and limit. */
  met: boolean | null;
  /** Only when `met` is false and the enforcement is soft. */
  penalty?: number;
}

export interface QoSRule {
  rule: string;
  /** The assert as a formula, or the violation's message. */
  text: string;
  /** The `when` as a formula; null when absent or the literal true. */
  when: string | null;
  enforcement: 'hard' | 'soft';
  met: boolean | null;
  penalty?: number;
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const OPERATORS: Record<string, string> = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', add: '+', sub: '−', mul: '×', div: '÷', pow: '^' };
const FLIPPED: Record<BoundOp, BoundOp> = { lt: 'gt', lte: 'gte', gt: 'lt', gte: 'lte' };
const FALLBACK_TEXT = 'Reported by the gateway; not a rule of the compiled problem.';

/** An expression of the compiled form as a short formula: `features.latency ≤ 600`. */
function describe(expression: unknown, depth = 0): string {
  if (!isRecord(expression) || depth > 8) return '…';
  const wrap = (inner: unknown) => {
    const shown = describe(inner, depth + 1);
    return isRecord(inner) && ['and', 'or', 'compare', 'arithmetic'].includes(String(inner.kind)) ? `(${shown})` : shown;
  };
  switch (expression.kind) {
    case 'literal': {
      const value = expression.value;
      if (value === null) return 'none';
      return typeof value === 'string' ? `“${value}”` : String(value);
    }
    case 'path':
      return list(expression.segments).map(String).join('.');
    case 'not': return `not ${wrap(expression.value)}`;
    case 'negate': return `−${wrap(expression.value)}`;
    case 'and': return `${wrap(expression.left)} and ${wrap(expression.right)}`;
    case 'or': return `${wrap(expression.left)} or ${wrap(expression.right)}`;
    case 'compare':
    case 'arithmetic':
      return `${wrap(expression.left)} ${OPERATORS[String(expression.op)] ?? String(expression.op)} ${wrap(expression.right)}`;
    case 'call':
      return `${String(expression.name)}(${list(expression.args).map((arg) => describe(arg, depth + 1)).join(', ')})`;
    default: return '…';
  }
}

const isAlways = (expression: unknown) => isRecord(expression) && expression.kind === 'literal' && expression.value === true;

/** The comparisons of an assert joined only by `and`, left to right; null when any conjunct is something else. */
function conjuncts(expression: unknown, depth = 0): Rec[] | null {
  if (!isRecord(expression) || depth > 24) return null;
  if (expression.kind === 'and') {
    const left = conjuncts(expression.left, depth + 1);
    const right = left && conjuncts(expression.right, depth + 1);
    return left && right ? [...left, ...right] : null;
  }
  return [expression];
}

const featureOf = (node: unknown): string | null => {
  if (!isRecord(node) || node.kind !== 'path') return null;
  const segments = list(node.segments);
  return segments.length === 2 && segments[0] === 'features' ? text(segments[1]) : null;
};

const numberOf = (node: unknown): number | null => (isRecord(node) && node.kind === 'literal' ? finite(node.value) : null);

function boundOf(node: Rec): { feature: string; op: BoundOp; limit: number } | null {
  if (node.kind !== 'compare') return null;
  const op = String(node.op);
  if (op !== 'lt' && op !== 'lte' && op !== 'gt' && op !== 'gte') return null;
  const left = featureOf(node.left);
  const right = numberOf(node.right);
  if (left !== null && right !== null) return { feature: left, op, limit: right };
  const flipped = featureOf(node.right);
  const limit = numberOf(node.left);
  return flipped !== null && limit !== null ? { feature: flipped, op: FLIPPED[op], limit } : null;
}

interface Violation { resource: string; id: string; soft: boolean; penalty: number | null; message: string | null }

const readViolations = (violations: unknown): Violation[] | null => {
  if (!Array.isArray(violations)) return null;
  const used: Violation[] = [];
  for (const entry of violations) {
    const constraint = isRecord(entry) ? entry.constraint : null;
    const id = isRecord(constraint) ? text(constraint.id) : null;
    if (!isRecord(entry) || !isRecord(constraint) || id === null) continue;
    const penalty = finite(entry.penalty);
    used.push({
      resource: typeof constraint.resource === 'string' ? constraint.resource : '',
      id,
      soft: entry.enforcement === 'soft',
      penalty: penalty !== null && penalty >= 0 ? penalty : null,
      message: text(entry.message),
    });
  }
  return used;
};

const penaltyOf = (matches: Violation[]) => matches.reduce((sum, v) => sum + (v.penalty ?? 0), 0);

/** Bounds and rules of the compiled form's constraints, with the status taken from the gateway's violations only. */
// [impl->req~frontend-rendering-qos-against-bounds~1]
export function qosBoundsOf(
  constraints: unknown,
  features: Record<string, unknown> | null | undefined,
  violations: unknown,
  units?: Record<string, string | null>,
): { bounds: QoSBound[]; rules: QoSRule[] } {
  const reported = readViolations(violations);
  const bounds: QoSBound[] = [];
  const rules: QoSRule[] = [];
  const matched = new Set<Violation>();
  const values = isRecord(features) ? features : {};

  for (const entry of list(constraints)) {
    if (!isRecord(entry) || !isRecord(entry.ref)) continue;
    const rule = text(entry.ref.id);
    if (rule === null) continue;
    const resource = typeof entry.ref.resource === 'string' ? entry.ref.resource : '';
    const enforcement = entry.enforcement === 'soft' ? 'soft' : 'hard';
    const matches = reported === null ? [] : reported.filter((v) => v.id === rule && v.resource === resource);
    matches.forEach((v) => matched.add(v));
    const met = reported === null ? null : matches.length === 0;
    const status = { enforcement, met, ...(met === false && enforcement === 'soft' ? { penalty: penaltyOf(matches) } : {}) } as const;

    const always = entry.when === undefined || entry.when === null || isAlways(entry.when);
    const parts = always ? conjuncts(entry.assert) : null;
    const read = parts?.map(boundOf);
    if (parts && read && read.every((b) => b !== null)) {
      for (const b of read) {
        const value = finite(values[b.feature]);
        const unit = text(units?.[b.feature]);
        bounds.push({ rule, feature: b.feature, op: b.op, limit: b.limit, value, unit, ...status });
      }
    } else {
      rules.push({ rule, text: describe(entry.assert), when: always ? null : describe(entry.when), ...status });
    }
  }

  const seen = new Set<string>();
  for (const v of reported ?? []) {
    const key = `${v.resource}\u0000${v.id}`;
    if (matched.has(v) || seen.has(key)) continue;
    seen.add(key);
    const group = (reported ?? []).filter((o) => o.resource === v.resource && o.id === v.id && !matched.has(o));
    rules.push({
      rule: v.id,
      text: group.find((o) => o.message !== null)?.message ?? FALLBACK_TEXT,
      when: null,
      enforcement: v.soft ? 'soft' : 'hard',
      met: false,
      ...(v.soft ? { penalty: penaltyOf(group) } : {}),
    });
  }
  return { bounds, rules };
}
