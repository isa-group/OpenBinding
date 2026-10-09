/**
 * The compiled form of a revision (a `BindingProblem`, the document engines receive) read as a plain-language model:
 * the workflow, who can do each task, the rules and the goal. Everything here is tolerant: a part that doesn't look as
 * expected is left out of the picture, never guessed at and never an error. The gateway stays the authority on validity.
 */

export type FeatureValue = number | { min: number; max: number };

export interface FeatureInfo {
  unit: string | null;
  direction: 'minimize' | 'maximize' | null;
}

export interface CandidateInfo {
  id: string;
  name: string;
  provider: string | null;
  features: Record<string, FeatureValue>;
}

export interface TaskInfo {
  id: string;
  name: string;
  kind: 'service' | 'local';
  /** The capability a service task asks for (`payment`). */
  capability: string | null;
  candidates: CandidateInfo[];
}

export type FlowNode =
  | { kind: 'task'; task: TaskInfo }
  | { kind: 'sequence'; steps: FlowNode[] }
  | { kind: 'parallel'; branches: FlowNode[] }
  | { kind: 'exclusive'; branches: Array<{ id: string; probability: number | null; condition: string | null; flow: FlowNode }> }
  | { kind: 'repeat'; body: FlowNode; times: string }
  | { kind: 'empty' };

export interface RuleInfo {
  id: string;
  enforcement: 'hard' | 'soft';
  text: string;
  /** The condition under which the rule applies, when it isn't "always". */
  when: string | null;
  penalty: string | null;
}

export interface CriterionInfo {
  id: string;
  feature: string;
  direction: 'minimize' | 'maximize' | null;
  range: { min: number; max: number } | null;
}

export interface PenaltyInfo {
  rule: string;
  weight: number;
}

export interface PlacementInfo {
  pools: Array<{ id: string; kind: string; capacity: Record<string, number> }>;
  demands: number;
  links: number;
  events: number;
  transitions: number;
}

export interface BindingModel {
  /** `qos-binding/v1`. */
  profile: string | null;
  profileDigest: string | null;
  dialects: Array<{ label: string; digest: string | null }>;
  adapters: string[];
  tasks: TaskInfo[];
  flow: FlowNode | null;
  features: Record<string, FeatureInfo>;
  rules: RuleInfo[];
  criteria: CriterionInfo[];
  penalties: PenaltyInfo[];
  placement: PlacementInfo | null;
  serviceTasks: number;
  /** Distinct candidates that can serve at least one task. */
  candidateCount: number;
  /** log10 of the product of each service task's candidate count: an upper bound of the binding space. */
  log10: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const OPERATORS: Record<string, string> = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', add: '+', sub: '−', mul: '×', div: '÷', pow: '^' };

/** An expression of the compiled form as a short formula: `features.latency ≤ 600`. */
export function describeExpression(expression: unknown, depth = 0): string {
  if (!isRecord(expression) || depth > 8) return '…';
  const wrap = (inner: unknown) => {
    const shown = describeExpression(inner, depth + 1);
    return isRecord(inner) && ['and', 'or', 'compare', 'arithmetic'].includes(String(inner.kind)) ? `(${shown})` : shown;
  };
  switch (expression.kind) {
    case 'literal': {
      const value = expression.value;
      if (value === null) return 'none';
      return typeof value === 'string' ? `“${value}”` : String(value);
    }
    case 'path':
      return list(expression.segments).map(String).join('.');
    case 'not': return `not ${wrap(expression.value)}`;
    case 'negate': return `−${wrap(expression.value)}`;
    case 'and': return `${wrap(expression.left)} and ${wrap(expression.right)}`;
    case 'or': return `${wrap(expression.left)} or ${wrap(expression.right)}`;
    case 'compare':
    case 'arithmetic':
      return `${wrap(expression.left)} ${OPERATORS[String(expression.op)] ?? String(expression.op)} ${wrap(expression.right)}`;
    case 'call':
      return `${String(expression.name)}(${list(expression.args).map((arg) => describeExpression(arg, depth + 1)).join(', ')})`;
    default: return '…';
  }
}

const isAlways = (expression: unknown) => isRecord(expression) && expression.kind === 'literal' && expression.value === true;

function direction(value: unknown): 'minimize' | 'maximize' | null {
  return value === 'minimize' || value === 'maximize' ? value : null;
}

function featureValue(value: unknown): FeatureValue | null {
  const plain = finite(value);
  if (plain !== null) return plain;
  if (isRecord(value)) {
    const min = finite(value.min);
    const max = finite(value.max);
    if (min !== null && max !== null) return { min, max };
  }
  return null;
}

/** A candidate's value as one number, for ordering and bars: the middle of an interval. */
export function featureNumber(value: FeatureValue): number {
  return typeof value === 'number' ? value : (value.min + value.max) / 2;
}

function readFlow(node: unknown, tasks: Map<string, TaskInfo>, routing: Map<string, number>, depth: number): FlowNode | null {
  if (!isRecord(node) || depth > 24) return null;
  switch (node.kind) {
    case 'task': {
      const ref = record(node.task);
      const id = text(ref.id);
      const task = id ? tasks.get(id) : undefined;
      return task ? { kind: 'task', task } : null;
    }
    case 'empty': return { kind: 'empty' };
    case 'sequence': {
      const steps = list(node.steps).map((step) => readFlow(step, tasks, routing, depth + 1)).filter((step): step is FlowNode => step !== null);
      return { kind: 'sequence', steps };
    }
    case 'parallel': {
      const branches = list(node.branches).map((branch) => readFlow(branch, tasks, routing, depth + 1)).filter((branch): branch is FlowNode => branch !== null);
      return { kind: 'parallel', branches };
    }
    case 'exclusive': {
      const branches = list(node.branches).flatMap((entry) => {
        const branch = record(entry);
        const id = text(branch.id);
        const flow = readFlow(branch.flow, tasks, routing, depth + 1);
        if (!id || !flow) return [];
        return [{ id, probability: routing.get(id) ?? null, condition: branch.when !== undefined && !isAlways(branch.when) ? describeExpression(branch.when) : null, flow }];
      });
      return { kind: 'exclusive', branches };
    }
    case 'repeat': {
      const body = readFlow(node.body, tasks, routing, depth + 1);
      if (!body) return null;
      const count = finite(node.count);
      const expected = finite(node.expectedCount);
      return { kind: 'repeat', body, times: count !== null ? `${count} times` : expected !== null ? `about ${expected} times` : 'repeated' };
    }
    default: return null;
  }
}

/** The tasks of a flow in the order they appear, each once. */
export function tasksOfFlow(flow: FlowNode | null): TaskInfo[] {
  const found: TaskInfo[] = [];
  const walk = (node: FlowNode) => {
    switch (node.kind) {
      case 'task': if (!found.includes(node.task)) found.push(node.task); break;
      case 'sequence': node.steps.forEach(walk); break;
      case 'parallel': node.branches.forEach(walk); break;
      case 'exclusive': node.branches.forEach((branch) => walk(branch.flow)); break;
      case 'repeat': walk(node.body); break;
      default: break;
    }
  };
  if (flow) walk(flow);
  return found;
}

/** The structure of a flow as one line, to tell whether two revisions draw the same workflow. */
export function flowText(flow: FlowNode | null): string {
  if (!flow) return '—';
  switch (flow.kind) {
    case 'task': return flow.task.id;
    case 'empty': return '∅';
    case 'sequence': return flow.steps.map(flowText).join(' → ');
    case 'parallel': return `(${flow.branches.map(flowText).join(' ∥ ')})`;
    case 'exclusive': return `[${flow.branches.map((branch) => `${flowText(branch.flow)}${branch.probability !== null ? ` ${Math.round(branch.probability * 100)}%` : ''}`).join(' | ')}]`;
    case 'repeat': return `${flowText(flow.body)} ×${flow.times}`;
    default: return '—';
  }
}

/** The workflow as a sentence, for the accessible name of its drawing. */
export function describeFlow(flow: FlowNode | null): string {
  const say = (node: FlowNode): string => {
    switch (node.kind) {
      case 'task': return node.task.id;
      case 'empty': return 'nothing';
      case 'sequence': return node.steps.map(say).join(', then ');
      case 'parallel': return `${node.branches.map(say).join(' and ')} in parallel`;
      case 'exclusive': return node.branches.map((branch) => `${say(branch.flow)}${branch.probability !== null ? ` (${Math.round(branch.probability * 100)}%)` : ''}`).join(' or ');
      case 'repeat': return `${say(node.body)} repeated (${node.times})`;
      default: return '';
    }
  };
  return flow ? `Workflow: ${say(flow)}` : 'Workflow not available';
}

/** Read a `BindingProblem`; `null` when the document isn't one. */
export function readBindingProblem(document: unknown): BindingModel | null {
  const root = record(document);
  const spec = record(root.spec);
  const application = record(spec.application);
  const taskMap = record(application.tasks);
  if (Object.keys(taskMap).length === 0) return null;

  const catalogs = record(spec.candidates);
  const candidateAt = (ref: unknown): CandidateInfo | null => {
    const pointer = record(ref);
    const resource = text(pointer.resource);
    const id = text(pointer.id);
    if (!resource || !id) return null;
    const catalog = record(catalogs[resource]);
    const entry = record(record(catalog.candidates)[id]);
    if (Object.keys(entry).length === 0) return null;
    const providerRef = record(entry.provider);
    const provider = text(record(record(catalog.providers)[String(providerRef.id ?? '')]).name) ?? text(providerRef.id);
    const features: Record<string, FeatureValue> = {};
    for (const [name, raw] of Object.entries(record(entry.features))) {
      const value = featureValue(raw);
      if (value !== null) features[name] = value;
    }
    return { id, name: text(entry.name) ?? id, provider, features };
  };

  const eligibility = record(spec.eligibility);
  const tasks = new Map<string, TaskInfo>();
  for (const [id, raw] of Object.entries(taskMap)) {
    const task = record(raw);
    const service = task.kind !== 'local';
    const requires = record(task.requires);
    tasks.set(id, {
      id,
      name: text(task.name) ?? id,
      kind: service ? 'service' : 'local',
      capability: service ? text(requires.type) : null,
      candidates: service ? list(eligibility[id]).map(candidateAt).filter((candidate): candidate is CandidateInfo => candidate !== null) : [],
    });
  }

  const routing = new Map<string, number>();
  for (const entry of list(spec.routing)) {
    const row = record(entry);
    const target = text(record(row.target).id);
    const probability = finite(row.probability);
    if (target && probability !== null) routing.set(target, probability);
  }

  const features: Record<string, FeatureInfo> = {};
  for (const [name, raw] of Object.entries(record(application.features))) {
    const feature = record(raw);
    features[name] = { unit: text(feature.unit), direction: direction(feature.direction) };
  }

  const rules: RuleInfo[] = list(spec.constraints).flatMap((entry) => {
    const rule = record(entry);
    const id = text(record(rule.ref).id);
    if (!id) return [];
    return [{
      id,
      enforcement: rule.enforcement === 'soft' ? 'soft' as const : 'hard' as const,
      text: describeExpression(rule.assert),
      when: rule.when !== undefined && !isAlways(rule.when) ? describeExpression(rule.when) : null,
      penalty: rule.penalty !== undefined ? describeExpression(rule.penalty) : null,
    }];
  });

  const optimization = record(spec.optimization);
  const criteria: CriterionInfo[] = list(optimization.criteria).flatMap((entry, index) => {
    const criterion = record(entry);
    const normalize = record(criterion.normalize);
    const min = finite(normalize.min);
    const max = finite(normalize.max);
    return [{
      id: text(criterion.id) ?? `criterion ${index + 1}`,
      feature: text(record(criterion.feature).id) ?? text(criterion.id) ?? '',
      direction: direction(criterion.direction),
      range: min !== null && max !== null ? { min, max } : null,
    }];
  });
  const penalties: PenaltyInfo[] = list(optimization.penalties).flatMap((entry) => {
    const penalty = record(entry);
    const rule = text(record(penalty.constraint).id);
    const weight = finite(penalty.weight);
    return rule && weight !== null ? [{ rule, weight }] : [];
  });

  const placements = list(spec.placement).map(record);
  const placement: PlacementInfo | null = placements.length === 0 ? null : {
    pools: placements.flatMap((entry) => Object.entries(record(entry.pools)).map(([id, raw]) => {
      const pool = record(raw);
      const capacity: Record<string, number> = {};
      for (const [name, value] of Object.entries(record(pool.capacity))) {
        const amount = finite(value);
        if (amount !== null) capacity[name] = amount;
      }
      return { id, kind: text(pool.kind) ?? 'pool', capacity };
    })),
    demands: placements.reduce((total, entry) => total + list(entry.demands).length, 0),
    links: placements.reduce((total, entry) => total + list(entry.network).length, 0),
    events: placements.reduce((total, entry) => total + Object.keys(record(entry.events)).length, 0),
    transitions: placements.reduce((total, entry) => total + list(entry.transitions).length, 0),
  };

  const profile = record(spec.profile);
  const adapters = [
    ...(isRecord(profile.adapter) ? [profile.adapter] : []),
    ...list(spec.dialects).map((dialect) => record(dialect).adapter).filter(isRecord),
  ].map((adapter) => `${text(adapter.id) ?? 'adapter'}@${text(adapter.version) ?? '?'}`);

  const flow = readFlow(application.workflow, tasks, routing, 0);
  const service = [...tasks.values()].filter((task) => task.kind === 'service');
  const distinct = new Set(service.flatMap((task) => task.candidates.map((candidate) => `${task.capability}/${candidate.id}`)));
  const sized = service.length > 0 && service.every((task) => task.candidates.length > 0);

  return {
    profile: text(profile.id),
    profileDigest: text(profile.digest),
    dialects: list(spec.dialects).map((entry) => {
      const dialect = record(entry);
      return { label: text(dialect.id) ?? 'dialect', digest: text(dialect.digest) };
    }),
    adapters: [...new Set(adapters)],
    tasks: [...tasks.values()],
    flow,
    features,
    rules,
    criteria,
    penalties,
    placement,
    serviceTasks: service.length,
    candidateCount: distinct.size,
    log10: sized ? service.reduce((total, task) => total + Math.log10(task.candidates.length), 0) : null,
  };
}

/** `10^5.1`, as plain text. */
export function powerText(log10: number | null): string {
  return log10 === null ? '—' : `10^${(Math.round(log10 * 10) / 10).toString()}`;
}

/** Rule counts in a sentence: `1 must, 1 should`. */
export function rulesText(rules: readonly Pick<RuleInfo, 'enforcement'>[]): string {
  if (rules.length === 0) return 'none';
  const must = rules.filter((rule) => rule.enforcement === 'hard').length;
  const should = rules.length - must;
  return [must ? `${must} must` : '', should ? `${should} should` : ''].filter(Boolean).join(', ');
}
