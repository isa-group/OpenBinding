import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class Solver {
    private readonly SOLVER_NAME = 'gecode';
    private readonly tmpDir = path.resolve(__dirname, '../tmp_minizinc');

    async solve(instance: any, options: any): Promise<any> {
        // 0. Best Practices Validation
        const violations = this.validateBestPractices(instance);
        if (violations.length > 0) {
            return Promise.resolve({
                solution: {
                    feasible: false,
                    selection: null,
                    objective_value: null,
                    violations: violations
                }
            });
        }

        // 1. Identify Features
        const features = this.getFeatures(instance);

        // 2. Transform Instance to DZN
        const dznContent = this.transformToDZN(instance, features, options);

        if (instance.metadata?.id?.includes('pautasso')) {
            console.warn(`[Pautasso Debug] DZN Content Sample: ${dznContent.substring(0, 500)}`);
        }

        // 3. Run MiniZinc
        // minizinc --solver <SOLVER_NAME> model.mzn -
        // The '-' argument tells minizinc to read data from stdin
        const modelPath = path.resolve(__dirname, '../model/composition.mzn');
        const startTime = Date.now();


        return new Promise((resolve, reject) => {
            const args = ['--solver', this.SOLVER_NAME, modelPath, '-'];

            // Ensure TMPDIR directory exists for MiniZinc
            if (!fs.existsSync(this.tmpDir)) {
                fs.mkdirSync(this.tmpDir, { recursive: true });
            }
            const env = { ...process.env, TMPDIR: this.tmpDir };

            const minizinc = spawn('minizinc', args, { env });

            let stdout = '';
            let stderr = '';

            minizinc.stdout.on('data', (data) => stdout += data.toString());
            minizinc.stderr.on('data', (data) => stderr += data.toString());

            // Write DZN content to stdin
            minizinc.stdin.write(dznContent);
            minizinc.stdin.end();

            minizinc.on('close', async (code) => {
                const endTime = Date.now();
                const timeSec = (endTime - startTime) / 1000;

                console.log(`MiniZinc process exited with code ${code}`);
                if (stdout) console.log(`MiniZinc Stdout: ${stdout}`);
                if (stderr) console.error(`MiniZinc Stderr: ${stderr}`);

                if (code !== 0) {
                    return resolve({
                        solution: {
                            feasible: false,
                            selection: null,
                            objective_value: null
                        },
                        violations: [{ message: `MiniZinc Error: ${stderr}`, code: "solver_error" }]
                    });
                }

                try {
                    // Check for UNSATISFIABLE
                    if (stdout.includes("=====UNSATISFIABLE=====") || stdout.includes("model inconsistency detected")) {
                        return resolve({
                            solution: {
                                feasible: false,
                                selection: null,
                                objective_value: null
                            },
                            provenance: {
                                solver: this.SOLVER_NAME,
                                time_sec: timeSec
                            }
                        });
                    }

                    // MiniZinc Output Handling
                    const lastBrace = stdout.lastIndexOf('}');
                    const firstBrace = stdout.indexOf('{');
                    if (firstBrace === -1 || lastBrace === -1) {
                        console.warn("No JSON block found in MiniZinc output");
                        return resolve({
                            solution: {
                                feasible: false,
                                selection: null,
                                objective_value: null
                            },
                            provenance: {
                                solver: this.SOLVER_NAME,
                                time_sec: timeSec
                            }
                        });
                    }

                    const jsonStr = stdout.substring(firstBrace, lastBrace + 1);
                    const result = JSON.parse(jsonStr);

                    // Map selected candidates back to IDs
                    const taskMap = this.mapTasks(instance); // task_idx -> task_id
                    const candMap = this.mapCandidates(instance); // cand_idx -> cand_id

                    const selection: Record<string, string> = {};

                    if (Array.isArray(result.selected_cand)) {
                        result.selected_cand.forEach((cIdx: number, idx: number) => {
                            const taskIdx = idx + 1;
                            const tId = taskMap[taskIdx];
                            const cId = candMap[cIdx.toString()];
                            if (tId && cId) {
                                selection[tId] = cId;
                            }
                        });
                    } else if (result.selection) {
                        for (const [tIdx, cIdx] of Object.entries(result.selection)) {
                            const tId = taskMap[parseInt(tIdx)];
                            const cId = candMap[String(cIdx)];
                            if (tId && cId) {
                                selection[tId] = cId;
                            }
                        }
                    }

                    // Map Aggregated Features: Indices -> Feature IDs
                    const aggregated_features: Record<string, number> = {};
                    if (result.aggregated_features) {
                        for (const [idxStr, val] of Object.entries(result.aggregated_features)) {
                            const fIdx = parseInt(idxStr);
                            // featureMap reverses: name -> idx. We need idx -> name
                            // features array is sorted: 0-based. fIdx is 1-based.
                            const featName = features[fIdx - 1];
                            if (featName) {
                                aggregated_features[featName] = Number(val);
                            }
                        }
                    }

                    // Handle Normalized Objective Scaling
                    // If objective was normalized, the result might be scaled.
                    // But actually minizinc result is just the sum.
                    // If using normalized weights, the result is in normalized range (0-1 approx).
                    // We just pass it through.

                    if (Object.keys(selection).length === 0 && Array.isArray(result.selected_cand) && result.selected_cand.length > 0) {
                        console.warn(`[MiniZinc Solver] Returned solution with 0 selection entries.`);
                        console.warn(`result.selected_cand: ${JSON.stringify(result.selected_cand)}`);
                        console.warn(`taskMap keys: ${Object.keys(taskMap).join(',')}`);
                        console.warn(`candMap keys (sample 10): ${Object.keys(candMap).slice(0, 10).join(',')}`);
                    }

                    resolve({
                        solution: {
                            selection: selection,
                            objective_value: result.objective_value !== undefined ? result.objective_value : 0,
                            feasible: true,
                            aggregated_features: aggregated_features
                        },
                        provenance: {
                            solver: this.SOLVER_NAME,
                            time_sec: timeSec
                        }
                    });
                } catch (e) {
                    console.error("Critical error parsing MiniZinc result:", e);
                    console.error("Raw Stdout:", stdout);
                    resolve({
                        solution: {
                            feasible: false,
                            selection: null,
                            objective_value: null
                        },
                        violations: [{ message: `Parse Error: ${e} \nOut: ${stdout}`, code: "parser_error" }]
                    });
                }
            });
        });
    }

    private getFeatures(instance: any): string[] {
        // 1. Collect all declared features from instance.features or fallback to keys in agg policies or candidates
        const declaredFeatures = (instance.features || []).map((f: any) => f.id);
        const featureSet = new Set<string>(declaredFeatures);

        // Also scan policies
        if (instance.aggregation_policies) {
            Object.keys(instance.aggregation_policies).forEach(k => featureSet.add(k));
        }

        // Scan candidates for any extra keys? (Optional, maybe stick to declared to avoid garbage)
        // Let's stick to featureSet. If empty, scan one candidate.
        if (featureSet.size === 0 && instance.candidates && instance.candidates.length > 0) {
            const c = instance.candidates[0];
            const qosData = c.qos || c.features || {};
            Object.keys(qosData).forEach(k => featureSet.add(k));
        }

        return Array.from(featureSet).sort(); // Consistent order
    }

    private transformToDZN(instance: any, features: string[], options: any): string {
        // Helper to format arrays
        const fmt = (arr: any[]) => `[${arr.join(', ')}]`;
        const fmt2d = (arr: any[][]) => {
            if (arr.length === 0) return `[| |]`;
            // MiniZinc 2D array syntax: [| r1 | r2 | ... |]
            return `[| ${arr.map(r => r.join(', ')).join(' | ')} |]`;
        };

        const tasks = instance.tasks || [];
        const candidates = instance.candidates || [];
        const n_tasks = tasks.length;
        const n_candidates = candidates.length;

        // --- 0. Identify QoS Features & Policies ---
        // Features passed as argument
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
        features.forEach((f, i) => featureMap[f] = i + 1);

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



        // Aggregation Enums: 1=SUM, 2=PROD, 3=MAX, 4=MIN, 5=WSUM
        const FN_MAP: Record<string, number> = {
            "sum": 1, "weighted_sum": 5, "product": 2, "max": 3, "min": 4,
            "scale_by_c": 1, // Loop specific: usually means sum * c
            "scaled_sum": 1, "scaled_product": 2
        };
        const DEFAULT_FN = 1; // Sum

        // Build Aggregation Policy Matrix: [feature_idx, kind_idx]
        // Kinds: TASK=1, SEQ=2, AND=3, XOR=4, LOOP=5
        const agg_policy: number[][] = [];

        for (const feat of features) {
            const pol = (instance.aggregation_policies || {})[feat] || {};
            const compose = pol.compose || {};

            const row: number[] = [];
            // 1. TASK (N/A really, but filler)
            row.push(DEFAULT_FN);

            // 2. SEQ
            row.push(FN_MAP[compose.seq?.fn?.toLowerCase()] || DEFAULT_FN);

            // 3. AND
            row.push(FN_MAP[compose.and?.fn?.toLowerCase()] || FN_MAP.max); // Default AND to MAX

            // 4. XOR
            // Default XOR to WSUM (5) unless specified
            row.push(FN_MAP[compose.xor?.fn?.toLowerCase()] || 5);

            // 5. LOOP
            row.push(FN_MAP[compose.loop?.fn?.toLowerCase()] || DEFAULT_FN);

            agg_policy.push(row);
        }

        // --- 1. Map Tasks & Providers ---
        const taskIdx: Record<string, number> = {};
        tasks.forEach((t: any, i: number) => taskIdx[t.id] = i + 1);

        const providerIdx: Record<string, number> = {};
        if (instance.providers) {
            instance.providers.forEach((p: any, i: number) => providerIdx[p.id] = i + 1);
        }
        console.log("Provider Mapping:", JSON.stringify(providerIdx));

        // --- 2. Candidates & QoS Matrix ---
        const task_candidates_map: number[][] = Array.from({ length: n_tasks + 1 }, () => []);
        const cand_provider: number[] = [];
        const cand_qos: number[][] = []; // [cand][feat]

        candidates.forEach((c: any, i: number) => {
            const global_idx = i + 1;
            const t_id = taskIdx[c.task_id];
            if (t_id) task_candidates_map[t_id].push(global_idx);

            // QoS Values - support both 'qos' and 'features' property names
            const qosData = c.qos || c.features || {};

            let pId = providerIdx[c.provider_id];
            if (!pId) {
                console.warn(`Warning: Provider '${c.provider_id}' not found for candidate '${c.id}' (Task ${c.task_id}). Assigning unique negative ID.`);
                // Assign unique negative ID to ensure it doesn't match other unknowns (FALSE SAME_PROVIDER)
                // Use global index to ensure uniqueness
                pId = -(global_idx);
            }
            cand_provider.push(pId);

            // QoS Values - support both 'qos' and 'features' property names
            const row: number[] = [];
            for (const feat of features) {
                let val = qosData[feat];
                // Handle missing values? Default to 0? Or Worst case?
                // For logic, 0.0 is safest default unless it's reliability (should be 1?)
                // Trying to be smart: if 'product' agg, default to 1?
                // For now, default 0.0. User should provide complete data.
                if (val === undefined || val === null) val = 0.0;
                const scaled = scaleValue(Number(val), feat);
                row.push(scaled);
            }
            cand_qos.push(row);
        });

        // Max candidates per task
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
            while (row.length < max_cands_per_task) row.push(1); // Pad
            task_cands.push(row);
        }

        // --- 3. Compute Bounds (QoS UB) ---
        // Use tighter bounds to avoid Gecode float overflow
        // For SUM aggregation: max possible is sum of max candidates per task
        // We compute a reasonable upper bound based on actual data
        const qos_ub: number[] = [];
        for (let f = 0; f < n_qos; f++) {
            const featId = features[f];
            const isAvailability = featId.toLowerCase().includes('availability') || featId.toLowerCase().includes('success');

            let maxVal = 1.0;
            if (candidates.length > 0 && cand_qos.length > 0) {
                maxVal = Math.max(1.0, ...cand_qos.map(row => Math.abs(row[f])));
            }

            const seqPol = agg_policy[f]?.[1] || 1;
            const loopPol = agg_policy[f]?.[4] || 1;

            if (isAvailability || seqPol === 2 || loopPol === 2) {
                // Probabilities/Availability: always 1.0
                qos_ub.push(1.0);
            } else if (seqPol === 1 || loopPol === 1) {
                // SUM: tightly sum the max for each task
                let taskSum = 0;
                for (let t = 1; t <= n_tasks; t++) {
                    const cands = task_candidates_map[t];
                    if (cands.length > 0) {
                        taskSum += Math.max(...cands.map(cIdx => Math.abs(cand_qos[cIdx - 1][f])));
                    }
                }
                const loopFactor = 10; // Margin for loops
                qos_ub.push(Math.max(1.0, taskSum * loopFactor));
            } else {
                qos_ub.push(maxVal * 1.5);
            }
        }

        // --- 4. Flatten Tree ---
        const nodes: any[] = [];
        const traverse = (node: any): number => {
            const myIdx = nodes.length + 1;

            // LOOP iterations: support both 'iterations' and 'expected_iterations'
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
                loop_iters: loopIters
            };
            nodes.push(nodeEntry);

            if (node.children) {
                // For XOR nodes, children may have 'probability' property
                const isXOR = node.kind === 'XOR';
                for (const child of node.children) {
                    const childIdx = traverse(child);
                    nodeEntry.children.push(childIdx);
                    // Extract probability for XOR children
                    nodeEntry.xor_probs.push(isXOR ? (child.probability || 0.0) : 0.0);
                }
            } else if (node.branches) { // XOR with branches format
                for (const br of node.branches) {
                    const childIdx = traverse(br.child);
                    nodeEntry.children.push(childIdx);
                    nodeEntry.xor_probs.push(br.p || 0.0);
                }
            } else if (node.body) { // LOOP: body is single child
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
        const max_children = Math.max(1, ...nodes.map(n => n.children.length));
        const pad = (arr: number[], len: number, val: number) => [...arr, ...Array(Math.max(0, len - arr.length)).fill(val)];

        const node_kind = nodes.map(n => n.kind);
        const node_task_id = nodes.map(n => n.task_id);
        const node_n_children = nodes.map(n => n.children.length);
        const node_children = nodes.map(n => pad(n.children, max_children, 0));
        const node_xor_probs = nodes.map(n => pad(n.xor_probs, max_children, 0.0));
        const node_loop_iters = nodes.map(n => n.loop_iters);

        // --- 5. Weights ---
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

        // --- 6. Constraints ---
        const constraints = instance.constraints || [];
        const opMap: Record<string, number> = { "<=": 1, ">=": 2, "==": 3, "<": 4, ">": 5 };

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
            // Skip soft constraints for now
            if (c.hard === false) continue;

            const kind = (c.kind || '').toLowerCase();
            const scope = (c.scope || '').toLowerCase();
            const opRaw = (c.op || '').toLowerCase();
            const type = (c.type || '').toLowerCase();

            if (kind === 'attribute_bound') {
                const attrIdx = featureMap[c.attribute_id];
                const featId = c.attribute_id;
                const op = opMap[opRaw];
                // Try literal first, if not found try mapped
                // The opMap keys are like "<=" etc. formatting shouldn't change much but good to be safe
                // Actually opMap keys are symbols, so toLowerCase doesn't affect "<="
                // But let's use c.op directly for lookup if it fails?
                // Actually opMap keys are "<=", ">=", "==", "<", ">".
                // If c.op is "EQ" or "LE" etc we might need mapping.
                // Assuming c.op is symbol.
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
                // ... (Same as before)
                const tIndices = (c.tasks || []).map((tid: string) => taskIdx[tid]).filter((i: any) => i);
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
            const weight = denom > 0 && Number.isFinite(denom) ? (1.0 / denom) : 0.0;
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
        if (k === 'ELEMENT') return 2; // Treat as empty SEQ (skip)
        return 0;
    }

    private mapTasks(instance: any): Record<number, string> {
        const map: Record<number, string> = {};
        instance.tasks.forEach((t: any, i: number) => map[i + 1] = t.id);
        return map;
    }

    private validateBestPractices(instance: any): any[] {
        const violations: any[] = [];

        // 1. Disconnected Tasks (Tasks defined but not in composition)
        const definedTaskIds = new Set<string>((instance.tasks || []).map((t: any) => t.id));
        const usedTaskIds = new Set<string>();

        // Recursive traversal to find used tasks
        const traverse = (node: any) => {
            if (!node) return;
            if (node.kind === 'TASK' && node.task_id) {
                usedTaskIds.add(node.task_id);
            }
            if (node.children) {
                node.children.forEach(traverse);
            }
            if (node.branches) {
                node.branches.forEach((b: any) => traverse(b.child));
            }
            if (node.body) {
                traverse(node.body);
            }
        };

        if (instance.composition && instance.composition.root) {
            traverse(instance.composition.root);
        }

        definedTaskIds.forEach(tid => {
            if (!usedTaskIds.has(tid)) {
                violations.push({ // ValidateViolation structure
                    message: `Task '${tid}' is defined but not used in the composition.`,
                    code: "unused_task_warning",
                    constraint_id: null
                });
            }
        });

        // 2. Unweighted Objectives (Heuristic)
        // If objective is weighted_sum, check if any weight is 0 (useless?) 
        // Actually 0 weight is fine (ignoring feature). 
        // But if ALL weights are 0, optimizer does nothing.
        const obj = instance.objective || {};
        if (obj.type === 'weighted_sum' && obj.weights) {
            const weights = Object.values(obj.weights).map((w: any) => Number(w));
            const sum = weights.reduce((a, b) => a + Math.abs(b), 0);
            if (sum === 0 && weights.length > 0) {
                violations.push({
                    message: "Objective has all zero weights. Optimization effectively disabled.",
                    code: "zero_weights_warning",
                    constraint_id: null
                });
            }
        }

        return violations;
    }

    private mapCandidates(instance: any): Record<string, string> {
        const map: Record<string, string> = {};
        instance.candidates.forEach((c: any, i: number) => {
            // MiniZinc selection returns index (1-based)
            map[(i + 1).toString()] = c.id;
        });
        return map;
    }
}
