import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { readApiError } from '../../modules/core/api/errors';
import { presetsApi } from './api';
import { presetFixture } from '../../test/fixtures/presets';

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('presetsApi', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const url = (call = 0) => String(fetchMock.mock.calls[call][0]);
  const init = (call = 0) => fetchMock.mock.calls[call][1] ?? {};
  const header = (name: string, call = 0) => new Headers(init(call).headers).get(name);

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lists the presets of an organization by name, with the filters given', async () => {
    fetchMock.mockImplementation(async () =>
      answer({ presets: [presetFixture()], total: 1, limit: 200, offset: 0 })
    );

    const page = await presetsApi.list('isa demo', { q: 'fast', limit: 200 });
    await presetsApi.list('isa-demo');

    expect(url(0)).toMatch(/\/v1\/organizations\/isa%20demo\/presets\?q=fast&limit=200$/);
    expect(url(1)).toMatch(/\/v1\/organizations\/isa-demo\/presets$/);
    expect(page.presets[0].slug).toBe('fast-sampling');
  });

  it('reads one preset with its ETag and sends it back as If-Match on an edit', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(presetFixture(), 200, { ETag: '"p-1"' }))
      .mockResolvedValueOnce(answer(presetFixture({ name: 'Faster' }), 200, { ETag: '"p-2"' }));

    const read = await presetsApi.get('isa-demo', 'fast-sampling');
    const changed = await presetsApi.update(
      'isa-demo',
      'fast-sampling',
      { name: 'Faster', options: { iterations: 10 } },
      read.etag
    );

    expect(read).toEqual({ value: presetFixture(), etag: '"p-1"' });
    expect(url(1)).toMatch(/\/presets\/fast-sampling$/);
    expect(init(1).method).toBe('PATCH');
    expect(header('If-Match', 1)).toBe('"p-1"');
    expect(JSON.parse(String(init(1).body))).toEqual({
      name: 'Faster',
      options: { iterations: 10 },
    });
    expect(changed.etag).toBe('"p-2"');
  });

  it('creates a preset with its settings, and deletes one', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(presetFixture(), 201, { ETag: '"p-1"' }))
      .mockResolvedValueOnce(answer(null, 204));
    const body = {
      slug: 'fast-sampling',
      name: 'Fast sampling',
      engine: presetFixture().engine,
      mode: 'sampling',
      options: { time_budget_ms: 30000 },
      optimization: { type: 'SINGLE' as const, scalarization: 'weighted-sum' },
    };

    const made = await presetsApi.create('isa-demo', body);
    await presetsApi.remove('isa-demo', 'fast-sampling');

    expect(init(0).method).toBe('POST');
    expect(JSON.parse(String(init(0).body))).toEqual(body);
    expect(made.value.id).toBe(presetFixture().id);
    expect(url(1)).toMatch(/\/v1\/organizations\/isa-demo\/presets\/fast-sampling$/);
    expect(init(1).method).toBe('DELETE');
  });

  it('throws the gateway’s refusal, readable as code and message', async () => {
    fetchMock.mockImplementation(async () =>
      answer(
        {
          detail: {
            code: 'slug_conflict',
            error: 'That preset slug is in use in this organization.',
          },
        },
        409
      )
    );

    const caught = await presetsApi
      .create('isa-demo', { slug: 'fast-sampling', name: 'Again', engine: 'random-search' })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(HttpError);
    expect(readApiError(caught)).toMatchObject({ status: 409, code: 'slug_conflict' });
  });
});
