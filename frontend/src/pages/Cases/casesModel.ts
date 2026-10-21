import type { ArtifactRef } from '../../api/library';
import type { BindingCase, CaseRevision } from '../../api/platform';
import { shortDigest } from '../../utils/digest';
import { formatFeature } from '../../utils/featureRange';
import { flowText, powerText, rulesText, type BindingModel } from './bindingModel';

export { SLUG_PATTERN, slugFromName } from '../Project/projectModel';

/** The longest a case's name and description may be (`BindingCaseCreate` in the contract). */
export const NAME_MAX = 160;
export const DESCRIPTION_MAX = 2000;

// --- the four parts of a composition

export type RoleKey = 'application' | 'candidateCatalog' | 'constraintSet' | 'optimization';

export interface RoleDef {
  key: RoleKey;
  number: number;
  label: string;
  help: string;
  requirement: string;
  required: boolean;
  /** More than one library version may fill this part. */
  many: boolean;
  /** The kinds of library item that can fill it. */
  kinds: readonly string[];
}

/** The roles of the `qos-binding` profile. The cardinalities follow its resource types (an assumption the screen states). */
export const ROLES: readonly RoleDef[] = [
  { key: 'application', number: 1, label: 'Application', help: 'Tasks and how they flow', requirement: 'Required · exactly one', required: true, many: false, kinds: ['Application'] },
  { key: 'candidateCatalog', number: 2, label: 'Candidate catalog', help: 'Providers and their measured qualities', requirement: 'Required · one or more', required: true, many: true, kinds: ['CandidateCatalog'] },
  { key: 'constraintSet', number: 3, label: 'Rules', help: 'Must-have and nice-to-have limits', requirement: 'Optional', required: false, many: true, kinds: ['ConstraintSet'] },
  { key: 'optimization', number: 4, label: 'Goal', help: 'What “best” means', requirement: 'Required · exactly one', required: true, many: false, kinds: ['Optimization'] },
];

const ROLE_LABELS: Record<string, string> = {
  application: 'Application · workflow',
  candidateCatalog: 'Candidate catalog',
  constraintSet: 'Rules',
  optimization: 'Goal',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** The pattern a local name (alias) must match. */
export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `providers-eu` from `Providers EU`: a local name a person didn't have to think about. */
export function aliasFrom(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128);
  return cleaned || 'part';
}

// --- the library versions a revision is built from

export interface ResourceUse {
  role: string;
  alias: string;
  ref: ArtifactRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRef(value: unknown): value is ArtifactRef {
  return isRecord(value) && typeof value.name === 'string' && typeof value.version === 'string' && typeof value.versionDigest === 'string';
}

/** The exact library versions the revision document names (`spec.resources.{role}.{alias}`), in a stable order. */
export function resourceUses(document: Record<string, unknown> | undefined): ResourceUse[] {
  const spec = document && isRecord(document.spec) ? document.spec : {};
  const resources = isRecord(spec.resources) ? spec.resources : {};
  const uses: ResourceUse[] = [];
  for (const [role, group] of Object.entries(resources)) {
    if (!isRecord(group)) continue;
    for (const [alias, target] of Object.entries(group)) {
      if (isRef(target)) uses.push({ role, alias, ref: { namespace: String(target.namespace ?? ''), name: target.name, version: target.version, versionDigest: target.versionDigest } });
    }
  }
  const order = ROLES.map((role) => role.key as string);
  const rank = (role: string) => (order.includes(role) ? order.indexOf(role) : order.length);
  return uses.sort((a, b) => rank(a.role) - rank(b.role) || a.alias.localeCompare(b.alias));
}

/** `providers-eu v3`. */
export function refLabel(ref: Pick<ArtifactRef, 'name' | 'version'>): string {
  return `${ref.name} ${/^\d/.test(ref.version) ? 'v' : ''}${ref.version}`;
}

// --- revisions

export function newestFirst(revisions: readonly CaseRevision[]): CaseRevision[] {
  return [...revisions].sort((a, b) => b.revision - a.revision);
}

export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** What a person copies to cite a revision exactly. */
export function exactReference(caseSlug: string, revision: Pick<CaseRevision, 'revision' | 'digest'>): string {
  return `${caseSlug}@${revision.revision} ${revision.digest}`;
}

const useKey = (use: ResourceUse) => `${use.role}/${use.alias}`;

export interface Change {
  label: string;
  from: string | null;
  to: string | null;
}

/** The inputs that differ between two revisions, from the library versions their documents name. */
export function changesBetween(previous: ResourceUse[], current: ResourceUse[]): Change[] {
  const before = new Map(previous.map((use) => [useKey(use), use]));
  const after = new Map(current.map((use) => [useKey(use), use]));
  const changes: Change[] = [];
  for (const [key, use] of after) {
    const old = before.get(key);
    if (!old) changes.push({ label: `${roleLabel(use.role)} · ${use.alias}`, from: null, to: refLabel(use.ref) });
    else if (old.ref.versionDigest !== use.ref.versionDigest) changes.push({ label: `${roleLabel(use.role)} · ${use.alias}`, from: refLabel(old.ref), to: refLabel(use.ref) });
  }
  for (const [key, use] of before) {
    if (!after.has(key)) changes.push({ label: `${roleLabel(use.role)} · ${use.alias}`, from: refLabel(use.ref), to: null });
  }
  return changes;
}

export function describeChange(change: Change): string {
  if (change.from === null) return `${change.label} added: ${change.to}`;
  if (change.to === null) return `${change.label} removed (was ${change.from})`;
  return `${change.label}: ${change.from} → ${change.to}`;
}

// --- comparison

export type DiffCategory = 'Resources' | 'Providers' | 'Tasks' | 'Rules' | 'Goal';

export const DIFF_CATEGORIES: readonly DiffCategory[] = ['Resources', 'Providers', 'Tasks', 'Rules', 'Goal'];

export interface DiffRow {
  category: DiffCategory;
  what: string;
  a: string;
  b: string;
  changed: boolean;
}

export interface RevisionView {
  revision: number;
  uses: ResourceUse[];
  /** `null` when the revision has no compiled snapshot or it couldn't be read. */
  model: BindingModel | null;
}

const row = (category: DiffCategory, what: string, a: string, b: string): DiffRow => ({ category, what, a, b, changed: a !== b });

/** Side by side, what the two revisions are made of and where they differ. */
export function diffRevisions(from: RevisionView, to: RevisionView): DiffRow[] {
  const rows: DiffRow[] = [];

  const keys = [...new Set([...from.uses, ...to.uses].map(useKey))];
  const find = (view: RevisionView, key: string) => view.uses.find((use) => useKey(use) === key);
  for (const key of keys) {
    const a = find(from, key);
    const b = find(to, key);
    const label = (use: ResourceUse | undefined) => (use ? `${refLabel(use.ref)} · ${shortDigest(use.ref.versionDigest)}` : '—');
    const sample = a ?? b;
    if (sample) rows.push(row('Resources', `${roleLabel(sample.role)} · ${sample.alias}`, label(a), label(b)));
  }

  const left = from.model;
  const right = to.model;
  if (!left || !right) return rows;

  const taskIds = [...new Set([...left.tasks, ...right.tasks].map((task) => task.id))];
  const taskOf = (model: BindingModel, id: string) => model.tasks.find((task) => task.id === id);
  rows.push(row('Providers', 'Providers in total', String(left.candidateCount), String(right.candidateCount)));
  for (const id of taskIds) {
    const a = taskOf(left, id);
    const b = taskOf(right, id);
    if ((a?.kind ?? b?.kind) !== 'service') continue;
    rows.push(row('Providers', `Candidates for ${id}`, a ? String(a.candidates.length) : '—', b ? String(b.candidates.length) : '—'));
  }
  // A quality that changed between the revisions, whether it stayed a number, became a range, or a range moved: before and after side by side.
  for (const id of taskIds) {
    const a = taskOf(left, id);
    const b = taskOf(right, id);
    if ((a?.kind ?? b?.kind) !== 'service') continue;
    const candidateIds = [...new Set([...(a?.candidates ?? []), ...(b?.candidates ?? [])].map((candidate) => candidate.id))];
    for (const candidateId of candidateIds) {
      const before = a?.candidates.find((candidate) => candidate.id === candidateId);
      const after = b?.candidates.find((candidate) => candidate.id === candidateId);
      if (!before || !after) continue;
      const names = [...new Set([...Object.keys(before.features), ...Object.keys(after.features)])];
      for (const name of names) {
        const was = before.features[name];
        const now = after.features[name];
        const unit = left.features[name]?.unit ?? right.features[name]?.unit ?? null;
        const shown = (value: typeof was) => (value === undefined ? '—' : formatFeature(value, { unit }));
        if (JSON.stringify(was) === JSON.stringify(now)) continue;
        const kind = was === undefined || now === undefined ? '' : typeof was === 'number' && typeof now === 'number' ? '' : typeof was === 'number' ? ' (now a range)' : typeof now === 'number' ? ' (now a single value)' : ' (range changed)';
        const what = `${candidateId} · ${name}${kind}`;
        if (rows.some((existing) => existing.category === 'Providers' && existing.what === what)) continue;
        rows.push(row('Providers', what, shown(was), shown(now)));
      }
    }
  }

  const tasksText = (model: BindingModel) => `${model.tasks.length} tasks (${model.serviceTasks} get a provider)`;
  rows.push(row('Tasks', 'Tasks', tasksText(left), tasksText(right)));
  for (const id of taskIds) {
    const a = taskOf(left, id);
    const b = taskOf(right, id);
    if (!a || !b) rows.push(row('Tasks', `Task ${id}`, a ? 'present' : '—', b ? 'present' : '—'));
  }
  rows.push(row('Tasks', 'Workflow', flowText(left.flow), flowText(right.flow)));

  const ruleIds = [...new Set([...left.rules, ...right.rules].map((rule) => rule.id))];
  for (const id of ruleIds) {
    const a = left.rules.find((rule) => rule.id === id);
    const b = right.rules.find((rule) => rule.id === id);
    const show = (rule: typeof a) => (rule ? `${rule.enforcement === 'hard' ? 'Must' : 'Should'}: ${rule.text}` : '—');
    rows.push(row('Rules', id, show(a), show(b)));
  }
  if (ruleIds.length === 0) rows.push(row('Rules', 'Rules', 'none', 'none'));

  const criterionIds = [...new Set([...left.criteria, ...right.criteria].map((item) => item.id))];
  for (const id of criterionIds) {
    const a = left.criteria.find((item) => item.id === id);
    const b = right.criteria.find((item) => item.id === id);
    const show = (item: typeof a) => (item ? `${item.direction ?? 'optimize'} ${item.feature}` : '—');
    rows.push(row('Goal', id, show(a), show(b)));
  }
  const penaltyRules = [...new Set([...left.penalties, ...right.penalties].map((item) => item.rule))];
  for (const rule of penaltyRules) {
    const a = left.penalties.find((item) => item.rule === rule);
    const b = right.penalties.find((item) => item.rule === rule);
    rows.push(row('Goal', `Penalty for breaking ${rule}`, a ? `weight ${a.weight}` : '—', b ? `weight ${b.weight}` : '—'));
  }
  if (criterionIds.length === 0 && penaltyRules.length === 0) rows.push(row('Goal', 'Goal', 'none', 'none'));
  return rows;
}

/** One line a person can paste into a message to say what changed. */
export function diffSummary(caseSlug: string, from: RevisionView, to: RevisionView, rows: readonly DiffRow[]): string {
  const changed = rows.filter((item) => item.changed).map((item) => `${item.what} ${item.a} → ${item.b}`);
  const size = from.model && to.model ? `; combinations ${powerText(from.model.log10)} → ${powerText(to.model.log10)}` : '';
  return `${caseSlug} r${from.revision} → r${to.revision}: ${changed.length ? changed.join('; ') : 'no changes'}${size}.`;
}

/** How much bigger or smaller the second revision's problem is, in words. */
export function sizeChange(from: number | null, to: number | null): { text: string; grew: boolean } | null {
  if (from === null || to === null) return null;
  const delta = to - from;
  if (Math.abs(delta) < 0.05) return { text: 'About the same number of combinations', grew: false };
  const factor = 10 ** Math.abs(delta);
  const shown = factor >= 10 ? Math.round(factor).toLocaleString('en-US') : (Math.round(factor * 10) / 10).toString();
  return {
    text: `≈ ${shown}× ${delta > 0 ? 'more' : 'fewer'} combinations (10^${(Math.round(Math.abs(delta) * 10) / 10).toString()})`,
    grew: delta > 0,
  };
}

/** The four figures under "Latest revision at a glance". */
export function glance(model: BindingModel): Array<{ value: string; label: string }> {
  return [
    { value: String(model.tasks.length), label: `tasks (${model.serviceTasks} get a provider)` },
    { value: String(model.candidateCount), label: 'candidates in total' },
    { value: String(model.rules.length), label: model.rules.length === 0 ? 'rules' : `rules (${rulesText(model.rules)})` },
    { value: String(model.criteria.length), label: model.criteria.length === 1 ? 'thing to optimize' : 'things to optimize' },
  ];
}

export function caseSortKey(item: BindingCase, revisions: readonly CaseRevision[]): number {
  const latest = revisions.reduce<string | null>((best, revision) => (best === null || revision.created_at > best ? revision.created_at : best), null);
  return Date.parse(latest ?? item.created_at) || 0;
}
