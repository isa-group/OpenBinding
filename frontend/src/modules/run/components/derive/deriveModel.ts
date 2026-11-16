import type { CompositionDerive, CompositionView, DeriveDraft } from '../../../core/api/types';

// The rules of deriving a composition from a run or from a binding of a problem version, without screens: the label a new version
// gets, the solutions a person picks from, and the requests. Every number shown is the run's own; nothing is ranked, summed or
// compared here.

/** A Semantic Versioning label, as the gateway accepts one for a derived version (`CompositionDerive.version`). */
export const LABEL_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The label of a composition's first version. */
export const FIRST_LABEL = '1.0.0';

/**
 * The label after `latest`: the next minor of its `major.minor` (`1.2.3` → `1.3.0`, `2.0.0-rc.1` → `2.1.0`). A composition with no
 * version, or a latest label that does not start with three numbers, starts at 1.0.0. A pure string bump: versions are not
 * compared.
 */
export function nextMinor(latest: string | null | undefined): string {
  const match = latest ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)/.exec(latest) : null;
  if (!match) return FIRST_LABEL;
  return `${match[1]}.${BigInt(match[2]) + 1n}.0`;
}

/** What a derivation starts from: a run and its solutions, as the run's result lists them. */
export interface RunSource {
  run: string;
  solutions: readonly unknown[];
}

/**
 * What a derivation starts from: a binding of a problem version, each task's candidate as a document writes it (the calculator's
 * and the configurator's), and the composition it is derived into by default.
 */
export interface BindingSource {
  /** `<problem>@<revision>`. */
  revision: string;
  binding: Record<string, string>;
  composition?: CompositionView;
}

/**
 * One point of a study's Pareto front, derived into a composition of its own (C5: a point is an alternative, not a version of
 * another one).
 */
export interface FrontPoint {
  /** The page's key of the point; results are reported under it. */
  key: string;
  /** How the point is named in the dialog: `P1`. */
  label: string;
  /** What else tells it apart (its problem version, cell, engine and objectives). */
  detail: string;
  /** The run the point's cell ran as (`ParetoPoint.job_id`). */
  run: string;
  /** The solution of that run (`ParetoPoint.solution_index`). */
  point: number;
  /** The address the composition is created at unless the person writes another. */
  slug: string;
  name: string;
}

/** What a batch derivation starts from: points of a study front, each derived as version 1.0.0 of a new composition. */
export interface PointsSource {
  points: readonly FrontPoint[];
}

/** A run or a binding: what one derivation, previewed before it is sealed, starts from. */
export type SingleSource = RunSource | BindingSource;

export type DeriveSource = SingleSource | PointsSource;

export const isPointsSource = (source: DeriveSource): source is PointsSource => 'points' in source;

export const isRunSource = (source: DeriveSource): source is RunSource => 'run' in source;

/** One objective of a solution, as the run's result writes it. */
export interface PointObjective {
  criterion: string;
  value: number | null;
}

/** A solution of the run a person can derive: its index in the result (the request's `point`) and its objectives as written. */
export interface Point {
  point: number;
  label: string;
  objectives: PointObjective[];
  /** `objectives.score`: one number, or one per criterion. */
  score: Array<number | null> | number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The objectives of a solution in the order its result lists them (`objectives.components[].criteria` and `value`). */
function objectivesOf(solution: Record<string, unknown>): PointObjective[] {
  const objectives = isRecord(solution.objectives) ? solution.objectives : {};
  const components = Array.isArray(objectives.components) ? objectives.components : [];
  return components.filter(isRecord).map((component, index) => ({
    criterion:
      typeof component.criteria === 'string' && component.criteria !== ''
        ? component.criteria
        : `criterion ${index + 1}`,
    value: finite(component.value),
  }));
}

function scoreOf(solution: Record<string, unknown>): Point['score'] {
  const score = isRecord(solution.objectives) ? solution.objectives.score : undefined;
  return Array.isArray(score) ? score.map(finite) : finite(score);
}

/** The solutions of a run, in the result's order. Entries that are not solutions are skipped, and the others keep their index. */
export function pointsOf(solutions: readonly unknown[]): Point[] {
  return solutions.flatMap((solution, point) =>
    isRecord(solution)
      ? [
          {
            point,
            label: `Solution ${point + 1}`,
            objectives: objectivesOf(solution),
            score: scoreOf(solution),
          },
        ]
      : []
  );
}

/** The criteria the table has columns for: every criterion any solution names, in the order they first appear. */
export function criteriaOf(points: readonly Point[]): string[] {
  const seen: string[] = [];
  for (const point of points)
    for (const objective of point.objectives)
      if (!seen.includes(objective.criterion)) seen.push(objective.criterion);
  return seen;
}

/** The request that derives `point` of the run as version `version`: only a preview (`seal: false`), or the version itself. */
export function runDerivation(
  source: Pick<RunSource, 'run'>,
  point: number,
  version: string,
  seal: boolean
): CompositionDerive {
  return { run: source.run, point, version, seal };
}

/** The request that derives the binding as version `version`: only a preview (`seal: false`), or the version itself. */
export function bindingDerivation(
  source: Pick<BindingSource, 'revision' | 'binding'>,
  version: string,
  seal: boolean
): CompositionDerive {
  return { revision: source.revision, binding: { ...source.binding }, version, seal };
}

/** The values of a preview, in the order the gateway listed them. */
export function previewValues(
  draft: Pick<DeriveDraft, 'values'>
): Array<{ name: string; value: number; unit: string }> {
  return Object.entries(draft.values).map(([name, value]) => ({
    name,
    value: value.value,
    unit: value.unit,
  }));
}

/** The longest address a composition may have (`CompositionCreate.slug`). */
const SLUG_MAX = 64;

/** The default address of the composition of point `n` of a problem: `<problem>-p<n>`, cut to the length a slug may have. */
export function pointSlug(problem: string, n: number): string {
  const suffix = `-p${n}`;
  return `${problem.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** What is wrong with each address of a batch: not an address, or one another point of the batch has too. */
export function batchSlugErrors(
  rows: ReadonlyArray<{ key: string; slug: string }>,
  pattern: RegExp
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const row of rows) {
    if (!pattern.test(row.slug))
      errors[row.key] = 'Lowercase letters, numbers and hyphens, at most 64.';
    else if (rows.some(other => other.key !== row.key && other.slug === row.slug))
      errors[row.key] = `Another point has ${row.slug} too.`;
  }
  return errors;
}
