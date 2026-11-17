import type { BimDiagnostic } from '../api/bim';
import { expressionRange, lineColumn, resolvePointer } from './jsonPointer';
import type { Located, Severity, Where } from './located';

/**
 * The BIM adapter of the located diagnostics (A-6): a finding of the gateway's compiler (`POST /v1/bim/validate`, a refused
 * upload) placed in the files of the package it was about.
 *
 * - `resource` names a file of the package, or the id an Instance gives a resource (`placement`), which `instance.json` maps to
 *   its file;
 * - a JSON `pointer` lands on the value it names (`jsonPointer.ts`), and an expression's `span` inside that string value;
 * - a BPMN element (`bpmnElement`, or a pointer `/process/<id>` into a BPMN file) is shown in the diagram;
 * - a finding whose resource is not a file of the package (a registered resource, a file the package lacks, none at all) is about
 *   the package as a whole.
 *
 * The codes and messages are the gateway's: nothing is judged here.
 */

/** The files of a package, by path, as the text that was checked. */
export type PackageTexts = Readonly<Record<string, string>>;

const INSTANCE = 'instance.json';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file of each resource id `instance.json` declares with a package path (registered resources have none). */
export function resourcePaths(files: PackageTexts): Record<string, string> {
  let root: unknown = null;
  try {
    root = JSON.parse(files[INSTANCE] ?? '');
  } catch {
    return {};
  }
  const groups =
    isRecord(root) && isRecord(root.spec) && isRecord(root.spec.resources)
      ? root.spec.resources
      : {};
  const paths: Record<string, string> = {};
  for (const group of Object.values(groups)) {
    if (!isRecord(group)) continue;
    for (const [id, target] of Object.entries(group))
      if (typeof target === 'string') paths[id] = target;
  }
  return paths;
}

const isXml = (path: string) => /\.(bpmn|xml)$/i.test(path);
const isJson = (path: string) => /\.json$/i.test(path);

/** The file a resource names: itself when it is a file of the package, else the file its id is declared with. */
function fileOf(
  resource: string | undefined,
  files: PackageTexts,
  ids: Readonly<Record<string, string>>
): string | null {
  if (!resource) return null;
  if (resource in files) return resource;
  const path = ids[resource];
  return path !== undefined && path in files ? path : null;
}

const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info'];

/** A related location of a finding, as the compiler writes it: `{resource, pointer?, bpmnElement?}`. */
interface Place {
  resource?: string;
  pointer?: string;
  bpmnElement?: string;
  span?: Record<string, number> | null;
}

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

function textWhere(file: string, text: string, from: number, to: number): Where {
  const { line, column } = lineColumn(text, from);
  return { kind: 'text', file, from, to: Math.max(from, to), line, column };
}

/** Where a place of the package is. */
function whereOf(place: Place, files: PackageTexts, ids: Readonly<Record<string, string>>): Where {
  const file = fileOf(place.resource, files, ids);
  if (!file) return { kind: 'package' };
  const element =
    place.bpmnElement ??
    (isXml(file) ? /^\/process\/([^/]+)/.exec(place.pointer ?? '')?.[1] : undefined);
  if (element) return { kind: 'bpmn', file, element };
  const text = files[file];
  const span = place.span;
  if (span && typeof span.offset === 'number')
    return textWhere(file, text, span.offset, span.offset + 1);
  if (!isJson(file) || place.pointer === undefined) return { kind: 'file', file };
  const target = resolvePointer(text, place.pointer);
  if (!target) return { kind: 'file', file };
  if (span && typeof span.start === 'number' && typeof span.end === 'number' && target.exact) {
    const range = expressionRange(text, target, { start: span.start, end: span.end });
    if (range) return textWhere(file, text, range.from, range.to);
  }
  return textWhere(file, text, target.from, target.to);
}

/** What the panel prints beside the place: the pointer, and the resource when the finding is about the package. */
function shownPath(place: Place, where: Where): string | undefined {
  if (where.kind === 'package' && place.resource)
    return place.pointer ? `${place.resource} ${place.pointer}` : place.resource;
  return place.pointer || undefined;
}

/**
 * One finding of the compiler, located in `files`. `severity` is the gateway's, or `fallback` when it names none (an error on a
 * refusal, a warning beside a valid package). Its related locations are kept in `related`, as notes about the same finding.
 */
export function fromBim(
  diagnostic: BimDiagnostic,
  files: PackageTexts,
  {
    fallback = 'error',
    ids = resourcePaths(files),
  }: { fallback?: Severity; ids?: Readonly<Record<string, string>> } = {}
): Located {
  const place: Place = {
    resource: textOf(diagnostic.resource),
    pointer: textOf(diagnostic.pointer),
    bpmnElement: textOf(diagnostic.bpmnElement),
    span: isRecord(diagnostic.span) ? diagnostic.span : null,
  };
  const where = whereOf(place, files, ids);
  const message =
    textOf(diagnostic.message) ??
    textOf(diagnostic.code) ??
    'The gateway sent no message for this finding.';
  const severity = SEVERITIES.find(item => item === diagnostic.severity) ?? fallback;
  const related = (Array.isArray(diagnostic.related) ? diagnostic.related : [])
    .filter(isRecord)
    .map((item): Located => {
      const at: Place = {
        resource: textOf(item.resource),
        pointer: textOf(item.pointer),
        bpmnElement: textOf(item.bpmnElement),
      };
      const located = whereOf(at, files, ids);
      const path = shownPath(at, located);
      return {
        code: diagnostic.code,
        message: `Related to: ${message}`,
        severity: 'info',
        where: located,
        ...(path ? { path } : {}),
        ...(at.pointer ? { pointer: at.pointer } : {}),
      };
    });
  const path = shownPath(place, where);
  return {
    code: diagnostic.code,
    message,
    severity,
    where,
    ...(path ? { path } : {}),
    ...(place.pointer ? { pointer: place.pointer } : {}),
    ...(related.length ? { related } : {}),
  };
}

/** Every finding of a check, located, each followed by its related locations as entries of their own (notes). */
export function fromBimAll(
  diagnostics: readonly BimDiagnostic[],
  files: PackageTexts,
  fallback: Severity = 'error'
): Located[] {
  const ids = resourcePaths(files);
  return diagnostics.flatMap(diagnostic => {
    const located = fromBim(diagnostic, files, { fallback, ids });
    return [located, ...(located.related ?? [])];
  });
}
