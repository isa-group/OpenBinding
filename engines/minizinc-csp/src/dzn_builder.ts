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
    const fmt = (arr: any[]) => `[${arr.join(', ')}]`;
    const fmt2d = (arr: any[][]) => {
      if (arr.length === 0) return `[| |]`;
      return `[| ${arr.map((r) => r.join(', ')).join(' | ')} |]`;
    };

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

    const scaleValue = (val: number, featId: string): number => {
      const range = featureRanges[featId] || { min: 0.0, max: 1.0 };
      const denom = range.max - range.min;
      if (Math.abs(denom) < 1e-12 || !Number.isFinite(val)) return 0.0;
      let scaled = (val - range.min) / denom;
      if (scaled < 0.0) scaled = 0.0;
      if (scaled > 1.0) scaled = 1.0;
      if (!Number.isFinite(scaled)) return 0.0;
      return scaled;
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

    const agg_policy: number[][] = [];

    for (const feat of features) {
      const pol = (instance.aggregation_policies || {})[feat] || {};
      const compose = pol.compose || {};

      const row: number[] = [];
      row.push(DEFAULT_FN);
      row.push(FN_MAP[compose.seq?.fn?.toLowerCase()] || DEFAULT_FN);
      row.push(FN_MAP[compose.and?.fn?.toLowerCase()] || FN_MAP.max);
      row.push(FN_MAP[compose.xor?.fn?.toLowerCase()] || 5);
      row.push(FN_MAP[compose.loop?.fn?.toLowerCase()] || DEFAULT_FN);
      agg_policy.push(row);
    }

    const taskIdx: Record<string, number> = {};
    tasks.forEach((t: any, i: number) => (taskIdx[t.id] = i + 1));

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
        row.push(scaled);
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

    const qos_ub: number[] = [];
    for (let f = 0; f < n_qos; f++) {
      const featId = features[f];
      const isAvailability =
        featId.toLowerCase().includes('availability') || featId.toLowerCase().includes('success');

      const featDef = featureDefinitions.find((feat: any) => feat.id === featId) || {};
      const featDir = (featDef.direction || 'MINIMIZE').toUpperCase();
      const neutralRaw =
        (instance.aggregation_policies?.[featId]?.neutral as number | undefined) ??
        (featDir === 'MAXIMIZE' ? featDef.valid_range?.min : featDef.valid_range?.max);
      const neutralScaled =
        neutralRaw !== undefined && neutralRaw !== null
          ? scaleValue(Number(neutralRaw), featId)
          : 0.0;

      let constraintMax = 0.0;
      for (const c of constraints) {
        if ((c.kind || '').toLowerCase() !== 'attribute_bound') continue;
        if (c.attribute_id !== featId) continue;

        if (typeof c.value === 'number') {
          constraintMax = Math.max(constraintMax, scaleValue(Number(c.value), featId));
        } else if (c.value && typeof c.value === 'object') {
          const minVal = c.value.min;
          const maxVal = c.value.max;
          if (minVal !== undefined && minVal !== null) {
            constraintMax = Math.max(constraintMax, scaleValue(Number(minVal), featId));
          }
          if (maxVal !== undefined && maxVal !== null) {
            constraintMax = Math.max(constraintMax, scaleValue(Number(maxVal), featId));
          }
        }
      }

      let maxVal = 1.0;
      if (candidates.length > 0 && cand_qos.length > 0) {
        maxVal = Math.max(1.0, ...cand_qos.map((row) => Math.abs(row[f])));
      }

      maxVal = Math.max(maxVal, neutralScaled, constraintMax);

      const seqPol = agg_policy[f]?.[1] || 1;
      const loopPol = agg_policy[f]?.[4] || 1;

      if (isAvailability || seqPol === 2 || loopPol === 2) {
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
        qos_ub.push(Math.max(1.0, taskSum * loopFactor));
      } else {
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
        loopIters = Math.round(iters || 1);
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

    const opMap: Record<string, number> = { '<=': 1, '>=': 2, '==': 3, '<': 4, '>': 5 };

    const gc_attr: number[] = [];
    const gc_op: number[] = [];
    const gc_val: number[] = [];

    const lc_task: number[] = [];
    const lc_attr: number[] = [];
    const lc_op: number[] = [];
    const lc_val: number[] = [];

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
        const op = opMap[opRaw];
        const validOp = opMap[c.op] || opMap[opRaw];

        if (!attrIdx || !validOp) continue;

        if (scope === 'global') {
          gc_attr.push(attrIdx);
          gc_op.push(validOp);
          gc_val.push(scaleValue(c.value, featId));
        } else if (scope === 'local') {
          const taskId = c.task_id || (c.tasks && c.tasks[0]);
          const tIdx = taskId ? taskIdx[taskId] : undefined;
          if (tIdx) {
            lc_task.push(tIdx);
            lc_attr.push(attrIdx);
            lc_op.push(validOp);
            lc_val.push(scaleValue(c.value, featId));
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
        }
      }
    }

    const taskOrder = [...tasks].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    const task_order = taskOrder.map((t: any) => taskIdx[t.id]);

    const candidatesByTask: Record<string, { id: string; index: number }[]> = {};
    candidates.forEach((c: any, i: number) => {
      if (!candidatesByTask[c.task_id]) candidatesByTask[c.task_id] = [];
      candidatesByTask[c.task_id].push({ id: c.id, index: i + 1 });
    });
    const cand_rank = Array(n_candidates).fill(0);
    for (const t of tasks) {
      const list = (candidatesByTask[t.id] || []).slice();
      list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      list.forEach((c, i) => {
        cand_rank[c.index - 1] = i;
      });
    }

    const tie_base = max_cands_per_task + 1;
    const tie_eps = 1e-9;
    const tie_weights: number[] = [];
    let denom = tie_base;
    for (let i = 0; i < n_tasks; i++) {
      const weight = denom > 0 && Number.isFinite(denom) ? 1.0 / denom : 0.0;
      tie_weights.push(weight);
      denom *= tie_base;
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
        qos_ub = ${fmt(qos_ub)};
        tie_eps = ${tie_eps};
        tie_weights = ${fmt(tie_weights)};
        cand_rank = ${fmt(cand_rank)};
        task_order = ${fmt(task_order)};

        n_global_constraints = ${gc_attr.length};
        gc_attr = ${fmt(gc_attr)};
        gc_op = ${fmt(gc_op)};
        gc_val = ${fmt(gc_val)};

        n_local_constraints = ${lc_task.length};
        lc_task = ${fmt(lc_task)};
        lc_attr = ${fmt(lc_attr)};
        lc_op = ${fmt(lc_op)};
        lc_val = ${fmt(lc_val)};

        n_dep_constraints = ${dc_type.length};
        dc_type = ${fmt(dc_type)};
        dc_t1 = ${fmt(dc_t1)};
        dc_t2 = ${fmt(dc_t2)};
        `;
  }

  private getKind(k: string): number {
    if (k === 'TASK') return 1;
    if (k === 'SEQ') return 2;
    if (k === 'AND') return 3;
    if (k === 'XOR') return 4;
    if (k === 'LOOP') return 5;
    if (k === 'ELEMENT') return 2;
    return 0;
  }
}
