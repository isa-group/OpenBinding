import { encodeConstraints } from './encoders/constraints';
import { encodePlacement } from './encoders/placement';
import { encodeFeatures } from './encoders/features';
import { LAT_SCALE, fmt, fmt2d, fmtA2d, requireInt, scaleLat } from './encoders/format';
import { PlacementModel, declaresNormalization } from './placement';

export interface DznBuildResult {
  dznContent: string;
  features: string[];
}

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
    // Derived from the optional resource_model / latency_model blocks; empty
    // when the instance carries neither.
    const model = new PlacementModel(instance);

    const tasks = instance.tasks || [];
    const candidates = instance.candidates || [];
    const n_tasks = tasks.length;
    const n_candidates = candidates.length;

    const n_qos = features.length;
    const featureEncoding = encodeFeatures(instance, features);
    const featureDirection = featureEncoding.direction;
    const featureRanges = featureEncoding.range;
    const featureMap = featureEncoding.index;
    const featureUsesProductSpace = featureEncoding.usesProductSpace;
    const agg_policy = featureEncoding.aggPolicy;
    const toModelValue = (value: number, featureId: string) =>
      featureEncoding.toModelValue(value, featureId);
    // Raw values reach the model unclamped: the reference evaluator does not
    // clamp into valid_range either, and constraint bounds may legally lie
    // outside it.
    const scaleValue = (value: number, _featureId: string): number =>
      Number.isFinite(value) ? value : 0.0;

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
      const featRange = featureRanges[featId];
      const neutralRaw =
        (instance.aggregation_policies?.[featId]?.neutral as number | undefined) ??
        (featureDirection[featId] === 'MAXIMIZE' ? featRange?.min : featRange?.max);
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

      const featRange = featureRanges[featId];
      const neutralRaw =
        (instance.aggregation_policies?.[featId]?.neutral as number | undefined) ??
        (featureDirection[featId] === 'MAXIMIZE' ? featRange?.min : featRange?.max);
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

    const constraintEncoding = encodeConstraints(
      instance, featureEncoding, taskIdx, candidateIdx, candidates, model.pools.length > 0
    );
    const gc_attr = constraintEncoding.globalAttr;
    const gc_op = constraintEncoding.globalOp;
    const gc_val = constraintEncoding.globalValue;
    const lc_task = constraintEncoding.localTask;
    const lc_attr = constraintEncoding.localAttr;
    const lc_op = constraintEncoding.localOp;
    const lc_val = constraintEncoding.localValue;
    const excluded_task = constraintEncoding.excludedTask;
    const excluded_cand = constraintEncoding.excludedCand;
    const dc_type = constraintEncoding.depType;
    const dc_t1 = constraintEncoding.depFirst;
    const dc_t2 = constraintEncoding.depSecond;

    // ------------------------------------------------------------------
    // Placement arrays (R and L), always emitted
    // ------------------------------------------------------------------
    const placement = encodePlacement(
      instance, model, featureEncoding, candidates, taskIdx, n_tasks
    );
    const {
      nPools: n_pools, nResources: n_resources, nEvents: n_events,
      candPool: cand_pool, candDemand: cand_demand, candExecLat: cand_exec_lat,
      poolLat: pool_lat, eventLat: event_lat,
      capPool: cap_pool, capRes: cap_res, capLimit: cap_limit,
      trFromTask: tr_from_task, trEvent: tr_event, trToTask: tr_to_task,
      trOp: tr_op, trVal: tr_val,
      nScenarios: n_scenarios, scenProb: scen_prob, scenActive: scen_active,
      peScen: pe_scen, peToTask: pe_to_task, peFromTask: pe_from_task, peEvent: pe_event,
      sinkScen: sink_scen, sinkTask: sink_task,
      xorSemantics: xor_semantics, latFeatureIdx: lat_feature_idx, maxLatInt: MAX_LAT_INT,
    } = placement;

    // The canonical objective is selected by declared normalization, not by
    // the presence of placement, and matches the gateway rule.
    const use_canonical =
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
