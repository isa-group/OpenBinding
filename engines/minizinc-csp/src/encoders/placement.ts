/**
 * Placement arrays (R and L of M'_C), as the model consumes them.
 *
 * Everything here is emitted unconditionally. An instance with neither
 * resource_model nor latency_model yields an empty model, so the arrays come
 * out empty and the model's placement constraints are vacuous - which is why
 * there is no second code path for problems without placement.
 */

import { PlacementModel } from '../placement';
import { FeatureEncoding } from './features';
import { LAT_SCALE, requireInt, scaleLat } from './format';

export interface PlacementEncoding {
  nPools: number;
  nResources: number;
  nEvents: number;
  candPool: number[];
  candDemand: number[][];
  candExecLat: number[];
  poolLat: number[][];
  eventLat: number[][];
  capPool: number[];
  capRes: number[];
  capLimit: number[];
  trFromTask: number[];
  trEvent: number[];
  trToTask: number[];
  trOp: number[];
  trVal: number[];
  nScenarios: number;
  scenProb: number[];
  scenActive: number[][];
  peScen: number[];
  peToTask: number[];
  peFromTask: number[];
  peEvent: number[];
  sinkScen: number[];
  sinkTask: number[];
  xorSemantics: number;
  latFeatureIdx: number;
  maxLatInt: number;
}

export function encodePlacement(
  instance: any,
  model: PlacementModel,
  featureEncoding: FeatureEncoding,
  candidates: any[],
  taskIdx: Record<string, number>,
  nTasks: number
): PlacementEncoding {
  let n_pools = 0;
  let n_resources = 0;
  let n_events = 0;
  let cand_pool: number[] = candidates.map(() => 0);
  let cand_demand: number[][] = candidates.map(() => []);
  let cand_exec_lat: number[] = candidates.map(() => 0);
  let pool_lat: number[][] = [];
  let event_lat: number[][] = [];
  const cap_pool: number[] = [];
  const cap_res: number[] = [];
  const cap_limit: number[] = [];
  const tr_from_task: number[] = [];
  const tr_event: number[] = [];
  const tr_to_task: number[] = [];
  const tr_op: number[] = [];
  const tr_val: number[] = [];
  let n_scenarios = 0;
  const scen_prob: number[] = [];
  let scen_active: number[][] = [];
  const pe_scen: number[] = [];
  const pe_to_task: number[] = [];
  const pe_from_task: number[] = [];
  const pe_event: number[] = [];
  const sink_scen: number[] = [];
  const sink_task: number[] = [];
  let xor_semantics = 1;
  let lat_feature_idx = 0;
  let MAX_LAT_INT = 1;


    const pools = model.pools;
    const poolIdx: Record<string, number> = {};
    pools.forEach((p, i) => (poolIdx[p.id] = i + 1));
    n_pools = pools.length;

    const resourceSet = new Set<string>();
    pools.forEach((p) => Object.keys(p.capacity || {}).forEach((r) => resourceSet.add(r)));
    Object.values(model.demandOfCandidate).forEach((d) =>
      Object.keys(d || {}).forEach((r) => resourceSet.add(r))
    );
    const resources = Array.from(resourceSet).sort();
    const resIdx: Record<string, number> = {};
    resources.forEach((r, i) => (resIdx[r] = i + 1));
    n_resources = resources.length;

    const e2e = model.globalLatency;
    const latAttr = e2e?.attribute_id;
    lat_feature_idx = latAttr ? featureEncoding.index[latAttr] || 0 : 0;
    const includeExec = Boolean(e2e?.include_execution_latency_feature);

    cand_pool = candidates.map((c: any) => poolIdx[model.poolOfCandidate[c.id]] || 0);
    cand_demand = candidates.map((c: any) => {
      const demand = model.demandOfCandidate[c.id] || {};
      return resources.map((r) =>
        requireInt(Number(demand[r] || 0), `Resource demand '${r}' of candidate '${c.id}'`)
      );
    });
    cand_exec_lat = candidates.map((c: any) => {
      if (!includeExec || !latAttr) return 0;
      const qosData = c.qos || c.features || {};
      return scaleLat(Number(qosData[latAttr] || 0));
    });

    const lookupLat = (a: string, b: string): number => model.poolLatency(a, b);
    let maxLatMs = 0;
    pool_lat = pools.map((pa) =>
      pools.map((pb) => {
        const v = lookupLat(pa.id, pb.id);
        if (v > maxLatMs) maxLatMs = v;
        return scaleLat(v);
      })
    );

    const eventIds = Array.from(
      new Set([...Object.keys(model.eventLatency), ...Object.keys(model.eventPools)])
    ).sort();
    const eventIdx: Record<string, number> = {};
    eventIds.forEach((e, i) => (eventIdx[e] = i + 1));
    n_events = eventIds.length;
    let maxEventMs = 0;
    event_lat = eventIds.map((eid) =>
      pools.map((p) => {
        const v = model.eventPoolLatency(eid, p.id);
        if (v > maxEventMs) maxEventMs = v;
        return scaleLat(v);
      })
    );

    for (const rc of model.capacityConstraints) {
      if (rc.hard === false) continue; // the CSP model enforces hard constraints only
      for (const poolId of rc.pools || []) {
        const pIdx = poolIdx[poolId];
        const pool = pools[pIdx - 1];
        if (!pIdx || !pool) continue;
        for (const r of rc.resources || []) {
          const cap = (pool.capacity || {})[r];
          if (cap === undefined || cap === null) continue; // undeclared = unconstrained
          cap_pool.push(pIdx);
          cap_res.push(resIdx[r]);
          cap_limit.push(requireInt(Number(cap), `Capacity of resource '${r}' in pool '${poolId}'`));
        }
      }
    }

    const trOpMap: Record<string, number> = { '<=': 1, '>=': 2, '==': 3, '<': 4, '>': 5 };
    for (const tc of model.transitions) {
      if (tc.hard === false) continue;
      const toIdx = tc.to_task ? taskIdx[tc.to_task] : 0;
      if (!toIdx) throw new Error(`Transition constraint targets unknown task '${tc.to_task}'`);
      const fromIdx = tc.from_task ? taskIdx[tc.from_task] || 0 : 0;
      const evIdx = tc.from_event ? eventIdx[tc.from_event] || 0 : 0;
      if (!fromIdx && !evIdx) {
        throw new Error(`Transition constraint '${tc.id}' has no valid source`);
      }
      const emit = (op: string, value: number) => {
        tr_from_task.push(fromIdx);
        tr_event.push(evIdx);
        tr_to_task.push(toIdx);
        tr_op.push(trOpMap[op]);
        tr_val.push(scaleLat(value));
      };
      const rawOp = String(tc.op ?? '<=');
      const op = rawOp.toUpperCase() === 'IN_RANGE' ? 'IN_RANGE' : rawOp;
      if (op === 'IN_RANGE') {
        emit('>=', Number(tc.value?.min ?? 0));
        emit('<=', Number(tc.value?.max ?? 0));
      } else if (trOpMap[op] !== undefined) {
        emit(op, Number(tc.value));
      } else {
        throw new Error(`Unsupported transition operator '${tc.op}'`);
      }
    }

    if (e2e && lat_feature_idx > 0) {
      const scenarios = model.scenarios();
      n_scenarios = scenarios.length;
      xor_semantics = e2e.xor_semantics === 'WORST_CASE' ? 2 : 1;
      scen_active = scenarios.map(() => Array(nTasks).fill(0));
      scenarios.forEach((s, sIdx) => {
        scen_prob.push(Number(s.prob));
        for (const t of s.order) {
          const tIdx = taskIdx[t];
          if (!tIdx) throw new Error(`Scenario references unknown task '${t}'`);
          scen_active[sIdx][tIdx - 1] = 1;
          for (const [srcKind, srcId] of s.preds[t] || []) {
            pe_scen.push(sIdx + 1);
            pe_to_task.push(tIdx);
            if (srcKind === 'task') {
              pe_from_task.push(taskIdx[srcId] || 0);
              pe_event.push(0);
            } else {
              pe_from_task.push(0);
              pe_event.push(eventIdx[srcId] || 0);
            }
          }
        }
        for (const t of s.sinks) {
          sink_scen.push(sIdx + 1);
          sink_task.push(taskIdx[t]);
        }
      });

      const maxExecMs = Math.max(0, ...cand_exec_lat.map((v) => v / LAT_SCALE));
      MAX_LAT_INT = scaleLat(maxEventMs + nTasks * (maxLatMs + maxExecMs) + 1);

      // Soundness of the PERT lower-bound encoding: the latency feature may
      // only be minimized or bounded from above.
      for (const c of instance.constraints || []) {
        if ((c.kind || '').toLowerCase() !== 'attribute_bound') continue;
        if ((c.scope || '').toLowerCase() !== 'global') continue;
        if (c.attribute_id !== latAttr) continue;
        if (!['<=', '<'].includes(String(c.op))) {
          throw new Error(
            `Global bound '${c.op}' on end-to-end latency feature '${latAttr}' is not ` +
            'supported by the exact engine (only <= and < are sound)'
          );
        }
      }
    }

  
  return {
    nPools: n_pools,
    nResources: n_resources,
    nEvents: n_events,
    candPool: cand_pool,
    candDemand: cand_demand,
    candExecLat: cand_exec_lat,
    poolLat: pool_lat,
    eventLat: event_lat,
    capPool: cap_pool,
    capRes: cap_res,
    capLimit: cap_limit,
    trFromTask: tr_from_task,
    trEvent: tr_event,
    trToTask: tr_to_task,
    trOp: tr_op,
    trVal: tr_val,
    nScenarios: n_scenarios,
    scenProb: scen_prob,
    scenActive: scen_active,
    peScen: pe_scen,
    peToTask: pe_to_task,
    peFromTask: pe_from_task,
    peEvent: pe_event,
    sinkScen: sink_scen,
    sinkTask: sink_task,
    xorSemantics: xor_semantics,
    latFeatureIdx: lat_feature_idx,
    maxLatInt: MAX_LAT_INT,
  };
}
