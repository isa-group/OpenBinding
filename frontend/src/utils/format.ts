const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
});

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const monthDayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** `Sep 25` in UTC, or `null` when the value is missing or not a date. */
export function formatMonthDay(value: string | null | undefined): string | null {
  const date = parse(value);
  return date ? monthDayFormat.format(date) : null;
}

/** `Sep 25, 2026` in UTC, or `null` when the value is missing or not a date. */
export function formatDate(value: string | null | undefined): string | null {
  const date = parse(value);
  return date ? dateFormat.format(date) : null;
}

/** `Sep 25, 2026, 11:55 UTC`, or `null` when the value is missing or not a date. */
export function formatDateTime(value: string | null | undefined): string | null {
  const date = parse(value);
  return date ? `${dateTimeFormat.format(date)} UTC` : null;
}

export function yearOf(value: string | null | undefined): number | null {
  return parse(value)?.getUTCFullYear() ?? null;
}

/** `8 MiB`, `5 GiB`, `512 bytes`: binary units, one decimal at most. */
export function formatByteSize(bytes: number): string {
  const units: Array<[number, string]> = [[1024 ** 3, 'GiB'], [1024 ** 2, 'MiB'], [1024, 'KiB']];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${formatNumber(Math.round((bytes / size) * 10) / 10)} ${unit}`;
  }
  return `${formatNumber(bytes)} bytes`;
}

/** `20 KiB (20,480 bytes)`; exact bytes below one KiB; `null` when there is no size to show. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const exact = `${formatNumber(bytes)} bytes`;
  return bytes < 1024 ? exact : `${formatByteSize(bytes)} (${exact})`;
}

/** A count or a measure the way every screen writes it: English separators, at most two decimals unless asked for more. */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString('en-US', { maximumFractionDigits });
}
