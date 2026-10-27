export type BindingValue = number | { min: number | null; max: number | null };

export interface BindingRow {
  /** The key of `decision.binding`. */
  task: string;
  /** The problem's task name, else `task`. */
  taskName: string;
  /** The `id` of the bound reference. */
  candidate: string;
  /** The problem's candidate name, else `candidate`. */
  candidateName: string;
  /** The problem's provider name (or provider id), else null. */
  provider: string | null;
  /** One entry per feature of `bindingFeaturesOf(problem)`; `{}` without a problem. */
  values: Record<string, BindingValue | null>;
}

export interface BindingFeature {
  name: string;
  unit: string | null;
}

/** The part of a compiled problem the table reads; the `BindingModel` of `readBindingProblem` fits it. */
export interface BindingProblemShape {
  tasks: ReadonlyArray<{
    id: string;
    name: string;
    candidates: ReadonlyArray<{
      id: string;
      name: string;
      provider: string | null;
      features: Record<string, BindingValue>;
    }>;
  }>;
  features: Record<string, { unit: string | null }>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The features of the problem in declaration order, each with its unit; `[]` without a problem. */
// [impl->req~frontend-rendering-binding-table~1]
export function bindingFeaturesOf(problem: BindingProblemShape | null): BindingFeature[] {
  if (!problem) return [];
  return Object.entries(problem.features).map(([name, feature]) => ({ name, unit: feature.unit }));
}

/**
 * One row per task of a solution's `decision.binding`, with the chosen candidate's own declared values. Tasks the problem knows
 * come first in its order, then the others in binding order. Malformed input leaves rows out, never guesses and never throws.
 */
// [impl->req~frontend-rendering-binding-table~1]
export function bindingRowsOf(binding: unknown, problem: BindingProblemShape | null): BindingRow[] {
  if (!isPlainObject(binding)) return [];
  const chosen = new Map<string, string>();
  for (const [task, reference] of Object.entries(binding)) {
    if (isPlainObject(reference) && typeof reference.id === 'string' && reference.id !== '') chosen.set(task, reference.id);
  }
  const names = bindingFeaturesOf(problem).map((feature) => feature.name);
  const known = problem ? problem.tasks.filter((task) => chosen.has(task.id)) : [];
  const knownIds = new Set(known.map((task) => task.id));
  const order = [...known.map((task) => task.id), ...[...chosen.keys()].filter((task) => !knownIds.has(task))];

  return order.map((task) => {
    const candidateId = chosen.get(task) as string;
    const info = known.find((entry) => entry.id === task);
    const candidate = info?.candidates.find((entry) => entry.id === candidateId);
    const values: Record<string, BindingValue | null> = {};
    if (problem) for (const name of names) values[name] = candidate && Object.hasOwn(candidate.features, name) ? candidate.features[name] : null;
    return {
      task,
      taskName: info?.name ?? task,
      candidate: candidateId,
      candidateName: candidate?.name ?? candidateId,
      provider: candidate?.provider ?? null,
      values,
    };
  });
}
