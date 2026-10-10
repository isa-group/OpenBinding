/**
 * The gateway's one problem document (docs/ERRORS.md): every 422 is
 * `{ type, title, status, code, detail (string), diagnostics: Diagnostic[] }`.
 * Other statuses keep `{ detail: { code, error, …extra } }` and gain `type/title/status/code` beside it.
 */

/** One finding of a 422: where it is (pointer, or a query/path/header parameter) and what is wrong. */
export interface Diagnostic {
  code: string;
  message: string;
  /** RFC 6901 pointer into the request body (validation) or the YAML (pricing). */
  pointer?: string;
  in?: string;
  parameter?: string;
  loc?: Array<string | number>;
  context?: Record<string, unknown>;
  hint?: string;
  fix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The diagnostics of a body or of `HttpError.diagnostics`, completed (a missing message or code is filled in) and nothing else kept. */
export function readDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Diagnostic[] => {
    if (!isRecord(entry)) return [];
    const message = text(entry.message) ?? text(entry.detail) ?? text(entry.code);
    if (!message) return [];
    const loc = Array.isArray(entry.loc) ? entry.loc.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number') : undefined;
    return [{
      code: text(entry.code) ?? 'invalid',
      message,
      ...(text(entry.pointer) !== undefined ? { pointer: text(entry.pointer) } : {}),
      ...(text(entry.in) !== undefined ? { in: text(entry.in) } : {}),
      ...(text(entry.parameter) !== undefined ? { parameter: text(entry.parameter) } : {}),
      ...(loc && loc.length > 0 ? { loc } : {}),
      ...(isRecord(entry.context) ? { context: entry.context } : {}),
      ...(text(entry.hint) !== undefined ? { hint: text(entry.hint) } : {}),
      ...(text(entry.fix) !== undefined ? { fix: text(entry.fix) } : {}),
    }];
  });
}

const unescapePointer = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const escapePointer = (segment: string | number) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * The JSON pointer a diagnostic is about: its `pointer`, else its `loc` inside the body without the leading `body`.
 * `undefined` for a whole-request finding and for a query, path or header parameter (those name `parameter` instead).
 */
export function pointerOf(diagnostic: Diagnostic): string | undefined {
  if (diagnostic.pointer !== undefined) return diagnostic.pointer;
  const inBody = diagnostic.in === undefined || diagnostic.in === 'body';
  if (inBody && diagnostic.loc && diagnostic.loc.length > 1) return `/${diagnostic.loc.slice(1).map(escapePointer).join('/')}`;
  return undefined;
}

/** The name of the field a diagnostic is about: the last segment of its pointer, else its `parameter`. */
export function fieldOf(diagnostic: Diagnostic): string | undefined {
  const pointer = pointerOf(diagnostic);
  if (pointer !== undefined) {
    const last = pointer.split('/').filter((part) => part !== '').pop();
    return last === undefined ? undefined : unescapePointer(last);
  }
  return diagnostic.parameter;
}

/**
 * The first message of each pointer, to paint under the field it names (`/spec/limits/maxTasks` → message).
 * A diagnostic that names a query/path/header parameter is keyed by that parameter; one that names nothing is left out.
 */
export function diagnosticsByPointer(diagnostics: readonly Diagnostic[]): Partial<Record<string, string>> {
  const messages: Partial<Record<string, string>> = {};
  for (const diagnostic of diagnostics) {
    const key = pointerOf(diagnostic) ?? diagnostic.parameter;
    if (key !== undefined && !(key in messages)) messages[key] = diagnostic.message;
  }
  return messages;
}

/** Like {@link diagnosticsByPointer}, keyed by the field's own name (`email`, `new_password`) for flat forms. */
export function diagnosticsByField(diagnostics: readonly Diagnostic[]): Partial<Record<string, string>> {
  const messages: Partial<Record<string, string>> = {};
  for (const diagnostic of diagnostics) {
    const key = fieldOf(diagnostic);
    if (key !== undefined && !(key in messages)) messages[key] = diagnostic.message;
  }
  return messages;
}

/** The sentence of a thrown error without the `HTTP 422: ` the client puts in front of it. */
function sentenceOf(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message.replace(/^HTTP \d+:\s*/, '').trim() : '';
}

/**
 * One line per diagnostic of a thrown error, for a notice that lists what the gateway found. A refusal with nothing finer to say
 * carries a single diagnostic that restates its own sentence (docs/ERRORS.md); that one is left out, so the notice doesn't say it twice.
 */
export function diagnosticLines(error: unknown, limit = 6): string[] {
  const sentence = sentenceOf(error);
  const rows = isRecord(error) && Array.isArray(error.diagnostics) ? error.diagnostics : [];
  return rows
    .map((row) => (isRecord(row) ? (text(row.message) ?? text(row.code) ?? '') : ''))
    .filter((line) => line !== '' && line !== sentence)
    .slice(0, limit);
}

/** The diagnostics a thrown error carries (on the error, else in its problem body), or `[]`. */
export function diagnosticsOf(error: unknown): Diagnostic[] {
  if (!isRecord(error)) return [];
  const own = readDiagnostics(error.diagnostics);
  if (own.length > 0) return own;
  return isRecord(error.problem) ? readDiagnostics(error.problem.diagnostics) : [];
}

/**
 * A field the gateway added beside `code` on a coded failure (`references`, `fields`, `index`, `proposal_id`…).
 * Platform routes keep them inside `detail`; BIM routes put them at the top.
 */
export function problemField(error: unknown, name: string): unknown {
  const problem = isRecord(error) ? error.problem : undefined;
  if (!isRecord(problem)) return undefined;
  const detail = problem.detail;
  if (isRecord(detail) && name in detail) return detail[name];
  return problem[name];
}
