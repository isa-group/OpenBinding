import * as path from 'path';
import { DznBuilder } from './dzn_builder';
import { MiniZincRunner } from './minizinc_runner';

export class Solver {
    private readonly DEFAULT_SOLVER_NAME = 'gecode';
    private readonly tmpDir = path.resolve(__dirname, '../tmp_minizinc');
    private readonly builder = new DznBuilder();
    private readonly runner = new MiniZincRunner();

    async solve(instance: any, options: any): Promise<any> {
        const debug = Boolean(options?.debug);
        const solverName = String(options?.solver || this.DEFAULT_SOLVER_NAME);

        // 0. Best Practices Validation
        const violations = this.validateBestPractices(instance);
        if (violations.length > 0) {
            return Promise.resolve({
                solution: {
                    feasible: false,
                    selection: null,
                    objective_value: null,
                    violations: violations
                },
                diagnostics: {
                    stage: 'pre_validation',
                    reason: 'best_practices_violations',
                    violations_count: violations.length,
                },
            });
        }

        // 1. Identify Features
        const { dznContent, features } = this.builder.build(instance, options);

        // 3. Run MiniZinc
        // minizinc --solver <SOLVER_NAME> model.mzn -
        // The '-' argument tells minizinc to read data from stdin
        const modelPath = path.resolve(__dirname, '../model/composition.mzn');

        const runResult = await this.runner.run(solverName, modelPath, dznContent, this.tmpDir);
        const timeSec = runResult.durationMs / 1000;

        const diagnosticsBase = {
            solver: solverName,
            requested_solver: solverName,
            model_path: modelPath,
            duration_ms: runResult.durationMs,
            exit_code: runResult.code,
            stderr: this.truncateText(runResult.stderr),
            stdout_tail: this.truncateText(runResult.stdout, 4000),
            ...(debug ? { dzn: dznContent } : {}),
        };

        if (runResult.code !== 0) {
            return {
                solution: {
                    feasible: false,
                    selection: null,
                    objective_value: null,
                },
                violations: [{ message: `MiniZinc Error: ${runResult.stderr}`, code: 'solver_error' }],
                diagnostics: {
                    stage: 'solver_execution',
                    reason: 'non_zero_exit',
                    ...diagnosticsBase,
                },
            };
        }

        try {
            if (
                runResult.stdout.includes('=====UNSATISFIABLE=====') ||
                runResult.stdout.includes('model inconsistency detected')
            ) {
                return {
                    solution: {
                        feasible: false,
                        selection: null,
                        objective_value: null,
                    },
                    provenance: {
                        solver: solverName,
                        time_sec: timeSec,
                    },
                    diagnostics: {
                        stage: 'solver_execution',
                        reason: 'unsat_or_inconsistent',
                        ...diagnosticsBase,
                    },
                };
            }

            const lastBrace = runResult.stdout.lastIndexOf('}');
            const firstBrace = runResult.stdout.indexOf('{');
            if (firstBrace === -1 || lastBrace === -1) {
                return {
                    solution: {
                        feasible: false,
                        selection: null,
                        objective_value: null,
                    },
                    provenance: {
                        solver: solverName,
                        time_sec: timeSec,
                    },
                    diagnostics: {
                        stage: 'parse_output',
                        reason: 'json_not_found_in_stdout',
                        ...diagnosticsBase,
                    },
                };
            }

            const jsonStr = runResult.stdout.substring(firstBrace, lastBrace + 1);
            const result = JSON.parse(jsonStr);

            const taskMap = this.mapTasks(instance);
            const candMap = this.mapCandidates(instance);

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

            // RECALCULATE RAW AGGREGATED VALUES
            // We ignore result.aggregated_features from MiniZinc because they are normalized
            const aggregated_features = this.computeRawAggregatedValues(instance, selection, features);

            /*
            // OLD NORMALIZED LOGIC
            const aggregated_features: Record<string, number> = {};
            if (result.aggregated_features) {
                for (const [idxStr, val] of Object.entries(result.aggregated_features)) {
                    const fIdx = parseInt(idxStr);
                    const featName = features[fIdx - 1];
                    if (featName) {
                        aggregated_features[featName] = Number(val);
                    }
                }
            }
            */

            return {
                solution: {
                    selection: selection,
                    objective_value: result.objective_value !== undefined ? result.objective_value : 0,
                    feasible: true,
                    aggregated_features: aggregated_features,
                },
                provenance: {
                    solver: solverName,
                    time_sec: timeSec,
                },
                diagnostics: {
                    stage: 'completed',
                    ...diagnosticsBase,
                },
            };
        } catch (e) {
            return {
                solution: {
                    feasible: false,
                    selection: null,
                    objective_value: null,
                },
                violations: [{ message: `Parse Error: ${e} \nOut: ${runResult.stdout}`, code: 'parser_error' }],
                diagnostics: {
                    stage: 'parse_output',
                    reason: 'json_parse_error',
                    error: String(e),
                    ...diagnosticsBase,
                },
            };
        }
    }

    private truncateText(text: string, max = 12000): string {
        if (!text) return '';
        if (text.length <= max) return text;
        return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
    }

    private computeRawAggregatedValues(instance: any, selection: Record<string, string>, features: string[]): Record<string, number> {
        // 1. Build a map of candidates for quick lookup
        const candidateMap: Record<string, any> = {};
        if (Array.isArray(instance.candidates)) {
            instance.candidates.forEach((c: any) => {
                candidateMap[c.id] = c;
            });
        }

        // 2. Recursive traversal
        const traverse = (node: any, featId: string): number => {
            if (!node) return 0;

            const kind = node.kind || '';

            if (kind === 'TASK') {
                const taskId = node.task_id;
                const candId = selection[taskId];
                if (!candId) return 0; // Should not happen if feasible

                const cand = candidateMap[candId];
                if (!cand) return 0;

                const qos = cand.qos || cand.features || {};
                let val = qos[featId];
                if (val === undefined || val === null) return 0; // Default to 0 if missing
                return Number(val);
            }

            // Composite nodes
            const pol = instance.aggregation_policies?.[featId]?.compose?.[kind.toLowerCase()] || {};
            const fn = (pol.fn || 'SUM').toUpperCase();

            let children: any[] = [];
            if (kind === 'LOOP') {
                // Loop has body
                // Loop iterations
                let iters = node.expected_iterations;
                if (iters === undefined || iters === null) {
                    const bounds = node.bounds || {};
                    const mn = Number(bounds.min ?? 0);
                    const mx = Number(bounds.max ?? 0);
                    if (mx > 0 || mn > 0) {
                        iters = (mn + mx) / 2.0;
                    } else {
                        iters = node.iterations || 1;
                    }
                }
                const loopIters = Number(iters);
                const bodyVal = traverse(node.body, featId);

                // Default loop aggregation logic matching engines
                // If SUM/SCALED_SUM -> val * iters
                // If PROD -> val ^ iters (SCALED_PRODUCT)
                // If MAX/MIN -> val

                if (fn === 'SUM' || fn === 'SCALED_SUM') return bodyVal * loopIters;
                if (fn === 'PRODUCT' || fn === 'SCALED_PRODUCT') return Math.pow(bodyVal, loopIters);
                if (fn === 'MAX' || fn === 'MIN') return bodyVal;

                // Fallback
                return bodyVal * loopIters;
            }

            // SEQ, AND, XOR
            let explicitProbs: number[] = [];
            if (node.children) {
                children = node.children;
            } else if (node.branches) {
                children = node.branches.map((b: any) => b.child);
                explicitProbs = node.branches.map((b: any) => b.p || 0);
            }

            const childVals = children.map(c => traverse(c, featId));

            if (kind === 'XOR') {
                // XOR uses probability weighted sum usually, or MAX/MIN
                // If fn is MAX -> max(childVals)
                // If fn is MIN -> min(childVals)
                // If fn is SCALED_SUM (default for XOR) -> sum(prob * val)

                if (fn === 'MAX') return Math.max(...childVals);
                if (fn === 'MIN') return Math.min(...childVals);

                // Default Weighted Sum
                let sum = 0;
                for (let i = 0; i < childVals.length; i++) {
                    // If explicit probs exist (from branches), use them
                    // If not (e.g. from children list), assume equal? XOR usually has branches with probs.
                    // The JSON usually has `branches` for XOR.
                    let p = explicitProbs[i] !== undefined ? explicitProbs[i] : (1.0 / childVals.length);
                    sum += p * childVals[i];
                }
                return sum;
            }

            // SEQ, AND (FLOW) usually SUM or MAX or PRODUCT
            if (fn === 'SUM' || fn === 'SCALED_SUM') {
                return childVals.reduce((a, b) => a + b, 0);
            }
            if (fn === 'PRODUCT' || fn === 'SCALED_PRODUCT') {
                return childVals.reduce((a, b) => a * b, 1);
            }
            if (fn === 'MAX') {
                return Math.max(...childVals);
            }
            if (fn === 'MIN') {
                return Math.min(...childVals);
            }

            // Default fallback
            return childVals.reduce((a, b) => a + b, 0);
        };

        const result: Record<string, number> = {};
        const root = instance.composition?.root;
        if (root) {
            features.forEach(featId => {
                result[featId] = traverse(root, featId);
            });
        }
        return result;
    }

    private validateBestPractices(instance: any): Array<Record<string, unknown>> {
        const violations: Array<Record<string, unknown>> = [];
        const tasks = Array.isArray(instance.tasks) ? instance.tasks : [];
        const definedTaskIds = new Set<string>(
            tasks
                .map((t: any) => t.id)
                .filter((id: unknown): id is string => typeof id === 'string')
        );
        const usedTaskIds = new Set<string>();

        const traverse = (node: any): void => {
            if (!node) {
                return;
            }

            if (node.kind === 'TASK' && node.task_id) {
                usedTaskIds.add(node.task_id);
            }

            if (Array.isArray(node.children)) {
                node.children.forEach((child: any) => traverse(child));
            }

            if (Array.isArray(node.branches)) {
                node.branches.forEach((branch: any) => traverse(branch?.child));
            }

            if (node.body) {
                traverse(node.body);
            }
        };

        if (instance.composition && instance.composition.root) {
            traverse(instance.composition.root);
        }

        definedTaskIds.forEach((tid) => {
            if (!usedTaskIds.has(tid)) {
                violations.push({
                    message: `Task '${tid}' is defined but not used in the composition.`,
                    code: 'unused_task_warning',
                    constraint_id: null,
                });
            }
        });

        const obj = instance.objective || {};
        if (obj.type === 'weighted_sum' && obj.weights) {
            const weights = Object.values(obj.weights).map((w: any) => Number(w));
            const sum = weights.reduce((a, b) => a + Math.abs(b), 0);
            if (sum === 0 && weights.length > 0) {
                violations.push({
                    message: 'Objective has all zero weights. Optimization effectively disabled.',
                    code: 'zero_weights_warning',
                    constraint_id: null,
                });
            }
        }

        return violations;
    }

    private mapTasks(instance: any): Record<number, string> {
        const map: Record<number, string> = {};
        if (!Array.isArray(instance.tasks)) {
            return map;
        }

        instance.tasks.forEach((t: any, i: number) => {
            if (t?.id) {
                map[i + 1] = t.id;
            }
        });

        return map;
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
