import * as path from 'path';
import { CandidateRef, DznBuilder, DznBuildResult } from './dzn_builder';
import { MiniZincRunner, MiniZincRunResult } from './minizinc_runner';
import { evaluatePlacement } from './placement';

/** Executes the exact MiniZinc subset and returns BIM Engine Protocol v1. */
export class Solver {
  private readonly tmpDir = path.resolve(__dirname, '../tmp_minizinc');
  private readonly builder = new DznBuilder();

  constructor(private readonly runner: MiniZincRunner = new MiniZincRunner()) {}

  validate(problem: any, options: any): DznBuildResult {
    this.validateOptions(options || {});
    return this.builder.build(problem, options || {});
  }

  async solve(problem: any, options: any): Promise<any> {
    const normalizedOptions = options || {};
    const built = this.validate(problem, normalizedOptions);
    const solverName = String(normalizedOptions.solver || 'gecode');
    const timeLimitMs = normalizedOptions.time_budget_ms == null
      ? 30000 : Number(normalizedOptions.time_budget_ms);
    const modelPath = path.resolve(__dirname, '../model/binding_problem.mzn');
    const run = await this.runner.run(solverName, modelPath, built.dznContent,
      this.tmpDir, ['--time-limit', String(Math.round(timeLimitMs)), '--intermediate-solutions']);

    if (run.code !== 0 || run.stdout.includes('=====ERROR=====') || /(^|\n)Error:/.test(run.stderr)) {
      throw new Error(`MiniZinc execution failed: ${this.truncate(run.stderr || run.stdout, 800)}`);
    }
    const unsatisfiable = run.stdout.includes('=====UNSATISFIABLE=====')
      || run.stdout.includes('model inconsistency detected');
    const complete = run.stdout.includes('==========');
    const provenance = {
      algorithm: 'minizinc-csp', solver: solverName, elapsed_ms: run.durationMs,
      time_budget_ms: timeLimitMs,
    };
    if (unsatisfiable) return { termination: 'INFEASIBLE', solutions: [], provenance };

    const incumbents = this.parseIncumbents(run);
    if (incumbents.length === 0) return { termination: 'UNKNOWN', solutions: [], provenance };
    const incumbent = incumbents[incumbents.length - 1];
    if (!Array.isArray(incumbent.selected_cand) || incumbent.selected_cand.length !== built.tasks.length) {
      throw new Error('MiniZinc incumbent has an invalid selected_cand vector');
    }
    const binding: Record<string, CandidateRef> = {};
    incumbent.selected_cand.forEach((raw: unknown, index: number) => {
      const candidateIndex = Number(raw);
      const candidate = built.candidates[candidateIndex - 1];
      if (!Number.isInteger(candidateIndex) || !candidate) {
        throw new Error(`MiniZinc selected unknown candidate index '${raw}'`);
      }
      const task = built.tasks[index];
      const eligible = problem.spec.eligibility?.[task];
      if (!Array.isArray(eligible) || !eligible.some((value: CandidateRef) =>
        value?.resource === candidate.resource && value?.id === candidate.id)) {
        throw new Error(`MiniZinc selected ineligible candidate '${candidate.resource}:${candidate.id}' for task '${task}'`);
      }
      binding[task] = candidate;
    });
    const objectiveValue = Number(incumbent.objective_value);
    if (!Number.isFinite(objectiveValue)) throw new Error('MiniZinc returned a non-finite objective');
    const evaluation = this.evaluate(problem, binding);
    if (Math.abs(Number(evaluation.objectives.score) - objectiveValue) > 1e-6) {
      throw new Error('MiniZinc objective disagrees with the canonical BIM v1 evaluation');
    }
    return {
      termination: complete ? 'OPTIMAL' : 'FEASIBLE',
      solutions: [{
        decision: { kind: 'binding', binding },
        metrics: evaluation.metrics,
        objectives: evaluation.objectives,
        penalties: evaluation.penalties,
        violations: evaluation.violations,
      }],
      provenance,
    };
  }

  private validateOptions(options: any): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Engine options must be an object');
    }
    const unknown = Object.keys(options).filter((key) => !['time_budget_ms', 'solver'].includes(key));
    if (unknown.length) throw new Error(`Unknown engine options: ${unknown.join(', ')}`);
    if (options.time_budget_ms !== undefined
        && (!Number.isInteger(Number(options.time_budget_ms)) || Number(options.time_budget_ms) < 1
          || Number(options.time_budget_ms) > 3600000)) {
      throw new Error('time_budget_ms must be an integer in [1,3600000]');
    }
    if (options.solver !== undefined && String(options.solver) !== 'gecode') {
      throw new Error('solver must be gecode for the declared float subset');
    }
  }

  private parseIncumbents(run: MiniZincRunResult): any[] {
    const values: any[] = [];
    const separator = '----------';
    let cursor = 0;
    while (true) {
      const end = run.stdout.indexOf(separator, cursor);
      if (end < 0) break;
      this.parseSegment(run.stdout.slice(cursor, end), values);
      cursor = end + separator.length;
    }
    if (values.length === 0) this.parseSegment(run.stdout, values);
    return values;
  }

  private evaluate(problem: any, binding: Record<string, CandidateRef>): any {
    const spec = problem.spec;
    const application = spec.application;
    const candidate = (reference: CandidateRef): any => {
      const value = spec.candidates?.[reference.resource]?.candidates?.[reference.id];
      if (!value) throw new Error(`Unknown selected candidate '${reference.resource}:${reference.id}'`);
      return value;
    };
    const candidateMetric = (reference: CandidateRef, metricId: string): number => {
      const wrapper = spec.candidates?.[reference.resource];
      const alias = Object.entries(wrapper?.metricBindings || {}).find(([, metricRef]: [string, any]) =>
        metricRef?.resource === application.resource && metricRef?.id === metricId)?.[0];
      const value = alias === undefined ? undefined : candidate(reference).metrics?.[alias];
      if (!Number.isFinite(Number(value))) {
        throw new Error(`Selected candidate '${reference.resource}:${reference.id}' is missing metric '${metricId}'`);
      }
      return Number(value);
    };
    const routing = new Map<string, number>((spec.routing as any[]).map((entry: any) => [
      this.refKey(entry.target), Number(entry.probability),
    ]));
    const invocation = (metricId: string, node: any, pointer: string): number => {
      const metric = application.metrics[metricId];
      if (node.kind === 'task') {
        const task = application.tasks[node.task.id];
        if (task.kind === 'local') return Number(metric.neutral);
        return candidateMetric(binding[node.task.id], metricId);
      }
      if (node.kind === 'empty') return Number(metric.neutral);
      if (node.kind === 'sequence' || node.kind === 'parallel') {
        const children = node.kind === 'sequence' ? node.steps : node.branches;
        const field = node.kind === 'sequence' ? 'steps' : 'branches';
        const values = children.map((child: any, index: number) => invocation(
          metricId, child, `${pointer}/${field}/${index}`));
        return this.aggregate(metric.aggregation[node.kind], values, Number(metric.neutral));
      }
      if (node.kind === 'exclusive') {
        const values = node.branches.map((branch: any, index: number) => invocation(
          metricId, branch.flow, `${pointer}/branches/${index}/flow`));
        const operation = metric.aggregation.exclusive;
        if (operation === 'weightedSum') {
          return node.branches.reduce((sum: number, branch: any, index: number) =>
            sum + Number(routing.get(this.refKey(this.workflowBranchRef(
              application.resource, spec.sourceMap, pointer, index, branch.id)))) * values[index], 0);
        }
        return this.aggregate(operation, values, Number(metric.neutral));
      }
      if (node.kind === 'repeat') {
        const value = invocation(metricId, node.body, `${pointer}/body`);
        const operation = metric.aggregation.repeat;
        return operation === 'identity' ? value : value * Number(node.count);
      }
      throw new Error(`Unsupported workflow node '${String(node.kind)}' during result evaluation`);
    };
    const metrics: Record<string, number> = {};
    for (const metricId of application.requiredMetrics) {
      const metric = application.metrics[metricId];
      const value = metric.scope === 'selectedCandidate'
        ? this.aggregate(metric.aggregation.selection,
          [...new Map(Object.values(binding).map((reference) => [this.refKey(reference), reference])).values()]
            .map((reference) => candidateMetric(reference, metricId)), Number(metric.neutral))
        : invocation(metricId, application.workflow, '/spec/application/workflow');
      metrics[metricId] = value;
      if (!Number.isFinite(metrics[metricId])) throw new Error(`Metric '${metricId}' evaluated to a non-finite value`);
    }
    const placement = evaluatePlacement(problem, binding, candidateMetric);
    Object.assign(metrics, placement.metrics);
    const taskContext: Record<string, any> = {};
    for (const [task, reference] of Object.entries(binding)) {
      const selected = candidate(reference);
      const wrapper = spec.candidates[reference.resource];
      const selectedMetrics = Object.fromEntries(Object.entries(wrapper.metricBindings || {}).map(([alias, metricRef]: [string, any]) =>
        [metricRef.id, Number(selected.metrics?.[alias])]));
      taskContext[task] = {
        candidate: reference, provider: selected.provider,
        metrics: selectedMetrics, properties: selected.properties || {},
      };
    }
    const context = { metrics, tasks: taskContext };
    const expression = (node: any): any => {
      if (node?.kind === 'literal') return node.value;
      if (node?.kind === 'path') return node.segments.reduce((value: any, segment: string) => {
        if (value === undefined || value === null || !(segment in value)) throw new Error(`Missing expression path '${node.segments.join('.')}'`);
        return value[segment];
      }, context as any);
      if (node?.kind === 'compare') {
        const left = expression(node.left), right = expression(node.right);
        const equal = typeof left === 'object' && typeof right === 'object'
          ? JSON.stringify(left) === JSON.stringify(right) : left === right;
        if (node.op === 'eq') return equal;
        if (node.op === 'ne') return !equal;
        if (node.op === 'lt') return left < right;
        if (node.op === 'lte') return left <= right;
        if (node.op === 'gt') return left > right;
        if (node.op === 'gte') return left >= right;
      }
      throw new Error('Unsupported MiniZinc constraint expression');
    };
    for (const constraint of spec.constraints) {
      if (expression(constraint.when) && !expression(constraint.assert)) {
        throw new Error(`MiniZinc returned a decision that violates hard constraint '${constraint.ref.resource}:${constraint.ref.id}'`);
      }
    }
    const components = spec.optimization.terms.map((term: any) => {
      const value = metrics[term.metric.id];
      let normalized = value;
      if (term.normalize) {
        normalized = (value - Number(term.normalize.min))
          / (Number(term.normalize.max) - Number(term.normalize.min));
        if (term.normalize.clamp) normalized = Math.max(0, Math.min(1, normalized));
      }
      const loss = term.direction === 'maximize'
        ? term.normalize ? 1 - normalized : -normalized
        : normalized;
      return { metric: term.metric, value, loss, weight: Number(term.weight) };
    });
    const score = components.reduce((sum: number, component: any) =>
      sum + component.loss * component.weight, placement.penalty);
    return {
      metrics,
      objectives: { mode: 'weighted', components, penalty: placement.penalty, score },
      penalties: placement.penalties,
      violations: placement.violations,
    };
  }

  private parseSegment(segment: string, values: any[]): void {
    const first = segment.indexOf('{');
    const last = segment.lastIndexOf('}');
    if (first < 0 || last <= first) return;
    try { values.push(JSON.parse(segment.slice(first, last + 1))); }
    catch (error) { throw new Error(`MiniZinc returned malformed JSON: ${String(error)}`); }
  }

  private aggregate(operation: string, values: number[], neutral: number): number {
    if (values.length === 0) return neutral;
    if (operation === 'sum') return values.reduce((sum, value) => sum + value, 0);
    if (operation === 'min') return Math.min(...values);
    if (operation === 'max') return Math.max(...values);
    throw new Error(`Unsupported aggregation '${operation}' during result evaluation`);
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

  private refKey(ref: CandidateRef): string { return `${ref.resource}\u0000${ref.id}`; }

  private truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}…`;
  }
}
