/**
 * The Composition2Yaml document as its JSON model (docs/COMPOSITION2YAML.md): what `GET …/versions/{v}?include=document`
 * serves for a sealed version and what `POST /v1/compositions/parse` answers for a text. OpenAPI types it as an untyped
 * object, so its shape is written here, after the language reference, and `readDocument` checks it at runtime before
 * anything reads it. The gateway is the only judge of a document: the guard checks only that the parts a screen reads have
 * the shape the reference gives them, it validates nothing.
 */

/** What a composition composes (§3). Metadata only: no rule depends on it. */
export type Kind = 'application' | 'workflow' | 'pipeline' | 'system';

export const KINDS: readonly Kind[] = ['application', 'workflow', 'pipeline', 'system'];

/** A node of the workflow (§4): a task by id, the empty step (`null`), or a block. */
export type WorkflowNode =
  | string
  | null
  | { seq: WorkflowNode[] }
  | { and: WorkflowNode[] }
  | { xor: Array<WorkflowNode | { probability: number; flow: WorkflowNode }>; uniform?: true }
  | { loop: WorkflowNode; count: number }
  | { loop: WorkflowNode; expected: number };

/** Where a candidate came from (§6): a plan of a SPHERE pricing at a pinned version, on an optional registry. */
export interface Provenance {
  sphere: string;
  registry?: string;
  version: string;
  plan: string;
  addons?: string[];
}

/** One task's entry of the binding (§5): a candidate (with its provenance) or a task done in house. */
export type BindingEntry = { candidate: string; from?: Provenance } | { local: true };

/** A global value (§8): a bare number is dimensionless (unit `"1"`), any other is `{value, unit}`. */
export type DocumentValue = number | { value: number; unit: string };

/** The composition's own pricing, by reference only (§7). */
export type Offering = { sphere: string; registry?: string } | { url: string };

/** How the values were obtained (§9). */
export interface Evidence {
  run?: string;
  point?: number;
  manual?: boolean;
  evaluatedBy?: 'gateway' | 'declared';
  toolchain?: string;
}

/** The problem revision the composition was judged against, and the compilation it was judged on (§13). */
export interface ProblemLink {
  ref: string;
  compilation: string;
}

export interface CompositionDocument {
  syntaxVersion: string;
  composition: string;
  version: string;
  kind: Kind;
  problem?: ProblemLink;
  workflow: WorkflowNode;
  binding: Record<string, BindingEntry>;
  values: Record<string, DocumentValue>;
  offering?: Offering;
  evidence?: Evidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const optional = (value: unknown, check: (item: unknown) => boolean) =>
  value === undefined || check(value);

function isProvenance(value: unknown): value is Provenance {
  return (
    isRecord(value) &&
    isText(value.sphere) &&
    isText(value.version) &&
    isText(value.plan) &&
    optional(value.registry, isText) &&
    optional(value.addons, addons => Array.isArray(addons) && addons.every(isText))
  );
}

function isBindingEntry(value: unknown): value is BindingEntry {
  if (!isRecord(value)) return false;
  if (value.local === true) return Object.keys(value).length === 1;
  return isText(value.candidate) && optional(value.from, isProvenance);
}

function isValue(value: unknown): value is DocumentValue {
  return isNumber(value) || (isRecord(value) && isNumber(value.value) && isText(value.unit));
}

function isOffering(value: unknown): value is Offering {
  if (!isRecord(value)) return false;
  if (isText(value.url)) return Object.keys(value).length === 1;
  return isText(value.sphere) && optional(value.registry, isText);
}

const every = <T>(
  record: unknown,
  check: (item: unknown) => item is T
): record is Record<string, T> => isRecord(record) && Object.values(record).every(check);

/**
 * The document, when `value` has the shape of one; otherwise null. The workflow is not checked here: the workflow graph
 * reads any node and shows an unknown shape as unreadable instead of dropping it.
 */
export function readDocument(value: unknown): CompositionDocument | null {
  if (!isRecord(value)) return null;
  const shaped =
    isText(value.syntaxVersion) &&
    isText(value.composition) &&
    isText(value.version) &&
    KINDS.includes(value.kind as Kind) &&
    Object.hasOwn(value, 'workflow') &&
    every(value.binding, isBindingEntry) &&
    every(value.values, isValue) &&
    optional(
      value.problem,
      problem => isRecord(problem) && isText(problem.ref) && isText(problem.compilation)
    ) &&
    optional(value.offering, isOffering) &&
    optional(value.evidence, isRecord);
  return shaped ? (value as unknown as CompositionDocument) : null;
}

/** Is it a document? The same check as `readDocument`, as a type guard. */
export function isCompositionDocument(value: unknown): value is CompositionDocument {
  return readDocument(value) !== null;
}

/** The number and unit of a document value, as written: a bare number has unit `"1"`. */
export function documentValue(value: DocumentValue): { value: number; unit: string } {
  return typeof value === 'number'
    ? { value, unit: '1' }
    : { value: value.value, unit: value.unit };
}
