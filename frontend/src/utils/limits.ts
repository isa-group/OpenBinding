/**
 * How the pricing document's limits read in the interface.
 *
 * The document is the source of truth for which limits exist and what they are worth; this file only
 * decides how one is worded and grouped. A limit the table does not know falls into a group by its type,
 * so adding one to the pricing shows up on the Pricing and Usage screens without a code change.
 */

import { formatByteSize, formatNumber } from './format';

export type LimitGroup = 'monthly' | 'capacity' | 'ceiling' | 'sponsored';
export type LimitKind = 'count' | 'seconds' | 'bytes' | 'log10' | 'days';

export interface LimitInfo {
  label: string;
  /** What running out of it stops, as a noun phrase: "New {short} can't start until it renews". */
  short: string;
  group: LimitGroup;
  kind: LimitKind;
}

const KNOWN: Record<string, LimitInfo> = {
  studyRuns: { label: 'Study runs', short: 'study runs', group: 'monthly', kind: 'count' },
  concurrentJobs: { label: 'Concurrent jobs', short: 'jobs', group: 'capacity', kind: 'count' },
  federatedEngines: { label: 'Federated engines', short: 'federated engines', group: 'capacity', kind: 'count' },
  apiKeys: { label: 'API keys', short: 'API keys', group: 'capacity', kind: 'count' },
  maxTimeoutSeconds: { label: 'Max time per job', short: 'jobs', group: 'ceiling', kind: 'seconds' },
  maxIterations: { label: 'Max iterations', short: 'jobs', group: 'ceiling', kind: 'count' },
  maxPayloadBytes: { label: 'Max package size', short: 'requests', group: 'ceiling', kind: 'bytes' },
  maxInstanceComplexityLog10: { label: 'Max problem size', short: 'problems', group: 'ceiling', kind: 'log10' },
  jobHistoryDays: { label: 'Job history', short: 'history', group: 'ceiling', kind: 'days' },
  organizations: { label: 'Organizations', short: 'organizations', group: 'sponsored', kind: 'count' },
  members: { label: 'Members', short: 'members', group: 'sponsored', kind: 'count' },
  projects: { label: 'Projects', short: 'projects', group: 'sponsored', kind: 'count' },
  privateProjects: { label: 'Private projects', short: 'private projects', group: 'sponsored', kind: 'count' },
  collections: { label: 'Collections', short: 'collections', group: 'sponsored', kind: 'count' },
  studies: { label: 'Studies', short: 'studies', group: 'sponsored', kind: 'count' },
  storageBytes: { label: 'Storage', short: 'storage', group: 'sponsored', kind: 'bytes' },
};

/** The order the known limits are listed in; any other limit follows them. */
export const LIMIT_ORDER: readonly string[] = Object.keys(KNOWN);

/** Fields of a `usageLimits` entry of the pricing document that decide the fallback. */
export interface LimitDefinition {
  type?: unknown;
  trackable?: unknown;
  unit?: unknown;
}

function humanize(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Wording and group of one limit; `definition` is its entry in the pricing document, when there is one. */
export function limitInfo(id: string, definition?: LimitDefinition): LimitInfo {
  const known = KNOWN[id];
  if (known) return known;
  const unit = typeof definition?.unit === 'string' ? definition.unit : '';
  const kind: LimitKind = unit === 'second' || unit === 'second/month' ? 'seconds'
    : unit === 'byte' ? 'bytes'
      : unit === 'day' ? 'days'
        : unit.startsWith('log10') ? 'log10' : 'count';
  const group: LimitGroup = definition?.type === 'RENEWABLE' ? 'monthly' : definition?.trackable === true ? 'capacity' : 'ceiling';
  return { label: humanize(id), short: humanize(id).toLowerCase(), group, kind };
}

export const LIMIT_GROUPS: ReadonlyArray<{ id: LimitGroup; title: string; note: string }> = [
  { id: 'monthly', title: 'Monthly', note: 'Renew each month' },
  { id: 'capacity', title: 'Capacity', note: 'Freed when work ends' },
  { id: 'ceiling', title: 'Per request', note: 'Ceilings for each job' },
  { id: 'sponsored', title: 'Sponsored', note: 'Counted across a sponsor’s organizations' },
];

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

export const formatCount = (value: number): string => formatNumber(value);

function trimmed(value: number): string {
  return formatCount(Math.round(value * 10) / 10);
}

/** `15 min`, `8.3 h`, `45 s`. */
export function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `${trimmed(seconds / 3600)} h`;
  if (seconds >= 60) return `${trimmed(seconds / 60)} min`;
  return `${formatCount(seconds)} s`;
}

/** The size of a binding space as a power of ten: `10⁹`. */
export function formatPowerOfTen(exponent: number): string {
  return `10${String(exponent).split('').map((digit) => SUPERSCRIPT[digit] ?? digit).join('')}`;
}

export interface LimitText {
  /** The rounded figure people read. */
  text: string;
  /** The exact value when the rounded one hides it (`900 s`, `8,388,608 bytes`). */
  exact?: string;
}

/**
 * One limit value in words. `Infinity` and `null` both mean "no limit": the YAML's `.inf` arrives as
 * `null` over JSON, and the usage endpoint reports an infinite allowance as `null` too.
 */
export function describeLimit(kind: LimitKind, value: number | null | undefined): LimitText {
  if (value === undefined) return { text: '—' };
  if (value === null || !Number.isFinite(value)) return { text: 'Unlimited' };
  switch (kind) {
    case 'seconds': {
      const text = formatDuration(value);
      const exact = `${formatCount(value)} s`;
      return text === exact ? { text } : { text, exact };
    }
    case 'bytes': {
      const text = formatByteSize(value);
      const exact = `${formatCount(value)} bytes`;
      return text === exact ? { text } : { text, exact };
    }
    case 'log10':
      return { text: formatPowerOfTen(value), exact: `log10 ${formatCount(value)}` };
    case 'days':
      return { text: `${formatCount(value)} ${value === 1 ? 'day' : 'days'}` };
    default:
      return { text: formatCount(value) };
  }
}
