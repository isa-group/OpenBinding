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
        const timeLimitMs = options?.time_limit_ms != null ? Number(options.time_limit_ms) : null;
        const intermediateSolutions = options?.intermediate_solutions !== false;

        // Semantic validation is the gateway's: by the time a request gets
        // here it has already passed general, manifest and engine
        // validation, so re-deriving warnings only duplicated them.
        // 1. Identify Features + build data
        let dznContent: string;
        let features: string[];
        try {
            const built = this.builder.build(instance, options);
            dznContent = built.dznContent;
            features = built.features;
        } catch (e) {
            return {
                solution: {
                    feasible: false,
                    selection: null,
                    objective_value: null,
                },
                violations: [{ message: `DZN build error: ${e}`, code: 'dzn_build_error' }],
                diagnostics: { stage: 'dzn_build', reason: 'build_error', error: String(e) },
            };
        }

        // 3. Run MiniZinc
        // minizinc --solver <SOLVER_NAME> [--time-limit ms] [--intermediate-solutions] model.mzn -
        // The '-' argument tells minizinc to read data from stdin
        const modelPath = path.resolve(__dirname, '../model/composition.mzn');
        const extraArgs: string[] = [];
        if (timeLimitMs != null && Number.isFinite(timeLimitMs) && timeLimitMs > 0) {
            extraArgs.push('--time-limit', String(Math.round(timeLimitMs)));
        }
        if (intermediateSolutions) {
            extraArgs.push('--intermediate-solutions');
        }

        const runResult = await this.runner.run(solverName, modelPath, dznContent, this.tmpDir, extraArgs);
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

        // Flattening/solver errors must fail the job loudly: an exact engine
        // returning "no solution" is interpreted downstream as an
        // infeasibility proof, silently masking model or data bugs.
        if (runResult.code !== 0) {
            throw new Error(
                `MiniZinc exited with code ${runResult.code}: ` +
                this.truncateText(runResult.stderr || runResult.stdout, 500)
            );
        }
        if (runResult.stdout.includes('=====ERROR=====') || /(^|\n)Error:/.test(runResult.stderr)) {
            throw new Error(
                'MiniZinc reported an error: ' +
                this.truncateText(runResult.stderr || runResult.stdout, 500)
            );
        }

        try {
            const stdout = runResult.stdout;
            const isUnsat =
                stdout.includes('=====UNSATISFIABLE=====') ||
                stdout.includes('model inconsistency detected');
            const isComplete = stdout.includes('==========');

            if (isUnsat) {
                return {
                    solution: {
                        feasible: false,
                        selection: null,
                        objective_value: null,
                    },
                    provenance: {
                        solver: solverName,
                        time_sec: timeSec,
                        status: 'UNSATISFIABLE',
                        time_limit_ms: timeLimitMs,
                    },
                    diagnostics: {
                        stage: 'solver_execution',
                        reason: 'unsat_or_inconsistent',
                        ...diagnosticsBase,
                    },
                };
            }

            // Each incumbent solution is printed as a JSON block followed by a
            // '----------' separator; timestamps come from stdout arrival times.
            const incumbents = this.parseIncumbents(stdout, runResult.stdoutEvents);

            if (incumbents.length === 0) {
                return {
                    solution: {
                        feasible: false,
                        selection: null,
                        objective_value: null,
                    },
                    provenance: {
                        solver: solverName,
                        time_sec: timeSec,
                        status: 'UNKNOWN',
                        time_limit_ms: timeLimitMs,
                    },
                    diagnostics: {
                        stage: 'parse_output',
                        reason: 'json_not_found_in_stdout',
                        ...diagnosticsBase,
                    },
                };
            }

            const result = incumbents[incumbents.length - 1].json;
            const trace = incumbents.map((b) => ({
                elapsed_ms: b.atMs,
                objective_value: b.json.objective_value,
                e2e_latency_ms: b.json.e2e_latency_ms,
            }));

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
            // Aggregated features are not this engine's to report: the
            // gateway recomputes them with the reference evaluator for every
            // engine alike, so anything sent here is overwritten. Computing
            // them was a fourth copy of the aggregation semantics.
            const aggregated_features = {};

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
                    status: isComplete ? 'OPTIMAL' : 'SATISFIED',
                    time_limit_ms: timeLimitMs,
                    trace: trace,
                    e2e_latency_ms: result.e2e_latency_ms,
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

    private parseIncumbents(
        stdout: string,
        events: Array<{ atMs: number; text: string }>
    ): Array<{ json: any; atMs: number }> {
        // Map a character offset in the accumulated stdout to the arrival time
        // of the chunk containing it.
        const offsets: number[] = [];
        let acc = 0;
        for (const ev of events) {
            acc += ev.text.length;
            offsets.push(acc);
        }
        const timeAt = (offset: number): number => {
            for (let i = 0; i < offsets.length; i++) {
                if (offset <= offsets[i]) return events[i].atMs;
            }
            return events.length > 0 ? events[events.length - 1].atMs : 0;
        };

        const incumbents: Array<{ json: any; atMs: number }> = [];
        const SEP = '----------';
        let cursor = 0;
        while (true) {
            const sepIdx = stdout.indexOf(SEP, cursor);
            if (sepIdx === -1) break;
            const segment = stdout.substring(cursor, sepIdx);
            const first = segment.indexOf('{');
            const last = segment.lastIndexOf('}');
            if (first !== -1 && last !== -1 && last > first) {
                try {
                    const json = JSON.parse(segment.substring(first, last + 1));
                    incumbents.push({ json, atMs: timeAt(sepIdx) });
                } catch {
                    // Malformed block: skip it, later incumbents still count.
                }
            }
            cursor = sepIdx + SEP.length;
        }

        // Without --intermediate-solutions there is a single JSON block and no
        // separator when the solver is interrupted; fall back to whole-output parse.
        if (incumbents.length === 0) {
            const first = stdout.indexOf('{');
            const last = stdout.lastIndexOf('}');
            if (first !== -1 && last !== -1 && last > first) {
                try {
                    const json = JSON.parse(stdout.substring(first, last + 1));
                    incumbents.push({ json, atMs: timeAt(last) });
                } catch {
                    // No parsable solution at all.
                }
            }
        }
        return incumbents;
    }

    private truncateText(text: string, max = 12000): string {
        if (!text) return '';
        if (text.length <= max) return text;
        return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
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
