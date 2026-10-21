export const fmt = (values: any[]): string => `[${values.join(', ')}]`;

export const fmt2d = (rows: any[][]): string =>
  rows.length === 0 ? '[| |]' : `[| ${rows.map((row) => row.join(', ')).join(' | ')} |]`;

/**
 * MiniZinc float literal. JavaScript prints integral doubles without a decimal
 * point (and very large ones without an exponent), which MiniZinc would lex as
 * an (invalid) integer literal; every float parameter therefore goes through here.
 */
export const fmtFloat = (value: any): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Non-finite float in DZN: ${String(value)}`);
  if (numeric === 0) return '0.0';
  const magnitude = Math.abs(numeric);
  if (magnitude >= 1e15 || magnitude < 1e-6) return numeric.toExponential();
  const text = String(numeric);
  return /[.eE]/.test(text) ? text : `${text}.0`;
};

export const fmtF = (values: any[]): string => fmt(values.map(fmtFloat));

export const fmt2dF = (rows: any[][]): string => fmt2d(rows.map((row) => row.map(fmtFloat)));
