import type { TaskModel } from '../../entities/composition/viewModel';

/**
 * Who serves each task of a composition, grouped. A task bound to a candidate goes under the candidate's provider when the
 * problem's facts name it (a member who can read the problem), else under the SPHERE pricing its `from` names, else under an
 * unknown provider; a task done in house goes under "In-house". Names are compared as written: nothing is inferred from them.
 */

export type ProviderGroupKind = 'provider' | 'pricing' | 'unknown' | 'in-house';

export interface ProviderGroup {
  kind: ProviderGroupKind;
  /** The provider as the facts name it, or the pricing as `owner/name` (with `on <registry>`); empty for the last two kinds. */
  name: string;
  /** In workflow order. */
  tasks: TaskModel[];
}

const pricingOf = (task: TaskModel): string | null => (
  task.from ? `${task.from.sphere}${task.from.registry ? ` on ${task.from.registry}` : ''}` : null
);

function placeOf(task: TaskModel): { kind: ProviderGroupKind; name: string } {
  if (task.local) return { kind: 'in-house', name: '' };
  if (task.candidate !== null && task.provider !== null) return { kind: 'provider', name: task.provider };
  const pricing = pricingOf(task);
  if (task.candidate !== null && pricing !== null) return { kind: 'pricing', name: pricing };
  return { kind: 'unknown', name: '' };
}

/** The groups in the order their first task appears, with the unknown provider and then the in-house tasks last. */
export function providerGroups(tasks: readonly TaskModel[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const task of tasks) {
    const { kind, name } = placeOf(task);
    const group = groups.find((item) => item.kind === kind && item.name === name);
    if (group) group.tasks.push(task);
    else groups.push({ kind, name, tasks: [task] });
  }
  const rank = (kind: ProviderGroupKind) => (kind === 'in-house' ? 2 : kind === 'unknown' ? 1 : 0);
  return groups.map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group.kind) - rank(b.group.kind) || a.index - b.index)
    .map(({ group }) => group);
}
