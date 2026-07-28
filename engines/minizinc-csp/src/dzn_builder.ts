import { PlacementModel, declaresNormalization } from './placement';

export interface DznBuildResult {
  dznContent: string;
  features: string[];
}

// Latencies are encoded as integers (milliseconds * LAT_SCALE) because
// Gecode propagates integers far better than floats.
const LAT_SCALE = 1000;

export class DznBuilder {
  build(instance: any, options: any): DznBuildResult {
    const features = this.getFeatures(instance);
    const dznContent = this.transformToDZN(instance, features, options);
    return { dznContent, features };
  }

  private getFeatures(instance: any): string[] {
    const declaredFeatures = (instance.features || []).map((f: any) => f.id);
    const featureSet = new Set<string>(declaredFeatures);

    if (instance.aggregation_policies) {
      Object.keys(instance.aggregation_policies).forEach((k) => featureSet.add(k));
    }

    if (featureSet.size === 0 && instance.candidates && instance.candidates.length > 0) {
      const c = instance.candidates[0];
      const qosData = c.qos || c.features || {};
      Object.keys(qosData).forEach((k) => featureSet.add(k));
    }

    return Array.from(featureSet).sort();
  }

  private transformToDZN(instance: any, features: string[], options: any): string {
    const fmt = (arr: any[]) => `[${arr.join(', ')}]`;
    const fmt2d = (arr: any[][]) => {
      if (arr.length === 0) return `[| |]`;
      return `[| ${arr.map((r) => r.join(', ')).join(' | ')} |]`;
    };

    // Loud validation: the integer-scaled CSP model must not silently distort
    // inputs. Latencies must be representable at 1/LAT_SCALE ms; resource
    // demands and capacities must be integral.
    const scaleLat = (v: number) => {
      const scaled = Number(v) * LAT_SCALE;
      const rounded = Math.round(scaled);
      if (Math.abs(scaled - rounded) > 1e-6) {
        throw new Error(
          `Latency value ${v} ms is not representable at 1/${LAT_SCALE} ms ` +
          'resolution; the integer-scaled CSP model would silently distort it'
        );
      }
      return rounded;
    };
    const requireInt = (v: number, what: string): number => {
      const n = Number(v);
      const rounded = Math.round(n);
      if (Math.abs(n - rounded) > 1e-9) {
        throw new Error(`${what} must be integral for the CSP model, got ${v}`);
      }
      return rounded;
    };
    const fmtA2d = (rows: number, cols: number, arr: number[][]) =>
      `array2d(1..${rows}, 1..${cols}, [${arr.flat().join(', ')}])`;

    // Derived from the optional resource_model / latency_model blocks; empty
    // when the instance carries neither.
    const model = new PlacementModel(instance);

    const tasks = instance.tasks || [];
    const candidates = instance.candidates || [];
    const n_tasks = tasks.length;
    const n_candidates = candidates.length;

    const n_qos = features.length;
    const featureDefinitions = instance.features || [];
    const featureDirection: Record<string, string> = {};
    featureDefinitions.forEach((f: any) => {
      featureDirection[f.id] = (f.direction || 'MINIMIZE').toUpperCase();
    });
    const featureRanges: Record<string, { min: number; max: number }> = {};
    featureDefinitions.forEach((f: any) => {
      const vr = f.valid_range || {};
      const min = Number(vr.min ?? 0.0);
      const max = Number(vr.max ?? 1.0);
      featureRanges[f.id] = { min, max };
    });
    const featureMap: Record<string, number> = {};
    features.forEach((f, i) => (featureMap[f] = i + 1));

    // The gateway reference evaluator never clamps raw values into the
    // feature's valid_range (out-of-range candidate values are rejected by
    // the gateway's semantic validation, and constraint bounds may legally
    // lie outside the range), so the engine must not clamp either.
    const scaleValue = (val: number, _featId: string): number => {
      if (!Number.isFinite(val)) return 0.0;
      return val;
    };

    const FN_MAP: Record<string, number> = {
      sum: 1,
      weighted_sum: 5,
      product: 2,
      max: 3,
      min: 4,
      scale_by_c: 1,
      scaled_sum: 1,
      scaled_product: 2,
    };
    const DEFAULT_FN = 1;

    const usesProductSpace = (featId: string): boolean => {
      const compose = (instance.aggregation_policies?.[featId]?.compose || {}) as Record<string, any>;
      const fns = [compose.seq?.fn, compose.and?.fn, compose.xor?.fn, compose.loop?.fn]
        .map((v: any) => String(v || '').toLowerCase());
      return fns.includes('product') || fns.includes('scaled_product');
    };

    const featureUsesProductSpace: Record<string, boolean> = {};
    for (const feat of features) {
      featureUsesProductSpace[feat] = usesProductSpace(feat);
    }

    const toModelValue = (scaledVal: number, featId: string): number => {
      if (!featureUsesProductSpace[featId]) {
        return scaledVal;
      }
      const safe = Math.max(1e-12, scaledVal);
      return Math.log(safe);
    };

    const agg_policy: number[][] = [];

    for (const feat of features) {
      const pol = (instance.aggregation_policies || {})[feat] || {};
      const compose = pol.compose || {};
      const productSpace = featureUsesProductSpace[feat];

      const mapFnForFeature = (fnRaw: any): number => {
        const fn = String(fnRaw || '').toLowerCase();
        if (productSpace && (fn === 'product' || fn === 'scaled_product')) {
          return 1;
        }
        return FN_MAP[fn] || DEFAULT_FN;
      };

      const row: number[] = [];
      row.push(DEFAULT_FN);
      row.push(mapFnForFeature(compose.seq?.fn));
      row.push(mapFnForFeature(compose.and?.fn) || FN_MAP.max);
      row.push(mapFnForFeature(compose.xor?.fn) || 5);
      row.push(mapFnForFeature(compose.loop?.fn));
      agg_policy.push(row);
    }

    const taskIdx: Record<string, number> = {};
    tasks.forEach((t: any, i: number) => (taskIdx[t.id] = i + 1));

    const candidateIdx: Record<string, number> = {};
    candidates.forEach((c: any, i: number) => (candidateIdx[c.id] = i + 1));

    const providerIdx: Record<string, number> = {};
    if (instance.providers) {
      instance.providers.forEach((p: any, i: number) => (providerIdx[p.id] = i + 1));
    }

    const task_candidates_map: number[][] = Array.from({ length: n_tasks + 1 }, () => []);
    const cand_provider: number[] = [];
    const cand_qos: number[][] = [];

    candidates.forEach((c: any, i: number) => {
      const global_idx = i + 1;
      const t_id = taskIdx[c.task_id];
      if (t_id) task_candidates_map[t_id].push(global_idx);

      const qosData = c.qos || c.features || {};

      let pId = providerIdx[c.provider_id];
      if (!pId) {
        pId = -global_idx;
      }
      cand_provider.push(pId);

      const row: number[] = [];
      for (const feat of features) {
        let val = qosData[feat];
        if (val === undefined || val === null) val = 0.0;
        const scaled = scaleValue(Number(val), feat);
        row.push(toModelValue(scaled, feat));
      }
      cand_qos.push(row);
    });

    let max_cands_per_task = 0;
    for (let t = 1; t <= n_tasks; t++) {
      if (task_candidates_map[t].length > max_cands_per_task) {
        max_cands_per_task = task_candidates_map[t].length;
      }
    }
    if (max_cands_per_task === 0) max_cands_per_task = 1;

    const task_cands: number[][] = [];
    const n_task_cands: number[] = [];

    for (let t = 1; t <= n_tasks; t++) {
      const cands = task_candidates_map[t];
      n_task_cands.push(cands.length);
      const row = [...cands];
      while (row.length < max_cands_per_task) row.push(1);
      task_cands.push(row);
    }

    const constraints = instance.constraints || [];

    const neutral_qos: number[] = [];
    for (const featId of features) {
      const featDef = featureDefinitions.find((feat: any) => feat.id === featId) || {};
      const featDir = (featDef.direction || 'MINIMIZE').toUpperCase();
      const neutralRaw =
        (instance.aggregation_policies?.[featId]?.neutral as number | undefined) ??
        (featDir === 'MAXIMIZE' ? featDef.valid_range?.min : featDef.valid_range?.max);
      const neutralValue =
        neutralRaw !== undefined && neutralRaw !== null
          ? toModelValue(scaleValue(Number(neutralRaw), featId), featId)
          : 0.0;
      neutral_qos.push(neutralValue);
    }

    const qos_lb: number[] = [];
    const qos_ub: number[] = [];
    for (let f = 0; f < n_qos; f++) {
      const featId = features[f];
      const productSpace = featureUsesProductSpace[featId];
      const isAvailability =
        featId.toLowerCase().includes('availability') || featId.toLowerCase().includes('success');

      const featDef = featureDefinitions.find((feat: any) => feat.id === featId) || {};
      const featDir = (featDef.direction || 'MINIMIZE').toUpperCase();
      const neutralRaw =
        (instance.aggregation_policies?.[featId]?.neutral as number | undefined) ??
        (featDir === 'MAXIMIZE' ? featDef.valid_range?.min : featDef.valid_range?.max);
      const neutralScaled =
        neutralRaw !== undefined && neutralRaw !== null
          ? toModelValue(scaleValue(Number(neutralRaw), featId), featId)
          : 0.0;

      let constraintMax = 0.0;
      for (const c of constraints) {
        if ((c.kind || '').toLowerCase() !== 'attribute_bound') continue;
        if (c.attribute_id !== featId) continue;

        if (typeof c.value === 'number') {
          constraintMax = Math.max(constraintMax, Math.abs(toModelValue(scaleValue(Number(c.value), featId), featId)));
        } else if (c.value && typeof c.value === 'object') {
          const minVal = c.value.min;
          const maxVal = c.value.max;
          if (minVal !== undefined && minVal !== null) {
            constraintMax = Math.max(constraintMax, Math.abs(toModelValue(scaleValue(Number(minVal), featId), featId)));
          }
          if (maxVal !== undefined && maxVal !== null) {
            constraintMax = Math.max(constraintMax, Math.abs(toModelValue(scaleValue(Number(maxVal), featId), featId)));
          }
        }
      }

      let maxVal = 1.0;
      if (candidates.length > 0 && cand_qos.length > 0) {
        maxVal = Math.max(1.0, ...cand_qos.map((row) => Math.abs(row[f])));
      }

      maxVal = Math.max(maxVal, Math.abs(neutralScaled), constraintMax);

      const seqPol = agg_policy[f]?.[1] || 1;
      const loopPol = agg_policy[f]?.[4] || 1;

      if (productSpace) {
        const absBound = Math.max(1.0, maxVal * Math.max(1, n_tasks) * 10);
        qos_lb.push(-absBound);
        qos_ub.push(absBound);
      } else if (isAvailability || seqPol === 2 || loopPol === 2) {
        qos_lb.push(0.0);
        qos_ub.push(1.0);
      } else if (seqPol === 1 || loopPol === 1) {
        let taskSum = 0;
        for (let t = 1; t <= n_tasks; t++) {
          const cands = task_candidates_map[t];
          if (cands.length > 0) {
            taskSum += Math.max(...cands.map((cIdx) => Math.abs(cand_qos[cIdx - 1][f])));
          }
        }
        const loopFactor = 10;
        qos_lb.push(0.0);
        qos_ub.push(Math.max(1.0, taskSum * loopFactor));
      } else {
        qos_lb.push(0.0);
        qos_ub.push(maxVal * 1.5);
      }
    }

    const nodes: any[] = [];
    const traverse = (node: any): number => {
      const myIdx = nodes.length + 1;

      let loopIters = 0.0;
      if (node.kind === 'LOOP') {
        let iters = node.expected_iterations;
        if (iters === undefined || iters === null) {
          const bounds = node.bounds || {};
          const mn = Number(bounds.min ?? 0);
          const mx = Number(bounds.max ?? 0);
          if (mx > 0 || mn > 0) {
            iters = (mn + mx) / 2.0;
          } else {
            iters = node.iterations;
          }
        }
        // The CSP model iterates loop bodies an integer number of times; a
        // fractional expected iteration count cannot be encoded faithfully.
        loopIters = requireInt(Number(iters || 1), 'LOOP expected iteration count');
      }

      const nodeEntry = {
        kind: this.getKind(node.kind),
        task_id: node.kind === 'TASK' ? taskIdx[node.task_id] : 0,
        children: [] as number[],
        xor_probs: [] as number[],
        loop_iters: loopIters,
      };
      nodes.push(nodeEntry);

      if (node.children) {
        const isXOR = node.kind === 'XOR';
        for (const child of node.children) {
          const childIdx = traverse(child);
          nodeEntry.children.push(childIdx);
          nodeEntry.xor_probs.push(isXOR ? (child.probability || 0.0) : 0.0);
        }
      } else if (node.branches) {
        for (const br of node.branches) {
          const childIdx = traverse(br.child);
          nodeEntry.children.push(childIdx);
          nodeEntry.xor_probs.push(br.p || 0.0);
        }
      } else if (node.body) {
        const childIdx = traverse(node.body);
        nodeEntry.children.push(childIdx);
        nodeEntry.xor_probs.push(0.0);
      }
      return myIdx;
    };

    const root = instance.composition.root;
    let root_id = 1;
    if (root) root_id = traverse(root);

    const n_nodes = nodes.length;
    const max_children = Math.max(1, ...nodes.map((n) => n.children.length));
    const pad = (arr: number[], len: number, val: number) => [
      ...arr,
      ...Array(Math.max(0, len - arr.length)).fill(val),
    ];

    const node_kind = nodes.map((n) => n.kind);
    const node_task_id = nodes.map((n) => n.task_id);
    const node_n_children = nodes.map((n) => n.children.length);
    const node_children = nodes.map((n) => pad(n.children, max_children, 0));
    const node_xor_probs = nodes.map((n) => pad(n.xor_probs, max_children, 0.0));
    const node_loop_iters = nodes.map((n) => n.loop_iters);

    const obj = instance.objective || {};
    const weightsObj = obj.weights || {};
    const qos_weights: number[] = [];
    for (const feat of features) {
      let w = Number(weightsObj[feat] || 0.0);
      if (featureDirection[feat] === 'MAXIMIZE') {
        w = -w;
      }
      qos_weights.push(w);
    }

    const opMap: Record<string, number> = { '<=': 1, '>=': 2, '==': 3, '<': 4, '>': 5, '!=': 6 };

    // IN_RANGE has no operator code of its own: it is the conjunction of a
    // lower and an upper bound, which is exactly what the model already knows
    // how to enforce.
    const expandOp = (op: string, value: any): Array<{ op: number; value: number }> => {
      if (op === 'in_range') {
        const range = value || {};
        return [
          { op: opMap['>='], value: Number(range.min) },
          { op: opMap['<='], value: Number(range.max) },
        ];
      }
      const code = opMap[op];
      if (code === undefined) {
        // Dropping it would let the engine report OPTIMAL for a solution that
        // breaks a hard constraint.
        throw new Error(`Unsupported attribute bound operator '${op}'`);
      }
      return [{ op: code, value: Number(value) }];
    };

    // Same tolerance and orientation as the gateway reference evaluator.
    const satisfiesBound = (current: number, op: string, value: any): boolean => {
      const EPS = 1e-6;
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
    };

    const gc_attr: number[] = [];
    const gc_op: number[] = [];
    const gc_val: number[] = [];

    const lc_task: number[] = [];
    const lc_attr: number[] = [];
    const lc_op: number[] = [];
    const lc_val: number[] = [];

    const excluded_task: number[] = [];
    const excluded_cand: number[] = [];

    const dc_type: number[] = [];
    const dc_t1: number[] = [];
    const dc_t2: number[] = [];

    for (const c of constraints) {
      if (c.hard === false) continue;

      const kind = (c.kind || '').toLowerCase();
      const scope = (c.scope || '').toLowerCase();
      const opRaw = (c.op || '').toLowerCase();
      const type = (c.type || '').toLowerCase();

      if (kind === 'attribute_bound') {
        const attrIdx = featureMap[c.attribute_id];
        const featId = c.attribute_id;
        if (!attrIdx) {
          throw new Error(`Attribute bound constraint refers to unknown feature '${c.attribute_id}'`);
        }
        const bounds = expandOp(opRaw, c.value);

        if (scope === 'global') {
          for (const bound of bounds) {
            gc_attr.push(attrIdx);
            gc_op.push(bound.op);
            gc_val.push(toModelValue(scaleValue(bound.value, featId), featId));
          }
        } else if (scope === 'local') {
          // Every task the constraint lists, not just the first one.
          const taskIds = c.task_id ? [c.task_id] : c.tasks || [];
          for (const taskId of taskIds) {
            const tIdx = taskIdx[taskId];
            if (!tIdx) continue;
            for (const bound of bounds) {
              lc_task.push(tIdx);
              lc_attr.push(attrIdx);
              lc_op.push(bound.op);
              lc_val.push(toModelValue(scaleValue(bound.value, featId), featId));
            }
          }

          // Scoping by candidate id constrains those candidates only. Their
          // feature values are data, so the ones that break the bound are
          // simply not selectable.
          for (const candidateId of c.candidates || []) {
            const cIdx = candidateIdx[candidateId];
            if (!cIdx) continue;
            const tIdx = taskIdx[candidates[cIdx - 1].task_id];
            if (!tIdx) continue;
            const raw = Number((candidates[cIdx - 1].qos || candidates[cIdx - 1].features || {})[featId] ?? 0);
            if (!satisfiesBound(raw, opRaw, c.value)) {
              excluded_task.push(tIdx);
              excluded_cand.push(cIdx);
            }
          }
        }
      } else if (kind === 'dependency') {
        const tIndices = (c.tasks || [])
          .map((tid: string) => taskIdx[tid])
          .filter((i: any) => i);
        if (tIndices.length < 2) continue;

        if (type === 'same_provider') {
          for (let i = 0; i < tIndices.length - 1; i++) {
            dc_type.push(1);
            dc_t1.push(tIndices[i]);
            dc_t2.push(tIndices[i + 1]);
          }
        } else if (type === 'different_provider') {
          for (let i = 0; i < tIndices.length; i++) {
            for (let j = i + 1; j < tIndices.length; j++) {
              dc_type.push(2);
              dc_t1.push(tIndices[i]);
              dc_t2.push(tIndices[j]);
            }
          }
        } else if (type === 'same_pool' && model.pools.length) {
          // Pool dependencies need declared pools to compare. Validation
          // rejects the instance before it reaches the engine otherwise.
          for (let i = 0; i < tIndices.length - 1; i++) {
            dc_type.push(3);
            dc_t1.push(tIndices[i]);
            dc_t2.push(tIndices[i + 1]);
          }
        } else if (type === 'different_pool' && model.pools.length) {
          for (let i = 0; i < tIndices.length; i++) {
            for (let j = i + 1; j < tIndices.length; j++) {
              dc_type.push(4);
              dc_t1.push(tIndices[i]);
              dc_t2.push(tIndices[j]);
            }
          }
        }
      }
    }


    // ------------------------------------------------------------------
    // Placement data (pools, capacities, latency matrix, scenarios)
    // ------------------------------------------------------------------
    // Derived from the optional resource_model / latency_model blocks of the
    // instance. When they are absent the model below is empty, every array
    // emitted here is empty, and the placement constraints of the MiniZinc
    // model are vacuous — there is no separate code path for that case.

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
    let use_canonical = false;

    {
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
      lat_feature_idx = latAttr ? featureMap[latAttr] || 0 : 0;
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
        scen_active = scenarios.map(() => Array(n_tasks).fill(0));
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
        MAX_LAT_INT = scaleLat(maxEventMs + n_tasks * (maxLatMs + maxExecMs) + 1);

        // Soundness of the PERT lower-bound encoding: the latency feature may
        // only be minimized or bounded from above.
        for (const c of constraints) {
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

      // Canonical objective (matches the gateway reference evaluator): selected
      // by declared normalization, not by the presence of placement blocks.
      use_canonical =
        String((instance.objective || {}).type || '').toUpperCase() === 'MONO' &&
        declaresNormalization(instance);
      if (use_canonical) {
        for (const target of (instance.objective || {}).targets || []) {
          if (featureUsesProductSpace[target]) {
            throw new Error(
              `Objective target '${target}' uses product-space aggregation, which is ` +
              'incompatible with the canonical normalized objective'
            );
          }
        }
      }
    }

    const qos_dir: number[] = [];
    const norm_lb: number[] = [];
    const norm_ub: number[] = [];
    const canon_w: number[] = [];
    const objTargets = new Set<string>(((instance.objective || {}).targets || []) as string[]);
    const objWeights = (instance.objective || {}).weights || {};
    for (const feat of features) {
      qos_dir.push(featureDirection[feat] === 'MAXIMIZE' ? -1 : 1);
      const normBounds = instance.aggregation_policies?.[feat]?.normalize?.bounds || {};
      const vr = featureRanges[feat] || { min: 0.0, max: 1.0 };
      norm_lb.push(Number(normBounds.min ?? vr.min ?? 0.0));
      norm_ub.push(Number(normBounds.max ?? vr.max ?? 1.0));
      canon_w.push(use_canonical && objTargets.has(feat) ? Math.abs(Number(objWeights[feat] ?? 1.0)) : 0.0);
    }

    return `
        root_id = ${root_id};
        PROB_EPS = 1e-6;

        n_tasks = ${n_tasks};
        n_candidates = ${n_candidates};
        n_nodes = ${n_nodes};
        n_qos = ${n_qos};
        max_children = ${max_children};

        max_cands_per_task = ${max_cands_per_task};
        n_task_cands = ${fmt(n_task_cands)};
        task_cands = ${fmt2d(task_cands)};

        cand_qos = ${fmt2d(cand_qos)};
        candidate_provider = ${fmt(cand_provider)};

        node_kind = ${fmt(node_kind)};
        node_task_id = ${fmt(node_task_id)};
        node_n_children = ${fmt(node_n_children)};
        node_children = ${fmt2d(node_children)};
        node_xor_probs = ${fmt2d(node_xor_probs)};
        node_loop_iters = ${fmt(node_loop_iters)};

        agg_policy = ${fmt2d(agg_policy)};
        
        qos_weights = ${fmt(qos_weights)};
        neutral_qos = ${fmt(neutral_qos)};
        qos_lb = ${fmt(qos_lb)};
        qos_ub = ${fmt(qos_ub)};

        n_global_constraints = ${gc_attr.length};
        gc_attr = ${fmt(gc_attr)};
        gc_op = ${fmt(gc_op)};
        gc_val = ${fmt(gc_val)};

        n_local_constraints = ${lc_task.length};
        lc_task = ${fmt(lc_task)};
        lc_attr = ${fmt(lc_attr)};
        lc_op = ${fmt(lc_op)};
        lc_val = ${fmt(lc_val)};

        n_excluded_candidates = ${excluded_cand.length};
        excluded_task = ${fmt(excluded_task)};
        excluded_cand = ${fmt(excluded_cand)};

        n_dep_constraints = ${dc_type.length};
        dc_type = ${fmt(dc_type)};
        dc_t1 = ${fmt(dc_t1)};
        dc_t2 = ${fmt(dc_t2)};

        n_pools = ${n_pools};
        n_resources = ${n_resources};
        n_events = ${n_events};
        LAT_SCALE = ${LAT_SCALE};
        MAX_LAT_INT = ${MAX_LAT_INT};
        xor_semantics = ${xor_semantics};
        lat_feature_idx = ${lat_feature_idx};

        cand_pool = ${fmt(cand_pool)};
        cand_demand = ${fmtA2d(n_candidates, n_resources, cand_demand)};
        cand_exec_lat = ${fmt(cand_exec_lat)};
        pool_lat = ${fmtA2d(n_pools, n_pools, pool_lat)};
        event_lat = ${fmtA2d(n_events, n_pools, event_lat)};

        n_cap_checks = ${cap_pool.length};
        cap_pool = ${fmt(cap_pool)};
        cap_res = ${fmt(cap_res)};
        cap_limit = ${fmt(cap_limit)};

        n_transitions = ${tr_to_task.length};
        tr_from_task = ${fmt(tr_from_task)};
        tr_event = ${fmt(tr_event)};
        tr_to_task = ${fmt(tr_to_task)};
        tr_op = ${fmt(tr_op)};
        tr_val = ${fmt(tr_val)};

        n_scenarios = ${n_scenarios};
        scen_prob = ${fmt(scen_prob)};
        scen_active = ${fmtA2d(n_scenarios, n_tasks, scen_active)};
        n_prec_edges = ${pe_scen.length};
        pe_scen = ${fmt(pe_scen)};
        pe_to_task = ${fmt(pe_to_task)};
        pe_from_task = ${fmt(pe_from_task)};
        pe_event = ${fmt(pe_event)};
        n_sinks = ${sink_scen.length};
        sink_scen = ${fmt(sink_scen)};
        sink_task = ${fmt(sink_task)};

        use_canonical = ${use_canonical};
        qos_dir = ${fmt(qos_dir)};
        norm_lb = ${fmt(norm_lb)};
        norm_ub = ${fmt(norm_ub)};
        canon_w = ${fmt(canon_w)};
        `;
  }

  private getKind(k: string): number {
    if (k === 'TASK') return 1;
    if (k === 'SEQ') return 2;
    if (k === 'AND') return 3;
    if (k === 'XOR') return 4;
    if (k === 'LOOP') return 5;
    if (k === 'ELEMENT') return 6;
    return 0;
  }
}
