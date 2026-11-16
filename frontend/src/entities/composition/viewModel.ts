import type {
  CompositionVersionView, CompositionView, EvaluationView, ForkedFrom, ProblemFacts, VersionDerivation,
} from '../../shared/api/types';
import { fromC2y, type Located } from '../../shared/diagnostics/located';
import { candidateMatrix, type CandidateMatrix } from '../binding/candidateMatrix';
import { workflowGraph, type WorkflowGraph } from '../binding/workflowGraph';
import { readDocument, type CompositionDocument, type Evidence, type Kind, type Provenance } from './document';
import { readAnalytics, type Analytics } from './evolution';
import { valueModels, valueStatus, type ValueModel, type ValueStatus } from './values';

/**
 * Everything a composition screen shows, in one place, from what the gateway served: the composition, one version (with
 * its document), and for a member the facts of the compilation its values were evaluated on. The view-model only places
 * the gateway's values: it never sums, compares numbers or ranks, and a comparison word on screen is always the gateway's.
 */

export type Reader = 'member' | 'public';

/** The renderer's modes; `calculator` and `configurator` need a linked problem the reader may read. */
export type Mode = 'catalog' | 'architecture' | 'workflow' | 'comparison' | 'calculator' | 'configurator' | 'showcase';

export type Outcome = EvaluationView['outcome'];

/** The file name a version's text is located in. */
export const COMPOSITION_FILE = 'composition.yaml';

export interface TaskModel {
  id: string;
  local: boolean;
  /** The candidate as the document writes it (its id, or `<resource>/<id>`); null for a local task. */
  candidate: string | null;
  from: Provenance | null;
  /** The provider of the chosen candidate, from the facts; null without facts or a selection. */
  provider: string | null;
}

export interface OfferingModel {
  source: 'sphere' | 'registry' | 'url';
  /** The pricing as the document names it: `owner/name`, `owner/name on <registry>`, or the URL. */
  label: string;
  /** Where it can be opened; only a URL offering has an address of its own. */
  href: string | null;
}

export interface CompositionViewModel {
  identity: {
    org: string;
    orgName: string;
    slug: string;
    name: string;
    description: string;
    kind: Kind;
    visibility: 'private' | 'public';
    archived: boolean;
  };
  reader: Reader;
  /** Null while the composition has no version. */
  version: {
    id: string;
    label: string;
    ordinal: number;
    createdAt: string;
    syntaxVersion: string;
    basedOn: Record<string, unknown> | null;
    forkedFrom: ForkedFrom | null;
    derivation: VersionDerivation | null;
  } | null;
  status: {
    /** Null while there is no version. */
    values: ValueStatus | null;
    outcome: Outcome | null;
    /** The current evaluation's compilation is not the one the version links (semantic digests differ). */
    compilationDrift: boolean;
    problemRef: string | null;
    /** The reader may open the linked problem (a member, and the gateway named it). */
    problemReadable: boolean;
    /**
     * The linked problem version as a derivation names one (`<problem>@<revision>`, by slug and number); null unless the reader
     * may read it.
     */
    problemRevision: string | null;
  };
  workflow: WorkflowGraph;
  tasks: TaskModel[];
  values: ValueModel[];
  offering: OfferingModel | null;
  /** How the values were obtained, as the document records it (`evidence`); null when it records nothing. */
  evidence: Evidence | null;
  /** Task to candidate key (`<resource>/<id>`), from the current evaluation's binding; empty for a public reader. */
  selection: Record<string, string>;
  /**
   * The candidates of the linked problem, from the facts of the compilation the values were evaluated on, with the
   * `selection` marked; null without facts, and always for a public reader.
   */
  matrix: CandidateMatrix | null;
  /** The counts the gateway stored for the version's document (`analytics`); null when the version view carries none. */
  analytics: Analytics | null;
  /** What the current evaluation found, located in the version's text; members only. */
  diagnostics: Located[];
  modes: Mode[];
}

export interface CompositionViewModelInput {
  composition: CompositionView;
  version: CompositionVersionView | null;
  /** The version's document; by default the one the version view carries (`include=document`). */
  document?: CompositionDocument | null;
  /** The facts of the compilation the current evaluation used, when the reader may read them. */
  facts?: ProblemFacts | null;
  reader: Reader;
  /** The version's text, to locate the evaluation's findings in it; without it they are located at the file. */
  content?: string;
}

function currentEvaluation(version: CompositionVersionView): EvaluationView | null {
  return version.evaluations.find((evaluation) => evaluation.current)
    ?? version.evaluations.find((evaluation) => evaluation.id === version.current_evaluation_id)
    ?? null;
}

/**
 * The candidate a version chose for each task (task → `<resource>/<id>`), from its current evaluation's `binding`: what the
 * candidate matrix of its problem highlights. Empty for a declared version, and for a public reader (the gateway sends no binding).
 */
export function bindingSelection(version: CompositionVersionView): Record<string, string> {
  const binding = currentEvaluation(version)?.binding;
  return binding ? { ...binding } : {};
}

function offeringModel(offering: Record<string, string> | null | undefined): OfferingModel | null {
  if (!offering) return null;
  if (offering.url) return { source: 'url', label: offering.url, href: offering.url };
  if (!offering.sphere) return null;
  return offering.registry
    ? { source: 'registry', label: `${offering.sphere} on ${offering.registry}`, href: null }
    : { source: 'sphere', label: offering.sphere, href: null };
}

function tasksOf(graph: WorkflowGraph, document: CompositionDocument | null, selection: Record<string, string>, facts: ProblemFacts | null) {
  const binding = document?.binding ?? {};
  const providers = new Map((facts?.candidates ?? []).map((candidate) => [candidate.key, candidate.provider]));
  const ids = [...graph.tasks, ...Object.keys(binding).filter((task) => !graph.tasks.includes(task))];
  return ids.map((id): TaskModel => {
    const entry = binding[id];
    const local = entry !== undefined && 'local' in entry;
    const candidate = entry && 'candidate' in entry ? entry : null;
    return {
      id,
      local,
      candidate: candidate?.candidate ?? null,
      from: candidate?.from ?? null,
      provider: selection[id] ? providers.get(selection[id]) ?? null : null,
    };
  });
}

export function compositionViewModel(input: CompositionViewModelInput): CompositionViewModel {
  const { composition, version, reader } = input;
  const document = input.document !== undefined ? input.document : readDocument(version?.document);
  const facts = input.facts ?? null;
  const member = reader === 'member';
  const evaluation = version ? currentEvaluation(version) : null;
  const selection = member && version ? bindingSelection(version) : {};
  const link = version?.problem ?? null;
  const problemReadable = member && link !== null && link.problem.id !== null;

  const evaluatedOn = version?.current_evaluation?.compilation?.semantic_digest ?? null;
  const linkedTo = link?.linked_compilation.semantic_digest ?? null;
  const graph = workflowGraph(document ? document.workflow : null);

  const modes: Mode[] = ['catalog'];
  if (version) {
    modes.push('architecture', 'workflow');
    if ((composition.version_count ?? 0) > 1) modes.push('comparison');
    if (problemReadable) modes.push('calculator', 'configurator');
    if (composition.visibility === 'public') modes.push('showcase');
  }

  const diagnostics = member && evaluation
    ? evaluation.diagnostics.map((diagnostic) => (input.content === undefined
      ? fromC2y({ ...diagnostic, span: null }, '', COMPOSITION_FILE)
      : fromC2y(diagnostic, input.content, COMPOSITION_FILE)))
    : [];

  return {
    identity: {
      org: composition.organization.slug,
      orgName: composition.organization.name,
      slug: composition.slug,
      name: composition.name,
      description: composition.description,
      kind: composition.kind,
      visibility: composition.visibility,
      archived: composition.archived,
    },
    reader,
    version: version && {
      id: version.id,
      label: version.label,
      ordinal: version.ordinal,
      createdAt: version.created_at,
      syntaxVersion: version.syntax_version,
      basedOn: version.based_on,
      forkedFrom: version.forked_from ?? null,
      derivation: version.derivation,
    },
    status: {
      values: version ? valueStatus(version) : null,
      outcome: version?.current_evaluation?.outcome ?? null,
      compilationDrift: evaluatedOn !== null && linkedTo !== null && evaluatedOn !== linkedTo,
      problemRef: document?.problem?.ref ?? (link ? `${link.problem.slug}@${link.revision.revision}` : null),
      problemReadable,
      problemRevision: problemReadable && link ? `${link.problem.slug}@${link.revision.revision}` : null,
    },
    workflow: graph,
    tasks: tasksOf(graph, document, selection, facts),
    values: version ? valueModels(version) : [],
    offering: offeringModel(version ? version.offering : null) ?? offeringModel(document?.offering as Record<string, string> | undefined),
    evidence: document?.evidence ?? null,
    selection,
    matrix: member && version && facts ? candidateMatrix(facts, { selection }) : null,
    analytics: readAnalytics(version?.analytics),
    diagnostics,
    modes,
  };
}
