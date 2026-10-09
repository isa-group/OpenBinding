import { unzipPackage } from '../../utils/bimZip';

/**
 * What a .bim.zip contains, read in the browser so it can be drawn as files, a workflow and tables.
 *
 * The gateway stays the authority on validity (POST /v1/instances/validate). This reads the same package to show its
 * shape, so everything here is tolerant: a file that does not look as expected is left out of the picture, never
 * guessed at, and never an error.
 */

export interface PackageFile {
  path: string;
  bytes: number;
  /** The Profile role the Instance gives it (`candidateCatalog`), or `null` for an unlisted file. */
  role: string | null;
  /** The logical id the Instance gives it within that role. */
  logicalId: string | null;
  /** `kind` of the JSON document, when it is one. */
  kind: string | null;
}

export interface PackageTreeNode {
  name: string;
  path: string;
  children: PackageTreeNode[];
  file?: PackageFile;
}

export type WorkflowNode =
  | { type: 'task'; id: string; capability: string | null; candidates: number | null; note: string }
  | { type: 'block'; label: string; note: string; children: WorkflowNode[] };

export interface TaskRow {
  id: string;
  capability: string | null;
  candidates: number;
  /** One entry per feature the candidates declare: its range and unit. */
  ranges: Array<{ feature: string; min: number; max: number; unit: string | null }>;
}

export interface ConstraintRow {
  id: string;
  enforcement: 'hard' | 'soft' | null;
  text: string | null;
  penalty: number | null;
}

export interface CriterionRow {
  id: string;
  direction: string | null;
  weight: number | null;
}

export interface RegisteredUse {
  role: string;
  logicalId: string;
  reference: string;
}

export interface PackageModel {
  name: string | null;
  description: string | null;
  profile: string | null;
  files: PackageFile[];
  tree: PackageTreeNode[];
  registered: RegisteredUse[];
  workflow: WorkflowNode | null;
  tasks: TaskRow[];
  constraints: ConstraintRow[];
  optimizationMode: string | null;
  criteria: CriterionRow[];
  /** Upper bound of the binding space: the product of each task's candidate count, as a power of ten. */
  bindingSpaceLog10: number | null;
}

export const ROLE_LABELS: Record<string, string> = {
  application: 'Application',
  candidateCatalog: 'Candidate catalog',
  constraintSet: 'Constraint set',
  optimization: 'Optimization',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record, or an empty one: for reading a section a package may leave out. */
function section(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isRecord(value) && typeof value.value === 'number' && Number.isFinite(value.value)) return value.value;
  return null;
}

function parse(source: string | undefined): Record<string, unknown> | null {
  if (source === undefined) return null;
  try {
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const BLOCKS: Record<string, string> = {
  sequence: 'SEQUENCE', parallel: 'PARALLEL', exclusive: 'EXCLUSIVE', repeat: 'REPEAT', loop: 'REPEAT', choice: 'EXCLUSIVE',
};

interface Catalogue {
  capabilityOf: (task: string) => string | null;
  candidatesFor: (capability: string | null) => number | null;
}

function noteOf(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['aggregation', 'probability', 'count', 'expectedCount', 'mode']) {
    const entry = value[key];
    if (typeof entry === 'string' || typeof entry === 'number') parts.push(`${key} ${entry}`);
  }
  return parts.join(' · ');
}

function workflowNode(value: unknown, catalogue: Catalogue, depth: number): WorkflowNode | null {
  if (!isRecord(value) || depth > 12) return null;
  const task = isRecord(value.task) ? value.task : null;
  if (task && typeof task.id === 'string') {
    const capability = catalogue.capabilityOf(task.id);
    return { type: 'task', id: task.id, capability, candidates: catalogue.candidatesFor(capability), note: '' };
  }
  for (const [key, label] of Object.entries(BLOCKS)) {
    const inner = value[key];
    if (inner === undefined) continue;
    const children: WorkflowNode[] = [];
    let note = noteOf(value);
    if (Array.isArray(inner)) {
      for (const item of inner) {
        const child = workflowNode(item, catalogue, depth + 1) ?? (isRecord(item) && item.branch !== undefined ? workflowNode(item.branch, catalogue, depth + 1) : null);
        if (child) {
          const probability = isRecord(item) && typeof item.probability === 'number' ? `p ${item.probability}` : '';
          children.push(probability ? { ...child, note: [child.note, probability].filter(Boolean).join(' · ') } : child);
        }
      }
    } else if (isRecord(inner)) {
      note = [note, noteOf(inner)].filter(Boolean).join(' · ');
      const body = workflowNode(inner.body ?? inner.node ?? inner.workflow ?? inner, catalogue, depth + 1);
      if (body) children.push(body);
    }
    return { type: 'block', label, note, children };
  }
  return null;
}

function treeOf(files: PackageFile[]): PackageTreeNode[] {
  const root: PackageTreeNode = { name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let next = current.children.find((child) => child.name === part);
      if (!next) {
        next = { name: part, path, children: [], ...(index === parts.length - 1 ? { file } : {}) };
        current.children.push(next);
      }
      current = next;
    });
  }
  const sort = (nodes: PackageTreeNode[]) => {
    nodes.sort((a, b) => Number(b.children.length > 0) - Number(a.children.length > 0) || a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

/** Read a package the way the gateway's own bounds allow; throws `BimPackageError` when it is not a readable package. */
export async function readPackageModel(buffer: ArrayBuffer): Promise<PackageModel> {
  const sources = await unzipPackage(buffer);
  const instance = parse(sources['instance.json']);
  const metadata = section(instance?.metadata);
  const spec = section(instance?.spec);
  const encoder = new TextEncoder();

  const roles = new Map<string, { role: string; logicalId: string }>();
  const registered: RegisteredUse[] = [];
  if (isRecord(spec.resources)) {
    for (const [role, entries] of Object.entries(spec.resources)) {
      if (!isRecord(entries)) continue;
      for (const [logicalId, target] of Object.entries(entries)) {
        if (typeof target === 'string') roles.set(target, { role, logicalId });
        else if (isRecord(target) && typeof target.name === 'string') {
          registered.push({ role, logicalId, reference: `${text(target.namespace) ?? '?'}/${target.name}@${text(target.version) ?? '?'}` });
        }
      }
    }
  }

  const documents = new Map<string, Record<string, unknown> | null>();
  const files: PackageFile[] = Object.entries(sources).map(([path, source]) => {
    const document = path.toLowerCase().endsWith('.json') ? parse(source) : null;
    documents.set(path, document);
    const mapped = roles.get(path);
    return {
      path,
      bytes: encoder.encode(source).length,
      role: mapped?.role ?? null,
      logicalId: mapped?.logicalId ?? null,
      kind: text(document?.kind) ?? (path.toLowerCase().endsWith('.bpmn') ? 'BPMN' : null),
    };
  });

  const ofKind = (kind: string) => files.filter((file) => file.kind === kind).map((file) => documents.get(file.path)).filter(isRecord);
  const application = ofKind('Application')[0];
  const applicationSpec = section(application?.spec);
  const tasksSpec = section(applicationSpec.tasks);
  const features = section(applicationSpec.features);

  const candidates: Array<{ provides: string | null; features: Record<string, number> }> = [];
  for (const catalog of ofKind('CandidateCatalog')) {
    const catalogSpec = section(catalog.spec);
    const entries = isRecord(catalogSpec.candidates) ? Object.values(catalogSpec.candidates) : Array.isArray(catalogSpec.candidates) ? catalogSpec.candidates : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const values: Record<string, number> = {};
      if (isRecord(entry.features)) for (const [name, raw] of Object.entries(entry.features)) {
        const value = number(raw);
        if (value !== null) values[name] = value;
      }
      candidates.push({ provides: text(entry.provides), features: values });
    }
  }

  const capabilityOf = (task: string) => text(tasksSpec[task]);
  const candidatesFor = (capability: string | null) => (capability ? candidates.filter((candidate) => candidate.provides === capability).length : null);
  const catalogue: Catalogue = { capabilityOf, candidatesFor };

  const tasks: TaskRow[] = Object.keys(tasksSpec).map((id) => {
    const capability = capabilityOf(id);
    const matching = candidates.filter((candidate) => capability !== null && candidate.provides === capability);
    const names = [...new Set(matching.flatMap((candidate) => Object.keys(candidate.features)))];
    return {
      id,
      capability,
      candidates: matching.length,
      ranges: names.map((feature) => {
        const values = matching.map((candidate) => candidate.features[feature]).filter((value): value is number => value !== undefined);
        const declared = isRecord(features[feature]) ? text((features[feature] as Record<string, unknown>).unit) : null;
        return { feature, min: Math.min(...values), max: Math.max(...values), unit: declared };
      }),
    };
  });

  const constraints: ConstraintRow[] = [];
  for (const set of ofKind('ConstraintSet')) {
    const setSpec = section(set.spec);
    const raw = setSpec.constraints;
    const entries: Array<[string, unknown]> = Array.isArray(raw)
      ? raw.map((item, index) => [isRecord(item) && typeof item.id === 'string' ? item.id : `constraint ${index + 1}`, item])
      : isRecord(raw) ? Object.entries(raw) : [];
    for (const [id, item] of entries) {
      const entry = section(item);
      const word = [entry.enforcement, entry.severity, entry.type, entry.kind].find((value): value is string => typeof value === 'string');
      const penalty = number(entry.penalty);
      const enforcement = word === 'hard' || word === 'soft' ? word : penalty !== null ? 'soft' : null;
      constraints.push({
        id,
        enforcement,
        text: text(entry.description) ?? text(entry.text) ?? text(entry.message) ?? (typeof entry.expression === 'string' ? entry.expression : null),
        penalty,
      });
    }
  }

  const optimization = ofKind('Optimization')[0];
  const optimizationSpec = section(optimization?.spec);
  const criteria: CriterionRow[] = (Array.isArray(optimizationSpec.criteria) ? optimizationSpec.criteria : []).filter(isRecord).map((item, index) => ({
    id: text(item.id) ?? `criterion ${index + 1}`,
    direction: text(item.direction) ?? text(item.goal),
    weight: number(item.weight),
  }));

  const sized = tasks.filter((task) => task.candidates > 0);
  const bindingSpaceLog10 = tasks.length > 0 && sized.length === tasks.length
    ? sized.reduce((sum, task) => sum + Math.log10(task.candidates), 0)
    : null;

  return {
    name: text(metadata.name),
    description: text(metadata.description),
    profile: text(spec.profile),
    files,
    tree: treeOf(files),
    registered,
    workflow: workflowNode(applicationSpec.workflow, catalogue, 0),
    tasks,
    constraints,
    optimizationMode: text(optimizationSpec.mode) ?? text(optimizationSpec.type),
    criteria,
    bindingSpaceLog10,
  };
}
