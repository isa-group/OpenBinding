import { fmt, fmt2d } from './encoders/format';
import { buildPlacementEncoding } from './placement';

export interface CandidateRef { resource: string; id: string }

export interface DznBuildResult {
  dznContent: string;
  metrics: string[];
  tasks: string[];
  candidates: CandidateRef[];
}

type CandidateEntry = {
  ref: CandidateRef;
  metrics: Record<string, number>;
  provider?: CandidateRef;
  properties: Record<string, string | number | boolean | null>;
};

/** Strict lowering for the exact subset declared by the minizinc-csp manifest. */
export class DznBuilder {
  build(problem: any, _options: any = {}): DznBuildResult {
    this.requireProblem(problem);
    const spec = problem.spec;
    const application = spec.application;
    const taskEntries = Object.entries(application.tasks || {}) as Array<[string, any]>;
    if (taskEntries.some(([, task]) => !task || !['service', 'local'].includes(task.kind))) {
      throw new Error('BindingProblem.application.tasks contains an unsupported task kind');
    }
    const tasks = taskEntries.filter(([, task]) => task?.kind === 'service').map(([id]) => id);
    if (tasks.length > 10000) throw new Error('MiniZinc mode limit maxTasks=10000 exceeded');

    if (!Array.isArray(application.requiredMetrics)) {
      throw new Error('BindingProblem.application.requiredMetrics must be materialized');
    }
    const requiredMetrics = application.requiredMetrics as unknown[];
    if (new Set(requiredMetrics).size !== requiredMetrics.length
        || requiredMetrics.some((id) => typeof id !== 'string' || !application.metrics?.[id])) {
      throw new Error('BindingProblem.application.requiredMetrics must contain unique known metric ids');
    }
    const localMetrics = Object.values(application.taskRequiredMetrics || {}).flatMap((value: any) =>
      Array.isArray(value) ? value : []).filter((id: any) => typeof id === 'string');
    const encodedMetricIds = [...new Set([...requiredMetrics as string[], ...localMetrics])];
    const metricEntries = encodedMetricIds.map((id) => [id, application.metrics[id]] as [string, any]);
    const metrics = metricEntries.map(([id]) => id);
    if (metrics.length === 0) throw new Error('MiniZinc requires at least one metric');
    for (const [id, metric] of metricEntries) this.validateMetric(id, metric);
    const routing = this.routing(spec.routing);
    const usedRouting = new Set<string>();

    const candidates = this.flattenCandidates(spec.candidates || {}, application.resource,
      new Set(Object.keys(application.metrics || {})), new Set(metrics));
    if (candidates.length === 0) throw new Error('MiniZinc requires at least one candidate');
    if (candidates.length > 100000) throw new Error('MiniZinc mode limit maxCandidates=100000 exceeded');
    const candidateIndex = new Map(candidates.map((candidate, index) => [this.refKey(candidate.ref), index + 1]));
    const taskIndex = new Map(tasks.map((task, index) => [task, index + 1]));
    const metricIndex = new Map(metrics.map((metric, index) => [metric, index + 1]));

    const eligibility: number[][] = [];
    if (!spec.eligibility || typeof spec.eligibility !== 'object' || Array.isArray(spec.eligibility)
        || Object.keys(spec.eligibility).length !== tasks.length
        || Object.keys(spec.eligibility).some((task) => !tasks.includes(task))) {
      throw new Error('BindingProblem.eligibility keys must be exactly the service tasks');
    }
    for (const task of tasks) {
      const refs = spec.eligibility?.[task];
      if (!Array.isArray(refs) || refs.length === 0) throw new Error(`Task '${task}' has no eligibility domain`);
      const seen = new Set<string>();
      eligibility.push(refs.map((ref: any) => {
        this.requireRef(ref, `eligibility.${task}`);
        const key = this.refKey(ref);
        if (seen.has(key)) throw new Error(`Task '${task}' repeats eligible candidate '${ref.resource}:${ref.id}'`);
        seen.add(key);
        const index = candidateIndex.get(this.refKey(ref));
        if (!index) throw new Error(`Eligibility references unknown candidate '${ref.resource}:${ref.id}'`);
        return index;
      }));
    }
    const maxCandidatesPerTask = tasks.length === 0
      ? 1 : Math.max(...eligibility.map((values) => values.length));
    const paddedEligibility = eligibility.map((values) => [
      ...values,
      ...Array(maxCandidatesPerTask - values.length).fill(values[0]),
    ]);

    const candidateMetric = candidates.map((candidate) => metrics.map((metric) => {
      const value = Number(candidate.metrics?.[metric]);
      if (!Number.isFinite(value)) throw new Error(`Candidate '${candidate.ref.resource}:${candidate.ref.id}' is missing finite metric '${metric}'`);
      return value;
    }));
    const nodes: Array<{ kind: number; task: number; children: number[]; weights: number[]; repeat: number }> = [];
    const visit = (node: any, pointer: string): number => {
      if (!node || typeof node !== 'object') throw new Error('Workflow node must be an object');
      const index = nodes.length + 1;
      const row = { kind: 0, task: 0, children: [] as number[], weights: [] as number[], repeat: 0 };
      nodes.push(row);
      if (node.kind === 'task') {
        this.requireRef(node.task, 'workflow.task');
        if (node.task.resource !== application.resource) throw new Error('Workflow task ref targets a different application resource');
        const task = application.tasks?.[node.task.id];
        if (!task) throw new Error(`Workflow references unknown task '${node.task.id}'`);
        if (task.kind === 'local') row.kind = 1;
        else {
          row.kind = 2;
          row.task = taskIndex.get(node.task.id) || 0;
        }
      } else if (node.kind === 'empty') {
        row.kind = 1;
      } else if (node.kind === 'sequence' || node.kind === 'parallel') {
        row.kind = node.kind === 'sequence' ? 3 : 4;
        const children = node.kind === 'sequence' ? node.steps : node.branches;
        if (!Array.isArray(children) || children.length === 0) throw new Error(`${node.kind} requires children`);
        row.children = children.map((child: any, childIndex: number) => visit(
          child, `${pointer}/${node.kind === 'sequence' ? 'steps' : 'branches'}/${childIndex}`));
        row.weights = children.map(() => 0);
      } else if (node.kind === 'exclusive') {
        row.kind = 5;
        if (!Array.isArray(node.branches) || node.branches.length === 0) throw new Error('exclusive requires branches');
        for (let branchIndex = 0; branchIndex < node.branches.length; branchIndex += 1) {
          const branch = node.branches[branchIndex];
          if (branch.when !== undefined) throw new Error('MiniZinc mode does not support conditional XOR');
          const target = this.workflowBranchRef(application.resource, spec.sourceMap,
            pointer, branchIndex, branch.id);
          const key = this.refKey(target);
          const probability = routing.get(key);
          if (!Number.isFinite(probability)) throw new Error(`Missing routing probability for XOR branch '${branch.id}'`);
          usedRouting.add(key);
          row.children.push(visit(branch.flow, `${pointer}/branches/${branchIndex}/flow`));
          row.weights.push(probability!);
        }
        const total = row.weights.reduce((sum, value) => sum + value, 0);
        if (Math.abs(total - 1) > 1e-12) throw new Error('XOR routing probabilities must sum to 1');
      } else if (node.kind === 'repeat') {
        if (node.expectedCount !== undefined) throw new Error('MiniZinc mode does not support expectedCount; use exact repeat.count');
        const count = Number(node.count);
        if (!Number.isInteger(count) || count < 0) throw new Error('repeat.count must be a non-negative integer');
        row.kind = 6;
        row.repeat = count;
        row.children = [visit(node.body, `${pointer}/body`)];
        row.weights = [0];
      } else {
        throw new Error(`MiniZinc mode does not support workflow node '${node.kind}'`);
      }
      return index;
    };
    const root = visit(application.workflow, '/spec/application/workflow');
    const unknownRouting = [...routing.keys()].filter((key) => !usedRouting.has(key));
    if (unknownRouting.length) throw new Error('Routing contains targets outside the executable workflow');
    let nodeMetricBound = 1;
    const metricBounds = new Map<string, number>();
    metricEntries.forEach(([metricId, metric], metricPosition) => {
      const candidateBound = Math.max(...candidateMetric.map((row) => Math.abs(row[metricPosition])));
      const nodeBounds: number[] = [];
      const bound = this.workflowBound(application.workflow, '/spec/application/workflow', metric,
        application, spec.sourceMap, routing, candidateBound, nodeBounds);
      if (!Number.isFinite(bound) || bound > 1e100
          || nodeBounds.some((value) => !Number.isFinite(value) || value > 1e100)) {
        throw new Error(`Metric '${metricId}' exceeds the finite MiniZinc numeric domain`);
      }
      metricBounds.set(metricId, bound);
      for (const value of nodeBounds) nodeMetricBound = Math.max(nodeMetricBound, value);
    });
    const maxChildren = Math.max(1, ...nodes.map((node) => node.children.length));
    const nodeChildren = nodes.map((node) => [...node.children, ...Array(maxChildren - node.children.length).fill(1)]);
    const nodeWeights = nodes.map((node) => [...node.weights, ...Array(maxChildren - node.weights.length).fill(0)]);

    const aggregationCodes = metricEntries.map(([metricId, metric]) => [
      this.aggregationCode(metric.aggregation.sequence, 'sequence', metricId),
      this.aggregationCode(metric.aggregation.parallel, 'parallel', metricId),
      this.aggregationCode(metric.aggregation.exclusive, 'exclusive', metricId),
      this.aggregationCode(metric.aggregation.repeat, 'repeat', metricId),
    ]);

    const constraints = this.constraints(spec.constraints || [], metricIndex, taskIndex, candidates);
    const optimization = this.optimization(spec.optimization, application.resource, metricIndex);
    const placement = buildPlacementEncoding(problem, candidates, tasks, metricIndex, optimization.penaltyWeight);
    let objectiveBound = 0;
    optimization.metric.forEach((metricPosition, index) => {
      const metricId = metrics[metricPosition - 1];
      let termBound = placement.globalMetricModel[metricPosition - 1]
        ? placement.timeBound : metricBounds.get(metricId) || 0;
      if (optimization.hasNormalize[index]) {
        const range = optimization.max[index] - optimization.min[index];
        if (optimization.clamp[index]) {
          termBound = 1;
        } else {
          const low = (-termBound - optimization.min[index]) / range;
          const high = (termBound - optimization.min[index]) / range;
          termBound = optimization.direction[index] === 1
            ? Math.max(Math.abs(low), Math.abs(high))
            : Math.max(Math.abs(1 - low), Math.abs(1 - high));
        }
      }
      objectiveBound += optimization.weight[index] * termBound;
    });
    if (!Number.isFinite(objectiveBound) || objectiveBound > 1e100) {
      throw new Error('Weighted objective exceeds the finite MiniZinc numeric domain');
    }
    objectiveBound = Math.max(1, objectiveBound + placement.penaltyBound);

    const content = `
n_tasks = ${tasks.length};
n_candidates = ${candidates.length};
n_metrics = ${metrics.length};
max_candidates_per_task = ${maxCandidatesPerTask};
n_task_candidates = ${fmt(eligibility.map((values) => values.length))};
task_candidates = ${fmt2d(paddedEligibility)};
candidate_metric = ${fmt2d(candidateMetric)};
metric_neutral = ${fmt(metricEntries.map(([, metric]) => Number(metric.neutral)))};
metric_scope = ${fmt(metricEntries.map(([, metric]) => metric.scope === 'selectedCandidate' ? 2 : 1))};
selection_aggregation = ${fmt(metricEntries.map(([metricId, metric]) =>
    this.selectionAggregationCode(metric.aggregation.selection, metricId)))};
node_metric_bound = ${nodeMetricBound};
objective_bound = ${objectiveBound};

root_node = ${root};
n_nodes = ${nodes.length};
max_children = ${maxChildren};
node_kind = ${fmt(nodes.map((node) => node.kind))};
node_task = ${fmt(nodes.map((node) => node.task))};
node_child_count = ${fmt(nodes.map((node) => node.children.length))};
node_children = ${fmt2d(nodeChildren)};
node_weights = ${fmt2d(nodeWeights)};
node_repeat_count = ${fmt(nodes.map((node) => node.repeat))};
aggregation = ${fmt2d(aggregationCodes)};

n_constraints = ${constraints.operator.length};
constraint_operator = ${fmt(constraints.operator)};
constraint_left_kind = ${fmt(constraints.leftKind)};
constraint_left_index = ${fmt(constraints.leftIndex)};
constraint_left_value = ${fmt(constraints.leftValue)};
constraint_left_candidate_value = ${fmt2d(constraints.leftCandidateValue)};
constraint_right_kind = ${fmt(constraints.rightKind)};
constraint_right_index = ${fmt(constraints.rightIndex)};
constraint_right_value = ${fmt(constraints.rightValue)};
constraint_right_candidate_value = ${fmt2d(constraints.rightCandidateValue)};

n_terms = ${optimization.metric.length};
term_metric = ${fmt(optimization.metric)};
term_weight = ${fmt(optimization.weight)};
term_direction = ${fmt(optimization.direction)};
term_has_normalize = ${fmt(optimization.hasNormalize)};
term_min = ${fmt(optimization.min)};
term_max = ${fmt(optimization.max)};
term_clamp = ${fmt(optimization.clamp)};

n_pool_slots = ${placement.poolModel.length};
candidate_model = ${fmt(placement.candidateModel)};
candidate_pool = ${fmt(placement.candidatePool)};
pool_model = ${fmt(placement.poolModel)};
pool_latency = ${fmt2d(placement.poolLatency)};
n_events = ${placement.eventModel.length};
event_model = ${fmt(placement.eventModel)};
event_pool = ${fmt(placement.eventPool)};
event_latency = ${fmt2d(placement.eventLatency)};
task_invocation = ${fmt(placement.taskInvocation)};
n_capacity_checks = ${placement.capacityPool.length};
capacity_pool = ${fmt(placement.capacityPool)};
capacity_scope = ${fmt(placement.capacityScope)};
capacity_limit = ${fmt(placement.capacityLimit)};
capacity_demand = ${fmt2d(placement.capacityDemand)};
n_transitions = ${placement.transitionModel.length};
transition_model = ${fmt(placement.transitionModel)};
transition_from_kind = ${fmt(placement.transitionFromKind)};
transition_from = ${fmt(placement.transitionFrom)};
transition_to_kind = ${fmt(placement.transitionToKind)};
transition_to = ${fmt(placement.transitionTo)};
transition_maximum = ${fmt(placement.transitionMaximum)};
transition_hard = ${fmt(placement.transitionHard)};
transition_penalty = ${fmt(placement.transitionPenalty)};
placement_penalty_bound = ${placement.penaltyBound};
global_metric_model = ${fmt(placement.globalMetricModel)};
placement_time_bound = ${placement.timeBound};
n_scenarios = ${placement.scenarioModel.length};
scenario_model = ${fmt(placement.scenarioModel)};
scenario_probability = ${fmt(placement.scenarioProbability)};
scenario_ready = ${fmt(placement.scenarioReady)};
n_activities = ${placement.activityModel.length};
max_activity_predecessors = ${placement.maxPreds};
activity_model = ${fmt(placement.activityModel)};
activity_task = ${fmt(placement.activityTask)};
activity_exec_metric = ${fmt(placement.activityExecMetric)};
activity_predecessor_count = ${fmt(placement.activityPredCount)};
activity_predecessor_kind = ${fmt2d(placement.activityPredKind)};
activity_predecessor_source = ${fmt2d(placement.activityPredSource)};
activity_predecessor_ready = ${fmt2d(placement.activityPredReady)};
n_ready_values = ${placement.readyKind.length};
max_ready_children = ${placement.maxReadyChildren};
ready_kind = ${fmt(placement.readyKind)};
ready_source = ${fmt(placement.readySource)};
ready_base = ${fmt(placement.readyBase)};
ready_child_count = ${fmt(placement.readyChildCount)};
ready_children = ${fmt2d(placement.readyChildren)};
`;
    return { dznContent: content.trimStart(), metrics, tasks, candidates: candidates.map((candidate) => candidate.ref) };
  }

  private requireProblem(problem: any): void {
    if (!problem || problem.apiVersion !== 'bim/v1' || problem.kind !== 'BindingProblem') {
      throw new Error('MiniZinc accepts only a canonical bim/v1 BindingProblem');
    }
    if (!problem.metadata || typeof problem.metadata !== 'object' || !problem.spec || typeof problem.spec !== 'object') {
      throw new Error('BindingProblem envelope requires metadata and spec');
    }
    const rootKeys = Object.keys(problem);
    if (rootKeys.some((key) => !['apiVersion', 'kind', 'metadata', 'spec'].includes(key))) {
      throw new Error('BindingProblem contains source or unknown top-level fields');
    }
    const specKeys = Object.keys(problem.spec);
    const allowedSpec = ['profile', 'dialects', 'instance', 'application', 'candidates', 'eligibility',
      'routing', 'constraints', 'placement', 'optimization', 'extensions', 'sourceMap'];
    if (specKeys.some((key) => !allowedSpec.includes(key))) {
      throw new Error('BindingProblem.spec contains source or unknown fields');
    }
    for (const key of allowedSpec) {
      if (problem.spec[key] === undefined) throw new Error(`BindingProblem.spec.${key} is required`);
    }
    const profile = problem.spec.profile;
    if (!profile || profile.namespace !== 'bim.builtin' || profile.id !== 'qos-binding/v1'
        || profile.output?.apiVersion !== 'bim/v1' || profile.output?.kind !== 'BindingProblem'
        || !this.isDigest(profile.output?.schemaDigest) || profile.deterministic !== true
        || typeof profile.version !== 'string' || !this.isDigest(profile.digest)
        || typeof profile.adapter?.id !== 'string' || typeof profile.adapter?.version !== 'string'
        || !this.isDigest(profile.adapter?.digest)) {
      throw new Error('BindingProblem.spec.profile must describe deterministic qos-binding/v1 over bim/v1');
    }
    if (!Array.isArray(problem.spec.dialects) || problem.spec.dialects.length === 0) {
      throw new Error('BindingProblem.spec.dialects must pin at least one Dialect');
    }
    for (const dialect of problem.spec.dialects) {
      if (!dialect || typeof dialect.namespace !== 'string' || typeof dialect.id !== 'string'
          || typeof dialect.version !== 'string' || !this.isDigest(dialect.digest)
          || !Array.isArray(dialect.irFeatures) || typeof dialect.adapter?.id !== 'string'
          || typeof dialect.adapter?.version !== 'string' || !this.isDigest(dialect.adapter?.digest)) {
        throw new Error('BindingProblem.spec.dialects contains an invalid pinned descriptor');
      }
    }
  }

  private validateMetric(id: string, metric: any): void {
    if (!metric || !['invocation', 'selectedCandidate'].includes(metric.scope)) {
      throw new Error(`MiniZinc mode does not support metric scope '${String(metric?.scope)}' (metric '${id}')`);
    }
    if (!Number.isFinite(Number(metric.neutral))) {
      throw new Error(`Metric '${id}' requires a finite materialized neutral`);
    }
    const aggregation = metric.aggregation;
    if (!aggregation || typeof aggregation !== 'object' || Array.isArray(aggregation)) {
      throw new Error(`Metric '${id}' requires materialized aggregation IR`);
    }
    for (const key of ['sequence', 'parallel', 'exclusive', 'repeat', 'selection']) {
      if (aggregation[key] === undefined) throw new Error(`Metric '${id}' is missing aggregation.${key}`);
      if (typeof aggregation[key] !== 'string') throw new Error(`MiniZinc does not support aggregation expressions (${id}.${key})`);
    }
  }

  private flattenCandidates(catalogs: any, applicationResource: string,
      applicationMetrics: Set<string>, encodedMetrics: Set<string>): CandidateEntry[] {
    const values: CandidateEntry[] = [];
    for (const [catalogId, wrapper] of Object.entries(catalogs || {}) as Array<[string, any]>) {
      if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)
          || Object.keys(wrapper).some((key) => !['providers', 'metricBindings', 'candidates'].includes(key))
          || !wrapper.providers || !wrapper.metricBindings || !wrapper.candidates) {
        throw new Error(`Candidate catalog '${catalogId}' must contain providers, metricBindings and candidates`);
      }
      const canonicalByAlias = new Map<string, string>();
      const seenMetrics = new Set<string>();
      for (const [alias, metricRef] of Object.entries(wrapper.metricBindings) as Array<[string, any]>) {
        this.requireRef(metricRef, `candidate catalog ${catalogId}.metricBindings.${alias}`);
        if (metricRef.resource !== applicationResource || !applicationMetrics.has(metricRef.id)) {
          throw new Error(`Candidate catalog '${catalogId}' binds alias '${alias}' to an unknown metric`);
        }
        if (seenMetrics.has(metricRef.id)) throw new Error(`Candidate catalog '${catalogId}' binds metric '${metricRef.id}' more than once`);
        seenMetrics.add(metricRef.id);
        canonicalByAlias.set(alias, metricRef.id);
      }
      for (const [candidateId, candidate] of Object.entries(wrapper.candidates) as Array<[string, any]>) {
        this.requireRef(candidate?.ref, `candidate ${catalogId}:${candidateId}`);
        if (candidate.ref.resource !== catalogId || candidate.ref.id !== candidateId) {
          throw new Error(`Candidate map key disagrees with ref '${catalogId}:${candidateId}'`);
        }
        let provider: CandidateRef | undefined;
        if (candidate.provider !== undefined) {
          this.requireRef(candidate.provider, `candidate ${catalogId}:${candidateId}.provider`);
          if (candidate.provider.resource !== catalogId || !wrapper.providers[candidate.provider.id]) {
            throw new Error(`Candidate '${catalogId}:${candidateId}' references an unknown provider`);
          }
          provider = candidate.provider;
        }
        const canonicalMetrics: Record<string, number> = {};
        for (const [alias, raw] of Object.entries(candidate.metrics || {})) {
          const metricId = canonicalByAlias.get(alias);
          if (!metricId) throw new Error(`Candidate '${catalogId}:${candidateId}' uses unknown metric alias '${alias}'`);
          const numeric = Number(raw);
          if (!Number.isFinite(numeric)) throw new Error(`Candidate '${catalogId}:${candidateId}' metric '${alias}' is not finite`);
          if (encodedMetrics.has(metricId)) canonicalMetrics[metricId] = numeric;
        }
        values.push({
          ref: { resource: catalogId, id: candidateId }, metrics: canonicalMetrics, provider,
          properties: candidate.properties || {},
        });
      }
    }
    return values;
  }

  private constraints(items: any[], metricIndex: Map<string, number>, taskIndex: Map<string, number>,
      candidates: CandidateEntry[]) {
    const result = {
      operator: [] as number[], leftKind: [] as number[], leftIndex: [] as number[], leftValue: [] as number[],
      leftCandidateValue: [] as number[][], rightKind: [] as number[], rightIndex: [] as number[],
      rightValue: [] as number[], rightCandidateValue: [] as number[][],
    };
    const opCode: Record<string, number> = { lte: 1, gte: 2, eq: 3, lt: 4, gt: 5, ne: 6 };
    for (const constraint of items) {
      this.requireRef(constraint?.ref, 'constraint.ref');
      if (constraint.enforcement !== 'hard') throw new Error(`MiniZinc does not support soft constraint '${constraint.ref.id}'`);
      if (constraint.penalty !== undefined) throw new Error(`Hard constraint '${constraint.ref.id}' cannot have penalty`);
      if (constraint.when?.kind !== 'literal' || constraint.when.value !== true) {
        throw new Error(`MiniZinc does not support conditional constraint '${constraint.ref.id}'`);
      }
      const assertion = constraint.assert;
      if (!assertion || assertion.kind !== 'compare' || !opCode[assertion.op]) {
        throw new Error(`MiniZinc supports only hard comparisons (constraint '${constraint.ref.id}')`);
      }
      const left = this.constraintOperand(assertion.left, metricIndex, taskIndex, candidates, constraint.ref.id);
      const right = this.constraintOperand(assertion.right, metricIndex, taskIndex, candidates, constraint.ref.id);
      if (left.type !== right.type || (!['number', 'string'].includes(left.type)
          && !['eq', 'ne'].includes(assertion.op))) {
        throw new Error(`Constraint '${constraint.ref.id}' compares incompatible operand types`);
      }
      if (left.type === 'string' || left.type === 'ref') {
        const values = [...left.rawValues, ...right.rawValues].map(String);
        const ordered = [...new Set(values)].sort((a, b) => {
          const aa = [...a], bb = [...b];
          for (let index = 0; index < Math.min(aa.length, bb.length); index += 1) {
            const difference = aa[index].codePointAt(0)! - bb[index].codePointAt(0)!;
            if (difference) return difference;
          }
          return aa.length - bb.length;
        });
        const code = new Map(ordered.map((value, index) => [value, index + 1]));
        left.values = left.rawValues.map((value) => code.get(String(value))!);
        right.values = right.rawValues.map((value) => code.get(String(value))!);
        left.value = code.get(String(left.rawValue)) || 0;
        right.value = code.get(String(right.rawValue)) || 0;
      }
      result.operator.push(opCode[assertion.op]);
      result.leftKind.push(left.kind); result.leftIndex.push(left.index); result.leftValue.push(left.value);
      result.leftCandidateValue.push(left.values);
      result.rightKind.push(right.kind); result.rightIndex.push(right.index); result.rightValue.push(right.value);
      result.rightCandidateValue.push(right.values);
    }
    return result;
  }

  private constraintOperand(node: any, metricIndex: Map<string, number>, taskIndex: Map<string, number>,
      candidates: CandidateEntry[], constraintId: string): {
        kind: number; index: number; value: number; values: number[]; type: string;
        rawValue: unknown; rawValues: unknown[];
      } {
    if (node?.kind === 'literal') {
      const type = typeof node.value;
      if (!['number', 'string', 'boolean'].includes(type) || (type === 'number' && !Number.isFinite(node.value))) {
        throw new Error(`Constraint '${constraintId}' has an unsupported literal`);
      }
      const numeric = type === 'number' ? Number(node.value) : type === 'boolean' ? Number(node.value) : 0;
      return { kind: 3, index: 1, value: numeric, values: candidates.map(() => numeric), type,
        rawValue: node.value, rawValues: candidates.map(() => node.value) };
    }
    const segments = node?.kind === 'path' && Array.isArray(node.segments) ? node.segments : [];
    if (segments.length === 2 && segments[0] === 'metrics' && metricIndex.has(segments[1])) {
      return { kind: 1, index: metricIndex.get(segments[1])!, value: 0, values: candidates.map(() => 0),
        type: 'number', rawValue: 0, rawValues: [] };
    }
    if (segments[0] !== 'tasks' || !taskIndex.has(segments[1])) {
      throw new Error(`Constraint '${constraintId}' uses an unsupported path`);
    }
    const task = taskIndex.get(segments[1])!;
    let values: unknown[];
    let type = 'string';
    if (segments.length === 4 && segments[2] === 'metrics' && metricIndex.has(segments[3])) {
      values = candidates.map((candidate) => candidate.metrics[segments[3]]);
      type = 'number';
    } else if (segments.length === 3 && segments[2] === 'candidate') {
      values = candidates.map((candidate) => this.refKey(candidate.ref)); type = 'ref';
    } else if (segments.length === 4 && segments[2] === 'candidate' && ['resource', 'id'].includes(segments[3])) {
      values = candidates.map((candidate) => candidate.ref[segments[3] as 'resource' | 'id']);
    } else if (segments.length === 3 && segments[2] === 'provider') {
      if (candidates.some((candidate) => !candidate.provider)) throw new Error(`Constraint '${constraintId}' reads a missing provider`);
      values = candidates.map((candidate) => this.refKey(candidate.provider!)); type = 'ref';
    } else if (segments.length === 4 && segments[2] === 'provider' && ['resource', 'id'].includes(segments[3])) {
      if (candidates.some((candidate) => !candidate.provider)) throw new Error(`Constraint '${constraintId}' reads a missing provider`);
      values = candidates.map((candidate) => candidate.provider![segments[3] as 'resource' | 'id']);
    } else if (segments.length >= 4 && segments[2] === 'properties') {
      values = candidates.map((candidate) => segments.slice(3).reduce((value: any, part: string) => value?.[part], candidate.properties));
      type = typeof values[0];
      if (values.some((value) => typeof value !== type) || !['number', 'string', 'boolean'].includes(type)) {
        throw new Error(`Constraint '${constraintId}' reads an unsupported candidate property`);
      }
    } else {
      throw new Error(`Constraint '${constraintId}' uses an unsupported tasks path`);
    }
    if (values.some((value) => type === 'number' && !Number.isFinite(Number(value)))) {
      throw new Error(`Constraint '${constraintId}' reads a non-finite candidate value`);
    }
    const numeric = values.map((value) => type === 'number' ? Number(value) : type === 'boolean' ? Number(value) : 0);
    return { kind: 2, index: task, value: 0, values: numeric, type, rawValue: values[0], rawValues: values };
  }

  private optimization(optimization: any, applicationResource: string, metricIndex: Map<string, number>) {
    if (!optimization || optimization.mode !== 'weighted') {
      throw new Error('MiniZinc exact-weighted mode requires optimization.mode weighted');
    }
    if (optimization.type !== 'MONO') {
      throw new Error('MiniZinc exact-weighted mode supports objective type MONO only');
    }
    if (!Array.isArray(optimization.penalties)) {
      throw new Error('Weighted optimization penalties must be materialized');
    }
    if (!Array.isArray(optimization.terms) || optimization.terms.length === 0) {
      throw new Error('Weighted optimization requires at least one term');
    }
    const result = {
      metric: [] as number[], weight: [] as number[], direction: [] as number[],
      hasNormalize: [] as boolean[], min: [] as number[], max: [] as number[], clamp: [] as boolean[],
      penaltyWeight: new Map<string, number>(),
    };
    for (const term of optimization.terms) {
      this.requireRef(term.metric, 'optimization term.metric');
      if (term.metric.resource !== applicationResource || !metricIndex.has(term.metric.id)) {
        throw new Error(`Optimization term references unknown metric '${term.metric.resource}:${term.metric.id}'`);
      }
      const weight = Number(term.weight);
      if (!(weight > 0) || !Number.isFinite(weight)) throw new Error('Optimization weights must be finite and positive');
      if (!['minimize', 'maximize'].includes(term.direction)) throw new Error('Optimization direction is invalid');
      const normalize = term.normalize;
      if (normalize !== undefined && (!Number.isFinite(Number(normalize.min))
          || !Number.isFinite(Number(normalize.max)) || Number(normalize.max) <= Number(normalize.min)
          || Math.abs(Number(normalize.min)) > 1e100 || Math.abs(Number(normalize.max)) > 1e100
          || typeof normalize.clamp !== 'boolean')) {
        throw new Error('Optimization normalization bounds are invalid');
      }
      result.metric.push(metricIndex.get(term.metric.id)!);
      result.weight.push(weight);
      result.direction.push(term.direction === 'minimize' ? 1 : -1);
      result.hasNormalize.push(normalize !== undefined);
      result.min.push(normalize === undefined ? 0 : Number(normalize.min));
      result.max.push(normalize === undefined ? 1 : Number(normalize.max));
      result.clamp.push(normalize === undefined ? false : normalize.clamp);
    }
    const weightTotal = result.weight.reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(weightTotal - 1) > 1e-12) {
      throw new Error('Weighted optimization term weights must be normalized to 1 in canonical IR');
    }
    for (const item of optimization.penalties) {
      this.requireRef(item?.constraint, 'optimization penalty.constraint');
      const weight = Number(item.weight);
      if (!(weight > 0) || !Number.isFinite(weight)) throw new Error('Optimization penalty weights must be finite and positive');
      result.penaltyWeight.set(this.refKey(item.constraint), weight);
    }
    return result;
  }

  private selectionAggregationCode(value: string, metric: string): number {
    const codes: Record<string, number> = { sum: 1, min: 3, max: 4 };
    if (!codes[value]) throw new Error(`MiniZinc does not support aggregation '${value}' at ${metric}.selection`);
    return codes[value];
  }

  private aggregationCode(value: string, place: string, metric: string): number {
    const general: Record<string, number> = { sum: 1, min: 3, max: 4 };
    if (place === 'sequence' || place === 'parallel') {
      if (general[value]) return general[value];
    } else if (place === 'exclusive') {
      const exclusive: Record<string, number> = { weightedSum: 5, min: 3, max: 4 };
      if (exclusive[value]) return exclusive[value];
    } else if (place === 'repeat') {
      const repeat: Record<string, number> = { scale: 6, identity: 8 };
      if (repeat[value]) return repeat[value];
    }
    throw new Error(`MiniZinc does not support aggregation '${value}' at ${metric}.${place}`);
  }

  private workflowBound(node: any, pointer: string, metric: any, application: any,
      sourceMap: any, routing: Map<string, number>, candidateBound: number,
      nodeBounds: number[]): number {
    const record = (value: number): number => { nodeBounds.push(value); return value; };
    if (node.kind === 'empty') return record(Math.abs(Number(metric.neutral)));
    if (node.kind === 'task') return record(application.tasks[node.task.id]?.kind === 'local'
      ? Math.abs(Number(metric.neutral)) : candidateBound);
    if (node.kind === 'sequence' || node.kind === 'parallel') {
      const children = node.kind === 'sequence' ? node.steps : node.branches;
      const field = node.kind === 'sequence' ? 'steps' : 'branches';
      const values = children.map((child: any, index: number) => this.workflowBound(
        child, `${pointer}/${field}/${index}`, metric, application, sourceMap, routing,
        candidateBound, nodeBounds));
      const operation = metric.aggregation[node.kind];
      return record(operation === 'sum'
        ? values.reduce((sum: number, value: number) => sum + value, 0)
        : Math.max(0, ...values));
    }
    if (node.kind === 'exclusive') {
      const values = node.branches.map((branch: any, index: number) => this.workflowBound(
        branch.flow, `${pointer}/branches/${index}/flow`, metric, application, sourceMap,
        routing, candidateBound, nodeBounds));
      if (metric.aggregation.exclusive === 'weightedSum') {
        return record(node.branches.reduce((sum: number, branch: any, index: number) =>
          sum + Math.abs(Number(routing.get(this.refKey(this.workflowBranchRef(
            application.resource, sourceMap, pointer, index, branch.id))))) * values[index], 0));
      }
      return record(Math.max(0, ...values));
    }
    if (node.kind === 'repeat') {
      const body = this.workflowBound(node.body, `${pointer}/body`, metric, application,
        sourceMap, routing, candidateBound, nodeBounds);
      return record(metric.aggregation.repeat === 'identity' ? body : body * Number(node.count));
    }
    throw new Error(`Unsupported workflow node '${String(node.kind)}' while bounding MiniZinc floats`);
  }

  private requireRef(value: any, where: string): asserts value is CandidateRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.resource !== 'string' || !value.resource
        || typeof value.id !== 'string' || !value.id
        || Object.keys(value).some((key) => !['resource', 'id'].includes(key))) {
      throw new Error(`${where} must be a closed {resource,id} reference`);
    }
  }

  private routing(value: any): Map<string, number> {
    if (!Array.isArray(value)) throw new Error('BindingProblem.spec.routing must be a canonical array');
    const result = new Map<string, number>();
    let previous = '';
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || Object.keys(entry).some((key) => !['target', 'probability'].includes(key))) {
        throw new Error('Routing entries must contain only target and probability');
      }
      this.requireRef(entry.target, 'routing.target');
      const key = this.refKey(entry.target);
      const probability = Number(entry.probability);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error('Routing probability must be finite and in [0,1]');
      }
      if (result.has(key)) throw new Error(`Duplicate routing target '${entry.target.resource}:${entry.target.id}'`);
      if (previous && previous >= key) throw new Error('Routing entries are not canonically ordered');
      previous = key;
      result.set(key, probability);
    }
    return result;
  }

  private workflowBranchRef(applicationResource: string, sourceMap: any,
      pointer: string, index: number, id: string): CandidateRef {
    const branch = sourceMap?.[`${pointer}/branches/${index}`];
    const element = sourceMap?.[`/spec/application/workflow/elements/${this.escapePointer(id)}`];
    const resource = typeof branch?.resource === 'string' ? branch.resource
      : typeof element?.resource === 'string' ? element.resource : applicationResource;
    return { resource, id };
  }

  private escapePointer(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }

  private isDigest(value: unknown): value is string {
    return typeof value === 'string' && /^sha256-[0-9a-f]{64}$/.test(value);
  }

  private refKey(ref: CandidateRef): string { return `${ref.resource}\u0000${ref.id}`; }
}
