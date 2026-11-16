import type { Problem, ProblemRevision } from '../../api/problems';
import { parseBindingSpace } from '../../components/BindingSpaceBadge/bindingSpace';
import { workflowGraph } from '../../modules/core/utils/binding/workflowGraph';
import { describeExpression } from '../../modules/core/utils/problem/expressions';
import type { ProblemFacts } from '../../modules/core/api/types';
import { formatFeature, type FeatureValue } from '../../utils/featureRange';

/** The longest a case's name and description may be (`BindingCaseCreate` in the contract). */
export const NAME_MAX = 160;
export const DESCRIPTION_MAX = 2000;

// --- revisions

export function newestFirst<T extends Pick<ProblemRevision, 'revision'>>(
  revisions: readonly T[]
): T[] {
  return [...revisions].sort((a, b) => b.revision - a.revision);
}

export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** What a person copies to cite a revision exactly: the problem, the version and the package digest. */
export function exactReference(
  caseSlug: string,
  revision: Pick<ProblemRevision, 'revision' | 'package_digest'>
): string {
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
  /** The facts of the revision's compilation; `null` when they couldn't be read. */
  facts: ProblemFacts | null;
}

/** A binding-space size (a decimal string) as a power of ten people can read: `10^3.3`. Counting digits is formatting. */
export function powerText(bindingSpace: string | null | undefined): string {
  if (!bindingSpace) return '—';
  return `10^${(Math.round(parseBindingSpace(bindingSpace).log10 * 10) / 10).toString()}`;
}

const row = (category: DiffCategory, what: string, a: string, b: string): DiffRow => ({
  category,
  what,
  a,
  b,
  changed: a !== b,
});

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The criteria and penalties of the objectives, as the facts pass them through from the compiled problem. */
const criteriaOf = (facts: ProblemFacts) =>
  facts.objectives.criteria.flatMap((criterion, index) => {
    const id = text(criterion.id) ?? `criterion ${index + 1}`;
    return [
      {
        id,
        feature: text(record(criterion.feature).id) ?? id,
        direction: text(criterion.direction),
      },
    ];
  });
const penaltiesOf = (facts: ProblemFacts) =>
  facts.objectives.penalties.flatMap(penalty => {
    const rule = text(record(penalty.constraint).id);
    return rule
      ? [{ rule, weight: typeof penalty.weight === 'number' ? penalty.weight : null }]
      : [];
  });

/** Side by side, what the two revisions are made of and where they differ. */
export function diffRevisions(from: RevisionView, to: RevisionView): DiffRow[] {
  const rows: DiffRow[] = [];
  const left = from.facts;
  const right = to.facts;
  if (!left || !right) return rows;

  const taskIds = [...new Set([...left.tasks, ...right.tasks].map(task => task.id))];
  const taskOf = (facts: ProblemFacts, id: string) => facts.tasks.find(task => task.id === id);
  const eligibleCount = (facts: ProblemFacts) =>
    new Set(facts.tasks.flatMap(task => task.eligible.map(entry => entry.candidate))).size;
  rows.push(
    row(
      'Providers',
      'Providers in total',
      String(eligibleCount(left)),
      String(eligibleCount(right))
    )
  );
  for (const id of taskIds) {
    const a = taskOf(left, id);
    const b = taskOf(right, id);
    if ((a?.kind ?? b?.kind) !== 'service') continue;
    rows.push(
      row(
        'Providers',
        `Candidates for ${id}`,
        a ? String(a.eligible.length) : '—',
        b ? String(b.eligible.length) : '—'
      )
    );
  }
  // A value that changed between the revisions, whether it stayed a number, became a range, or a range moved: before and after side by side.
  const valuesOf = (facts: ProblemFacts, key: string) =>
    facts.candidates.find(candidate => candidate.key === key)?.values ?? null;
  const unitOf = (name: string) =>
    right.features.find(feature => feature.id === name)?.unit ??
    left.features.find(feature => feature.id === name)?.unit ??
    null;
  for (const id of taskIds) {
    const a = taskOf(left, id);
    const b = taskOf(right, id);
    if ((a?.kind ?? b?.kind) !== 'service' || !a || !b) continue;
    for (const entry of a.eligible) {
      const after = b.eligible.find(other => other.candidate === entry.candidate);
      const was = valuesOf(left, entry.candidate);
      const now = valuesOf(right, entry.candidate);
      if (!after || !was || !now) continue;
      for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
        const before: FeatureValue | undefined = was[name];
        const later: FeatureValue | undefined = now[name];
        if (JSON.stringify(before) === JSON.stringify(later)) continue;
        const unit = unitOf(name);
        const shown = (value: FeatureValue | undefined) =>
          value === undefined ? '—' : formatFeature(value, { unit });
        const kind =
          before === undefined || later === undefined
            ? ''
            : typeof before === 'number' && typeof later === 'number'
              ? ''
              : typeof before === 'number'
                ? ' (now a range)'
                : typeof later === 'number'
                  ? ' (now a single value)'
                  : ' (range changed)';
        const what = `${after.written} · ${name}${kind}`;
        if (rows.some(existing => existing.category === 'Providers' && existing.what === what))
          continue;
        rows.push(row('Providers', what, shown(before), shown(later)));
      }
    }
  }

  const services = (facts: ProblemFacts) =>
    facts.tasks.filter(task => task.kind === 'service').length;
  const tasksText = (facts: ProblemFacts) =>
    `${facts.tasks.length} tasks (${services(facts)} get a provider)`;
  rows.push(row('Tasks', 'Tasks', tasksText(left), tasksText(right)));
  for (const id of taskIds) {
    const a = taskOf(left, id);
    const b = taskOf(right, id);
    if (!a || !b) rows.push(row('Tasks', `Task ${id}`, a ? 'present' : '—', b ? 'present' : '—'));
  }
  // Two workflows are the same when the gateway wrote the same Composition2Yaml node for both; the words are only what the row shows.
  const flowWords = (facts: ProblemFacts) =>
    workflowGraph(facts.workflow).description.replace(/^Workflow: /, '');
  rows.push({
    category: 'Tasks',
    what: 'Workflow',
    a: flowWords(left),
    b: flowWords(right),
    changed: JSON.stringify(left.workflow) !== JSON.stringify(right.workflow),
  });

  const ruleIds = [...new Set([...left.constraints, ...right.constraints].map(rule => rule.id))];
  for (const id of ruleIds) {
    const a = left.constraints.find(rule => rule.id === id);
    const b = right.constraints.find(rule => rule.id === id);
    const show = (rule: typeof a) =>
      rule
        ? `${rule.enforcement === 'hard' ? 'Must' : 'Should'}: ${describeExpression(rule.expression)}`
        : '—';
    rows.push(row('Rules', id, show(a), show(b)));
  }
  if (ruleIds.length === 0) rows.push(row('Rules', 'Rules', 'none', 'none'));

  const leftCriteria = criteriaOf(left);
  const rightCriteria = criteriaOf(right);
  const criterionIds = [...new Set([...leftCriteria, ...rightCriteria].map(item => item.id))];
  for (const id of criterionIds) {
    const a = leftCriteria.find(item => item.id === id);
    const b = rightCriteria.find(item => item.id === id);
    const show = (item: typeof a) =>
      item ? `${item.direction ?? 'optimize'} ${item.feature}` : '—';
    rows.push(row('Goal', id, show(a), show(b)));
  }
  const leftPenalties = penaltiesOf(left);
  const rightPenalties = penaltiesOf(right);
  const penaltyRules = [...new Set([...leftPenalties, ...rightPenalties].map(item => item.rule))];
  for (const rule of penaltyRules) {
    const a = leftPenalties.find(item => item.rule === rule);
    const b = rightPenalties.find(item => item.rule === rule);
    const show = (item: typeof a) => (item ? `weight ${item.weight ?? '—'}` : '—');
    rows.push(row('Goal', `Penalty for breaking ${rule}`, show(a), show(b)));
  }
  if (criterionIds.length === 0 && penaltyRules.length === 0)
    rows.push(row('Goal', 'Goal', 'none', 'none'));
  return rows;
}

/** One line a person can paste into a message to say what changed. */
export function diffSummary(
  caseSlug: string,
  from: RevisionView,
  to: RevisionView,
  rows: readonly DiffRow[]
): string {
  const changed = rows
    .filter(item => item.changed)
    .map(item => `${item.what} ${item.a} → ${item.b}`);
  const size =
    from.facts && to.facts
      ? `; combinations ${powerText(from.facts.binding_space)} → ${powerText(to.facts.binding_space)}`
      : '';
  return `${caseSlug} v${from.revision} → v${to.revision}: ${changed.length ? changed.join('; ') : 'no changes'}${size}.`;
}

export function problemSortKey(item: Problem, revisions: readonly ProblemRevision[]): number {
  const latest = revisions.reduce<string | null>(
    (best, revision) => (best === null || revision.created_at > best ? revision.created_at : best),
    null
  );
  return Date.parse(latest ?? item.created_at) || 0;
}
