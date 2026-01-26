import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export class Solver {
    private readonly SOLVER_NAME = 'gecode'; // TODO: Make this configurable. For now, only gecode is supported.

    async solve(instance: any, options: any): Promise<any> {
        const jobName = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const dznPath = path.join('/tmp', `${jobName}.dzn`);

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

        // 1. Transform Instance to DZN
        const dznContent = this.transformToDZN(instance, options);
        await fs.writeFile(dznPath, dznContent);

        // 2. Run MiniZinc
        // minizinc --solver <SOLVER_NAME> model.mzn data.dzn
        const modelPath = path.resolve(__dirname, '../model/composition.mzn');
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            // NOTE: Removed '--output-mode', 'json' to rely on the custom 'output' item in .mzn
            // which includes 'objective_value' and 'selection'.
            const minizinc = spawn('minizinc', ['--solver', this.SOLVER_NAME, modelPath, dznPath]);

            let stdout = '';
            let stderr = '';

            minizinc.stdout.on('data', (data) => stdout += data.toString());
            minizinc.stderr.on('data', (data) => stderr += data.toString());

            minizinc.on('close', async (code) => {
                const endTime = Date.now();
                const timeSec = (endTime - startTime) / 1000;

                console.log(`MiniZinc process exited with code ${code}`);
                if (stdout) console.log(`MiniZinc Stdout: ${stdout}`);
                if (stderr) console.error(`MiniZinc Stderr: ${stderr}`);

                await fs.unlink(dznPath).catch(() => { }); // Cleanup

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
                    // We expect a valid JSON string from the 'output' item in the .mzn file.
                    // However, MiniZinc might print "----------" or other delimiters.
                    // We look for the JSON block { ... }
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
                    console.log("Parsing JSON string:", jsonStr);
                    const result = JSON.parse(jsonStr);

                    // Map selected candidates back to IDs
                    // Result.selection is { "1": 5, "2": 3 } (task_idx -> cand_idx)
                    // We need to map back to task_id -> cand_id

                    const taskMap = this.mapTasks(instance); // task_idx -> task_id
                    const candMap = this.mapCandidates(instance); // cand_idx -> cand_id

                    const selection: Record<string, string> = {};

                    if (Array.isArray(result.selected_cand)) {
                        // Fallback if MZN output format changes back to array
                        result.selected_cand.forEach((cIdx: number, idx: number) => {
                            const taskIdx = idx + 1;
                            const tId = taskMap[taskIdx];
                            const cId = candMap[cIdx.toString()];
                            if (tId && cId) {
                                selection[tId] = cId;
                            }
                        });
                    } else if (result.selection) {
                        // Custom output from .mzn
                        for (const [tIdx, cIdx] of Object.entries(result.selection)) {
                            // key is string "1", val is number/string
                            const tId = taskMap[parseInt(tIdx)];
                            const cId = candMap[String(cIdx)];
                            if (tId && cId) {
                                selection[tId] = cId;
                            }
                        }
                    }

                    resolve({
                        solution: {
                            selection: selection,
                            objective_value: result.objective_value !== undefined ? result.objective_value : 0,
                            feasible: true
                        },
                        provenance: {
                            solver: this.SOLVER_NAME,
                            time_sec: timeSec
                        }
                    });
                } catch (e) {
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

    private transformToDZN(instance: any, options: any): string {
        // Helper to format arrays
        const fmt = (arr: any[]) => `[${arr.join(', ')}]`;
        const fmt2d = (arr: any[][]) => `[| ${arr.map(r => r.join(', ')).join(' | ')} |]`;

        const tasks = instance.tasks || [];
        const candidates = instance.candidates || [];
        const n_tasks = tasks.length;
        const n_candidates = candidates.length;

        // Identify task indices (1-based)
        const taskIdx: Record<string, number> = {};
        tasks.forEach((t: any, i: number) => taskIdx[t.id] = i + 1);

        // Identify provider indices (1-based)
        const providerIdx: Record<string, number> = {};
        if (instance.providers) {
            instance.providers.forEach((p: any, i: number) => providerIdx[p.id] = i + 1);
        }

        // --- 1. Compute Per-Task Candidate Lists & Bounds ---
        // We need:
        // - max_cands_per_task
        // - task_cands[t, c_idx] -> cand_index (global)
        // - n_task_cands[t]
        // - candidate_provider (global map)

        // Also Compute Bounds for Domains
        // COST_UB: Sum over tasks of their max cost candidate
        // TIME_UB: Sum over tasks of their max time candidate (Worst case SEQ)

        const task_candidates_map: number[][] = Array.from({ length: n_tasks + 1 }, () => []);

        const c_cost_arr: number[] = [];
        const c_time_arr: number[] = [];
        const c_rel_arr: number[] = [];
        const c_avail_arr: number[] = [];
        const c_sec_arr: number[] = [];
        const cand_provider: number[] = [];

        // Global candidate properties
        candidates.forEach((c: any, i: number) => {
            const global_idx = i + 1;
            const t_id = taskIdx[c.task_id];

            // Populate per-task list
            if (t_id) {
                task_candidates_map[t_id].push(global_idx);
            }

            cand_provider.push(providerIdx[c.provider_id] || 0);

            const q = c.qos || {};
            c_cost_arr.push(q.cost || 0);
            c_time_arr.push(q.time || 0);
            c_rel_arr.push(q.reliability || 1.0);
            c_avail_arr.push(q.availability || 1.0);
            c_sec_arr.push(q.security || 1.0);
        });

        // Compute Max Candidates Per Task for Matrix Size
        let max_cands_per_task = 0;
        for (let t = 1; t <= n_tasks; t++) {
            if (task_candidates_map[t].length > max_cands_per_task) {
                max_cands_per_task = task_candidates_map[t].length;
            }
        }
        if (max_cands_per_task === 0) max_cands_per_task = 1; // Avoid 0 size

        // Pad task_cands matrix
        const task_cands: number[][] = []; // 1-based logic, 0-index in JS
        const n_task_cands: number[] = [];

        // Compute UB
        let COST_UB = 0.0;
        let TIME_UB = 0.0;

        for (let t = 1; t <= n_tasks; t++) {
            const cands = task_candidates_map[t];
            n_task_cands.push(cands.length);

            // Pad
            const row = [...cands];
            while (row.length < max_cands_per_task) {
                row.push(1); // Dummy filler, won't be picked if constraint holds
            }
            task_cands.push(row);

            // Bounds accumulation
            if (cands.length > 0) {
                const max_cost = Math.max(...cands.map(ci => c_cost_arr[ci - 1]));
                const max_time = Math.max(...cands.map(ci => c_time_arr[ci - 1]));
                COST_UB += max_cost;
                TIME_UB += max_time;
            }
        }

        // Safety margin for float errors or structure overhead
        if (COST_UB === 0) COST_UB = 1000000.0;
        if (TIME_UB === 0) TIME_UB = 1000000.0;

        // --- 2. Flatten Tree & Identify Root ---
        const nodes: any[] = [];

        // Recursive traversal
        const traverse = (node: any): number => {
            const myIdx = nodes.length + 1;
            const nodeEntry = {
                kind: this.getKind(node.kind),
                task_id: node.kind === 'TASK' ? taskIdx[node.task_id] : 0,
                children: [] as number[],
                xor_probs: [] as number[]
            };
            nodes.push(nodeEntry);

            if (node.children) {
                for (const child of node.children) {
                    const childIdx = traverse(child);
                    nodeEntry.children.push(childIdx);
                    nodeEntry.xor_probs.push(0.0);
                }
            } else if (node.branches) { // XOR
                for (const br of node.branches) {
                    const childIdx = traverse(br.child);
                    nodeEntry.children.push(childIdx);
                    nodeEntry.xor_probs.push(br.p);
                }
            } else if (node.body) { // LOOP (Not fully supported, treat as SEQ child)
                const childIdx = traverse(node.body);
                nodeEntry.children.push(childIdx);
                nodeEntry.xor_probs.push(0.0);
            }
            return myIdx;
        };

        const root = instance.composition.root;
        let root_id = 1;
        if (root) {
            root_id = traverse(root); // Should be 1 because we traverse recursively pushing to array
        }
        // Since traverse returns the index of the node *after* it's pushed, 
        // and we start root traversal first, the root of the tree is actually the *last* node processed?
        // Wait, traverse(root) calls traverse(child).
        // nodes.push is CALLED at start of function.
        // So Root is pushed FIRST. index 1.
        // children (recursive) key pushed AFTER.
        // So root_id is indeed 1. Verified.

        const n_nodes = nodes.length;
        const max_children = Math.max(1, ...nodes.map(n => n.children.length));

        // Helper to pad arrays
        const pad = (arr: number[], len: number, val: number) =>
            [...arr, ...Array(Math.max(0, len - arr.length)).fill(val)];

        const node_kind = nodes.map(n => n.kind);
        const node_task_id = nodes.map(n => n.task_id);
        const node_n_children = nodes.map(n => n.children.length);
        const node_children = nodes.map(n => pad(n.children, max_children, 0)); 
        const node_xor_probs = nodes.map(n => pad(n.xor_probs, max_children, 0.0));

        // Objective
        const obj = instance.objective || {};
        const w = obj.weights || {};

        // --- 3. Constraints ---
        const constraints = instance.constraints || [];
        const attrMap: Record<string, number> = { "cost": 1, "time": 2, "reliability": 3, "availability": 4, "security": 5 };
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
            if (c.kind === 'attribute_bound') {
                const attr = attrMap[c.attribute_id];
                const op = opMap[c.op];
                if (!attr || !op) continue;

                if (c.scope === 'global') {
                    gc_attr.push(attr);
                    gc_op.push(op);
                    gc_val.push(c.value);
                } else if (c.scope === 'local' && c.task_id) {
                    const tIdx = taskIdx[c.task_id];
                    if (tIdx) {
                        lc_task.push(tIdx);
                        lc_attr.push(attr);
                        lc_op.push(op);
                        lc_val.push(c.value);
                    }
                }
            } else if (c.kind === 'dependency') {
                const tIndices = (c.tasks || []).map((tid: string) => taskIdx[tid]).filter((i: any) => i);
                if (tIndices.length < 2) continue;

                if (c.type === 'same_provider') {
                    for (let i = 0; i < tIndices.length - 1; i++) {
                        dc_type.push(1);
                        dc_t1.push(tIndices[i]);
                        dc_t2.push(tIndices[i + 1]);
                    }
                } else if (c.type === 'different_provider') {
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

        return `
        % --- Generated Data ---
        root_id = ${root_id};
        PROB_EPS = 1e-6;

        COST_UB = ${COST_UB};
        TIME_UB = ${TIME_UB};

        n_tasks = ${n_tasks};
        n_candidates = ${n_candidates};
        n_nodes = ${n_nodes};
        max_children = ${max_children};

        max_cands_per_task = ${max_cands_per_task};
        n_task_cands = ${fmt(n_task_cands)};
        task_cands = ${fmt2d(task_cands)};

        candidate_provider = ${fmt(cand_provider)};

        c_cost = ${fmt(c_cost_arr)};
        c_time = ${fmt(c_time_arr)};
        c_rel = ${fmt(c_rel_arr)};
        c_avail = ${fmt(c_avail_arr)};
        c_sec = ${fmt(c_sec_arr)};

        node_kind = ${fmt(node_kind)};
        node_task_id = ${fmt(node_task_id)};
        node_n_children = ${fmt(node_n_children)};
        node_children = ${fmt2d(node_children)};
        node_xor_probs = ${fmt2d(node_xor_probs)};

        w_cost = ${w.cost || 0.0};
        w_time = ${w.time || 0.0};
        w_rel = ${w.reliability || 0.0};
        w_avail = ${w.availability || 0.0};
        w_sec = ${w.security || 0.0};

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
            const sum = weights.reduce((a, b) => a + b, 0);
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
