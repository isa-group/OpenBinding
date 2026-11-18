import type { PricingDocument } from '../../core/api/account';

// The word and the colour of a run, and the plan's limits a launch reads.

// --- runs

export type JobTone = 'running' | 'queued' | 'ok' | 'warn' | 'bad' | 'off';

/** The word and the colour of a run, from the state it reports and how it ended. */
export function jobStatus(
  status: string,
  termination?: string | null
): { label: string; tone: JobTone } {
  const state = status.toLowerCase();
  if (state === 'running') return { label: 'Running', tone: 'running' };
  if (state === 'queued') return { label: 'Queued', tone: 'queued' };
  if (state === 'failed') return { label: 'Failed', tone: 'bad' };
  if (state === 'cancelled' || state === 'canceled') return { label: 'Cancelled', tone: 'off' };
  if (state === 'completed') {
    if (termination === 'INFEASIBLE') return { label: 'No feasible binding', tone: 'warn' };
    if (termination === 'OPTIMAL') return { label: 'Optimal', tone: 'ok' };
    if (termination === 'FEASIBLE') return { label: 'Feasible', tone: 'ok' };
    return { label: 'Completed', tone: 'ok' };
  }
  return { label: status, tone: 'off' };
}

// --- the plan

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The plan's value of a usage limit in the pricing document (`maxRunMinutes`, `maxConcurrentRuns`, … of pricing 0.2.0): its own, else
 * the document's default; `null` when unlimited or unknown.
 */
export function planLimit(
  catalog: PricingDocument | null | undefined,
  plan: string | undefined,
  id: string
): number | null {
  if (!catalog || !plan) return null;
  const own = record(record(record(record(catalog.plans)[plan]).usageLimits)[id]);
  const raw = 'value' in own ? own.value : record(record(catalog.usageLimits)[id]).defaultValue;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
