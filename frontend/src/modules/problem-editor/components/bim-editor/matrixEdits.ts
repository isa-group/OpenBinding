import { parsePointer, resolvePointer } from '../../../core/diagnostics/jsonPointer';
import type { Located } from '../../../core/diagnostics/located';
import { isFeatureSlot, type FeatureSlot, type FeatureValue } from '../../../../utils/featureRange';
import { isRecord, pretty, type WorkspaceFiles } from './documents';

/**
 * The candidate matrix of the problem editor writes each edit to the source document a cell's origin names (D9). The matrix is
 * drawn from the facts of the last check, so what it shows as a candidate, its eligibility and its values are the gateway's; an
 * edit only changes the value written at `origin.pointer` in `origin.path`, and the cell stays "pending check" until a check of
 * the package has the source and the facts agree again. Nothing here evaluates the package.
 */

/** Where the package writes a value: the file and the JSON Pointer of the value in it (`ProblemValueOrigin`). */
export interface CellOrigin {
  path: string;
  pointer: string;
}

/** What the source writes at an origin. */
export type SourceValue =
  /** A number or a range, as the matrix edits them. */
  | { kind: 'value'; value: FeatureSlot }
  /** The document reads, and holds nothing at the pointer (the value was removed). */
  | { kind: 'absent' }
  /** Something the matrix does not edit (text, a list…): the file is where to change it. */
  | { kind: 'other' }
  /** The file is missing, or its JSON does not parse right now. */
  | { kind: 'unreadable' };

/** The JSON documents of a package, parsed once per state of the files: `undefined` for a file whose text does not parse. */
export function parsedDocuments(files: WorkspaceFiles): Record<string, unknown> {
  const documents: Record<string, unknown> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!/\.json$/i.test(path)) continue;
    try {
      documents[path] = JSON.parse(text);
    } catch {
      documents[path] = undefined;
    }
  }
  return documents;
}

/** The member a reference token names in a value, if it is there. */
function child(value: unknown, token: string): { found: boolean; value: unknown } {
  if (Array.isArray(value)) {
    const index = /^(0|[1-9]\d*)$/.test(token) ? Number(token) : -1;
    return index >= 0 && index < value.length
      ? { found: true, value: value[index] }
      : { found: false, value: undefined };
  }
  if (isRecord(value) && Object.hasOwn(value, token)) return { found: true, value: value[token] };
  return { found: false, value: undefined };
}

/** What the document `documents[origin.path]` writes at `origin.pointer`. */
export function sourceValue(documents: Record<string, unknown>, origin: CellOrigin): SourceValue {
  const tokens = parsePointer(origin.pointer);
  const document = documents[origin.path];
  if (!tokens || document === undefined) return { kind: 'unreadable' };
  let value: unknown = document;
  for (const token of tokens) {
    const next = child(value, token);
    if (!next.found) return { kind: 'absent' };
    value = next.value;
  }
  return isFeatureSlot(value) ? { kind: 'value', value } : { kind: 'other' };
}

/**
 * The files with `value` written at the origin, or with the value removed when it is `null`. A number that replaces a number is
 * written in place, so the rest of the text stays as it was; any other change rewrites the document in the editor's format. `null`
 * when nothing can be written there: the file is missing or does not parse, or the object that holds the value is gone.
 */
export function writeAtOrigin(
  files: WorkspaceFiles,
  origin: CellOrigin,
  value: FeatureSlot | null
): WorkspaceFiles | null {
  const text = files[origin.path];
  const tokens = parsePointer(origin.pointer);
  if (text === undefined || !tokens || tokens.length === 0) return null;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  let parent: unknown = document;
  for (const token of tokens.slice(0, -1)) {
    const next = child(parent, token);
    if (!next.found) return null;
    parent = next.value;
  }
  if (!isRecord(parent)) return null;
  const member = tokens[tokens.length - 1];
  const before = Object.hasOwn(parent, member) ? parent[member] : undefined;

  if (typeof value === 'number' && typeof before === 'number') {
    const target = resolvePointer(text, origin.pointer);
    if (target?.exact && target.kind === 'Number') {
      return {
        ...files,
        [origin.path]: `${text.slice(0, target.from)}${JSON.stringify(value)}${text.slice(target.to)}`,
      };
    }
  }
  if (value === null) {
    if (before === undefined) return files;
    delete parent[member];
  } else {
    parent[member] = value;
  }
  return { ...files, [origin.path]: pretty(document) };
}

/** The same number, or the same range with the same ends written (an end left out is not an open end). */
export function sameValue(fact: FeatureValue | null, source: SourceValue): boolean {
  if (source.kind !== 'value') return fact === null && source.kind === 'absent';
  const written = source.value;
  if (fact === null) return false;
  if (typeof fact === 'number' || typeof written === 'number') return fact === written;
  return (
    Object.hasOwn(written, 'min') &&
    Object.hasOwn(written, 'max') &&
    written.min === fact.min &&
    written.max === fact.max
  );
}

/**
 * A cell waits for a check while its source no longer writes the value the last valid check read: it was edited since, and the
 * gateway has not passed the package with the edit yet. An unreadable file says nothing about the value.
 */
export const isPending = (fact: FeatureValue | null, source: SourceValue): boolean =>
  source.kind !== 'unreadable' && source.kind !== 'other' && !sameValue(fact, source);

/** The findings of the last check about the value at an origin, or about something inside it (a range's end). */
export function cellFindings(diagnostics: readonly Located[], origin: CellOrigin): Located[] {
  return diagnostics.filter(
    finding =>
      finding.where.kind !== 'package' &&
      finding.where.file === origin.path &&
      finding.pointer !== undefined &&
      (finding.pointer === origin.pointer || finding.pointer.startsWith(`${origin.pointer}/`))
  );
}
