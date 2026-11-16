import type { TaskOverlay } from '../../../../entities/binding/workflowGraph';
import { formatDiffValue, type DiffSide } from '../../../../entities/composition/changes';
import type { TaskModel } from '../../../../entities/composition/viewModel';
import type { CompositionVersionDiff } from '../../../../modules/core/api/types';

/**
 * How the comparison mode reads the gateway's diff of two versions: which entries a kind filter keeps, how a field change is
 * written, and what the workflow drawing marks. The diff is the gateway's; nothing here compares two values itself.
 */

export type Diff = CompositionVersionDiff;
export type DiffSection = Diff['sections'][number];
export type DiffEntry = DiffSection['entries'][number];
export type FieldChange = Diff['general'][number];
export type ChangeKind = DiffEntry['kind'];

export const CHANGE_KINDS: readonly ChangeKind[] = ['added', 'removed', 'changed'];

export const KIND_LABELS: Readonly<Record<ChangeKind, string>> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

/** Something the screen asked the gateway for: on its way, refused (with a retry), or here. */
export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | { status: 'ready'; value: T };

/** A filter only holds while there is something of its kind to show. */
export function activeFilter(diff: Diff, filter: ChangeKind | null): ChangeKind | null {
  return filter && diff.totals[filter] > 0 ? filter : null;
}

/** The sections with entries of the kind the filter keeps (every kind without one); empty sections are left out. */
export function filteredSections(diff: Diff, filter: ChangeKind | null): DiffSection[] {
  return diff.sections
    .map(section => ({
      ...section,
      entries: filter ? section.entries.filter(entry => entry.kind === filter) : section.entries,
    }))
    .filter(section => section.entries.length > 0);
}

/** Changes of the top-level fields (kind, problem, workflow…) count as changed. */
export function showsGeneral(diff: Diff, filter: ChangeKind | null): boolean {
  return diff.general.length > 0 && (filter === null || filter === 'changed');
}

/** An entry shows its field changes at first when it was changed in a few fields. */
export const opensAtFirst = (entry: DiffEntry): boolean =>
  entry.kind === 'changed' && entry.changes.length <= 6;

const isStructure = (value: unknown) => typeof value === 'object' && value !== null;

/** One side of a field change as written on screen; `absent` when the field is not there on that side. */
export interface SideText {
  text: string;
  absent: boolean;
}

export interface ChangeRowModel {
  path: string;
  /** Shown for a changed or removed entry. */
  before: SideText | null;
  /** Shown for a changed or added entry. */
  after: SideText | null;
  /** A whole structure changed (the workflow, say): it is named, not printed; the file view shows it. */
  structure: boolean;
}

const side = (value: unknown, which: DiffSide): SideText => ({
  text: formatDiffValue(value, which),
  absent: value === null || value === undefined,
});

/** A field change of an entry of `kind`, as a row reads it: `before → after`, with a missing side read as absent. */
export function changeRow(change: FieldChange, kind: ChangeKind): ChangeRowModel {
  if (isStructure(change.before) || isStructure(change.after))
    return { path: change.path, before: null, after: null, structure: true };
  return {
    path: change.path,
    before: kind === 'added' ? null : side(change.before, 'before'),
    after: kind === 'removed' ? null : side(change.after, 'after'),
    structure: false,
  };
}

const bindingEntries = (diff: Diff) =>
  diff.sections.filter(section => section.key === 'binding').flatMap(section => section.entries);

/**
 * What the workflow drawing of the later version says of each task: its candidate (or that it is local) and whether its binding
 * entry was added or changed since the earlier version.
 */
export function taskOverlay(diff: Diff, tasks: readonly TaskModel[]): Record<string, TaskOverlay> {
  const kinds = new Map(bindingEntries(diff).map(entry => [entry.name, entry.kind]));
  return Object.fromEntries(
    tasks.map((task): [string, TaskOverlay] => {
      const status = kinds.get(task.id);
      return [
        task.id,
        {
          ...(task.local ? { local: true } : task.candidate ? { candidate: task.candidate } : {}),
          ...(status ? { status } : {}),
        },
      ];
    })
  );
}

/** The tasks whose binding entry was removed and that the later version's workflow no longer has, so its drawing cannot show them. */
export function removedTasks(diff: Diff, tasks: readonly TaskModel[]): string[] {
  const present = new Set(tasks.map(task => task.id));
  return bindingEntries(diff)
    .filter(entry => entry.kind === 'removed' && !present.has(entry.name))
    .map(entry => entry.name);
}

/** Whether the workflow itself changed (a general change of `workflow`). */
export const workflowChanged = (diff: Diff): boolean =>
  diff.general.some(change => change.path === 'workflow');

/**
 * The tags of each candidate in the matrix: the label of every version whose evaluation chose it, so both selections show.
 * Selections are task → candidate key, as `EvaluationView.binding` has them; keys are compared, never read.
 */
export function selectionTags(
  selections: ReadonlyArray<{ label: string; selection: Readonly<Record<string, string>> | null }>
): (task: string, candidate: string) => string[] {
  return (task, candidate) =>
    selections
      .filter(({ selection }) => selection?.[task] === candidate)
      .map(({ label }) => `In ${label}`);
}
