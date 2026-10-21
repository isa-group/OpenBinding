import { config } from '../config';

export type ProbeName = 'health' | 'live' | 'ready';

export interface ProbeResult {
  name: ProbeName;
  /** The request the probe made, as shown to readers: `GET /health`. */
  request: string;
  /** False when no HTTP answer arrived at all (network down, CORS refusal, timeout). */
  reached: boolean;
  status: number | null;
  /** A 2xx answer. */
  ok: boolean;
  ms: number | null;
  body: unknown;
}

/**
 * How a dependency reported, whatever words the gateway used.
 * `unknown` is a value this client does not recognise: shown, never counted as healthy.
 */
export type DependencyState = 'ok' | 'inactive' | 'down' | 'unknown';

export interface Dependency {
  name: string;
  /** The gateway's own word for it: `ok`, `configured`, `not-required`, `unavailable`… */
  value: string;
  state: DependencyState;
}

export interface GatewayStatus {
  checkedAt: Date;
  probes: Record<ProbeName, ProbeResult>;
  dependencies: Dependency[];
}

const PROBES: ReadonlyArray<{ name: ProbeName; path: string }> = [
  { name: 'health', path: '/health' },
  { name: 'live', path: '/health/live' },
  { name: 'ready', path: '/health/ready' },
];

const TIMEOUT_MS = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function probe({ name, path }: { name: ProbeName; path: string }): Promise<ProbeResult> {
  const request = `GET ${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(`${config.apiBaseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* a probe that answers without JSON is still an answer */
    }
    return { name, request, reached: true, status: response.status, ok: response.ok, ms: Math.round(performance.now() - started), body };
  } catch {
    return { name, request, reached: false, status: null, ok: false, ms: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

const OK_WORDS = new Set(['ok', 'ready', 'up', 'healthy', 'configured', 'available', 'connected']);
const INACTIVE_WORDS = new Set(['not-required', 'not_required', 'not required', 'disabled', 'skipped', 'off']);
const DOWN_WORDS = new Set(['unavailable', 'down', 'error', 'failed', 'failing', 'unhealthy', 'degraded', 'not-ready', 'not_ready', 'timeout']);

function classify(value: string): DependencyState {
  const word = value.trim().toLowerCase();
  if (OK_WORDS.has(word)) return 'ok';
  if (INACTIVE_WORDS.has(word)) return 'inactive';
  if (DOWN_WORDS.has(word)) return 'down';
  return 'unknown';
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'ok' : 'unavailable';
  if (isRecord(value) && typeof value.status === 'string') return value.status;
  return 'unknown';
}

/**
 * The dependency list of a `/health/ready` answer.
 *
 * The contract only says the body is an object. The gateway sends `{ dependencies: { name: word } }`, on a 200 and
 * inside `detail` on a 503, but the shape is treated as indicative: a list of `{ name, status }` is read too, and
 * anything else yields no rows rather than an error.
 */
export function parseDependencies(body: unknown): Dependency[] {
  if (!isRecord(body)) return [];
  const source = body.dependencies ?? (isRecord(body.detail) ? body.detail.dependencies : undefined);
  if (Array.isArray(source)) {
    return source.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return [];
      const value = describe(entry.status ?? entry.state);
      return [{ name: entry.name, value, state: classify(value) }];
    });
  }
  if (isRecord(source)) {
    return Object.entries(source).map(([name, entry]) => {
      const value = describe(entry);
      return { name, value, state: classify(value) };
    });
  }
  return [];
}

/** Run the three probes side by side. A probe that cannot reach the gateway is a result, not an exception. */
export async function checkGateway(): Promise<GatewayStatus> {
  const [health, live, ready] = await Promise.all(PROBES.map(probe));
  return { checkedAt: new Date(), probes: { health, live, ready }, dependencies: parseDependencies(ready.body) };
}
