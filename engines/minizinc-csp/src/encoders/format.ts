/**
 * Turning arrays into the literals a DZN data file is made of, and refusing
 * values the integer-scaled model cannot represent.
 *
 * The refusals matter: silently rounding a latency or a resource demand would
 * make the model solve a slightly different problem from the one asked, and
 * the answer would look perfectly ordinary.
 */

/** Latencies are integers of milliseconds * LAT_SCALE: Gecode propagates integers far better. */
export const LAT_SCALE = 1000;

export const fmt = (values: any[]): string => `[${values.join(', ')}]`;

export const fmt2d = (rows: any[][]): string =>
  rows.length === 0 ? '[| |]' : `[| ${rows.map((row) => row.join(', ')).join(' | ')} |]`;

export const fmtA2d = (rows: number, cols: number, values: number[][]): string =>
  `array2d(1..${rows}, 1..${cols}, [${values.flat().join(', ')}])`;

export function scaleLat(value: number): number {
  const scaled = Number(value) * LAT_SCALE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new Error(
      `Latency value ${value} ms is not representable at 1/${LAT_SCALE} ms ` +
        'resolution; the integer-scaled CSP model would silently distort it'
    );
  }
  return rounded;
}

export function requireInt(value: number, what: string): number {
  const parsed = Number(value);
  const rounded = Math.round(parsed);
  if (Math.abs(parsed - rounded) > 1e-9) {
    throw new Error(`${what} must be integral for the CSP model, got ${value}`);
  }
  return rounded;
}
