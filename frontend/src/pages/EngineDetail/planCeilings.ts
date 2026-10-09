import type { OptionFact } from '../Engines/enginesModel';
import { formatDefault } from '../Engines/enginesModel';

/**
 * What a plan allows one job, read from the pricing document the gateway serves.
 *
 * The gateway lowers a request to these two limits and no others (access/policy.py): `time_budget_ms` to
 * `maxTimeoutSeconds`, and `iterations` / `max_evaluations` to `maxIterations`. Anything else a mode declares
 * reaches the engine as asked, so it has no plan ceiling to preview.
 */
export interface PlanLimits {
  plan: string;
  /** `null` when the pricing document does not define the limit for this plan. */
  maxTimeoutSeconds: number | null;
  maxIterations: number | null;
}

export interface PlanCeilings {
  version: string | null;
  plans: PlanLimits[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A plan's own value for a limit, or the document's default when the plan does not override it. */
function limitOf(pricing: Record<string, unknown>, plan: Record<string, unknown>, id: string): number | null {
  const ownLimits: Record<string, unknown> = isRecord(plan.usageLimits) ? plan.usageLimits : {};
  const own = ownLimits[id];
  if (isRecord(own) && numeric(own.value) !== null) return numeric(own.value);
  const sharedLimits: Record<string, unknown> = isRecord(pricing.usageLimits) ? pricing.usageLimits : {};
  const shared = sharedLimits[id];
  return isRecord(shared) ? numeric(shared.defaultValue) : null;
}

/** The ceilings of every plan in a parsed pricing document (`retrievePricingFromYaml`). */
export function planCeilings(pricing: unknown): PlanCeilings {
  if (!isRecord(pricing) || !isRecord(pricing.plans)) return { version: null, plans: [] };
  const plans = pricing.plans;
  return {
    version: typeof pricing.version === 'string' ? pricing.version : null,
    plans: Object.entries(plans).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([plan, value]) => ({
      plan,
      maxTimeoutSeconds: limitOf(pricing, value, 'maxTimeoutSeconds'),
      maxIterations: limitOf(pricing, value, 'maxIterations'),
    })),
  };
}

export type OptionKind = 'time' | 'effort' | 'unmapped-by-plan';

const TIME_OPTIONS = new Set(['time_budget_ms']);
const EFFORT_OPTIONS = new Set(['iterations', 'max_evaluations']);

export function optionKind(name: string): OptionKind {
  if (TIME_OPTIONS.has(name)) return 'time';
  if (EFFORT_OPTIONS.has(name)) return 'effort';
  return 'unmapped-by-plan';
}

export interface OptionPreview {
  name: string;
  unit: string;
  default: string;
  required: boolean;
  /** The plan's ceiling in words, or why there is none. */
  ceiling: string;
  /** What the default becomes under this plan. */
  outcome: { kind: 'clamped'; applied: string } | { kind: 'fits'; text: string } | { kind: 'none'; text: string };
}

function whole(value: number): string {
  return value.toLocaleString('en-US');
}

/** Preview of one option under one plan: the ceiling, and whether the engine's own default would be reduced. */
export function previewOption(fact: OptionFact, limits: PlanLimits | null): OptionPreview {
  const kind = optionKind(fact.name);
  const base = {
    name: fact.name,
    // The mode's own schema names the unit; when it does not, the gateway's names say it (`_ms`, iterations).
    unit: fact.unit ?? (kind === 'time' ? 'ms' : kind === 'effort' ? (fact.name === 'iterations' ? 'iteration' : 'evaluation') : '—'),
    default: fact.default !== null ? formatDefault(fact.default) : '—',
    required: fact.required,
  };
  if (kind === 'unmapped-by-plan') {
    return { ...base, ceiling: 'Not reduced by plan', outcome: { kind: 'none', text: 'Applies as requested' } };
  }
  const ceiling = limits === null ? null : kind === 'time'
    ? (limits.maxTimeoutSeconds === null ? null : limits.maxTimeoutSeconds * 1000)
    : limits.maxIterations;
  if (ceiling === null) {
    return { ...base, ceiling: 'Not mapped', outcome: { kind: 'none', text: 'The pricing document has no ceiling for it' } };
  }
  const words = kind === 'time' ? `${whole(ceiling)} ms (${whole(ceiling / 1000)} s)` : `${whole(ceiling)} iterations`;
  if (typeof fact.default !== 'number') return { ...base, ceiling: words, outcome: { kind: 'none', text: 'No default to compare' } };
  if (fact.default > ceiling) return { ...base, ceiling: words, outcome: { kind: 'clamped', applied: whole(ceiling) } };
  return { ...base, ceiling: words, outcome: { kind: 'fits', text: 'Within the ceiling' } };
}
