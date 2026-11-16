/**
 * The IR expressions a problem's facts carry (a constraint's `expression`, `when` and `penalty`) as short formulas, such as
 * `features.latency ≤ 600`. They are printed, never evaluated: whether a rule holds is the gateway's answer.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const OPERATORS: Record<string, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  add: '+',
  sub: '−',
  mul: '×',
  div: '÷',
  pow: '^',
};

/** An expression of the compiled form as a short formula: `features.latency ≤ 600`. */
export function describeExpression(expression: unknown, depth = 0): string {
  if (!isRecord(expression) || depth > 8) return '…';
  const wrap = (inner: unknown) => {
    const shown = describeExpression(inner, depth + 1);
    return isRecord(inner) && ['and', 'or', 'compare', 'arithmetic'].includes(String(inner.kind))
      ? `(${shown})`
      : shown;
  };
  switch (expression.kind) {
    case 'literal': {
      const value = expression.value;
      if (value === null) return 'none';
      return typeof value === 'string' ? `“${value}”` : String(value);
    }
    case 'path':
      return list(expression.segments).map(String).join('.');
    case 'not':
      return `not ${wrap(expression.value)}`;
    case 'negate':
      return `−${wrap(expression.value)}`;
    case 'and':
      return `${wrap(expression.left)} and ${wrap(expression.right)}`;
    case 'or':
      return `${wrap(expression.left)} or ${wrap(expression.right)}`;
    case 'compare':
    case 'arithmetic':
      return `${wrap(expression.left)} ${OPERATORS[String(expression.op)] ?? String(expression.op)} ${wrap(expression.right)}`;
    case 'call':
      return `${String(expression.name)}(${list(expression.args)
        .map(arg => describeExpression(arg, depth + 1))
        .join(', ')})`;
    default:
      return '…';
  }
}

/** Is it the literal `true`, the `when` of a rule that always applies? */
export const isAlways = (expression: unknown): boolean =>
  isRecord(expression) && expression.kind === 'literal' && expression.value === true;
