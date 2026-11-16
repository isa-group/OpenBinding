import type { Diagnostic, ResourceEntry } from '../../features/bim-editor/documents';

export function resourcePathForDiagnostic(resources: ResourceEntry[], item: Diagnostic): string | undefined {
  const explicit = item.resourcePath || item.path;
  const direct = resources.find((resource) => resource.path === explicit);
  if (direct) return direct.path;
  const id = item.resource || explicit;
  return resources.find((resource) => resource.id === id)?.path;
}

export function diagnosticSelection(source: string, item: Diagnostic): { anchor: number; head: number } | undefined {
  const start = item.span?.start ?? item.start;
  const end = item.span?.end ?? item.end;
  if (typeof start === 'number') return { anchor: start, head: typeof end === 'number' ? end : start };
  const pointer = item.pointer || item.jsonPointer;
  if (!pointer) return undefined;
  const token = pointer.split('/').filter(Boolean).at(-1)?.replace(/~1/g, '/').replace(/~0/g, '~');
  if (!token) return undefined;
  const needle = JSON.stringify(token);
  const offset = source.indexOf(needle);
  return offset >= 0 ? { anchor: offset, head: offset + needle.length } : undefined;
}
