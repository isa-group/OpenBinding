/**
 * Constraints (Delta): attribute bounds in either scope, and dependencies.
 *
 * The model can only enforce what is emitted here, so an operator it cannot
 * represent is a refusal rather than an omission: silently dropping one is
 * how the engine used to report a solution OPTIMAL while breaking it.
 */

import { FeatureEncoding } from './features';

/** How the model numbers the comparison operators; see check_op in the model. */
const OP_CODE: Record<string, number> = { '<=': 1, '>=': 2, '==': 3, '<': 4, '>': 5, '!=': 6 };

/** Same tolerance as the gateway reference evaluator. */
const EPS = 1e-6;

export interface ConstraintEncoding {
  /** Global attribute bounds: feature index, operator code, bound value. */
  globalAttr: number[];
  globalOp: number[];
  globalValue: number[];
  /** Local attribute bounds, one entry per (task, bound). */
  localTask: number[];
  localAttr: number[];
  localOp: number[];
  localValue: number[];
  /** Candidates a candidate-scoped bound rules out, as (task, candidate). */
  excludedTask: number[];
  excludedCand: number[];
  /**
   * Candidate-scoped bounds on a feature whose value depends on how many tasks
   * share the candidate, which cannot be decided here. Kept as constraints for
   * the model to enforce once it knows: (task, candidate, feature, op, bound).
   */
  candBoundTask: number[];
  candBoundCand: number[];
  candBoundAttr: number[];
  candBoundOp: number[];
  candBoundValue: number[];
  /** Dependencies as pairs of tasks, by type code. */
  depType: number[];
  depFirst: number[];
  depSecond: number[];
}

/**
 * IN_RANGE has no operator code of its own: it is the conjunction of a lower
 * and an upper bound, which is exactly what the model already enforces.
 */
function expandOp(op: string, value: any): Array<{ op: number; value: number }> {
  if (op === 'in_range') {
    const range = value || {};
    return [
      { op: OP_CODE['>='], value: Number(range.min) },
      { op: OP_CODE['<='], value: Number(range.max) },
    ];
  }
  const code = OP_CODE[op];
  if (code === undefined) {
    throw new Error(`Unsupported attribute bound operator '${op}'`);
  }
  return [{ op: code, value: Number(value) }];
}

/** Whether a constant value satisfies a bound, with the reference tolerance. */
function satisfiesBound(current: number, op: string, value: any): boolean {
  if (op === 'in_range') {
    const range = value || {};
    return current >= Number(range.min) - EPS && current <= Number(range.max) + EPS;
  }
  const rhs = Number(value);
  switch (op) {
    case '<=': return current <= rhs + EPS;
    case '<': return current < rhs - EPS;
    case '>=': return current >= rhs - EPS;
    case '>': return current > rhs + EPS;
    case '==': return Math.abs(current - rhs) <= EPS;
    case '!=': return Math.abs(current - rhs) > EPS;
    default: throw new Error(`Unsupported attribute bound operator '${op}'`);
  }
}

export function encodeConstraints(
  instance: any,
  featureEncoding: FeatureEncoding,
  taskIdx: Record<string, number>,
  candidateIdx: Record<string, number>,
  candidates: any[],
  hasPools: boolean
): ConstraintEncoding {
  const encoding: ConstraintEncoding = {
    globalAttr: [], globalOp: [], globalValue: [],
    localTask: [], localAttr: [], localOp: [], localValue: [],
    excludedTask: [], excludedCand: [],
    candBoundTask: [], candBoundCand: [], candBoundAttr: [], candBoundOp: [], candBoundValue: [],
    depType: [], depFirst: [], depSecond: [],
  };

  const toModel = (value: number, featureId: string) =>
    featureEncoding.toModelValue(Number.isFinite(value) ? value : 0.0, featureId);

  for (const c of instance.constraints || []) {
    // Soft constraints are the gateway's to report; the model enforces hard ones.
    if (c.hard === false) continue;

    const kind = (c.kind || '').toLowerCase();
    const scope = (c.scope || '').toLowerCase();
    const opRaw = (c.op || '').toLowerCase();
    const type = (c.type || '').toLowerCase();

    if (kind === 'attribute_bound') {
      const featId = c.attribute_id;
      const attrIdx = featureEncoding.index[featId];
      if (!attrIdx) {
        throw new Error(`Attribute bound constraint refers to unknown feature '${featId}'`);
      }
      const bounds = expandOp(opRaw, c.value);

      if (scope === 'global') {
        for (const bound of bounds) {
          encoding.globalAttr.push(attrIdx);
          encoding.globalOp.push(bound.op);
          encoding.globalValue.push(toModel(bound.value, featId));
        }
        continue;
      }
      if (scope !== 'local') continue;

      // Every task the constraint lists, not just the first one.
      for (const taskId of c.task_id ? [c.task_id] : c.tasks || []) {
        const tIdx = taskIdx[taskId];
        if (!tIdx) continue;
        for (const bound of bounds) {
          encoding.localTask.push(tIdx);
          encoding.localAttr.push(attrIdx);
          encoding.localOp.push(bound.op);
          encoding.localValue.push(toModel(bound.value, featId));
        }
      }

      // Scoping by candidate id constrains those candidates only, in every
      // task they can serve. For a feature whose value is fixed data, the
      // candidates that break the bound are simply not selectable and the
      // builder can say so outright. For a feature that is divided between the
      // tasks sharing a candidate, the value is not known until the model has
      // decided how many that is, so the bound goes to the model instead.
      const isDivided = featureEncoding.divided.has(featId);
      for (const candidateId of c.candidates || []) {
        const cIdx = candidateIdx[candidateId];
        if (!cIdx) continue;
        const candidate = candidates[cIdx - 1];
        const raw = Number((candidate.qos || candidate.features || {})[featId] ?? 0);
        for (const taskId of candidate.task_ids || []) {
          const tIdx = taskIdx[taskId];
          if (!tIdx) continue;
          if (isDivided) {
            for (const bound of bounds) {
              encoding.candBoundTask.push(tIdx);
              encoding.candBoundCand.push(cIdx);
              encoding.candBoundAttr.push(attrIdx);
              encoding.candBoundOp.push(bound.op);
              encoding.candBoundValue.push(toModel(bound.value, featId));
            }
          } else if (!satisfiesBound(raw, opRaw, c.value)) {
            encoding.excludedTask.push(tIdx);
            encoding.excludedCand.push(cIdx);
          }
        }
      }
      continue;
    }

    if (kind !== 'dependency') continue;

    const tasks = (c.tasks || []).map((id: string) => taskIdx[id]).filter((i: any) => i);
    if (tasks.length < 2) continue;

    // Consecutive pairs suffice for SAME (equality is transitive); DIFFERENT
    // needs every pair.
    const chain = (code: number) => {
      for (let i = 0; i < tasks.length - 1; i++) {
        encoding.depType.push(code);
        encoding.depFirst.push(tasks[i]);
        encoding.depSecond.push(tasks[i + 1]);
      }
    };
    const allPairs = (code: number) => {
      for (let i = 0; i < tasks.length; i++) {
        for (let j = i + 1; j < tasks.length; j++) {
          encoding.depType.push(code);
          encoding.depFirst.push(tasks[i]);
          encoding.depSecond.push(tasks[j]);
        }
      }
    };

    if (type === 'same_provider') chain(1);
    else if (type === 'different_provider') allPairs(2);
    // Pool dependencies need declared pools to compare; validation rejects the
    // instance before it reaches the engine otherwise.
    else if (type === 'same_pool' && hasPools) chain(3);
    else if (type === 'different_pool' && hasPools) allPairs(4);
    else if (type === 'same_candidate') chain(5);
    else if (type === 'different_candidate') allPairs(6);
  }

  return encoding;
}
