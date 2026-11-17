// The configurations the explorer walks: the version's own binding, then each of the toolchain's one-task moves of it (the
// gateway's neighbourhood), as SPHERE's configuration space lists a pricing's subscriptions. Nothing here evaluates or ranks a
// binding: the comparison word and every delta are the gateway's.

import type { WrittenBinding } from '../../../core/components/composition-renderer/modes/analysis';
import {
  withMove,
  type MoveRow,
} from '../../../core/components/composition-renderer/modes/calculatorModel';

export interface ExplorerConfiguration {
  /** `version`, or `<task>:<candidate>` for a move: what a compare slot and the address hold. */
  key: string;
  /** In words: "The version's binding", "T1: a → b". */
  label: string;
  binding: WrittenBinding;
  /** The move that makes it; null for the version's own binding. */
  move: MoveRow | null;
}

export const VERSION_KEY = 'version';

export const moveKey = (row: Pick<MoveRow, 'task' | 'to'>) => `${row.task}:${row.to}`;

export function configurationsOf(
  rows: readonly MoveRow[],
  base: WrittenBinding
): ExplorerConfiguration[] {
  return [
    { key: VERSION_KEY, label: 'The version’s binding', binding: base, move: null },
    ...rows.map(row => ({
      key: moveKey(row),
      label: `${row.task}: ${row.from ?? 'none'} → ${row.to}`,
      binding: withMove(base, row.task, row.to),
      move: row,
    })),
  ];
}

/** The tasks two bindings bind differently, in the first one's order then the second's. */
export function differingTasks(a: WrittenBinding, b: WrittenBinding): string[] {
  const tasks = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return tasks.filter(task => a[task] !== b[task]);
}
