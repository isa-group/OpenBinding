/**
 * What a library item holds, as the screens read and write it. A draft's content is one JSON document (or, for BPMN and other text
 * kinds, a text file); these helpers read the documents people edit most as rows (providers, rules), keep every field they don't know
 * about, and describe the rest generically. Nothing here talks to the gateway.
 */

import { formatFeature, isFeatureSlot, isRange, parseFiniteNumber, validateFeature, type FeatureSlot } from '../../utils/featureRange';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Content = JsonObject | string;

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The language version the resource kinds of the library are written in (`Profile qos-binding/v1`). */
export const RESOURCE_API_VERSION = 'qos-binding/v1';
/** Placement is a separate dialect with its own version (`schemas/bim/v1/placement.schema.json`). */
export const PLACEMENT_API_VERSION = 'qos-binding-placement/v1';
export const BPMN_MEDIA_TYPE = 'application/vnd.omg.bpmn+xml';

const BPMN_SKELETON = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://openbinding/bpmn">
  <bpmn:process id="Process_1" isExecutable="false" />
</bpmn:definitions>
`;

const RESOURCE_KINDS = new Set(['Application', 'CandidateCatalog', 'ConstraintSet', 'Optimization', 'Placement', 'RoutingOverlay']);

/** The empty document a new draft starts from, shaped as its kind expects so that filling it in is all that is left. */
export function templateFor(kind: string, name: string): { content: Content; mediaType: string } {
  const resource = (spec: JsonObject): JsonObject => ({ apiVersion: kind === 'Placement' ? PLACEMENT_API_VERSION : RESOURCE_API_VERSION, kind, metadata: { name }, spec });
  // Each template holds the keys its schema requires, empty: filling them in is all that is left.
  switch (kind) {
    case 'Application': return { content: resource({ tasks: {}, features: {}, workflow: {} }), mediaType: 'application/json' };
    case 'CandidateCatalog': return { content: resource({ featureBindings: {}, candidates: {} }), mediaType: 'application/json' };
    case 'ConstraintSet': return { content: resource({ constraints: {} }), mediaType: 'application/json' };
    case 'Optimization': return { content: resource({ criteria: [], penalties: [] }), mediaType: 'application/json' };
    case 'RoutingOverlay': return { content: resource({ uniform: true }), mediaType: 'application/json' };
    case 'Placement': return { content: resource({ pools: {} }), mediaType: 'application/json' };
    case 'Study': return { content: { apiVersion: 'openbinding/study/v1', cases: [], engines: [], parameter_sets: [{}], seeds: [0] }, mediaType: 'application/json' };
    case 'Collection': return { content: { apiVersion: 'openbinding/collection/v1', members: [] }, mediaType: 'application/json' };
    case 'ExecutionConfiguration': return { content: { engine: { namespace: '', name: '', version: '', digest: '' }, mode: '', options: {} }, mediaType: 'application/json' };
    case 'BPMN': return { content: BPMN_SKELETON, mediaType: BPMN_MEDIA_TYPE };
    default: return { content: RESOURCE_KINDS.has(kind) ? resource({}) : {}, mediaType: 'application/json' };
  }
}

/** Reads the bytes of a version: a JSON object when it is one, otherwise the text. */
export function parseContent(text: string, mediaType: string): Content {
  if (mediaType.toLowerCase().includes('json')) {
    try {
      const value: unknown = JSON.parse(text);
      if (isObject(value)) return value;
    } catch {
      /* not JSON after all: shown as text */
    }
  }
  return text;
}

export const sourceOf = (content: Content): string => (typeof content === 'string' ? content : JSON.stringify(content, null, 2));

export const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// --- an immutable update of a path, keeping order

function setIn(root: Json, path: readonly (string | number)[], value: Json | undefined): Json {
  if (path.length === 0) return value ?? null;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    const index = Number(head);
    if (value === undefined && rest.length === 0) copy.splice(index, 1);
    else copy[index] = setIn(copy[index] ?? null, rest, value);
    return copy;
  }
  const base: JsonObject = isObject(root) ? root : {};
  if (value === undefined && rest.length === 0) {
    const { [String(head)]: removed, ...others } = base;
    void removed;
    return others;
  }
  return { ...base, [String(head)]: setIn(base[String(head)] ?? null, rest, value) };
}

/** `document` with the value at `path` replaced (or removed, when `value` is `undefined`). */
export function updateAt(document: JsonObject, path: readonly (string | number)[], value: Json | undefined): JsonObject {
  const next = setIn(document, path, value);
  return isObject(next) ? next : document;
}

/** An object with one key renamed, in the same position. */
export function renameKey(object: JsonObject, from: string, to: string): JsonObject {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key === from ? to : key, value]));
}

export function uniqueKey(taken: readonly string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// --- candidate catalogs

export interface CatalogRow {
  id: string;
  provider: string;
  /** A number or a range; a range that misses an end while it is being typed is kept as it is, and `checksFor` flags it. */
  features: Record<string, FeatureSlot>;
}

export interface CatalogGroup {
  capability: string;
  rows: CatalogRow[];
}

export interface CatalogView {
  groups: CatalogGroup[];
  /** Every quality any candidate declares, in the order first met. */
  columns: string[];
}

const NO_CAPABILITY = '';

/**
 * A catalog as rows, when it is shaped simply enough to be edited as a table: a map of candidates, each providing one named capability
 * and declaring numbers or ranges (`{ min, max }`, an end `null` for no limit). Anything richer (a capability that is a list or a
 * description, a quality that is neither) returns `null` and is shown with the generic form instead, so nothing is ever flattened away.
 */
export function catalogOf(document: Content): CatalogView | null {
  if (!isObject(document) || !isObject(document.spec) || !isObject(document.spec.candidates)) return null;
  const groups = new Map<string, CatalogRow[]>();
  const columns: string[] = [];
  for (const [id, candidate] of Object.entries(document.spec.candidates)) {
    if (!isObject(candidate)) return null;
    const provides = candidate.provides ?? NO_CAPABILITY;
    if (typeof provides !== 'string') return null;
    const features = candidate.features ?? {};
    if (!isObject(features) || Object.values(features).some((value) => !isFeatureSlot(value))) return null;
    const provider = candidate.provider;
    if (provider !== undefined && !(isObject(provider) && (provider.id === undefined || typeof provider.id === 'string'))) return null;
    for (const column of Object.keys(features)) if (!columns.includes(column)) columns.push(column);
    const row: CatalogRow = { id, provider: isObject(provider) && typeof provider.id === 'string' ? provider.id : '', features: features as Record<string, FeatureSlot> };
    groups.set(provides, [...(groups.get(provides) ?? []), row]);
  }
  return { groups: [...groups].map(([capability, rows]) => ({ capability, rows })), columns };
}

const candidatesOf = (document: JsonObject): JsonObject => (isObject(document.spec) && isObject(document.spec.candidates) ? document.spec.candidates : {});
const withCandidates = (document: JsonObject, candidates: JsonObject): JsonObject => updateAt(document, ['spec', 'candidates'], candidates);

export function renameCandidate(document: JsonObject, from: string, to: string): JsonObject {
  const candidates = candidatesOf(document);
  if (!to.trim() || (to !== from && to in candidates)) return document;
  return withCandidates(document, renameKey(candidates, from, to));
}

export function setCandidateProvider(document: JsonObject, id: string, provider: string): JsonObject {
  const current = candidatesOf(document)[id];
  const previous = isObject(current) && isObject(current.provider) ? current.provider : { resource: 'catalog' };
  return updateAt(document, ['spec', 'candidates', id, 'provider'], provider ? { ...previous, id: provider } : undefined);
}

/** Sets one quality of a candidate to a number or a range; `null` removes it. A range is written with its keys in the order `min`, `max`. */
export function setCandidateFeature(document: JsonObject, id: string, feature: string, value: FeatureSlot | null): JsonObject {
  if (value === null) return updateAt(document, ['spec', 'candidates', id, 'features', feature], undefined);
  const written: Json = typeof value === 'number' ? value : Object.fromEntries(
    (['min', 'max'] as const).filter((end) => value[end] !== undefined).map((end) => [end, value[end] as number | null]),
  );
  return updateAt(document, ['spec', 'candidates', id, 'features', feature], written);
}

export function addCandidate(document: JsonObject, capability: string): JsonObject {
  const candidates = candidatesOf(document);
  const id = uniqueKey(Object.keys(candidates), 'new-provider');
  return withCandidates(document, { ...candidates, [id]: capability ? { provides: capability, features: {} } : { features: {} } });
}

export function removeCandidate(document: JsonObject, id: string): JsonObject {
  return updateAt(document, ['spec', 'candidates', id], undefined);
}

// --- rules

export type Enforcement = 'hard' | 'soft';

export interface RuleRow {
  id: string;
  condition: string;
  enforcement: Enforcement;
  penalty: number | null;
}

/** The rules as rows, when each is a plain condition with hard or soft enforcement; `null` otherwise (shown with the generic form). */
export function rulesOf(document: Content): RuleRow[] | null {
  if (!isObject(document) || !isObject(document.spec) || !isObject(document.spec.constraints)) return null;
  const rows: RuleRow[] = [];
  for (const [id, rule] of Object.entries(document.spec.constraints)) {
    if (!isObject(rule) || (rule.assert !== undefined && typeof rule.assert !== 'string')) return null;
    if (rule.enforcement !== 'hard' && rule.enforcement !== 'soft') return null;
    if (rule.penalty !== undefined && typeof rule.penalty !== 'number') return null;
    rows.push({ id, condition: typeof rule.assert === 'string' ? rule.assert : '', enforcement: rule.enforcement, penalty: typeof rule.penalty === 'number' ? rule.penalty : null });
  }
  return rows;
}

const constraintsOf = (document: JsonObject): JsonObject => (isObject(document.spec) && isObject(document.spec.constraints) ? document.spec.constraints : {});

export function renameRule(document: JsonObject, from: string, to: string): JsonObject {
  const rules = constraintsOf(document);
  if (!to.trim() || (to !== from && to in rules)) return document;
  return updateAt(document, ['spec', 'constraints'], renameKey(rules, from, to));
}

export function setRuleField(document: JsonObject, id: string, field: 'assert' | 'enforcement' | 'penalty', value: Json | undefined): JsonObject {
  return updateAt(document, ['spec', 'constraints', id, field], value);
}

export function addRule(document: JsonObject): JsonObject {
  const rules = constraintsOf(document);
  const id = uniqueKey(Object.keys(rules), 'new-rule');
  return updateAt(document, ['spec', 'constraints'], { ...rules, [id]: { assert: '', enforcement: 'hard' } });
}

export function removeRule(document: JsonObject, id: string): JsonObject {
  return updateAt(document, ['spec', 'constraints', id], undefined);
}

// --- checks before sealing

export interface Check {
  level: 'ok' | 'warn' | 'error';
  text: string;
  /** A problem the draft can't be saved or sealed with (a range that isn't valid); other errors are for the gateway to judge. */
  blocking?: boolean;
}

const MUST_NOT_BE_EMPTY = new Set(['Report', 'Collection', 'Study', 'BindingDecision', 'ExecutionConfiguration', 'AnalysisConfiguration']);

/** What can be said about a draft without asking the gateway; the gateway's own verdict (a 422 at seal) is added by the screen. */
export function checksFor(kind: string, content: Content): Check[] {
  const checks: Check[] = [];
  if (typeof content === 'string') {
    checks.push(content.trim() ? { level: 'ok', text: 'The file has content' } : { level: 'error', text: 'The file is empty' });
    if (kind === 'BPMN') {
      const xml = summarizeXml(content);
      checks.push(xml.ok ? { level: 'ok', text: `Well-formed XML with ${xml.tasks === 1 ? '1 task' : `${xml.tasks} tasks`}` } : { level: 'error', text: `The XML can’t be read: ${xml.error}` });
    }
    return checks;
  }
  const catalog = kind === 'CandidateCatalog' ? catalogOf(content) : null;
  const rules = kind === 'ConstraintSet' ? rulesOf(content) : null;
  if (catalog) {
    const rows = catalog.groups.flatMap((group) => group.rows);
    const incomplete = rows.filter((row) => catalog.columns.some((column) => row.features[column] === undefined));
    checks.push(rows.length ? { level: 'ok', text: `${rows.length} ${rows.length === 1 ? 'provider' : 'providers'} in ${catalog.groups.length} ${catalog.groups.length === 1 ? 'capability' : 'capabilities'}` } : { level: 'warn', text: 'No providers yet' });
    checks.push(incomplete.length
      ? { level: 'error', text: `${incomplete.length} ${incomplete.length === 1 ? 'provider is' : 'providers are'} missing a quality` }
      : { level: 'ok', text: 'Every provider has the same qualities' });
    const badRanges = rows.flatMap((row) => Object.entries(row.features)
      .filter(([, value]) => typeof value !== 'number' && validateFeature(value) !== null)
      .map(([column, value]) => `${row.id} · ${column}: ${validateFeature(value)}`));
    if (badRanges.length) {
      checks.push({ level: 'error', text: `${badRanges.length} ${badRanges.length === 1 ? 'range is' : 'ranges are'} not valid (${badRanges[0]}${badRanges.length > 1 ? `, and ${badRanges.length - 1} more` : ''})`, blocking: true });
    }
    const ranged = rows.reduce((total, row) => total + Object.values(row.features).filter((value) => typeof value !== 'number').length, 0);
    if (ranged && !badRanges.length) checks.push({ level: 'ok', text: `${ranged} ${ranged === 1 ? 'quality is a range' : 'qualities are ranges'}` });
    const unnamed = rows.filter((row) => !row.provider.trim());
    if (unnamed.length) checks.push({ level: 'warn', text: `${unnamed.length} ${unnamed.length === 1 ? 'candidate has' : 'candidates have'} no provider id` });
    const loose = catalog.groups.find((group) => group.capability === NO_CAPABILITY);
    if (loose) checks.push({ level: 'warn', text: 'Some candidates provide no capability' });
    return checks;
  }
  if (rules) {
    const blank = rules.filter((rule) => !rule.condition.trim());
    const unpriced = rules.filter((rule) => rule.enforcement === 'soft' && rule.penalty === null);
    checks.push(rules.length ? { level: 'ok', text: `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}` } : { level: 'warn', text: 'No rules yet' });
    checks.push(blank.length ? { level: 'error', text: `${blank.length} ${blank.length === 1 ? 'rule has' : 'rules have'} no condition` } : { level: 'ok', text: 'Every rule has a condition' });
    if (unpriced.length) checks.push({ level: 'warn', text: `${unpriced.length} soft ${unpriced.length === 1 ? 'rule has' : 'rules have'} no penalty` });
    return checks;
  }
  const empty = Object.keys(content).length === 0;
  if (MUST_NOT_BE_EMPTY.has(kind) && empty) checks.push({ level: 'error', text: 'The content can’t be empty for this kind' });
  else checks.push({ level: 'ok', text: empty ? 'No fields yet' : `${Object.keys(content).length} top-level ${Object.keys(content).length === 1 ? 'field' : 'fields'}` });
  if (kind === 'ExecutionConfiguration') {
    const engine = content.engine;
    const exact = isObject(engine) && ['namespace', 'name', 'version', 'digest'].every((key) => typeof engine[key] === 'string' && engine[key] !== '');
    checks.push(exact ? { level: 'ok', text: 'Names an exact engine' } : { level: 'error', text: 'The engine needs its namespace, name, version and digest' });
    checks.push(typeof content.mode === 'string' && content.mode ? { level: 'ok', text: 'Names a mode' } : { level: 'error', text: 'Choose the engine mode' });
  }
  return checks;
}

// --- text files

export interface XmlSummary {
  ok: boolean;
  root: string;
  tasks: number;
  lines: number;
  bytes: number;
  error?: string;
}

/** What a BPMN (or other XML) file holds, without opening it: its root, how many tasks it draws and how big it is. */
export function summarizeXml(text: string): XmlSummary {
  const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  const bytes = new TextEncoder().encode(text).length;
  if (typeof DOMParser === 'undefined') return { ok: true, root: '', tasks: 0, lines, bytes };
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(text, 'application/xml');
  } catch (caught) {
    return { ok: false, root: '', tasks: 0, lines, bytes, error: (caught instanceof Error ? caught.message : 'not well-formed').slice(0, 160) };
  }
  const failure = parsed.getElementsByTagName('parsererror')[0];
  if (failure || !parsed.documentElement) {
    return { ok: false, root: '', tasks: 0, lines, bytes, error: (failure?.textContent ?? 'not well-formed').split('\n')[0].slice(0, 160) };
  }
  const tasks = Array.from(parsed.getElementsByTagName('*')).filter((element) => /(^|:)([A-Za-z]*[tT]ask)$/.test(element.tagName)).length;
  return { ok: true, root: parsed.documentElement.localName, tasks, lines, bytes };
}

/** What sealing freezes, in words: the lines of the "Seal a new version" dialog. */
export function freezeLines(kind: string, content: Content, dependencies: number, basedOn: string | null): string[] {
  const lines: string[] = [];
  if (typeof content === 'string') {
    const xml = summarizeXml(content);
    lines.push(`The file (${xml.lines} ${xml.lines === 1 ? 'line' : 'lines'}${kind === 'BPMN' ? `, ${xml.tasks} ${xml.tasks === 1 ? 'task' : 'tasks'}` : ''})`);
  } else {
    const catalog = kind === 'CandidateCatalog' ? catalogOf(content) : null;
    const rules = kind === 'ConstraintSet' ? rulesOf(content) : null;
    if (catalog) {
      const count = catalog.groups.reduce((total, group) => total + group.rows.length, 0);
      lines.push(`${count} ${count === 1 ? 'provider' : 'providers'} in ${catalog.groups.length} ${catalog.groups.length === 1 ? 'capability' : 'capabilities'}, and their qualities`);
    } else if (rules) {
      lines.push(`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} and their conditions`);
    } else {
      const fields = Object.keys(content).length;
      lines.push(`${fields} top-level ${fields === 1 ? 'field' : 'fields'} and everything inside them`);
    }
    if (typeof content.apiVersion === 'string') lines.push(`The language ${content.apiVersion}`);
  }
  if (dependencies > 0) lines.push(`${dependencies} exact ${dependencies === 1 ? 'dependency' : 'dependencies'}`);
  if (basedOn) lines.push(`Everything in version ${basedOn} that you didn’t change`);
  return lines;
}

// --- comparing two copies of a draft

export interface Difference {
  field: string;
  mine: string;
  theirs: string;
}

function flatten(value: Json | undefined, path: string[], into: Map<string, string>): void {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flatten(child, [...path, key], into);
  } else if (Array.isArray(value) && value.length > 0) {
    value.forEach((child, index) => flatten(child, [...path, String(index + 1)], into));
  } else {
    into.set(path.join(' · '), value === undefined ? '' : isObject(value) ? '{}' : Array.isArray(value) ? '[]' : String(value));
  }
}

/** The fields that differ between two copies of a draft, by name: what the conflict screen puts side by side. */
export function differences(mine: Content, theirs: Content, limit = 20): Difference[] {
  if (typeof mine === 'string' || typeof theirs === 'string') {
    if (mine === theirs) return [];
    const lines = (text: Content) => {
      if (typeof text !== 'string') return 'structured content';
      const count = text.split('\n').length;
      return `${count} ${count === 1 ? 'line' : 'lines'}`;
    };
    return [{ field: 'File', mine: lines(mine), theirs: lines(theirs) }];
  }
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  flatten(mine, [], left);
  flatten(theirs, [], right);
  const fields = [...new Set([...left.keys(), ...right.keys()])];
  return fields
    .filter((field) => left.get(field) !== right.get(field))
    .slice(0, limit)
    .map((field) => ({ field: field.replace(/^spec · /, ''), mine: left.get(field) ?? '—', theirs: right.get(field) ?? '—' }));
}

/** Is it a reference to an exact version (`namespace`, `name`, `version`, `versionDigest`)? */
export function isVersionRef(value: unknown): value is { namespace: string; name: string; version: string; versionDigest: string } {
  return isObject(value) && ['namespace', 'name', 'version', 'versionDigest'].every((key) => typeof value[key] === 'string');
}

/** A reference to the exact version of a case revision (what a study or a collection may also hold). */
export function isCaseRevisionRef(value: unknown): value is { caseRevisionId: string; compositionDigest: string } {
  return isObject(value) && typeof value.caseRevisionId === 'string' && typeof value.compositionDigest === 'string';
}

/** A number as people type it (`0.5`, `-3`, `1e-4`); `undefined` for anything else, so a half-typed value never becomes `NaN`. */
export const parseNumber = parseFiniteNumber;

export type NodeType = 'text' | 'number' | 'boolean' | 'group' | 'list';

export const NODE_TYPES: ReadonlyArray<{ id: NodeType; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Yes / No' },
  { id: 'group', label: 'Group' },
  { id: 'list', label: 'List' },
];

export function defaultOf(type: NodeType): Json {
  switch (type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'group': return {};
    case 'list': return [];
    default: return '';
  }
}

export function typeOf(value: Json | undefined): NodeType {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'list';
  if (isObject(value)) return 'group';
  return 'text';
}

// --- how fields are called

const KEY_LABELS: Record<string, string> = {
  apiVersion: 'Language version', kind: 'Type', metadata: 'Details', spec: 'Contents', name: 'Name', description: 'Description',
  tasks: 'Tasks', features: 'Qualities', workflow: 'Workflow', candidates: 'Candidates', constraints: 'Rules', penalties: 'Penalties',
  criteria: 'Goal criteria', engines: 'Engines', engine: 'Engine', cases: 'Cases', seeds: 'Seeds', parameter_sets: 'Parameter sets',
  members: 'Members', options: 'Options', mode: 'Mode', registration: 'Registration', assert: 'Condition', enforcement: 'Enforcement',
  penalty: 'Penalty', weight: 'Weight', unit: 'Unit', direction: 'Direction', scope: 'Scope', aggregation: 'Aggregation', domain: 'Range',
  minimum: 'Minimum', maximum: 'Maximum', min: 'Minimum', max: 'Maximum', provides: 'Provides', provider: 'Provider', resource: 'Resource',
  id: 'Id', normalize: 'Scale', feature: 'Quality', collection: 'Collection', version: 'Version', namespace: 'Namespace', digest: 'Fingerprint',
  versionDigest: 'Version fingerprint', labels: 'Labels', annotations: 'Notes',
};

/** A field name in words: the well-known ones are named, the rest are shown as written. */
export function labelOf(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** A value in one line, for tables and the conflict comparison. */
export function brief(value: Json | undefined): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(brief).join(', ');
  if (isRange(value)) return formatFeature(value);
  const entries = Object.entries(value);
  return entries.length === 0 ? '—' : entries.map(([key, child]) => `${labelOf(key)}: ${brief(child)}`).join(' · ');
}
