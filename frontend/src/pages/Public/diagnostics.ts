import { ROLE_LABELS, type PackageFile } from './packageModel';

/** One problem the gateway found, in terms a person can act on. */
export interface ReadableDiagnostic {
  code: string | null;
  message: string;
  /** The package file it is about, when it can be told. */
  file: string | null;
  fileLabel: string;
  /** Where inside the file, in words: `providers › item 4 › metrics › latency`. */
  where: string;
  /** The JSON Pointer or BPMN element as written, for copying. */
  location: string | null;
  fix: string | null;
}

export interface DiagnosticGroup {
  /** The file path, or `''` for problems about the package as a whole. */
  file: string;
  label: string;
  items: ReadableDiagnostic[];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** `/spec/providers/3/metrics/latency` → `providers › item 4 › metrics › latency` (the leading `spec` is plumbing). */
export function pointerInWords(pointer: string): string {
  const tokens = pointer.split('/').filter(Boolean).map(unescapeToken);
  if (tokens[0] === 'spec' && tokens.length > 1) tokens.shift();
  return tokens.map((token) => (/^\d+$/.test(token) ? `item ${Number(token) + 1}` : token)).join(' › ');
}

export function labelOfFile(path: string, files: PackageFile[]): string {
  const file = files.find((entry) => entry.path === path);
  if (file?.role) return `${ROLE_LABELS[file.role] ?? file.role} · ${path}`;
  if (file?.kind) return `${file.kind} · ${path}`;
  return path;
}

/** Match whatever a diagnostic names (a path, a logical id, a role) to a file of the package. */
function fileOf(raw: Record<string, unknown>, files: PackageFile[]): string | null {
  const named = [raw.resourcePath, raw.path, raw.file, raw.resource].map(text).filter((value): value is string => value !== null);
  for (const name of named) {
    const byPath = files.find((file) => file.path === name);
    if (byPath) return byPath.path;
    const byId = files.find((file) => file.logicalId === name || file.role === name);
    if (byId) return byId.path;
  }
  return null;
}

export function readDiagnostics(raw: Array<Record<string, unknown>>, files: PackageFile[]): ReadableDiagnostic[] {
  return raw.map((item) => {
    const file = fileOf(item, files);
    const pointer = text(item.pointer) ?? text(item.jsonPointer);
    const element = text(item.bpmnElement) ?? text(item.element);
    const named = [item.resourcePath, item.path, item.resource].map(text).find((value) => value !== null) ?? null;
    return {
      code: text(item.code),
      message: text(item.message) ?? text(item.detail) ?? 'The gateway reported a problem without a message.',
      file,
      fileLabel: file ? labelOfFile(file, files) : named ?? 'Package',
      where: element ? `BPMN element “${element}”` : pointer ? pointerInWords(pointer) : 'Whole file',
      location: pointer ?? element,
      fix: text(item.fix) ?? text(item.suggestion) ?? text(item.hint),
    };
  });
}

/** Problems grouped by file, files in the order they first appear, package-wide problems first. */
export function groupDiagnostics(items: ReadableDiagnostic[]): DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticGroup>();
  for (const item of items) {
    const key = item.file ?? (item.fileLabel === 'Package' ? '' : item.fileLabel);
    const group = groups.get(key) ?? { file: item.file ?? '', label: item.fileLabel, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)));
}
