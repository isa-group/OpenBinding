import { CandidateRef } from './dzn_builder';

export interface PlacementCandidate {
  ref: CandidateRef;
  metrics: Record<string, number>;
}

export interface PlacementEncoding {
  candidateModel: number[];
  candidatePool: number[];
  poolModel: number[];
  poolLatency: number[][];
  eventModel: number[];
  eventPool: number[];
  eventLatency: number[][];
  taskInvocation: number[];
  capacityPool: number[];
  capacityScope: number[];
  capacityLimit: number[];
  capacityDemand: number[][];
  transitionModel: number[];
  transitionFromKind: number[];
  transitionFrom: number[];
  transitionToKind: number[];
  transitionTo: number[];
  transitionMaximum: number[];
  transitionHard: boolean[];
  transitionPenalty: number[];
  globalMetricModel: number[];
  scenarioModel: number[];
  scenarioProbability: number[];
  scenarioReady: number[];
  activityModel: number[];
  activityTask: number[];
  activityExecMetric: number[];
  activityPredKind: number[][];
  activityPredSource: number[][];
  activityPredReady: number[][];
  activityPredCount: number[];
  readyKind: number[];
  readySource: number[];
  readyBase: number[];
  readyChildren: number[][];
  readyChildCount: number[];
  timeBound: number;
  maxPreds: number;
  maxReadyChildren: number;
  penaltyBound: number;
}

type Assignment = { model: number; pool: number; resources: Record<string, number> };
type Frontier = { kind: 1 | 2; source: number; ready: number };
type Variant = { probability: number; frontier: Frontier[] };

const key = (ref: CandidateRef): string => `${ref.resource}\u0000${ref.id}`;

function branchRef(problem: any, pointer: string, index: number, id: string): CandidateRef {
  const sourceMap = problem.spec.sourceMap;
  const branch = sourceMap?.[`${pointer}/branches/${index}`];
  const escaped = id.replace(/~/g, '~0').replace(/\//g, '~1');
  const element = sourceMap?.[`/spec/application/workflow/elements/${escaped}`];
  const resource = typeof branch?.resource === 'string' ? branch.resource
    : typeof element?.resource === 'string' ? element.resource : problem.spec.application.resource;
  return { resource, id };
}

function routingMap(problem: any): Map<string, number> {
  return new Map((problem.spec.routing || []).map((entry: any) => [key(entry.target), Number(entry.probability)]));
}

function taskInvocations(problem: any, taskIndex: Map<string, number>): number[] {
  const result = Array(taskIndex.size).fill(0);
  const routing = routingMap(problem);
  const visit = (node: any, pointer: string, multiplier: number): void => {
    if (node.kind === 'task') {
      const index = taskIndex.get(node.task.id);
      if (index) result[index - 1] += multiplier;
    } else if (node.kind === 'sequence' || node.kind === 'parallel') {
      const field = node.kind === 'sequence' ? 'steps' : 'branches';
      (node[field] || []).forEach((child: any, index: number) =>
        visit(child, `${pointer}/${field}/${index}`, multiplier));
    } else if (node.kind === 'exclusive') {
      (node.branches || []).forEach((branch: any, index: number) => {
        const probability = routing.get(key(branchRef(problem, pointer, index, branch.id)));
        if (!Number.isFinite(probability)) throw new Error(`Missing routing probability for XOR branch '${branch.id}'`);
        visit(branch.flow, `${pointer}/branches/${index}/flow`, multiplier * probability!);
      });
    } else if (node.kind === 'repeat') {
      visit(node.body, `${pointer}/body`, multiplier * Number(node.count));
    }
  };
  visit(problem.spec.application.workflow, '/spec/application/workflow', 1);
  return result;
}

/** Lower the canonical Placement IR. Empty Placement yields only a harmless dummy pool. */
export function buildPlacementEncoding(problem: any, candidates: PlacementCandidate[], tasks: string[],
    metricIndex: Map<string, number>, optimizationPenalty: Map<string, number>): PlacementEncoding {
  const placements = problem.spec.placement as any[];
  const taskIndex = new Map(tasks.map((task, index) => [task, index + 1]));
  const poolModel = [0]; // one-based dummy pool keeps every MiniZinc array index valid
  const poolRefs: CandidateRef[] = [{ resource: '', id: '' }];
  const poolIndex = new Map<string, number>();
  const modelIndex = new Map<string, number>();
  placements.forEach((model, modelOffset) => {
    const modelId = modelOffset + 1;
    modelIndex.set(model.resource, modelId);
    for (const pool of Object.values(model.pools || {}) as any[]) {
      const index = poolRefs.length + 1;
      poolRefs.push(pool.ref);
      poolModel.push(modelId);
      poolIndex.set(key(pool.ref), index);
    }
  });
  const poolSlots = poolRefs.length;
  const poolLatency = Array.from({ length: poolSlots }, () => Array(poolSlots).fill(0));
  for (const model of placements) {
    const links = new Map<string, number>((model.network || []).map((link: any) =>
      [`${key(link.from)}\u0001${key(link.to)}`, Number(link.latency)]));
    const ownPools = Object.values(model.pools || {}) as any[];
    for (const from of ownPools) for (const to of ownPools) {
      const value = key(from.ref) === key(to.ref) ? 0 : links.get(`${key(from.ref)}\u0001${key(to.ref)}`);
      // The compiler guarantees links only between pools that a decision can
      // actually reach; unused infrastructure pools may stay disconnected.
      poolLatency[poolIndex.get(key(from.ref))! - 1][poolIndex.get(key(to.ref))! - 1] = value || 0;
    }
  }

  const assignments = new Map<string, Assignment>();
  placements.forEach((model, modelOffset) => {
    for (const demand of model.demands || []) {
      assignments.set(key(demand.candidate), {
        model: modelOffset + 1,
        pool: poolIndex.get(key(demand.pool))!,
        resources: Object.fromEntries(Object.entries(demand.resources || {}).map(([name, value]) => [name, Number(value)])),
      });
    }
  });
  const candidateModel = candidates.map((candidate) => assignments.get(key(candidate.ref))?.model || 0);
  const candidatePool = candidates.map((candidate) => assignments.get(key(candidate.ref))?.pool || 1);

  const eventModel: number[] = [];
  const eventPool: number[] = [];
  const eventLatency: number[][] = [];
  const eventIndex = new Map<string, number>();
  placements.forEach((model, modelOffset) => {
    for (const eventId of Object.keys(model.events || {}).sort()) {
      const event = model.events[eventId];
      const index = eventModel.length + 1;
      eventIndex.set(`${model.resource}\u0000${eventId}`, index);
      eventModel.push(modelOffset + 1);
      eventPool.push(poolIndex.get(key(event.pool))!);
      const overrides = new Map<string, number>((event.latency || []).map((item: any) => [key(item.pool), Number(item.latency)]));
      eventLatency.push(poolRefs.map((target, poolOffset) => {
        if (poolOffset === 0 || poolModel[poolOffset] !== modelOffset + 1) return 0;
        const explicit = overrides.get(key(target));
        return explicit === undefined ? poolLatency[eventPool[index - 1] - 1][poolOffset] : explicit;
      }));
    }
  });

  const taskInvocation = taskInvocations(problem, taskIndex);
  const capacityPool: number[] = [];
  const capacityScope: number[] = [];
  const capacityLimit: number[] = [];
  const capacityDemand: number[][] = [];
  placements.forEach((model) => {
    for (const rule of model.capacityRules || []) for (const pool of Object.values(model.pools || {}) as any[]) {
      for (const resource of rule.resources || []) {
        capacityPool.push(poolIndex.get(key(pool.ref))!);
        capacityScope.push(rule.scope === 'invocation' ? 1 : 2);
        capacityLimit.push(Number(pool.capacity[resource]));
        capacityDemand.push(candidates.map((candidate) => assignments.get(key(candidate.ref))?.resources[resource] || 0));
      }
    }
  });

  const transitionModel: number[] = [];
  const transitionFromKind: number[] = [];
  const transitionFrom: number[] = [];
  const transitionToKind: number[] = [];
  const transitionTo: number[] = [];
  const transitionMaximum: number[] = [];
  const transitionHard: boolean[] = [];
  const transitionPenalty: number[] = [];
  const endpoint = (model: any, ref: CandidateRef): [number, number] => {
    if (ref.resource === model.resource) {
      const index = eventIndex.get(`${model.resource}\u0000${ref.id}`);
      if (!index) throw new Error(`Unknown placement event '${ref.resource}:${ref.id}'`);
      return [1, index];
    }
    const index = taskIndex.get(ref.id);
    if (ref.resource !== problem.spec.application.resource || !index) {
      throw new Error(`Unknown placement transition endpoint '${ref.resource}:${ref.id}'`);
    }
    return [2, index];
  };
  placements.forEach((model, modelOffset) => {
    for (const transition of model.transitions || []) {
      const from = endpoint(model, transition.from);
      const to = endpoint(model, transition.to);
      transitionModel.push(modelOffset + 1);
      transitionFromKind.push(from[0]); transitionFrom.push(from[1]);
      transitionToKind.push(to[0]); transitionTo.push(to[1]);
      transitionMaximum.push(Number(transition.maximum));
      transitionHard.push(transition.enforcement === 'hard');
      transitionPenalty.push(transition.enforcement === 'soft'
        ? Number(transition.penalty) * (optimizationPenalty.get(key(transition.ref)) || 0) : 0);
    }
  });

  const globalMetricModel = Array(metricIndex.size).fill(0);
  const scenarioModel: number[] = [];
  const scenarioProbability: number[] = [];
  const scenarioReady: number[] = [];
  const activityModel: number[] = [];
  const activityTask: number[] = [];
  const activityExecMetric: number[] = [];
  const activityPredKind: number[][] = [];
  const activityPredSource: number[][] = [];
  const activityPredReady: number[][] = [];
  const readyKind: number[] = [];
  const readySource: number[] = [];
  const readyBase: number[] = [];
  const readyChildren: number[][] = [];
  const routing = routingMap(problem);
  const newReady = (kindCode: number, source: number, base = 0, children: number[] = []): number => {
    readyKind.push(kindCode); readySource.push(source); readyBase.push(base); readyChildren.push(children);
    return readyKind.length;
  };
  const latest = (frontier: Frontier[]): number => {
    const children = [...new Set(frontier.map((entry) => entry.ready).filter((value) => value > 0))];
    if (children.length === 0) return newReady(4, 0);
    if (children.length === 1) return children[0];
    return newReady(2, 0, 0, children);
  };
  const variantsLimit = (): never => { throw new Error('Placement latency expands beyond 4096 deterministic routing variants'); };
  const workflow = (node: any, pointer: string, variants: Variant[], model: any,
      modelId: number, metric: number, includeExecution: boolean): Variant[] => {
    if (node.kind === 'empty') return variants;
    if (node.kind === 'task') {
      const task = taskIndex.get(node.task.id);
      if (!task) return variants; // local task
      return variants.map((variant) => {
        const activity = activityTask.length + 1;
        activityModel.push(modelId); activityTask.push(task);
        activityExecMetric.push(includeExecution ? metric : 0);
        activityPredKind.push(variant.frontier.map((entry) => entry.kind));
        activityPredSource.push(variant.frontier.map((entry) => entry.source));
        activityPredReady.push(variant.frontier.map((entry) => entry.ready));
        const ready = newReady(1, activity);
        return { probability: variant.probability, frontier: [{ kind: 2, source: activity, ready }] };
      });
    }
    if (node.kind === 'sequence') {
      return (node.steps || []).reduce((current: Variant[], child: any, index: number) =>
        workflow(child, `${pointer}/steps/${index}`, current, model, modelId, metric, includeExecution), variants);
    }
    if (node.kind === 'parallel') {
      const result: Variant[] = [];
      for (const base of variants) {
        let combinations: Array<{ probability: number; frontiers: Frontier[][] }> = [{ probability: base.probability, frontiers: [] }];
        (node.branches || []).forEach((branch: any, branchIndex: number) => {
          const branchVariants = workflow(branch, `${pointer}/branches/${branchIndex}`,
            [{ probability: 1, frontier: base.frontier.map((entry) => ({ ...entry })) }],
            model, modelId, metric, includeExecution);
          combinations = combinations.flatMap((combination) => branchVariants.map((branchVariant) => ({
            probability: combination.probability * branchVariant.probability,
            frontiers: [...combination.frontiers, branchVariant.frontier],
          })));
          if (combinations.length > 4096) variantsLimit();
        });
        for (const combination of combinations) {
          let frontier = combination.frontiers.flat();
          if (model.globalLatency.parallel === 'sum') {
            const baseReady = latest(base.frontier);
            const branchReadies = combination.frontiers.map(latest);
            const summed = newReady(3, 0, baseReady, branchReadies);
            frontier = frontier.map((entry) => ({ ...entry, ready: summed }));
          }
          result.push({ probability: combination.probability, frontier });
        }
      }
      if (result.length > 4096) variantsLimit();
      return result;
    }
    if (node.kind === 'exclusive') {
      if (model.globalLatency.exclusive !== 'routing') {
        throw new Error('MiniZinc placement supports globalLatency.exclusive routing only');
      }
      const result: Variant[] = [];
      (node.branches || []).forEach((branch: any, branchIndex: number) => {
        const probability = routing.get(key(branchRef(problem, pointer, branchIndex, branch.id)));
        if (!Number.isFinite(probability)) throw new Error(`Missing routing probability for XOR branch '${branch.id}'`);
        const input = variants.map((variant) => ({ probability: variant.probability * probability!, frontier: variant.frontier.map((entry) => ({ ...entry })) }));
        result.push(...workflow(branch.flow, `${pointer}/branches/${branchIndex}/flow`, input,
          model, modelId, metric, includeExecution));
      });
      if (result.length > 4096) variantsLimit();
      return result;
    }
    if (node.kind === 'repeat') {
      let result = variants;
      for (let count = 0; count < Number(node.count); count += 1) {
        result = workflow(node.body, `${pointer}/body`, result, model, modelId, metric, includeExecution);
      }
      return result;
    }
    throw new Error(`Unsupported workflow node '${String(node.kind)}' in placement latency`);
  };
  placements.forEach((model, modelOffset) => {
    if (!model.globalLatency) return;
    const modelId = modelOffset + 1;
    const metric = metricIndex.get(model.globalLatency.metric.id);
    if (!metric) throw new Error(`Placement globalLatency references unknown metric '${model.globalLatency.metric.id}'`);
    globalMetricModel[metric - 1] = modelId;
    const initial = Object.keys(model.events || {}).sort().map((eventId) => ({
      kind: 1 as const, source: eventIndex.get(`${model.resource}\u0000${eventId}`)!, ready: 0,
    }));
    const variants = workflow(problem.spec.application.workflow, '/spec/application/workflow',
      [{ probability: 1, frontier: initial }], model, modelId, metric, Boolean(model.globalLatency.includeExecution));
    const total = variants.reduce((sum, variant) => sum + variant.probability, 0);
    if (Math.abs(total - 1) > 1e-12) throw new Error(`Placement routing probability is ${total}, expected 1`);
    for (const variant of variants) {
      scenarioModel.push(modelId); scenarioProbability.push(variant.probability); scenarioReady.push(latest(variant.frontier));
    }
  });
  const maxNetwork = Math.max(0, ...poolLatency.flat(), ...eventLatency.flat());
  const globalMetrics = new Set(globalMetricModel.map((value, index) => value ? index + 1 : 0));
  const maxExecution = Math.max(0, ...candidates.flatMap((candidate) =>
    [...globalMetrics].filter(Boolean).map((metric) => Math.max(0, candidate.metrics[[...metricIndex.entries()].find(([, value]) => value === metric)?.[0] || ''] || 0))));
  const timeBound = Math.max(1, (activityTask.length + 1) * (maxNetwork + maxExecution + 1));
  const maxPreds = Math.max(1, ...activityPredKind.map((row) => row.length));
  const maxReadyChildren = Math.max(1, ...readyChildren.map((row) => row.length));
  const pad = (rows: number[][], length: number, value: number) => rows.map((row) => [...row, ...Array(length - row.length).fill(value)]);
  const penaltyBound = Math.max(1, transitionPenalty.reduce((sum, value) => sum + value, 0));
  return {
    candidateModel, candidatePool, poolModel, poolLatency, eventModel, eventPool, eventLatency,
    taskInvocation, capacityPool, capacityScope, capacityLimit, capacityDemand,
    transitionModel, transitionFromKind, transitionFrom, transitionToKind, transitionTo,
    transitionMaximum, transitionHard, transitionPenalty, globalMetricModel,
    scenarioModel, scenarioProbability, scenarioReady, activityModel, activityTask, activityExecMetric,
    activityPredKind: pad(activityPredKind, maxPreds, 1),
    activityPredSource: pad(activityPredSource, maxPreds, 1),
    activityPredReady: pad(activityPredReady, maxPreds, 0),
    activityPredCount: activityPredKind.map((row) => row.length),
    readyKind, readySource, readyBase,
    readyChildren: pad(readyChildren, maxReadyChildren, 1),
    readyChildCount: readyChildren.map((row) => row.length),
    timeBound, maxPreds, maxReadyChildren, penaltyBound,
  };
}

export interface PlacementEvaluation {
  metrics: Record<string, number>;
  penalties: number[];
  violations: any[];
  penalty: number;
}

/** Canonical post-check used to verify and report MiniZinc incumbents. */
export function evaluatePlacement(problem: any, binding: Record<string, CandidateRef>,
    candidateMetric: (candidate: CandidateRef, metric: string) => number): PlacementEvaluation {
  const placements = problem.spec.placement as any[];
  const assignment = new Map<string, { model: any; demand: any }>();
  for (const model of placements) for (const demand of model.demands || []) assignment.set(key(demand.candidate), { model, demand });
  const network = (model: any, from: CandidateRef, to: CandidateRef): number => {
    if (key(from) === key(to)) return 0;
    const link = (model.network || []).find((item: any) => key(item.from) === key(from) && key(item.to) === key(to));
    if (!link) throw new Error(`Placement '${model.resource}' lacks network latency ${from.id} -> ${to.id}`);
    return Number(link.latency);
  };
  const eventLatency = (model: any, eventId: string, pool: CandidateRef): number => {
    const event = model.events?.[eventId];
    if (!event) throw new Error(`Unknown placement event '${eventId}'`);
    const override = (event.latency || []).find((item: any) => key(item.pool) === key(pool));
    return override ? Number(override.latency) : network(model, event.pool, pool);
  };
  type NumericFrontier = { kind: 1 | 2; event?: string; pool?: CandidateRef; ready: number };
  type NumericVariant = { probability: number; frontier: NumericFrontier[] };
  const routing = routingMap(problem);
  const latest = (frontier: NumericFrontier[]) => Math.max(0, ...frontier.map((item) => item.ready));
  const global = (model: any): number => {
    const config = model.globalLatency;
    const walk = (node: any, pointer: string, variants: NumericVariant[]): NumericVariant[] => {
      if (node.kind === 'empty') return variants;
      if (node.kind === 'task') {
        const selected = binding[node.task.id];
        if (!selected) return variants;
        const placed = assignment.get(key(selected));
        if (!placed || placed.model.resource !== model.resource) throw new Error(`Task '${node.task.id}' is assigned outside placement '${model.resource}'`);
        const target = placed.demand.pool;
        const execution = config.includeExecution ? candidateMetric(selected, config.metric.id) : 0;
        return variants.map((variant) => {
          const start = Math.max(0, ...variant.frontier.map((source) => source.ready + (source.kind === 1
            ? eventLatency(model, source.event!, target) : network(model, source.pool!, target))));
          return { probability: variant.probability, frontier: [{ kind: 2, pool: target, ready: start + execution }] };
        });
      }
      if (node.kind === 'sequence') return (node.steps || []).reduce((current: NumericVariant[], child: any, index: number) =>
        walk(child, `${pointer}/steps/${index}`, current), variants);
      if (node.kind === 'parallel') {
        const result: NumericVariant[] = [];
        for (const base of variants) {
          let combinations: Array<{ probability: number; frontiers: NumericFrontier[][] }> = [{ probability: base.probability, frontiers: [] }];
          (node.branches || []).forEach((branch: any, index: number) => {
            const branchVariants = walk(branch, `${pointer}/branches/${index}`,
              [{ probability: 1, frontier: base.frontier.map((entry) => ({ ...entry })) }]);
            combinations = combinations.flatMap((combination) => branchVariants.map((variant) => ({
              probability: combination.probability * variant.probability,
              frontiers: [...combination.frontiers, variant.frontier],
            })));
          });
          for (const combination of combinations) {
            let frontier = combination.frontiers.flat();
            if (config.parallel === 'sum') {
              const baseline = latest(base.frontier);
              const finish = baseline + combination.frontiers.reduce((sum, value) => sum + Math.max(0, latest(value) - baseline), 0);
              frontier = frontier.map((entry) => ({ ...entry, ready: finish }));
            }
            result.push({ probability: combination.probability, frontier });
          }
        }
        return result;
      }
      if (node.kind === 'exclusive') {
        if (config.exclusive !== 'routing') throw new Error('MiniZinc placement supports globalLatency.exclusive routing only');
        return (node.branches || []).flatMap((branch: any, index: number) => {
          const probability = routing.get(key(branchRef(problem, pointer, index, branch.id)))!;
          return walk(branch.flow, `${pointer}/branches/${index}/flow`, variants.map((variant) => ({
            probability: variant.probability * probability, frontier: variant.frontier.map((entry) => ({ ...entry })),
          })));
        });
      }
      if (node.kind === 'repeat') {
        let result = variants;
        for (let count = 0; count < Number(node.count); count += 1) result = walk(node.body, `${pointer}/body`, result);
        return result;
      }
      throw new Error(`Unsupported workflow node '${String(node.kind)}' in placement latency`);
    };
    const initial = Object.keys(model.events || {}).sort().map((event) => ({ kind: 1 as const, event, ready: 0 }));
    return walk(problem.spec.application.workflow, '/spec/application/workflow', [{ probability: 1, frontier: initial }])
      .reduce((sum, variant) => sum + variant.probability * latest(variant.frontier), 0);
  };
  const metrics: Record<string, number> = {};
  for (const model of placements) if (model.globalLatency) metrics[model.globalLatency.metric.id] = global(model);

  const violations: any[] = [];
  const invocations = taskInvocations(problem, new Map(Object.keys(binding).map((task, index) => [task, index + 1])));
  const invocationByTask = new Map(Object.keys(binding).map((task, index) => [task, invocations[index]]));
  for (const model of placements) {
    const pools = new Map(Object.values(model.pools || {}).map((pool: any) => [key(pool.ref), pool]));
    for (const rule of model.capacityRules || []) {
      const charges = rule.scope === 'selectedCandidate'
        ? [...new Map(Object.values(binding).map((ref) => [key(ref), ref])).values()].map((ref) => [ref, 1] as const)
        : Object.entries(binding).map(([task, ref]) => [ref, invocationByTask.get(task) || 0] as const);
      const usage = new Map<string, Record<string, number>>();
      for (const [candidate, multiplier] of charges) {
        const placed = assignment.get(key(candidate));
        if (!placed || placed.model.resource !== model.resource) continue;
        const values = usage.get(key(placed.demand.pool)) || {};
        for (const resource of rule.resources) values[resource] = (values[resource] || 0) + Number(placed.demand.resources?.[resource] || 0) * multiplier;
        usage.set(key(placed.demand.pool), values);
      }
      for (const [poolKey, values] of usage) for (const resource of rule.resources) {
        const capacity = Number((pools.get(poolKey) as any).capacity[resource]);
        if ((values[resource] || 0) > capacity) violations.push({ constraint: rule.ref, enforcement: 'hard', penalty: 0,
          message: `Pool ${poolKey.replace('\u0000', ':')} exceeds ${resource} capacity ${capacity}` });
      }
    }
    const endpointPool = (ref: CandidateRef): CandidateRef => {
      if (ref.resource === model.resource) return model.events[ref.id].pool;
      const placed = assignment.get(key(binding[ref.id]));
      if (!placed || placed.model.resource !== model.resource) throw new Error(`Transition endpoint '${ref.resource}:${ref.id}' is assigned outside placement`);
      return placed.demand.pool;
    };
    for (const transition of model.transitions || []) {
      const to = endpointPool(transition.to);
      const current = transition.from.resource === model.resource
        ? eventLatency(model, transition.from.id, to) : network(model, endpointPool(transition.from), to);
      if (current > Number(transition.maximum)) violations.push({ constraint: transition.ref,
        enforcement: transition.enforcement, penalty: transition.enforcement === 'soft' ? Number(transition.penalty) : 0,
        message: `Transition latency ${current} exceeds maximum ${transition.maximum}` });
    }
  }
  if (violations.some((value) => value.enforcement === 'hard')) throw new Error('MiniZinc returned a decision that violates a hard placement constraint');
  const rawPenalty = new Map(violations.filter((value) => value.enforcement === 'soft').map((value) => [key(value.constraint), value.penalty]));
  const penalties = (problem.spec.optimization.penalties || []).map((item: any) =>
    (rawPenalty.get(key(item.constraint)) || 0) * Number(item.weight));
  return { metrics, penalties, violations, penalty: penalties.reduce((sum: number, value: number) => sum + value, 0) };
}
