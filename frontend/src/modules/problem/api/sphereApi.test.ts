import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../../core/api/http';
import { forgetSnapshotReads } from '../../core/utils/sphere/snapshotYaml';
import search from '../../../test/fixtures/sphere/search.mailgun.json';
import { useSphereApi } from './sphereApi';

const transport = new HttpTransport('https://gateway.example');
vi.mock('../../auth/hooks/useAuth', () => ({
  useAuth: () => ({ fetchWithInterceptor: transport.fetchWithInterceptor }),
}));

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const called = (index = 0) => {
  const [input, init] = fetchMock.mock.calls[index];
  return { url: String(input), init: init ?? {} };
};

describe('useSphereApi', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    forgetSnapshotReads();
  });

  it('searches SPHERE through the organization, naming only the filters it was given', async () => {
    fetchMock.mockResolvedValueOnce(json(search));
    const { result } = renderHook(() => useSphereApi());
    const page = await result.current.searchPricings('isa-demo', {
      q: 'mailgun',
      minPrice: 10,
      sort: 'minPrice',
      limit: 24,
    });
    expect(page.total).toBe(3);
    expect(called().url).toBe(
      'https://gateway.example/v1/organizations/isa-demo/sphere/pricings?q=mailgun&minPrice=10&sort=minPrice&limit=24'
    );
  });

  it('reads a family and a version under a registry, and posts a recipe to preview and apply', async () => {
    fetchMock.mockImplementation(async () => json({}));
    const { result } = renderHook(() => useSphereApi());
    const recipe = { recipeVersion: '1', currency: 'USD', billing: 'monthly', tasks: [] } as never;
    await result.current.manifest('isa-demo', 'a'.repeat(24), 'score-mirror');
    await result.current.version('isa-demo', 'a'.repeat(24), 'b'.repeat(24));
    await result.current.expand('isa-demo', 'storage', { recipe, base: null });
    await result.current.apply('isa-demo', 'storage', {
      recipe,
      base: { revision: 2 },
      expect: { packageDigest: `sha256-${'c'.repeat(64)}` },
    });
    await result.current.recipe('isa-demo', 'storage', 2);
    expect(called(0).url).toBe(
      `https://gateway.example/v1/organizations/isa-demo/sphere/pricings/${'a'.repeat(24)}?registry=score-mirror`
    );
    expect(called(1).url).toBe(
      `https://gateway.example/v1/organizations/isa-demo/sphere/pricings/${'a'.repeat(24)}/versions/${'b'.repeat(24)}`
    );
    expect(called(2).url).toBe(
      'https://gateway.example/v1/organizations/isa-demo/problems/storage/sphere/expand'
    );
    expect(called(2).init.method).toBe('POST');
    expect(JSON.parse(String(called(2).init.body))).toEqual({ recipe, base: null });
    expect(JSON.parse(String(called(3).init.body)).expect).toEqual({
      packageDigest: `sha256-${'c'.repeat(64)}`,
    });
    expect(called(4).url).toBe(
      'https://gateway.example/v1/organizations/isa-demo/problems/storage/sphere/recipe?revision=2'
    );
  });

  it('throws a refusal with its Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ detail: { code: 'sphere_busy', error: 'SPHERE is busy.' } }, 429, {
        'Retry-After': '3',
      })
    );
    const { result } = renderHook(() => useSphereApi());
    await expect(result.current.searchPricings('isa-demo', {})).rejects.toMatchObject({
      status: 429,
      retryAfter: 3,
    });
  });

  it('reads a snapshot’s YAML once per address', async () => {
    fetchMock.mockImplementation(async () => new Response('saasName: Mailgun\n', { status: 200 }));
    const { result } = renderHook(() => useSphereApi());
    const href = '/v1/organizations/isa-demo/pricing-snapshots/s-1/yaml';
    const [first, second] = await Promise.all([
      result.current.snapshotYaml(href),
      result.current.snapshotYaml(href),
    ]);
    expect(first).toBe('saasName: Mailgun\n');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
