import type { Problem, ProblemRevision } from '../../api/problems';
import { formatFeature } from '../../utils/featureRange';
import { flowText, powerText, rulesText, type BindingModel } from './bindingModel';

export { SLUG_PATTERN, slugFromName } from '../../features/workspace/model';

/** The longest a case's name and description may be (`BindingCaseCreate` in the contract). */
export const NAME_MAX = 160;
export const DESCRIPTION_MAX = 2000;

// --- revisions

export function newestFirst<T extends Pick<ProblemRevision, 'revision'>>(revisions: readonly T[]): T[] {
  return [...revisions].sort((a, b) => b.revision - a.revision);
}

export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** What a person copies to cite a revision exactly: the problem, the version and the package digest. */
export function exactReference(caseSlug: string, revision: Pick<ProblemRevision, 'revision' | 'package_digest'>): string {
  return `${caseSlug}@${revision.revision} ${revision.package_digest}`;
}

// --- comparison

export type DiffCategory = 'Providers' | 'Tasks' | 'Rules' | 'Goal';

export const DIFF_CATEGORIES: readonly DiffCategory[] = ['Providers', 'Tasks', 'Rules', 'Goal'];

export interface DiffRow {
  category: DiffCategory;
  what: string;
  a: string;
  b: string;
  changed: boolean;
}

export interface RevisionView {
  revision: number;
  /** The package digest: two versions with the same digest are the same package. */
  digest: string;
  /** `null` when the compilation of the revision couldn't be read. */
  model: BindingModel | null;
}

const row = (category: DiffCategory, what: string, a: string, b: string): DiffRow => ({ category, what, a, b, changed: a !== b });

/** Side by side, what the two revisions are made of and where they differ. */
export function diffRevisions(from: RevisionView, to: RevisionView): DiffRow[] {
  const rows: DiffRow[] = [];
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
  return `${caseSlug} v${from.revision} → v${to.revision}: ${changed.length ? changed.join('; ') : 'no changes'}${size}.`;
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

export function caseSortKey(item: Problem, revisions: readonly ProblemRevision[]): number {
  const latest = revisions.reduce<string | null>((best, revision) => (best === null || revision.created_at > best ? revision.created_at : best), null);
  return Date.parse(latest ?? item.created_at) || 0;
}
