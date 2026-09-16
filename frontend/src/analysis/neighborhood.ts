/** Legacy explicit reevaluation API, separate from the stored-evidence workspace. */
export interface Neighborhood {
  jobId: string; solutionIndex: number; kind: string; irDigest: string; scope: string; task: string | null;
  base: Record<string, unknown>; moves: Record<string, unknown>[]; failures: Record<string, unknown>[];
  coverage: { total: number; attempted: number; evaluated: number; complete: boolean; limit: number; stopReason: string | null; perTask: Record<string, number> };
  conclusion: string; semantics: string;
}
