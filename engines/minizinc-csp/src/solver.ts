import * as path from 'path';
import { DznBuilder } from './dzn_builder';
import { MiniZincRunner } from './minizinc_runner';

export class Solver {
    private readonly SOLVER_NAME = 'gecode';
    private readonly tmpDir = path.resolve(__dirname, '../tmp_minizinc');
    private readonly builder = new DznBuilder();
    private readonly runner = new MiniZincRunner();

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
        const { dznContent, features } = this.builder.build(instance, options);

        // 3. Run MiniZinc
        // minizinc --solver <SOLVER_NAME> model.mzn -
        // The '-' argument tells minizinc to read data from stdin
        const modelPath = path.resolve(__dirname, '../model/composition.mzn');

        const runResult = await this.runner.run(this.SOLVER_NAME, modelPath, dznContent, this.tmpDir);
        const timeSec = runResult.durationMs / 1000;

        if (runResult.code !== 0) {
            return {
                solution: {
                    feasible: false,
                    selection: null,
                    objective_value: null,
                },
                violations: [{ message: `MiniZinc Error: ${runResult.stderr}`, code: 'solver_error' }],
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
                        solver: this.SOLVER_NAME,
                        time_sec: timeSec,
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
                        solver: this.SOLVER_NAME,
                        time_sec: timeSec,
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

            return {
                solution: {
                    selection: selection,
                    objective_value: result.objective_value !== undefined ? result.objective_value : 0,
                    feasible: true,
                    aggregated_features: aggregated_features,
                },
                provenance: {
                    solver: this.SOLVER_NAME,
                    time_sec: timeSec,
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
            };
        }
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
