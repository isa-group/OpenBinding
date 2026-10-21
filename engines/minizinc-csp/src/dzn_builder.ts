import { fmt, fmt2d, fmt2dF, fmtF, fmtFloat } from './encoders/format';
import { relaxLiteral, widenBound } from './numeric';
import { buildPlacementEncoding } from './placement';

export interface CandidateRef { resource: string; id: string }

export interface DznBuildResult {
  dznContent: string;
  features: string[];
  metrics: string[];
  tasks: string[];
  candidates: CandidateRef[];
  /** Lowering facts that explain how multiplicative features were encoded. */
  encoding: {
    productConstraints: 'log' | 'real';
    flatProducts: number;
    logSpaceMetrics: string[];
    logSpaceAtoms: number;
    realSpaceProductAtoms: number;
    softConstraints: number;
    /** Capacity checks posted as native bin-packing columns / total capacity checks. */
    binPackingColumns: number;
    binPackingChecks: number;
    capacityChecks: number;
    /** Comparison literals moved by the numeric slack in the feasible direction (see numeric.ts). */
    relaxedLiterals: number;
  };
}

type CandidateEntry = {
  ref: CandidateRef;
  features: Record<string, number>;
  metrics: Record<string, number>;
  provider?: CandidateRef;
  properties: Record<string, string | number | boolean | null>;
};

type WorkflowRow = { kind: number; task: number; children: number[]; weights: number[]; repeat: number; source: any; pointer: string };

type FlatProduct = {
  node: number;
  metric: number;
  constant: number;
  logConstant: number;
  exponents: number[];
};

type Operand = {
  kind: number; index: number; value: number; values: number[]; type: string;
  rawValue: unknown; rawValues: unknown[];
};

const AGGREGATION_CODES: Record<string, Record<string, number>> = {
  sequence: { sum: 1, product: 2, min: 3, max: 4 },
  parallel: { sum: 1, product: 2, min: 3, max: 4 },
  exclusive: { weightedSum: 5, weightedProduct: 7, min: 3, max: 4 },
  repeat: { scale: 6, power: 9, identity: 8 },
  selection: { sum: 1, product: 2, min: 3, max: 4 },
};
const PRODUCT_FAMILY: Record<string, Set<string>> = {
  sequence: new Set(['product']),
  parallel: new Set(['product']),
  exclusive: new Set(['weightedProduct']),
  repeat: new Set(['power', 'identity']),
};
/** Gap (in log units) separating "a zero factor was selected" from every all-positive selection. */
const ZERO_GAP = 10;

/** Strict lowering for the exact subset declared by the minizinc-csp manifest. */
export class DznBuilder {
  build(problem: any, options: any = {}, executionOptimization?: any): DznBuildResult {
    this.requireProblem(problem);
    const productConstraints: 'log' | 'real' = options?.product_constraints === 'real' ? 'real' : 'log';
    const spec = problem.spec;
    const application = spec.application;
    const taskEntries = Object.entries(application.tasks || {}) as Array<[string, any]>;
    if (taskEntries.some(([, task]) => !task || !['service', 'local'].includes(task.kind))) {
      throw new Error('BindingProblem.application.tasks contains an unsupported task kind');
    }
    const tasks = taskEntries.filter(([, task]) => task?.kind === 'service').map(([id]) => id);
    if (tasks.length > 10000) throw new Error('MiniZinc mode limit maxTasks=10000 exceeded');

    const appFeatures = application.features || application.metrics || {};
    const appReqFeatures = application.requiredFeatures || application.requiredMetrics;
    if (!Array.isArray(appReqFeatures)) {
      throw new Error('BindingProblem.application.requiredFeatures must be materialized');
    }
    const requiredMetrics = appReqFeatures as unknown[];
    if (new Set(requiredMetrics).size !== requiredMetrics.length
        || requiredMetrics.some((id) => typeof id !== 'string' || !appFeatures?.[id])) {
      throw new Error('BindingProblem.application.requiredFeatures must contain unique known feature ids');
    }
    const taskReq = application.taskRequiredFeatures || application.taskRequiredMetrics || {};
    const localMetrics = Object.values(taskReq).flatMap((value: any) =>
      Array.isArray(value) ? value : []).filter((id: any) => typeof id === 'string');
    const encodedMetricIds = [...new Set([...requiredMetrics as string[], ...localMetrics])];
    const metricEntries = encodedMetricIds.map((id) => [id, appFeatures[id]] as [string, any]);
    const metrics = metricEntries.map(([id]) => id);
    if (metrics.length === 0) throw new Error('MiniZinc requires at least one feature');
    const activeContexts = this.activeContexts(application.workflow);
    for (const [id, metric] of metricEntries) this.validateMetric(id, metric, activeContexts);
    const routing = this.routing(spec.routing);
    const usedRouting = new Set<string>();

    const candidates = this.flattenCandidates(spec.candidates || {}, application.resource,
      new Set(Object.keys(appFeatures)), new Set(metrics));
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
    // Value ordering: list each task's candidates from the most to the least promising
    // (estimated weighted loss of the candidate's own values), so that the solver's
    // in-order value selection reaches good incumbents early.
    this.orderEligibility(eligibility, candidates, metrics, spec.optimization, executionOptimization);
    const maxCandidatesPerTask = tasks.length === 0
      ? 1 : Math.max(...eligibility.map((values) => values.length));
    const paddedEligibility = eligibility.map((values) => [
      ...values,
      ...Array(maxCandidatesPerTask - values.length).fill(values[0]),
    ]);
    const candidateTaskCount = new Map<number, number>();
    for (const values of eligibility) {
      for (const candidate of values) candidateTaskCount.set(candidate, (candidateTaskCount.get(candidate) || 0) + 1);
    }
    const selectionDisjoint = [...candidateTaskCount.values()].every((count) => count <= 1);

    const candidateMetric = candidates.map((candidate) => metrics.map((metric) => {
      const value = Number(candidate.features?.[metric] ?? candidate.metrics?.[metric]);
      if (!Number.isFinite(value)) throw new Error(`Candidate '${candidate.ref.resource}:${candidate.ref.id}' is missing finite feature '${metric}'`);
      return value;
    }));
    const nodes: WorkflowRow[] = [];
    const visit = (node: any, pointer: string): number => {
      if (!node || typeof node !== 'object') throw new Error('Workflow node must be an object');
      const index = nodes.length + 1;
      const row: WorkflowRow = { kind: 0, task: 0, children: [], weights: [], repeat: 0, source: node, pointer };
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
        const count = Number(node.expectedCount !== undefined ? node.expectedCount : node.count);
        if (!Number.isFinite(count) || count < 0) throw new Error('repeat count must be a finite non-negative number');
        if (node.expectedCount === undefined && !Number.isInteger(count)) throw new Error('repeat.count must be a non-negative integer');
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

    // ---- Multiplicative features: flatten maximal pure-product subtrees.
    const flats: FlatProduct[] = [];
    const nodeFlat: number[][] = nodes.map(() => metrics.map(() => 0));
    const eligibleAbsMax = (task: number, metricPosition: number): number =>
      Math.max(0, ...eligibility[task - 1].map((candidate) => Math.abs(candidateMetric[candidate - 1][metricPosition])));
    metricEntries.forEach(([metricId, metric], metricPosition) => {
      if (metric.scope !== 'invocation') {
        // Selected-candidate features never read the workflow tree: mark every node unused.
        nodes.forEach((_row, index) => { nodeFlat[index][metricPosition] = -1; });
        return;
      }
      const pure = new Map<number, boolean>();
      const isPure = (nodeIndex: number): boolean => {
        const cached = pure.get(nodeIndex);
        if (cached !== undefined) return cached;
        const row = nodes[nodeIndex - 1];
        let result: boolean;
        if (row.kind === 1 || row.kind === 2) result = true;
        else if (row.kind === 3) result = metric.aggregation.sequence === 'product' && row.children.every(isPure);
        else if (row.kind === 4) result = metric.aggregation.parallel === 'product' && row.children.every(isPure);
        else if (row.kind === 5) result = metric.aggregation.exclusive === 'weightedProduct' && row.children.every(isPure);
        else result = (metric.aggregation.repeat === 'power' || metric.aggregation.repeat === 'identity') && row.children.every(isPure);
        pure.set(nodeIndex, result);
        return result;
      };
      const markInside = (nodeIndex: number): void => {
        for (const child of nodes[nodeIndex - 1].children) {
          nodeFlat[child - 1][metricPosition] = -1;
          markInside(child);
        }
      };
      const collect = (nodeIndex: number, multiplier: number, flat: FlatProduct): void => {
        const row = nodes[nodeIndex - 1];
        if (row.kind === 1) {
          const neutral = Number(metric.neutral);
          if (neutral < 0 && !Number.isInteger(multiplier)) {
            throw new Error(`Feature '${metricId}' raises a negative neutral to a fractional exponent`);
          }
          flat.constant *= neutral ** multiplier;
        } else if (row.kind === 2) {
          flat.exponents[row.task - 1] += multiplier;
        } else if (row.kind === 5) {
          row.children.forEach((child, index) => collect(child, multiplier * row.weights[index], flat));
        } else if (row.kind === 6) {
          const factor = metric.aggregation.repeat === 'identity' ? 1 : row.repeat;
          collect(row.children[0], multiplier * factor, flat);
        } else {
          for (const child of row.children) collect(child, multiplier, flat);
        }
      };
      const place = (nodeIndex: number): void => {
        const row = nodes[nodeIndex - 1];
        if (row.kind >= 3 && isPure(nodeIndex)) {
          const flat: FlatProduct = {
            node: nodeIndex, metric: metricPosition + 1, constant: 1, logConstant: 0,
            exponents: tasks.map(() => 0),
          };
          collect(nodeIndex, 1, flat);
          if (!Number.isFinite(flat.constant)) throw new Error(`Feature '${metricId}' has a non-finite neutral product`);
          for (let task = 1; task <= tasks.length; task += 1) {
            const exponent = flat.exponents[task - 1];
            if (exponent === 0 || Number.isInteger(exponent)) continue;
            if (eligibility[task - 1].some((candidate) => candidateMetric[candidate - 1][metricPosition] < 0)) {
              throw new Error(`Feature '${metricId}' raises a negative candidate value of task '${tasks[task - 1]}' to a fractional exponent`);
            }
          }
          flats.push(flat);
          nodeFlat[nodeIndex - 1][metricPosition] = flats.length;
          markInside(nodeIndex);
          return;
        }
        if (row.kind === 5 && metric.aggregation.exclusive === 'weightedProduct') {
          throw new Error(`Feature '${metricId}' applies exclusive.weightedProduct to a branch that is not a pure product`);
        }
        if (row.kind === 6 && metric.aggregation.repeat === 'power' && !Number.isInteger(row.repeat)) {
          throw new Error(`Feature '${metricId}' applies repeat.power with a fractional count to a body that is not a pure product`);
        }
        for (const child of row.children) place(child);
      };
      place(root);
    });

    // ---- Bounds on |value| for every node and metric (0 for nodes inside flat products).
    let nodeMetricBound = 1;
    const metricBounds = new Map<string, number>();
    const nodeBound = (nodeIndex: number, metricPosition: number, metric: any, candidateBound: number, all: number[]): number => {
      const row = nodes[nodeIndex - 1];
      const flat = nodeFlat[nodeIndex - 1][metricPosition];
      let bound: number;
      if (flat < 0) {
        bound = 0;
        for (const child of row.children) nodeBound(child, metricPosition, metric, candidateBound, all);
      } else if (flat > 0) {
        const descriptor = flats[flat - 1];
        bound = Math.abs(descriptor.constant);
        descriptor.exponents.forEach((exponent, task) => {
          if (exponent !== 0) bound *= eligibleAbsMax(task + 1, metricPosition) ** exponent;
        });
        for (const child of row.children) nodeBound(child, metricPosition, metric, candidateBound, all);
      } else if (row.kind === 1) bound = Math.abs(Number(metric.neutral));
      else if (row.kind === 2) bound = eligibleAbsMax(row.task, metricPosition);
      else if (row.kind === 3 || row.kind === 4) {
        const values = row.children.map((child) => nodeBound(child, metricPosition, metric, candidateBound, all));
        const operation = row.kind === 3 ? metric.aggregation.sequence : metric.aggregation.parallel;
        bound = operation === 'sum' ? values.reduce((sum, value) => sum + value, 0)
          : operation === 'product' ? values.reduce((product, value) => product * value, 1)
            : Math.max(0, ...values);
      } else if (row.kind === 5) {
        const values = row.children.map((child) => nodeBound(child, metricPosition, metric, candidateBound, all));
        const operation = metric.aggregation.exclusive;
        bound = operation === 'weightedSum'
          ? values.reduce((sum, value, index) => sum + Math.abs(row.weights[index]) * value, 0)
          : operation === 'weightedProduct'
            ? values.reduce((product, value, index) => product * (value ** row.weights[index]), 1)
            : Math.max(0, ...values);
      } else {
        const body = nodeBound(row.children[0], metricPosition, metric, candidateBound, all);
        const operation = metric.aggregation.repeat;
        bound = operation === 'identity' ? body : operation === 'scale' ? body * row.repeat : body ** row.repeat;
      }
      all.push(bound);
      return bound;
    };
    const selectionBound = (metricPosition: number, metric: any): number => {
      const operation = metric.aggregation.selection;
      const perTask = tasks.map((_task, index) => eligibleAbsMax(index + 1, metricPosition));
      if (operation === 'sum') return perTask.reduce((sum, value) => sum + value, 0);
      if (operation === 'product') return perTask.reduce((product, value) => product * Math.max(1, value), 1);
      return Math.max(0, ...perTask);
    };
    metricEntries.forEach(([metricId, metric], metricPosition) => {
      const candidateBound = Math.max(0, ...candidateMetric.map((row) => Math.abs(row[metricPosition])));
      const all: number[] = [];
      const bound = metric.scope === 'selectedCandidate'
        ? selectionBound(metricPosition, metric)
        : nodeBound(root, metricPosition, metric, candidateBound, all);
      all.push(Math.abs(Number(metric.neutral)));
      if (!Number.isFinite(bound) || bound > 1e100 || all.some((value) => !Number.isFinite(value) || value > 1e100)) {
        throw new Error(`Metric '${metricId}' exceeds the finite MiniZinc numeric domain`);
      }
      metricBounds.set(metricId, Math.max(bound, Math.abs(Number(metric.neutral))));
      for (const value of all) nodeMetricBound = Math.max(nodeMetricBound, value);
    });

    // ---- Log-space availability, zero substitutes and bounds.
    const logAvailable: boolean[] = metrics.map(() => false);
    const zeroLog: number[] = metrics.map(() => 0);
    const logThreshold: number[] = metrics.map(() => 0);
    const hasZero: boolean[] = metrics.map(() => false);
    let logMetricBound = 1;
    metricEntries.forEach(([, metric], metricPosition) => {
      let exponents: number[] | null = null;
      let constant = 1;
      if (metric.scope === 'selectedCandidate') {
        if (metric.aggregation.selection === 'product') exponents = tasks.map(() => 1);
      } else {
        const flat = nodeFlat[root - 1][metricPosition];
        if (flat > 0) { exponents = flats[flat - 1].exponents; constant = flats[flat - 1].constant; }
      }
      if (!exponents || constant <= 0 || !Number.isFinite(constant)) return;
      let magnitude = Math.abs(Math.log(constant));
      let minExponent = Infinity;
      let zero = false;
      let representable = true;
      exponents.forEach((exponent, task) => {
        if (exponent === 0) return;
        minExponent = Math.min(minExponent, exponent);
        let positiveMax = 0;
        for (const candidate of eligibility[task]) {
          const value = candidateMetric[candidate - 1][metricPosition];
          if (value < 0) representable = false;
          else if (value === 0) zero = true;
          else positiveMax = Math.max(positiveMax, Math.abs(Math.log(value)));
        }
        magnitude += exponent * positiveMax;
      });
      if (!representable || !Number.isFinite(magnitude) || !Number.isFinite(minExponent)) return;
      const zeroSubstitute = (2 * magnitude + ZERO_GAP) / minExponent;
      logAvailable[metricPosition] = true;
      hasZero[metricPosition] = zero;
      zeroLog[metricPosition] = -zeroSubstitute;
      logThreshold[metricPosition] = -magnitude - ZERO_GAP / 2;
      const totalExponent = exponents.reduce((sum, exponent) => sum + exponent, 0);
      logMetricBound = Math.max(logMetricBound, Math.abs(Math.log(constant)) + totalExponent * Math.max(magnitude, zeroSubstitute) + 1);
    });
    flats.forEach((flat) => {
      flat.logConstant = logAvailable[flat.metric - 1] && flat.node === root ? Math.log(flat.constant) : 0;
    });
    if (!Number.isFinite(logMetricBound) || logMetricBound > 1e100) {
      throw new Error('Log-space product features exceed the finite MiniZinc numeric domain');
    }

    const maxChildren = Math.max(1, ...nodes.map((node) => node.children.length));
    const nodeChildren = nodes.map((node) => [...node.children, ...Array(maxChildren - node.children.length).fill(1)]);
    const nodeWeights = nodes.map((node) => [...node.weights, ...Array(maxChildren - node.weights.length).fill(0)]);

    const aggregationCodes = metricEntries.map(([metricId, metric]) => [
      this.aggregationCode(metric.aggregation.sequence, 'sequence', metricId),
      this.aggregationCode(metric.aggregation.parallel, 'parallel', metricId),
      this.aggregationCode(metric.aggregation.exclusive, 'exclusive', metricId),
      this.aggregationCode(metric.aggregation.repeat, 'repeat', metricId),
    ]);

    const optimization = this.optimization(spec.optimization, executionOptimization, application.resource, metricIndex);
    const constraints = this.constraints(spec.constraints || [], metricIndex, taskIndex, candidates,
      optimization.penaltyWeight, {
        productConstraints, logAvailable, hasZero, zeroLog, logThreshold, metricPositions: metrics,
      });
    const placement = buildPlacementEncoding(problem, candidates, tasks, metricIndex, optimization.penaltyWeight,
      eligibility, selectionDisjoint);
    let objectiveBound = 0;
    const termBounds: number[] = [];
    optimization.metric.forEach((metricPosition, index) => {
      const metricId = metrics[metricPosition - 1];
      const rawBound = placement.globalMetricModel[metricPosition - 1]
        ? placement.timeBound : metricBounds.get(metricId) || 0;
      termBounds.push(Math.max(1, rawBound));
      let termBound = rawBound;
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
    const softBound = constraints.penalty.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(objectiveBound) || objectiveBound > 1e100 || !Number.isFinite(softBound)) {
      throw new Error('Weighted objective exceeds the finite MiniZinc numeric domain');
    }
    // Margin: the objective is a float expression whose propagated bounds may exceed
    // the mathematical bound by rounding; a slack of 1 keeps attainable values inside.
    objectiveBound = Math.max(1, objectiveBound + placement.penaltyBound + softBound) + 1;

    // Every technical bound printed below is widened (numeric.ts): MiniZinc prints float
    // literals with 16 significant digits and Gecode propagates outward-rounded intervals,
    // so a bound that is tight to the data (the sum of the largest latency of every task,
    // the largest attainable cost) excludes exactly the extreme bindings it was computed
    // from. The explicit `metric_bound` constraints of the model are the case the FlatZinc
    // post-processing cannot repair: they leave the flattener as `float_le` constraints,
    // not as declared domains, and `widenFloatDomains` must not touch those because it
    // cannot tell them from user constraints. The first campaign recorded two false
    // optima of this kind (qfbs_guaranteed_20_011 and _033).
    const technicalMetricBound = (metricId: string, index: number): number =>
      widenBound(Math.max(1, placement.globalMetricModel[index] ? placement.timeBound : metricBounds.get(metricId) || 0));

    const content = `
n_tasks = ${tasks.length};
n_candidates = ${candidates.length};
n_metrics = ${metrics.length};
max_candidates_per_task = ${maxCandidatesPerTask};
n_task_candidates = ${fmt(eligibility.map((values) => values.length))};
task_candidates = ${fmt2d(paddedEligibility)};
candidate_metric = ${fmt2dF(candidateMetric)};
metric_neutral = ${fmtF(metricEntries.map(([, metric]) => Number(metric.neutral)))};
metric_scope = ${fmt(metricEntries.map(([, metric]) => metric.scope === 'selectedCandidate' ? 2 : 1))};
metric_bound = ${fmtF(metrics.map(technicalMetricBound))};
selection_aggregation = ${fmt(metricEntries.map(([metricId, metric]) =>
    this.selectionAggregationCode(metric.aggregation.selection, metricId)))};
node_metric_bound = ${fmtFloat(widenBound(nodeMetricBound))};
objective_bound = ${fmtFloat(widenBound(objectiveBound))};
metric_log_available = ${fmt(logAvailable)};
metric_zero_log = ${fmtF(zeroLog)};
log_metric_bound = ${fmtFloat(widenBound(logMetricBound))};
selection_disjoint = ${selectionDisjoint};

root_node = ${root};
n_nodes = ${nodes.length};
max_children = ${maxChildren};
node_kind = ${fmt(nodes.map((node) => node.kind))};
node_task = ${fmt(nodes.map((node) => node.task))};
node_child_count = ${fmt(nodes.map((node) => node.children.length))};
node_children = ${fmt2d(nodeChildren)};
node_weights = ${fmt2dF(nodeWeights)};
node_repeat_count = ${fmtF(nodes.map((node) => node.repeat))};
aggregation = ${fmt2d(aggregationCodes)};

n_flat = ${flats.length};
flat_metric = ${fmt(flats.map((flat) => flat.metric))};
flat_constant = ${fmtF(flats.map((flat) => flat.constant))};
flat_log_constant = ${fmtF(flats.map((flat) => flat.logConstant))};
flat_exponent = ${this.fmt2dFixed(flats.map((flat) => flat.exponents.map(fmtFloat)), tasks.length)};
node_flat = ${fmt2d(nodeFlat)};

n_constraints = ${constraints.enforcement.length};
constraint_enforcement = ${fmt(constraints.enforcement)};
constraint_penalty = ${fmtF(constraints.penalty)};
n_atoms = ${constraints.operator.length};
atom_constraint = ${fmt(constraints.constraintOf)};
atom_operator = ${fmt(constraints.operator)};
atom_left_kind = ${fmt(constraints.leftKind)};
atom_left_index = ${fmt(constraints.leftIndex)};
atom_left_value = ${fmtF(constraints.leftValue)};
atom_left_candidate_value = ${this.fmt2dFixed(constraints.leftCandidateValue.map((row) => row.map(fmtFloat)), candidates.length)};
atom_right_kind = ${fmt(constraints.rightKind)};
atom_right_index = ${fmt(constraints.rightIndex)};
atom_right_value = ${fmtF(constraints.rightValue)};
atom_right_candidate_value = ${this.fmt2dFixed(constraints.rightCandidateValue.map((row) => row.map(fmtFloat)), candidates.length)};

n_terms = ${optimization.metric.length};
term_metric = ${fmt(optimization.metric)};
term_weight = ${fmtF(optimization.weight)};
term_direction = ${fmt(optimization.direction)};
term_has_normalize = ${fmt(optimization.hasNormalize)};
term_min = ${fmtF(optimization.min)};
term_max = ${fmtF(optimization.max)};
term_clamp = ${fmt(optimization.clamp)};
term_bound = ${fmtF(termBounds.map(widenBound))};

n_pool_slots = ${placement.poolModel.length};
candidate_model = ${fmt(placement.candidateModel)};
candidate_pool = ${fmt(placement.candidatePool)};
pool_model = ${fmt(placement.poolModel)};
pool_latency = ${fmt2dF(placement.poolLatency)};
n_events = ${placement.eventModel.length};
event_model = ${fmt(placement.eventModel)};
event_pool = ${fmt(placement.eventPool)};
event_latency = ${fmt2dF(placement.eventLatency)};
task_invocation = ${fmtF(placement.taskInvocation)};
n_capacity_checks = ${placement.capacityPool.length};
n_capacity_resources = ${placement.capacityResources};
capacity_pool = ${fmt(placement.capacityPool)};
capacity_scope = ${fmt(placement.capacityScope)};
capacity_column = ${fmt(placement.capacityColumn)};
capacity_limit = ${fmtF(placement.capacityLimit.map((limit) => relaxLiteral(limit, 1)))};
candidate_resource_demand = ${this.fmt2dFixed(placement.candidateResourceDemand.map((row) => row.map(fmtFloat)), placement.capacityResources)};
n_bin_columns = ${placement.binWeights.length};
bin_weight = ${this.fmt2dFixed(placement.binWeights.map((row) => row.map(String)), tasks.length)};
bin_capacity = ${this.fmt2dFixed(placement.binCapacities.map((row) => row.map(String)), placement.poolModel.length)};
capacity_in_bin = ${fmt(placement.capacityInBin)};
n_transitions = ${placement.transitionModel.length};
transition_model = ${fmt(placement.transitionModel)};
transition_from_kind = ${fmt(placement.transitionFromKind)};
transition_from = ${fmt(placement.transitionFrom)};
transition_to_kind = ${fmt(placement.transitionToKind)};
transition_to = ${fmt(placement.transitionTo)};
transition_maximum = ${fmtF(placement.transitionMaximum.map((limit) => relaxLiteral(limit, 1)))};
transition_hard = ${fmt(placement.transitionHard)};
transition_penalty = ${fmtF(placement.transitionPenalty)};
placement_penalty_bound = ${fmtFloat(widenBound(placement.penaltyBound))};
global_metric_model = ${fmt(placement.globalMetricModel)};
placement_time_bound = ${fmtFloat(widenBound(placement.timeBound))};
n_scenarios = ${placement.scenarioModel.length};
scenario_model = ${fmt(placement.scenarioModel)};
scenario_probability = ${fmtF(placement.scenarioProbability)};
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
    return {
      dznContent: content.trimStart(), features: metrics, metrics, tasks,
      candidates: candidates.map((candidate) => candidate.ref),
      encoding: {
        productConstraints,
        flatProducts: flats.length,
        logSpaceMetrics: metrics.filter((_metric, index) => logAvailable[index]),
        logSpaceAtoms: constraints.logSpaceAtoms,
        realSpaceProductAtoms: constraints.realSpaceProductAtoms,
        softConstraints: constraints.enforcement.filter((value) => value === 2).length,
        binPackingColumns: placement.binWeights.length,
        binPackingChecks: placement.capacityInBin.filter(Boolean).length,
        capacityChecks: placement.capacityInBin.length,
        relaxedLiterals: constraints.relaxedLiterals,
      },
    };
  }

  private orderEligibility(eligibility: number[][], candidates: CandidateEntry[], metrics: string[],
      optimization: any, execution: any): void {
    const weights = new Map<string, number>((execution?.weights || []).map((item: any) => [item.criteria, Number(item.value)]));
    const terms = (optimization?.criteria || []).map((term: any) => ({
      metric: term?.feature?.id, weight: weights.get(term?.id) || 0, minimize: term?.direction !== 'maximize',
    })).filter((term: any) => typeof term.metric === 'string' && metrics.includes(term.metric) && term.weight > 0);
    if (!terms.length) return;
    for (const values of eligibility) {
      const estimate = new Map<number, number>();
      for (const candidate of values) estimate.set(candidate, 0);
      for (const term of terms) {
        const raw = values.map((candidate) => Number(candidates[candidate - 1].features?.[term.metric]));
        if (raw.some((value) => !Number.isFinite(value))) continue;
        const low = Math.min(...raw);
        const high = Math.max(...raw);
        if (!(high > low)) continue;
        values.forEach((candidate, index) => {
          const normalized = (raw[index] - low) / (high - low);
          estimate.set(candidate, estimate.get(candidate)! + term.weight * (term.minimize ? normalized : 1 - normalized));
        });
      }
      values.sort((a, b) => (estimate.get(a)! - estimate.get(b)!) || (a - b));
    }
  }

  /** MiniZinc requires 2-D literals with a consistent column count, including the empty case. */
  private fmt2dFixed(rows: any[][], columns: number): string {
    if (rows.length === 0 || columns === 0) return `array2d(1..${rows.length}, 1..${columns}, [])`;
    return fmt2d(rows);
  }

  private activeContexts(workflow: any): Set<string> {
    const contexts = new Set<string>();
    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (node.kind === 'sequence') { contexts.add('sequence'); (node.steps || []).forEach(visit); }
      else if (node.kind === 'parallel') { contexts.add('parallel'); (node.branches || []).forEach(visit); }
      else if (node.kind === 'exclusive') {
        contexts.add('exclusive');
        (node.branches || []).forEach((branch: any) => visit(branch?.flow));
      } else if (node.kind === 'repeat') { contexts.add('repeat'); visit(node.body); }
    };
    visit(workflow);
    return contexts;
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

  private validateMetric(id: string, metric: any, activeContexts: Set<string>): void {
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
    const active = metric.scope === 'selectedCandidate' ? new Set(['selection']) : activeContexts;
    for (const key of ['sequence', 'parallel', 'exclusive', 'repeat', 'selection']) {
      if (aggregation[key] === undefined) throw new Error(`Metric '${id}' is missing aggregation.${key}`);
      if (!active.has(key)) continue;
      if (typeof aggregation[key] !== 'string') throw new Error(`MiniZinc does not support aggregation expressions (${id}.${key})`);
      if (!AGGREGATION_CODES[key][aggregation[key]]) {
        throw new Error(`MiniZinc does not support aggregation '${aggregation[key]}' at ${id}.${key}`);
      }
    }
    for (const key of ['sequence', 'parallel', 'exclusive', 'repeat', 'selection']) {
      // Inactive contexts are only required to be well-formed; they never execute.
      if (typeof aggregation[key] !== 'string' && !(typeof aggregation[key] === 'object' && aggregation[key] !== null)) {
        throw new Error(`Metric '${id}' has a malformed aggregation.${key}`);
      }
    }
  }

  private flattenCandidates(catalogs: any, applicationResource: string,
      applicationMetrics: Set<string>, encodedMetrics: Set<string>): CandidateEntry[] {
    const values: CandidateEntry[] = [];
    for (const [catalogId, wrapper] of Object.entries(catalogs || {}) as Array<[string, any]>) {
      const allowedKeys = ['providers', 'features', 'metrics', 'featureBindings', 'metricBindings', 'candidates'];
      const featureBindings = wrapper?.featureBindings || wrapper?.metricBindings;
      if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)
          || Object.keys(wrapper).some((key) => !allowedKeys.includes(key))
          || !wrapper.providers || !featureBindings || !wrapper.candidates) {
        throw new Error(`Candidate catalog '${catalogId}' must contain providers, featureBindings and candidates`);
      }
      const canonicalByAlias = new Map<string, string>();
      const seenMetrics = new Set<string>();
      for (const [alias, metricRef] of Object.entries(featureBindings) as Array<[string, any]>) {
        this.requireRef(metricRef, `candidate catalog ${catalogId}.featureBindings.${alias}`);
        if (metricRef.resource !== applicationResource || !applicationMetrics.has(metricRef.id)) {
          throw new Error(`Candidate catalog '${catalogId}' binds alias '${alias}' to an unknown feature`);
        }
        if (seenMetrics.has(metricRef.id)) throw new Error(`Candidate catalog '${catalogId}' binds feature '${metricRef.id}' more than once`);
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
        const candFeatures = candidate.features || candidate.metrics || {};
        for (const [alias, raw] of Object.entries(candFeatures)) {
          const metricId = canonicalByAlias.get(alias);
          if (!metricId) throw new Error(`Candidate '${catalogId}:${candidateId}' uses unknown feature alias '${alias}'`);
          const numeric = Number(raw);
          if (!Number.isFinite(numeric)) throw new Error(`Candidate '${catalogId}:${candidateId}' feature '${alias}' is not finite`);
          if (encodedMetrics.has(metricId)) canonicalMetrics[metricId] = numeric;
        }
        values.push({
          ref: { resource: catalogId, id: candidateId }, features: canonicalMetrics, metrics: canonicalMetrics, provider,
          properties: candidate.properties || {},
        });
      }
    }
    return values;
  }

  private constraints(items: any[], metricIndex: Map<string, number>, taskIndex: Map<string, number>,
      candidates: CandidateEntry[], penaltyWeight: Map<string, number>, logSpace: {
        productConstraints: 'log' | 'real'; logAvailable: boolean[]; hasZero: boolean[]; zeroLog: number[];
        logThreshold: number[]; metricPositions: string[];
      }) {
    const result = {
      enforcement: [] as number[], penalty: [] as number[],
      constraintOf: [] as number[],
      operator: [] as number[], leftKind: [] as number[], leftIndex: [] as number[], leftValue: [] as number[],
      leftCandidateValue: [] as number[][], rightKind: [] as number[], rightIndex: [] as number[],
      rightValue: [] as number[], rightCandidateValue: [] as number[][],
      logSpaceAtoms: 0, realSpaceProductAtoms: 0, relaxedLiterals: 0,
    };
    const opCode: Record<string, number> = { lte: 1, gte: 2, eq: 3, lt: 4, gt: 5, ne: 6 };
    const flipped: Record<string, string> = { lte: 'gte', gte: 'lte', eq: 'eq', lt: 'gt', gt: 'lt', ne: 'ne' };
    for (const constraint of items) {
      this.requireRef(constraint?.ref, 'constraint.ref');
      const constraintId = constraint.ref.id;
      if (!['hard', 'soft'].includes(constraint.enforcement)) {
        throw new Error(`Constraint '${constraintId}' has an unsupported enforcement`);
      }
      if (constraint.when?.kind !== 'literal' || constraint.when.value !== true) {
        throw new Error(`MiniZinc does not support conditional constraint '${constraintId}'`);
      }
      let weightedPenalty = 0;
      if (constraint.enforcement === 'soft') {
        const penalty = constraint.penalty;
        if (!penalty || penalty.kind !== 'literal' || typeof penalty.value !== 'number'
            || !Number.isFinite(penalty.value) || penalty.value < 0) {
          throw new Error(`MiniZinc supports only constant non-negative soft penalties (constraint '${constraintId}')`);
        }
        weightedPenalty = Number(penalty.value) * (penaltyWeight.get(this.refKey(constraint.ref)) || 0);
      } else if (constraint.penalty !== undefined) {
        throw new Error(`Hard constraint '${constraintId}' cannot have penalty`);
      }
      const atoms: any[] = [];
      const collect = (node: any): void => {
        if (node?.kind === 'and') { collect(node.left); collect(node.right); return; }
        atoms.push(node);
      };
      collect(constraint.assert);
      result.enforcement.push(constraint.enforcement === 'hard' ? 1 : 2);
      result.penalty.push(weightedPenalty);
      const constraintPosition = result.enforcement.length;
      for (const assertion of atoms) {
        if (!assertion || assertion.kind !== 'compare' || !opCode[assertion.op]) {
          throw new Error(`MiniZinc supports only (conjunctions of) comparisons (constraint '${constraintId}')`);
        }
        let op: string = assertion.op;
        let left = this.constraintOperand(assertion.left, metricIndex, taskIndex, candidates, constraintId);
        let right = this.constraintOperand(assertion.right, metricIndex, taskIndex, candidates, constraintId);
        if (left.type !== right.type || (!['number', 'string'].includes(left.type)
            && !['eq', 'ne'].includes(assertion.op))) {
          throw new Error(`Constraint '${constraintId}' compares incompatible operand types`);
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
        if (left.type === 'number') {
          // Put a log-representable product metric on the left so that the rewrite has one shape.
          const isLogMetric = (operand: Operand): boolean => operand.kind === 1 && logSpace.logAvailable[operand.index - 1];
          if (!isLogMetric(left) && isLogMetric(right)) {
            [left, right] = [right, left];
            op = flipped[op];
          }
          if (isLogMetric(left)) {
            const rewritten = logSpace.productConstraints === 'log'
              ? this.logSpaceAtom(left, op, right, logSpace, candidates.length) : null;
            if (rewritten) {
              [left, op, right] = rewritten;
              result.logSpaceAtoms += 1;
            } else {
              result.realSpaceProductAtoms += 1;
            }
          }
          if (this.relaxComparison(left, op, right)) result.relaxedLiterals += 1;
        }
        result.constraintOf.push(constraintPosition);
        result.operator.push(opCode[op]);
        result.leftKind.push(left.kind); result.leftIndex.push(left.index); result.leftValue.push(left.value);
        result.leftCandidateValue.push(left.values);
        result.rightKind.push(right.kind); result.rightIndex.push(right.index); result.rightValue.push(right.value);
        result.rightCandidateValue.push(right.values);
      }
    }
    return result;
  }

  /**
   * Rewrite `P op X` (P a log-representable product metric) into log space.
   * Returns null when the comparison must stay in real space.
   */
  private logSpaceAtom(left: Operand, op: string, right: Operand, logSpace: {
      logAvailable: boolean[]; hasZero: boolean[]; zeroLog: number[]; logThreshold: number[];
    }, candidateCount: number): [Operand, string, Operand] | null {
    const metricPosition = left.index - 1;
    const threshold = logSpace.logThreshold[metricPosition];
    const literalAtom = (truth: boolean): [Operand, string, Operand] => [
      this.literalOperand(1, candidateCount), 'eq', this.literalOperand(truth ? 1 : 0, candidateCount)];
    const logMetric: Operand = { ...left, kind: 4, values: left.values.map(() => 0) };
    if (right.kind === 3) {
      const value = right.value;
      if (value > 0) {
        return [logMetric, op, this.literalOperand(Math.max(Math.log(value), threshold), candidateCount)];
      }
      if (value === 0) {
        // P >= 0 always holds; P > 0 / P != 0 mean "no zero factor"; P <= 0 / P == 0 mean "a zero factor".
        if (op === 'gte') return literalAtom(true);
        if (op === 'lt') return literalAtom(false);
        if (op === 'gt' || op === 'ne') return [logMetric, 'gt', this.literalOperand(threshold, candidateCount)];
        return [logMetric, 'lt', this.literalOperand(threshold, candidateCount)];
      }
      return literalAtom(op === 'gte' || op === 'gt' || op === 'ne');
    }
    if (logSpace.hasZero[metricPosition]) return null;
    if (right.kind === 1) {
      const otherPosition = right.index - 1;
      if (!logSpace.logAvailable[otherPosition] || logSpace.hasZero[otherPosition]) return null;
      return [logMetric, op, { ...right, kind: 4, values: right.values.map(() => 0) }];
    }
    if (right.kind === 2) {
      if (right.values.some((value) => !(value > 0))) return null;
      return [logMetric, op, { ...right, kind: 5, values: right.values.map((value) => Math.log(value)) }];
    }
    return null;
  }

  /**
   * Move the literal side of a non-strict numeric comparison by the numeric slack in
   * the direction that enlarges the feasible region (numeric.ts): `X <= L` raises `L`,
   * `X >= L` lowers it, and the mirrored forms with the literal on the left do the
   * opposite. MiniZinc prints the literal into the FlatZinc with 16 significant digits,
   * so a limit that equals an attainable value exactly (a generated instance whose
   * limit is the value of a reference binding) can otherwise come out one ulp below
   * it and exclude the boundary binding. Strict comparisons and (in)equalities keep
   * their literal: a boundary binding is infeasible for them anyway, and widening an
   * equality has no single direction. Returns true when a literal moved.
   */
  private relaxComparison(left: Operand, op: string, right: Operand): boolean {
    if (op !== 'lte' && op !== 'gte') return false;
    const leftLiteral = left.kind === 3;
    const rightLiteral = right.kind === 3;
    if (leftLiteral === rightLiteral) return false; // two variables, or two constants
    const literal = rightLiteral ? right : left;
    const direction: 1 | -1 = (rightLiteral ? op === 'lte' : op === 'gte') ? 1 : -1;
    literal.value = relaxLiteral(literal.value, direction);
    literal.values = literal.values.map((value) => relaxLiteral(value, direction));
    return true;
  }

  private literalOperand(value: number, candidateCount: number): Operand {
    return { kind: 3, index: 1, value, values: Array(candidateCount).fill(value), type: 'number',
      rawValue: value, rawValues: Array(candidateCount).fill(value) };
  }

  private constraintOperand(node: any, metricIndex: Map<string, number>, taskIndex: Map<string, number>,
      candidates: CandidateEntry[], constraintId: string): Operand {
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
    if (segments.length === 2 && (segments[0] === 'features' || segments[0] === 'metrics') && metricIndex.has(segments[1])) {
      return { kind: 1, index: metricIndex.get(segments[1])!, value: 0, values: candidates.map(() => 0),
        type: 'number', rawValue: 0, rawValues: [] };
    }
    if (segments[0] !== 'tasks' || !taskIndex.has(segments[1])) {
      throw new Error(`Constraint '${constraintId}' uses an unsupported path`);
    }
    const task = taskIndex.get(segments[1])!;
    let values: unknown[];
    let type = 'string';
    if (segments.length === 4 && (segments[2] === 'features' || segments[2] === 'metrics') && metricIndex.has(segments[3])) {
      values = candidates.map((candidate) => candidate.features[segments[3]] ?? candidate.metrics[segments[3]]);
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

  private optimization(source: any, execution: any, applicationResource: string, metricIndex: Map<string, number>) {
    if (!execution || execution.scalarization !== 'weighted-sum') {
      throw new Error('MiniZinc exact-weighted mode requires scalarization weighted-sum');
    }
    if (execution.type !== 'SINGLE') {
      throw new Error('MiniZinc exact-weighted mode supports objective type SINGLE only');
    }
    if (!Array.isArray(source.penalties)) {
      throw new Error('Weighted optimization penalties must be materialized');
    }
    if (!Array.isArray(source.criteria) || source.criteria.length === 0) {
      throw new Error('Weighted optimization requires at least one criterion');
    }
    const weights = new Map((execution.weights || []).map((item: any) => [item.criteria, Number(item.value)]));
    const result = {
      metric: [] as number[], weight: [] as number[], direction: [] as number[],
      hasNormalize: [] as boolean[], min: [] as number[], max: [] as number[], clamp: [] as boolean[],
      penaltyWeight: new Map<string, number>(),
    };
    for (const term of source.criteria) {
      const featureRef = term.feature;
      this.requireRef(featureRef, 'optimization criterion.feature');
      if (featureRef.resource !== applicationResource || !metricIndex.has(featureRef.id)) {
        throw new Error(`Optimization term references unknown feature '${featureRef.resource}:${featureRef.id}'`);
      }
      const weight = Number(weights.get(term.id));
      if (!(weight > 0) || !Number.isFinite(weight)) throw new Error('Optimization weights must be finite and positive');
      if (!['minimize', 'maximize'].includes(term.direction)) throw new Error('Optimization direction is invalid');
      const normalize = term.normalize;
      if (normalize !== undefined && (!Number.isFinite(Number(normalize.min))
          || !Number.isFinite(Number(normalize.max)) || Number(normalize.max) <= Number(normalize.min)
          || Math.abs(Number(normalize.min)) > 1e100 || Math.abs(Number(normalize.max)) > 1e100
          || typeof normalize.clamp !== 'boolean')) {
        throw new Error('Optimization normalization bounds are invalid');
      }
      result.metric.push(metricIndex.get(featureRef.id)!);
      result.weight.push(weight);
      result.direction.push(term.direction === 'minimize' ? 1 : -1);
      result.hasNormalize.push(normalize !== undefined);
      result.min.push(normalize === undefined ? 0 : Number(normalize.min));
      result.max.push(normalize === undefined ? 1 : Number(normalize.max));
      result.clamp.push(normalize === undefined ? false : normalize.clamp);
    }
    const weightTotal = result.weight.reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(weightTotal - 1) > 1e-12) {
      throw new Error('Execution optimization weights must be normalized to 1');
    }
    for (const item of source.penalties) {
      this.requireRef(item?.constraint, 'optimization penalty.constraint');
      const weight = Number(item.weight);
      if (!(weight > 0) || !Number.isFinite(weight)) throw new Error('Optimization penalty weights must be finite and positive');
      result.penaltyWeight.set(this.refKey(item.constraint), weight);
    }
    return result;
  }

  private selectionAggregationCode(value: string, metric: string): number {
    const code = AGGREGATION_CODES.selection[value];
    if (!code) throw new Error(`MiniZinc does not support aggregation '${value}' at ${metric}.selection`);
    return code;
  }

  private aggregationCode(value: string, place: string, metric: string): number {
    const code = AGGREGATION_CODES[place]?.[value];
    // Inactive contexts (validated as well-formed only) are emitted with a harmless placeholder.
    if (!code) return place === 'repeat' ? 8 : 1;
    void metric;
    return code;
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
