import type { ValueSource } from '../../api/types';
import type { ValueOrigin } from '../../utils/binding/candidateMatrix';

/**
 * Where a value comes from, in words. Only names and labels are written: the pricing as SPHERE names it (`owner/slug`), the plan,
 * the version label, the guarantee, limit or feature; never an id, a hash or a snapshot (`digestHygiene.test.ts`).
 */

/** The words of each source kind (the badge's label). */
export const SOURCE_WORD: Readonly<Record<ValueSource['kind'], string>> = {
  priced: 'Priced',
  guarantee: 'Guarantee',
  limit: 'Limit',
  feature: 'Feature',
  manual: 'Manual',
};

/** pricing4ts's sentinel for an unlimited value (`1e8`), which the import writes for an unlimited limit. */
const UNLIMITED = 1e8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scalar = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number')
    return value >= UNLIMITED
      ? 'unlimited'
      : value.toLocaleString('en', { maximumFractionDigits: 6 });
  if (typeof value === 'string') return value;
  if (isRecord(value) && value.unlimited === true) return 'unlimited';
  return '—';
};

const PERIOD: Record<string, string> = {
  SEC: 'second',
  MIN: 'minute',
  HOUR: 'hour',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
};

/** `per day`, `per 3 months`, or nothing when the limit has no period. */
function periodText(period: unknown): string {
  if (!isRecord(period) || typeof period.unit !== 'string') return '';
  const word = PERIOD[period.unit] ?? period.unit.toLowerCase();
  const count = typeof period.value === 'number' ? period.value : 1;
  return count === 1 ? ` per ${word}` : ` per ${count} ${word}s`;
}

/** The upstream plan a value was read from: `danruilop1/mailgun FOUNDATION, version 2026-10`. */
export function planText(pricing: ValueSource['pricing']): string {
  if (!pricing) return 'a SPHERE pricing';
  const name = pricing.sphere ?? 'a SPHERE pricing';
  const plan = pricing.plan ? ` ${pricing.plan}` : '';
  const addOns = pricing.addOns.length ? ` with ${pricing.addOns.join(', ')}` : '';
  const version = pricing.versionLabel ? `, version ${pricing.versionLabel}` : '';
  const registry = pricing.registry ? ` (registry ${pricing.registry})` : '';
  return `${name}${plan}${addOns}${version}${registry}`;
}

/** What a source says about its value, in a sentence; `shown` is the value as the screen prints it (`35 USD/month`). */
export function sourceText(source: ValueSource, shown?: string): string {
  const detail = isRecord(source.detail) ? source.detail : {};
  const carried = source.carried ? ' (kept from an earlier version)' : '';
  switch (source.kind) {
    case 'priced':
      return `Priced from SPHERE: ${planText(source.pricing)}${shown ? ` (${shown})` : ''}${carried}`;
    case 'guarantee': {
      const name = typeof detail.feature === 'string' ? detail.feature : 'a guarantee';
      const raw = scalar(detail.raw);
      const table = isRecord(detail.map) ? detail.map : null;
      const mapped =
        table && typeof detail.raw === 'boolean' && String(detail.raw) in table
          ? ` → ${scalar(table[String(detail.raw)])}`
          : typeof detail.scale === 'number' && detail.scale !== 1
            ? ` × ${detail.scale}`
            : '';
      return `From the guarantee ${name} (${raw}${mapped}) of ${planText(source.pricing)}${carried}`;
    }
    case 'limit': {
      const name = typeof detail.name === 'string' ? detail.name : 'a usage limit';
      const value = detail.unlimited === true ? 'unlimited' : scalar(detail.raw);
      const unit = typeof detail.unit === 'string' && detail.unit ? ` ${detail.unit}` : '';
      const per = detail.unlimited === true ? '' : `${unit}${periodText(detail.period)}`;
      return `Usage limit ${name}: ${value}${per}, of ${planText(source.pricing)}${carried}`;
    }
    case 'feature': {
      const name = typeof detail.name === 'string' ? detail.name : 'a feature';
      return `Feature ${name}: ${scalar(detail.raw)}, of ${planText(source.pricing)}${carried}`;
    }
    case 'manual': {
      if (detail.assumed === true) {
        const limit = typeof detail.limit === 'string' ? detail.limit : 'a limit';
        return `Assumed ${scalar(detail.value)} for ${limit} when importing from SPHERE: the pricing does not declare it${carried}`;
      }
      return `Set by hand when importing from SPHERE${carried}`;
    }
  }
}

/** The external page a source cites (a guarantee's `docUrl`), when it names an https address. */
export function sourceLink(source: ValueSource | null | undefined): string | null {
  const url = isRecord(source?.detail) ? source.detail.docUrl : null;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

/**
 * Where a value comes from, in words: its source when an import wrote it, then where it is written. A package value reads
 * `written in candidates.json at /spec/candidates/c1/features/cost`.
 */
export function originText(origin: ValueOrigin, shown?: string): string {
  const written = `written in ${origin.path} at ${origin.pointer}`;
  return origin.source ? `${sourceText(origin.source, shown)}; ${written}` : written;
}
