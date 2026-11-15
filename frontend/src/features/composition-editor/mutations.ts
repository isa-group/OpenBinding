import type { Kind } from '../../entities/composition/document';

/**
 * The changes the visual editor makes, as pure functions over the document's JSON model (`POST /v1/compositions/parse`). Each
 * answers a new document and leaves the one it was given as it was; the editor writes the result back through
 * `POST /v1/compositions/serialise`, so the text is always the gateway's canonical form of what was chosen. They only place what
 * the person chose: whether the result is a valid composition is the gateway's to say on the next check, and no presentation
 * hint is ever written into the document.
 */

/** A document as the language services serve it. */
export type DocumentModel = Record<string, unknown>;

/** The keys a Composition2Yaml 1.0 document may hold (the schema's properties); nothing else is ever written. */
export const DOCUMENT_KEYS = ['syntaxVersion', 'composition', 'version', 'kind', 'problem', 'workflow', 'binding', 'values', 'offering', 'evidence'] as const;

/** The composition's own pricing in one of its three forms. */
export type OfferingChoice =
  | { source: 'sphere'; sphere: string }
  | { source: 'registry'; sphere: string; registry: string }
  | { source: 'url'; url: string };

/** What a candidate change says about the provenance it dropped. */
export const PROVENANCE_REMOVED = 'Provenance removed; derive fills it.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = (document: DocumentModel): DocumentModel => structuredClone(document);

const section = (document: DocumentModel, key: 'binding' | 'values'): Record<string, unknown> => (
  isRecord(document[key]) ? document[key] as Record<string, unknown> : {}
);

/** The document's own label. */
export function setVersion(document: DocumentModel, label: string): DocumentModel {
  return { ...clone(document), version: label };
}

/** What the composition composes. */
export function setKind(document: DocumentModel, kind: Kind): DocumentModel {
  return { ...clone(document), kind };
}

/**
 * Bind a task to a candidate, as the problem writes it. The entry's `from` is dropped: it named where the previous candidate came
 * from, and a derivation writes it again for the new one.
 */
export function setCandidate(document: DocumentModel, task: string, candidate: string): { document: DocumentModel; note: string | null } {
  const next = clone(document);
  const binding = section(next, 'binding');
  const previous = binding[task];
  const dropped = isRecord(previous) && 'from' in previous;
  next.binding = { ...binding, [task]: { candidate } };
  return { document: next, note: dropped ? PROVENANCE_REMOVED : null };
}

/** Declare a value: a dimensionless one (unit `"1"` or none) is written as a bare number, any other as `{value, unit}`. */
export function setValue(document: DocumentModel, name: string, value: number, unit: string): DocumentModel {
  const next = clone(document);
  const written = unit.trim() === '' || unit.trim() === '1' ? value : { value, unit: unit.trim() };
  next.values = { ...section(next, 'values'), [name]: written };
  return next;
}

/** Remove a declared value. */
export function removeValue(document: DocumentModel, name: string): DocumentModel {
  const next = clone(document);
  const values = { ...section(next, 'values') };
  delete values[name];
  next.values = values;
  return next;
}

/** The composition's own pricing in one of its forms, or none. */
export function setOffering(document: DocumentModel, offering: OfferingChoice | null): DocumentModel {
  const next = clone(document);
  if (!offering) {
    delete next.offering;
    return next;
  }
  next.offering = offering.source === 'url'
    ? { url: offering.url }
    : offering.source === 'registry' ? { sphere: offering.sphere, registry: offering.registry } : { sphere: offering.sphere };
  return next;
}

/** The offering of a document as a choice of the form, or null. */
export function offeringChoice(document: DocumentModel): OfferingChoice | null {
  const offering = document.offering;
  if (!isRecord(offering)) return null;
  if (typeof offering.url === 'string') return { source: 'url', url: offering.url };
  if (typeof offering.sphere !== 'string') return null;
  return typeof offering.registry === 'string'
    ? { source: 'registry', sphere: offering.sphere, registry: offering.registry }
    : { source: 'sphere', sphere: offering.sphere };
}
