/**
 * What a refusal says about the limit that caused it.
 *
 * A refused request names its limit in a `quota` member (and, for the size of a binding space, a
 * `binding_space` one). They sit at the top of the problem on the BIM routes and on any 422, and inside
 * `detail` on the other platform routes; the client reads both places and hands over what is here.
 *
 * Only well-formed members are kept, and only the fields the screens show: nothing else of the answer is
 * passed on, so a refusal can't leak a path, a host or an internal message into the interface.
 */

/** `exhausted`: the limit is reached. `unknown`: the gateway couldn't tell what the limit is. `unmeasured`: it couldn't measure the request. */
export type LimitState = 'exhausted' | 'unknown' | 'unmeasured';

/** Which limit refused: the caller's `plan`, a `technical` safeguard of the deployment that no plan raises, a counter of the pricing service (`space`), or `none` (no limit is known). */
export type LimitSource = 'plan' | 'technical' | 'space' | 'none';

export interface LimitNotice {
  limit_id: string;
  state: LimitState;
  source?: LimitSource;
  unit?: string;
  /** Absent when the state is `unknown`: there is no limit to name. */
  limit?: number;
  used?: number;
}

/** The size of a binding space, as an estimate: a refusal about it carries the measure, never the problem. */
export interface BindingSpaceReport {
  log10?: number;
  digits?: number;
  /** Only when it is short enough to print. */
  cardinality?: string;
}

const STATES: readonly string[] = ['exhausted', 'unknown', 'unmeasured'];
const SOURCES: readonly string[] = ['plan', 'technical', 'space', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The limit a `quota` member names, or `undefined` when it isn't one. A state that isn't recognised is read as `unknown`, never as `exhausted`. */
export function limitNoticeFrom(raw: unknown): LimitNotice | undefined {
  if (!isRecord(raw) || typeof raw.limit_id !== 'string' || raw.limit_id === '') return undefined;
  const state: LimitState = raw.state === undefined
    ? 'exhausted'
    : typeof raw.state === 'string' && STATES.includes(raw.state) ? (raw.state as LimitState) : 'unknown';
  return {
    limit_id: raw.limit_id,
    state,
    ...(typeof raw.source === 'string' && SOURCES.includes(raw.source) ? { source: raw.source as LimitSource } : {}),
    ...(typeof raw.unit === 'string' ? { unit: raw.unit } : {}),
    ...(finite(raw.limit) ? { limit: raw.limit } : {}),
    ...(finite(raw.used) ? { used: raw.used } : {}),
  };
}

/** The measure a `binding_space` member carries, or `undefined` when there is none. */
export function bindingSpaceFrom(raw: unknown): BindingSpaceReport | undefined {
  if (!isRecord(raw)) return undefined;
  const report: BindingSpaceReport = {
    ...(finite(raw.log10) ? { log10: raw.log10 } : {}),
    ...(finite(raw.digits) ? { digits: raw.digits } : {}),
    ...(typeof raw.cardinality === 'string' && /^[0-9]{1,40}$/.test(raw.cardinality) ? { cardinality: raw.cardinality } : {}),
  };
  return Object.keys(report).length ? report : undefined;
}
