/**
 * Documents written before the editors used the vocabulary of the schemas (`schemas/bim/v1`), read on the way in and written back in
 * the real one. Reading accepts both vocabularies; writing is always the real one, and whatever has no place in the schema is kept
 * under `metadata.annotations["openbinding.legacy"]` and named in the notes, never dropped.
 *
 *   Application      spec.metrics                      → spec.features
 *   CandidateCatalog spec.metricBindings               → spec.featureBindings
 *                    candidates.*.metrics              → candidates.*.features
 *   Optimization     spec.terms[].metric / .feature    → spec.criteria[] { id, feature, direction, normalize }
 *                    spec.type, spec.mode, term.weight → annotations (the strategy is chosen when the package runs)
 *   Placement        transitions.*.metric, globalLatency.metric → .feature
 */

export const LEGACY_ANNOTATION = 'openbinding.legacy';

type Json = Record<string, unknown>;

export interface Migrated<T> {
  value: T;
  /** One sentence per change, for the person to read; empty when the document already used the schema's vocabulary. */
  notes: string[];
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asJson = (value: unknown): Json => (isRecord(value) ? value : {});

/** `object` with `from` called `to`, in the same position; `from` is kept in `bag` when `to` already exists. */
function renameKey(object: Json, from: string, to: string, where: string, bag: Json, notes: string[], label: string): Json {
  if (!(from in object)) return object;
  const next: Json = {};
  for (const [key, value] of Object.entries(object)) {
    if (key !== from) next[key] = value;
    else if (to in object) {
      bag[where] = { ...asJson(bag[where]), [from]: value };
      notes.push(`${label}: both "${from}" and "${to}" were present; "${to}" was kept and "${from}" is under the legacy annotation.`);
    } else next[to] = value;
  }
  if (!(to in object)) notes.push(`${label}: "${from}" is now "${to}".`);
  return next;
}

/** The map `legacy` merged into the map `real` (the real entries win), as one object placed where `real` or else `legacy` stood. */
function mergeMaps(object: Json, legacy: string, real: string, where: string, bag: Json, notes: string[], label: string): Json {
  if (!isRecord(object[legacy])) return renameKey(object, legacy, real, where, bag, notes, label);
  const old = asJson(object[legacy]);
  const current = asJson(object[real]);
  const merged: Json = { ...old, ...current };
  const clashes = Object.keys(old).filter((key) => key in current && JSON.stringify(old[key]) !== JSON.stringify(current[key]));
  if (clashes.length) bag[where] = { ...asJson(bag[where]), ...Object.fromEntries(clashes.map((key) => [key, old[key]])) };
  const next: Json = {};
  for (const [key, value] of Object.entries(object)) {
    if (key === legacy || key === real) {
      if (!(real in next)) next[real] = merged;
    } else next[key] = value;
  }
  notes.push(`${label}: "${legacy}" is now "${real}"${clashes.length ? ` (${clashes.join(', ')} kept their "${real}" value; the older one is under the legacy annotation)` : ''}.`);
  return next;
}

function mapValues(object: unknown, change: (value: Json, key: string) => Json): unknown {
  if (!isRecord(object)) return object;
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, isRecord(value) ? change(value, key) : value]));
}

function application(spec: Json, bag: Json, notes: string[]): Json {
  return mergeMaps(spec, 'metrics', 'features', 'spec.metrics', bag, notes, 'spec');
}

function catalog(spec: Json, bag: Json, notes: string[]): Json {
  const bound = renameKey(spec, 'metricBindings', 'featureBindings', 'spec.metricBindings', bag, notes, 'spec');
  if (!isRecord(bound.candidates)) return bound;
  const candidateNotes: string[] = [];
  const candidates = mapValues(bound.candidates, (candidate, id) => (
    mergeMaps(candidate, 'metrics', 'features', `candidates.${id}.metrics`, bag, candidateNotes, `candidate ${id}`)
  ));
  if (candidateNotes.length) notes.push(`spec.candidates: ${candidateNotes.length === 1 ? candidateNotes[0] : `${candidateNotes.length} candidates moved "metrics" to "features".`}`);
  return { ...bound, candidates };
}

function optimization(spec: Json, bag: Json, notes: string[]): Json {
  if (!('terms' in spec) && !('type' in spec) && !('mode' in spec)) return spec;
  const taken = new Set<string>();
  const existing = Array.isArray(spec.criteria) ? spec.criteria : [];
  for (const item of existing) if (isRecord(item) && typeof item.id === 'string') taken.add(item.id);
  const criteria: unknown[] = [...existing];
  const weights: Json = {};
  const extras: Json = {};
  const leftovers: unknown[] = [];
  const terms = Array.isArray(spec.terms) ? spec.terms : [];
  terms.forEach((term, index) => {
    const reference = isRecord(term) ? (isRecord(term.metric) ? term.metric : isRecord(term.feature) ? term.feature : null) : null;
    if (!isRecord(term) || !reference) {
      leftovers.push(term);
      return;
    }
    const base = typeof reference.id === 'string' && reference.id ? reference.id : `criterion${index + 1}`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    const criterion: Json = { id, feature: reference };
    if (term.direction === 'minimize' || term.direction === 'maximize') criterion.direction = term.direction;
    if (isRecord(term.normalize)) criterion.normalize = term.normalize;
    if (term.weight !== undefined) weights[id] = term.weight;
    const rest = Object.fromEntries(Object.entries(term).filter(([key]) => !['metric', 'feature', 'direction', 'normalize', 'weight'].includes(key)));
    if (Object.keys(rest).length) extras[id] = rest;
    criteria.push(criterion);
  });
  const next: Json = {};
  let placed = false;
  const place = () => {
    if (placed) return;
    placed = true;
    next.criteria = criteria;
  };
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'terms' || key === 'criteria') place();
    else if (key !== 'type' && key !== 'mode') next[key] = value;
  }
  place();
  const moved: Json = {};
  if ('type' in spec) moved.type = spec.type;
  if ('mode' in spec) moved.mode = spec.mode;
  if (Object.keys(weights).length) moved.weights = weights;
  if (Object.keys(extras).length) moved.termKeys = extras;
  if (leftovers.length) moved.terms = leftovers;
  if (Object.keys(moved).length) bag['spec.optimization'] = moved;
  notes.push(`spec: ${terms.length - leftovers.length} term${terms.length - leftovers.length === 1 ? '' : 's'} became criteria${'mode' in spec || 'type' in spec ? `; the strategy (${[spec.type, spec.mode].filter((value) => value !== undefined).map(String).join(' · ')}) is chosen when the package runs and is kept under the legacy annotation` : ''}${Object.keys(weights).length ? '; term weights are kept there too' : ''}${leftovers.length ? `; ${leftovers.length} term${leftovers.length === 1 ? '' : 's'} without a feature could not be converted and ${leftovers.length === 1 ? 'is' : 'are'} kept there` : ''}.`);
  return next;
}

function placement(spec: Json, bag: Json, notes: string[]): Json {
  const transitionNotes: string[] = [];
  const next: Json = { ...spec };
  if (isRecord(spec.transitions)) {
    next.transitions = mapValues(spec.transitions, (transition, id) => renameKey(transition, 'metric', 'feature', `transitions.${id}.metric`, bag, transitionNotes, `transition ${id}`));
  }
  if (transitionNotes.length) notes.push(`spec.transitions: ${transitionNotes.length === 1 ? transitionNotes[0] : `${transitionNotes.length} transitions moved "metric" to "feature".`}`);
  if (isRecord(spec.globalLatency)) next.globalLatency = renameKey(spec.globalLatency, 'metric', 'feature', 'globalLatency.metric', bag, notes, 'spec.globalLatency');
  return next;
}

const BY_KIND: Record<string, (spec: Json, bag: Json, notes: string[]) => Json> = {
  Application: application,
  CandidateCatalog: catalog,
  Optimization: optimization,
  Placement: placement,
};

/** One document read in either vocabulary and written in the real one. The same object comes back when nothing had to change. */
export function migrateDocument(document: Json): Migrated<Json> {
  const migrate = typeof document.kind === 'string' ? BY_KIND[document.kind] : undefined;
  if (!migrate || !isRecord(document.spec)) return { value: document, notes: [] };
  const bag: Json = {};
  const notes: string[] = [];
  const spec = migrate(document.spec, bag, notes);
  if (!notes.length) return { value: document, notes };
  const next: Json = { ...document, spec };
  if (Object.keys(bag).length) {
    const metadata = asJson(document.metadata);
    const annotations = asJson(metadata.annotations);
    const previous = asJson(annotations[LEGACY_ANNOTATION]);
    next.metadata = { ...metadata, annotations: { ...annotations, [LEGACY_ANNOTATION]: { ...previous, ...bag } } };
  }
  return { value: next, notes };
}

/** The files of a package: every JSON document migrated, the rest (BPMN, text, JSON that does not parse) as it was. */
export function migrateFiles(files: Record<string, string>): Migrated<Record<string, string>> {
  const notes: string[] = [];
  const next: Record<string, string> = {};
  for (const [path, source] of Object.entries(files)) {
    next[path] = source;
    if (!path.toLowerCase().endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const migrated = migrateDocument(parsed);
    if (!migrated.notes.length) continue;
    next[path] = `${JSON.stringify(migrated.value, null, 2)}\n`;
    notes.push(...migrated.notes.map((note) => `${path} · ${note}`));
  }
  return { value: notes.length ? next : files, notes };
}
