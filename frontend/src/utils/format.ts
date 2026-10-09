const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
});

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

/** `20 KiB (20,480 bytes)`; exact bytes below one KiB. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const exact = `${bytes.toLocaleString('en-US')} bytes`;
  if (bytes < 1024) return exact;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString('en-US')} ${units[unit]} (${exact})`;
}
