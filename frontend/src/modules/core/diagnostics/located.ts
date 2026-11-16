import type { CompositionDiagnosticView } from '../api/types';

/**
 * One shape for every finding shown on screen, whichever language it is about: where it is (a range of a text file, an
 * element of a BPMN diagram, a file, or the package as a whole), what the gateway said, and the path and pointer it gave.
 * Adapters turn each language's diagnostics into it: `fromC2y` here for Composition2Yaml, `fromBim` for BIM packages
 * later. No rule of either language lives in the browser: the codes and messages are the gateway's.
 */

export type Severity = 'error' | 'warning' | 'info';

export type Where =
  | { kind: 'text'; file: string; from: number; to: number; line: number; column: number }
  | { kind: 'bpmn'; file: string; element: string }
  | { kind: 'file'; file: string }
  | { kind: 'package' };

export interface Located {
  code: string;
  message: string;
  severity: Severity;
  where: Where;
  path?: string;
  pointer?: string;
  related?: Located[];
}

/** The UTF-16 offset of each line's start, as an editor counts positions. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/**
 * The offset of a one-based line and column. The gateway counts a column in characters (code points), an editor in
 * UTF-16 units, so the line is walked character by character. A position past a line's end is that end, and a line past
 * the text is its end.
 */
function offsetOf(text: string, starts: number[], line: number, column: number): number {
  if (line < 1) return 0;
  if (line > starts.length) return text.length;
  const start = starts[line - 1];
  const end = line < starts.length ? starts[line] - 1 : text.length;
  let offset = start;
  for (let walked = 1; walked < column && offset < end; walked += 1) {
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return Math.min(offset, end);
}

/**
 * A Composition2Yaml diagnostic, located in `text`. Its span is one-based with an exclusive end; a diagnostic without a
 * span (a document with no text, or an element the text does not place) is located at the file, with its path shown.
 */
export function fromC2y(
  diagnostic: CompositionDiagnosticView,
  text: string,
  file: string
): Located {
  const { span } = diagnostic;
  let where: Where = { kind: 'file', file };
  if (span) {
    const starts = lineStarts(text);
    const from = offsetOf(text, starts, span.line, span.column);
    const to = offsetOf(text, starts, span.end_line, span.end_column);
    where = {
      kind: 'text',
      file,
      from,
      to: Math.max(from, to),
      line: span.line,
      column: span.column,
    };
  }
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    where,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.pointer ? { pointer: diagnostic.pointer } : {}),
  };
}

const PLACE: Record<Where['kind'], number> = { text: 0, bpmn: 1, file: 2, package: 3 };
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

const fileOf = (where: Where) => (where.kind === 'package' ? '' : where.file);

/**
 * In the order a reader meets them: by file, then text positions in reading order, then diagram elements, findings about
 * a whole file, and last those about the package; errors before warnings before infos at the same place.
 */
export function byLocation(diagnostics: readonly Located[]): Located[] {
  return [...diagnostics].sort((one, other) => {
    const whole = Number(one.where.kind === 'package') - Number(other.where.kind === 'package');
    if (whole !== 0) return whole;
    const file = fileOf(one.where).localeCompare(fileOf(other.where));
    if (file !== 0) return file;
    const place = PLACE[one.where.kind] - PLACE[other.where.kind];
    if (place !== 0) return place;
    if (one.where.kind === 'text' && other.where.kind === 'text') {
      const at = one.where.from - other.where.from;
      if (at !== 0) return at;
    }
    if (one.where.kind === 'bpmn' && other.where.kind === 'bpmn') {
      const element = one.where.element.localeCompare(other.where.element);
      if (element !== 0) return element;
    }
    return RANK[one.severity] - RANK[other.severity];
  });
}

export interface Counts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/** How many findings of each severity there are. */
export function counts(diagnostics: readonly Located[]): Counts {
  const tally: Counts = { error: 0, warning: 0, info: 0, total: diagnostics.length };
  for (const diagnostic of diagnostics) tally[diagnostic.severity] += 1;
  return tally;
}

/**
 * A key that stays the same while the finding does, for lists that redraw on every check: the code, the path, the line,
 * the column and the message, in the format SPHERE's problems panel uses for its own diagnostics.
 */
export function locatedKey(diagnostic: Located): string {
  const { where } = diagnostic;
  const line = where.kind === 'text' ? where.line : 0;
  const column = where.kind === 'text' ? where.column : 0;
  const place = where.kind === 'bpmn' ? `${where.file}#${where.element}` : fileOf(where);
  return `${diagnostic.code}:${diagnostic.path ?? place}:${line}:${column}:${diagnostic.message}`;
}
