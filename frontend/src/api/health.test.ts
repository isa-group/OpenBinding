import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGateway, parseDependencies } from './health';

describe('parseDependencies', () => {
  it('reads the gateway’s own shape and sorts the words into states', () => {
    expect(parseDependencies({
      status: 'ready',
      dependencies: { database: 'ok', redis: 'not-required', sphere: 'disabled', space: 'configured', cache: 'warming' },
    })).toEqual([
      { name: 'database', value: 'ok', state: 'ok' },
      { name: 'redis', value: 'not-required', state: 'inactive' },
      { name: 'sphere', value: 'disabled', state: 'inactive' },
      { name: 'space', value: 'configured', state: 'ok' },
      { name: 'cache', value: 'warming', state: 'unknown' },
    ]);
  });

  it('reads the dependencies the gateway puts inside detail when it answers 503', () => {
    expect(parseDependencies({ detail: { code: 'not_ready', dependencies: { database: 'unavailable' } } }))
      .toEqual([{ name: 'database', value: 'unavailable', state: 'down' }]);
  });

  it('is tolerant of a list of named entries and of booleans', () => {
    expect(parseDependencies({ dependencies: [{ name: 'queue', status: 'degraded' }, { name: 'db', state: 'up' }, { nope: true }] }))
      .toEqual([{ name: 'queue', value: 'degraded', state: 'down' }, { name: 'db', value: 'up', state: 'ok' }]);
    expect(parseDependencies({ dependencies: { database: true, space: false, mail: { status: 'ok' } } }))
      .toEqual([
        { name: 'database', value: 'ok', state: 'ok' },
        { name: 'space', value: 'unavailable', state: 'down' },
        { name: 'mail', value: 'ok', state: 'ok' },
      ]);
  });

  it('yields no rows, and no error, for anything else', () => {
    for (const body of [null, undefined, 'ready', 42, [], {}, { dependencies: 'none' }, { detail: 'x' }]) {
      expect(parseDependencies(body)).toEqual([]);
    }
  });
});

describe('checkGateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs the three probes without credentials and keeps a failing answer as a result', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health/ready')) return new Response(JSON.stringify({ detail: { dependencies: { database: 'unavailable' } } }), { status: 503 });
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkGateway();

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual(['/health', '/health/live', '/health/ready']);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.cache).toBe('no-store');
    }
    expect(result.probes.health).toMatchObject({ reached: true, ok: true, status: 200, request: 'GET /health' });
    expect(result.probes.ready).toMatchObject({ reached: true, ok: false, status: 503 });
    expect(result.dependencies).toEqual([{ name: 'database', value: 'unavailable', state: 'down' }]);
  });

  it('records a probe that never got an answer as unreached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await checkGateway();

    for (const probe of Object.values(result.probes)) expect(probe).toMatchObject({ reached: false, ok: false, status: null, ms: null });
    expect(result.dependencies).toEqual([]);
  });

  it('tolerates an answer that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));

    const result = await checkGateway();

    expect(result.probes.health).toMatchObject({ reached: true, ok: false, status: 502, body: null });
  });
});
