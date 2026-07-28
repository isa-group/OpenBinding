/**
 * Placement view of an instance, derived here rather than received pre-built.
 *
 * The resource and latency models are optional blocks of the instance. This
 * module turns them into the structures the DZN builder needs — pool of each
 * candidate, capacity constraints with their scope resolved, latency matrices,
 * and the XOR scenarios of the composition with their precedence DAG.
 *
 * An instance without those blocks yields an empty model: no pools, no
 * constraints, no scenarios. The builder emits the same (empty) arrays either
 * way, so the MiniZinc model's placement constraints are simply vacuous.
 *
 * The semantics here mirror the gateway reference evaluator; both are checked
 * against each other by the engine parity tests.
 */

export const EVENT_SOURCE = 'event';
export const TASK_SOURCE = 'task';

export type Source = [typeof TASK_SOURCE | typeof EVENT_SOURCE, string];

export interface Scenario {
  prob: number;
  /** Predecessor sources of every active task. */
  preds: Record<string, Source[]>;
  /** Topological order of the active tasks. */
  order: string[];
  /** Exit tasks of the scenario. */
  sinks: string[];
}

export interface Pool {
  id: string;
  kind?: string;
  capacity: Record<string, number>;
}

export interface CapacityConstraint {
  id?: string;
  hard: boolean;
  resources: string[];
  pools: string[];
}

export interface TransitionConstraint {
  id?: string;
  hard: boolean;
  from_task?: string;
  from_event?: string;
  to_task?: string;
  op?: string;
  value?: any;
}

export interface GlobalLatency {
  attribute_id?: string;
  include_execution_latency_feature: boolean;
  xor_semantics: string;
}

function collectXorNodes(node: any, acc: any[]): void {
  const kind = node?.kind;
  if (kind === 'XOR') {
    acc.push(node);
    for (const branch of node.branches || []) collectXorNodes(branch?.child || {}, acc);
  } else if (kind === 'SEQ' || kind === 'AND') {
    for (const child of node.children || []) collectXorNodes(child, acc);
  } else if (kind === 'LOOP') {
    collectXorNodes(node.body || {}, acc);
  }
}

/**
 * Thread entry points through the tree, recording task predecessors.
 *
 * Returns the exit points of `node`. Fork/join semantics emerge from the entry
 * sets: an AND joins because the next consumer receives the exits of every
 * branch and must wait for the slowest one.
 */
function buildDag(
  node: any,
  entries: Source[],
  choice: Map<any, number>,
  preds: Record<string, Source[]>,
  order: string[]
): Source[] {
  const kind = node?.kind;

  if (kind === 'TASK') {
    const taskId = node.task_id;
    if (taskId in preds) {
      throw new Error(
        `Task '${taskId}' appears more than once in the composition; ` +
          'the latency model requires a single occurrence per task'
      );
    }
    preds[taskId] = [...entries];
    order.push(taskId);
    return [[TASK_SOURCE, taskId]];
  }

  if (kind === 'ELEMENT') return [...entries];

  if (kind === 'SEQ') {
    let current = [...entries];
    for (const child of node.children || []) current = buildDag(child, current, choice, preds, order);
    return current;
  }

  if (kind === 'AND') {
    const exits: Source[] = [];
    for (const child of node.children || []) exits.push(...buildDag(child, [...entries], choice, preds, order));
    return exits;
  }

  if (kind === 'XOR') {
    const branches = node.branches || [];
    const idx = choice.get(node) ?? 0;
    return buildDag(branches[idx]?.child || {}, entries, choice, preds, order);
  }

  if (kind === 'LOOP') {
    throw new Error('LOOP nodes are not supported by the latency model');
  }

  throw new Error(`Unsupported composition node kind '${kind}'`);
}

function cartesian(sizes: number[]): number[][] {
  let combos: number[][] = [[]];
  for (const size of sizes) {
    const next: number[][] = [];
    for (const combo of combos) {
      for (let i = 0; i < size; i++) next.push([...combo, i]);
    }
    combos = next;
  }
  return combos;
}

/** Enumerate the XOR scenarios of a composition tree. */
export function buildScenarios(root: any, eventIds: string[]): Scenario[] {
  const xorNodes: any[] = [];
  collectXorNodes(root, xorNodes);

  const entries: Source[] = eventIds.map((id) => [EVENT_SOURCE, id]);
  const combos = xorNodes.length ? cartesian(xorNodes.map((n) => (n.branches || []).length)) : [[]];

  return combos.map((combo) => {
    let prob = 1.0;
    const choice = new Map<any, number>();
    xorNodes.forEach((node, i) => {
      choice.set(node, combo[i]);
      prob *= Number(node.branches?.[combo[i]]?.p ?? 0);
    });

    const preds: Record<string, Source[]> = {};
    const order: string[] = [];
    const exits = buildDag(root, [...entries], choice, preds, order);
    const sinks = exits.filter(([kind]) => kind === TASK_SOURCE).map(([, id]) => id);

    return { prob, preds, order, sinks };
  });
}

/**
 * Resource capacity is a dependency-type constraint: canonical form
 * `kind: DEPENDENCY` + `type: RESOURCE_CAPACITY`; the legacy spelling
 * `kind: RESOURCE_CAPACITY` is still accepted.
 */
function isCapacityConstraint(constraint: any): boolean {
  const kind = String(constraint?.kind || '').toUpperCase();
  if (kind === 'RESOURCE_CAPACITY') return true;
  return kind === 'DEPENDENCY' && String(constraint?.type || '').toUpperCase() === 'RESOURCE_CAPACITY';
}

export class PlacementModel {
  readonly pools: Pool[];
  readonly poolOfCandidate: Record<string, string>;
  readonly demandOfCandidate: Record<string, Record<string, number>>;
  readonly capacityConstraints: CapacityConstraint[];
  readonly latencyMatrix: Record<string, Record<string, number>>;
  readonly eventLatency: Record<string, Record<string, number>>;
  readonly eventPools: Record<string, string>;
  readonly eventIds: string[];
  readonly transitions: TransitionConstraint[];
  readonly globalLatency: GlobalLatency | null;

  private readonly instance: any;
  private scenarioCache: Scenario[] | null = null;

  constructor(instance: any) {
    this.instance = instance || {};
    const resourceModel = this.instance.resource_model || {};
    const latencyModel = this.instance.latency_model || {};

    this.pools = (resourceModel.pools || []).map((pool: any) => ({
      id: pool.id,
      kind: pool.kind,
      capacity: Object.fromEntries(
        Object.entries(pool.capacity || {}).map(([resource, value]) => [resource, Number(value)])
      ),
    }));

    this.poolOfCandidate = {};
    this.demandOfCandidate = {};
    for (const binding of resourceModel.candidate_bindings || []) {
      this.poolOfCandidate[binding.candidate_id] = binding.pool_id;
      this.demandOfCandidate[binding.candidate_id] = Object.fromEntries(
        Object.entries(binding.demand || {}).map(([resource, value]) => [resource, Number(value)])
      );
    }

    this.capacityConstraints = (resourceModel.constraints || [])
      .filter(isCapacityConstraint)
      .map((constraint: any) => ({
        id: constraint.id,
        hard: constraint.hard !== false,
        resources: [...(constraint.resources || [])],
        pools: this.poolsInScope(constraint),
      }));

    this.latencyMatrix = latencyModel.pool_latency_matrix_ms || {};
    this.eventLatency = latencyModel.event_latency_matrix_ms || {};
    this.eventPools = { ...(latencyModel.event_generator_pools || {}) };
    this.eventIds = Object.keys(this.eventPools).sort();
    this.transitions = latencyModel.transition_constraints || [];

    const globalLatency = latencyModel.global_latency;
    this.globalLatency = globalLatency
      ? {
          attribute_id: globalLatency.attribute_id,
          include_execution_latency_feature: Boolean(globalLatency.include_execution_latency_feature),
          xor_semantics: String(globalLatency.xor_semantics || 'EXPECTED').toUpperCase(),
        }
      : null;

    const andSemantics = String(globalLatency?.and_semantics || 'MAX').toUpperCase();
    if (andSemantics !== 'MAX') {
      throw new Error(`Unsupported and_semantics '${andSemantics}' (only MAX)`);
    }
  }

  private poolsInScope(constraint: any): string[] {
    const scope = String(constraint?.scope || 'ALL_POOLS').toUpperCase();
    if (scope === 'POOL_KIND') {
      const kinds = new Set(constraint?.pool_kinds || []);
      return this.pools.filter((pool) => kinds.has(pool.kind)).map((pool) => pool.id);
    }
    return this.pools.map((pool) => pool.id);
  }

  scenarios(): Scenario[] {
    if (this.scenarioCache === null) {
      const root = this.instance.composition?.root || {};
      this.scenarioCache = buildScenarios(root, this.eventIds);
    }
    return this.scenarioCache;
  }

  /** Pool-to-pool latency, falling back to the transposed entry. */
  poolLatency(a: string, b: string): number {
    let value = this.latencyMatrix[a]?.[b];
    if (value === undefined || value === null) value = this.latencyMatrix[b]?.[a];
    if (value === undefined || value === null) {
      if (a === b) return 0;
      throw new Error(`Missing pool latency entry for '${a}' -> '${b}'`);
    }
    return Number(value);
  }

  /** Latency from an event generator to a pool, falling back to its own pool. */
  eventPoolLatency(eventId: string, pool: string): number {
    const value = this.eventLatency[eventId]?.[pool];
    if (value !== undefined && value !== null) return Number(value);

    const generatorPool = this.eventPools[eventId];
    if (generatorPool !== undefined) return this.poolLatency(generatorPool, pool);

    throw new Error(`Missing event latency entry for '${eventId}' -> '${pool}'`);
  }
}

/**
 * Whether the instance normalizes every one of its objective targets, which is
 * what selects the canonical objective. Kept identical to the gateway rule.
 */
export function declaresNormalization(instance: any): boolean {
  const targets = instance?.objective?.targets || [];
  const policies = instance?.aggregation_policies || {};
  return targets.length > 0 && targets.every((target: string) => policies?.[target]?.normalize);
}
