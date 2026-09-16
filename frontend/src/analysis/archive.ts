import { apiClient } from '../api/client';
import type { Report } from '../api/platform';

export type DecisionRule = 'balanced' | 'weighted' | 'ideal' | 'topsis' | 'chebyshev' | 'reference' | 'model';
export type AnalysisView = 'decision' | 'budgets' | 'pareto' | 'preferences' | 'evidence';
export type Point = [number, number];
export interface Requirement { dimension: string; value: number; space: 'raw' | 'normalized' }
export interface ArchiveQuery {
  sources: string[]; revision?: string; rule?: DecisionRule; weights?: Record<string, number>;
  reference?: Record<string, number>; requirements?: Requirement[]; axes?: string[];
  view?: AnalysisView; paretoScope?: 'archive' | 'eligible'; page?: number; pageSize?: number;
  search?: string; status?: 'all' | 'eligible' | 'feasible' | 'infeasible' | 'unknown' | 'excluded';
  selected?: string; compare?: string[]; metric?: 'euclidean' | 'manhattan' | 'hamming' | 'gower';
  neighbors?: number; geometry?: 'none' | 'voronoi' | 'power' | 'sensitivity'; viewport?: number[] | null; layers?: boolean;
}
export interface ArchiveSource {
  id: string; engine: string; state: string; projectId: string | null; createdAt: string;
  irDigest: string | null; evaluatorDigest: string | null; resultDigest: string | null; resultDigestKind: 'canonical-json' | 'stored-json';
  legacy: boolean; compatible: boolean | null; diagnostic: boolean;
}
export interface Dimension {
  key: string; label: string; direction: 'minimize' | 'maximize'; kind: 'objective' | 'penalty';
  unit: string | null; minimum: number | null; maximum: number | null;
  rawMinimum: number | null; rawMaximum: number | null; constant: boolean;
}
export interface ArchiveRow {
  id: string; feasible: boolean | null; eligible: boolean; reasons: string[];
  losses: number[] | null; values: number[] | null; normalized: number[] | null; score: number[] | null;
  modelScore: number | number[] | null; rank: number | null; scoreGroup: number | null;
  paretoRank: number | null; occurrences: number;
}
export interface PlotPoint { id: string; x: number; y: number; feasible: boolean | null; eligible: boolean; paretoRank: number | null }
export interface Plot {
  axes: number[]; points: PlotPoint[]; bins: { x: number; y: number; count: number; feasible: number; infeasible: number; unknown: number }[];
  count: number; bounds: number[]; aggregated: boolean; resolution?: number;
  constraints?: { planes: Plane[]; skipped: string[]; meaning?: string };
}
export interface Plane { a: number; b: number; c: number; label: string; hard: boolean; strict: boolean }
export interface BudgetMap {
  available: boolean; reason?: string; axes: number[]; signs: number[]; bounds: number[];
  selected: (number | null)[]; corners: { x: number; y: number; id: string }[];
  tiles: { x: number; y: number; witness: string }[]; resolution: number; aggregated: boolean;
  cornerCount: number; witnessCount: number; excluded: Plane[]; skipped: string[]; meaning: string; detail: string;
}
export interface Cell { ids: string[]; count: number; polygon: Point[]; area: number; site?: Point; coefficients?: number[]; powerWeight?: number; restrictedPolygon?: Point[]; restrictedArea?: number }
export interface Geometry {
  kind: string; state: string; reason?: string; axes?: number[]; mass?: number; cells?: Cell[];
  selectedOnly?: boolean; competitors?: number; functions?: number; meaning?: string; axis?: number;
  scenarios?: { t: number; winners: string[]; winnerCount: number; score: number[] }[];
}
export interface ArchiveResponse {
  version: string; revision: string; sources: ArchiveSource[]; dimensions: Dimension[]; counts: Record<string, number>;
  rule: DecisionRule; formula: string; modelOrderingAvailable: boolean; weights: Record<string, number>; warnings: string[];
  winners: ArchiveRow[]; winnerCount: number; next: ArchiveRow[]; nextCount: number;
  rows: ArchiveRow[]; total: number; page: number; pageSize: number;
  pareto: { state: string; scope: string; count: number; frontCount: number | null; meaning: string; taskId?: string; hypervolume: { value: number; reference: number[]; meaning: string } | null };
  plot: Plot; geometry: Geometry | null; budgets: BudgetMap | null;
  trajectory: { jobId: string; events: unknown[]; kind: string }[];
}
export interface BindingRef { resource: string; id: string }
export interface CandidateDetail {
  revision: string; row: ArchiveRow; binding: Record<string, BindingRef>; violations: unknown[];
  metrics: Record<string, unknown>; evaluation: Record<string, unknown>; occurrences: { jobId: string; solutionIndex: number }[];
  explanation: {
    formula: string; rule: DecisionRule; score: number[] | null; summary: string; eligibility: string[];
    nextScore: number[] | null; nearTieTolerance: number; nearTie: boolean; normalizationScope: string;
    components: { key: string; value: number | null; loss: number | null; normalized: number | null;
      weight: number; weightedLoss: number | null; minimum: number | null; maximum: number | null; direction: string }[];
  };
  comparison: { id: string; reasons: string[]; score: number[] | null; scoreDelta: number[] | null;
    changes: { task: string; selected: BindingRef | null; alternative: BindingRef | null }[];
    dimensions: { key: string; selected: number; alternative: number; delta: number; improves: boolean }[] }[];
  dominance: { scope: string; computed: boolean; eligibleForFront: boolean; dominatorCount: number; dominators: string[] };
  neighbors: { id: string; distance: number; metric: string }[];
}
export interface AnalysisTask {
  id: string; revision: string; state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  progress: number; scope: string; layers: boolean; error: string | null;
  result: { complete: boolean; count: number; front: string[]; ranks: Record<string, number> | null } | null;
}
export interface DecisionReceipt {
  kind: 'binding-decision'; version: string; revision: string; sources: ArchiveSource[];
  query: ArchiveQuery; dimensions: Dimension[]; scope: string; selected: CandidateDetail[];
}
const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
  const response = await apiClient.request<T>(`/v1/analysis/${path}`, { method: 'POST', body: JSON.stringify(body), signal });
  // The legacy compiler client returns 422 documents. Analysis endpoints must surface them as errors.
  if (response && typeof response === 'object' && 'detail' in response) {
    throw new Error(typeof response.detail === 'string' ? response.detail : JSON.stringify(response.detail));
  }
  return response;
};
export const analysisApi = {
  sources: (cursor = '', anchor = '', signal?: AbortSignal) => apiClient.request<{ items: ArchiveSource[]; nextCursor: string | null }>(
    `/v1/analysis/sources?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${anchor ? `&compatible_with=${encodeURIComponent(anchor)}` : ''}`, { signal }),
  query: (q: ArchiveQuery, signal?: AbortSignal) => post<ArchiveResponse>('query', q, signal),
  candidate: (q: ArchiveQuery, signal?: AbortSignal) => post<CandidateDetail>('candidate', q, signal),
  receipt: (q: ArchiveQuery) => post<DecisionReceipt>('export', { ...q, format: 'receipt' }),
  export: (q: ArchiveQuery, format: 'csv' | 'json') => apiClient.requestText('/v1/analysis/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...q, format }),
  }),
  save: (q: ArchiveQuery, organization: string, project: string, title: string, slug: string) =>
    post<Report>('reports', { ...q, organization, project, title, slug }),
  startPareto: (q: ArchiveQuery) => post<AnalysisTask>('pareto', q),
  pareto: (id: string, signal?: AbortSignal) => apiClient.request<AnalysisTask>(`/v1/analysis/pareto/${encodeURIComponent(id)}`, { signal }),
  cancelPareto: (id: string) => post<AnalysisTask>(`pareto/${encodeURIComponent(id)}/cancel`, {}),
};
export const shortId = (id: string) => id.replace(/^sha256[:-]/, '').slice(0, 10);
export const formatNumber = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 5 });

/** Reports are editable documents; a saved snapshot is not a trusted API response. */
export function decisionReceipt(value: unknown): DecisionReceipt | null {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const numbers = (v: unknown) => Array.isArray(v) && v.every(n => typeof n === 'number' && Number.isFinite(n));
  if (!object(value) || value.kind !== 'binding-decision' || typeof value.scope !== 'string' || typeof value.revision !== 'string'
    || !object(value.query) || !Array.isArray(value.query.sources) || !value.query.sources.every(s => typeof s === 'string')
    || !Array.isArray(value.selected)) return null;
  const q = value.query;
  for (const name of ['weights', 'reference']) if (q[name] !== undefined && (!object(q[name]) || !numbers(Object.values(q[name])))) return null;
  for (const name of ['axes', 'compare']) if (q[name] !== undefined && (!Array.isArray(q[name]) || !q[name].every(v => typeof v === 'string'))) return null;
  if (q.requirements !== undefined && (!Array.isArray(q.requirements) || !q.requirements.every(r => object(r)
    && typeof r.dimension === 'string' && typeof r.value === 'number' && Number.isFinite(r.value) && ['raw', 'normalized'].includes(String(r.space))))) return null;
  if (!value.selected.every(s => object(s) && object(s.row) && typeof s.row.id === 'string' && (s.row.score == null || numbers(s.row.score))
    && object(s.explanation) && typeof s.explanation.formula === 'string' && Array.isArray(s.explanation.components)
    && s.explanation.components.every(c => object(c) && typeof c.key === 'string' && (c.value === null || typeof c.value === 'number') && typeof c.weight === 'number'))) return null;
  return value as unknown as DecisionReceipt;
}
