const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

const STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Number.POSITIVE_INFINITY],
];

/** How long ago an instant was, in words (`3 hours ago`, `yesterday`); `null` when the value is not a date. */
export function relativeTime(value: string | null | undefined, now: number = Date.now()): string | null {
  const instant = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(instant)) return null;
  let amount = (instant - now) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(amount) < size) return RELATIVE.format(Math.round(amount), unit);
    amount /= size;
  }
  return null;
}
