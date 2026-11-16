import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProblemFacts } from '../../shared/api/types';
import fms from '../../test/fixtures/core/fms.facts.json';
import simpleSeq from '../../test/fixtures/core/simple-seq.facts.json';
import validated from '../../test/fixtures/core/simple-seq.validate.json';
import { clearProblemFactsCache, hasRanges, problemFactsApi, rangeCandidates } from './facts';

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('problemFactsApi', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    clearProblemFactsCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reads the facts of a compilation, then revalidates its cached copy with If-None-Match', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(simpleSeq, 200, { ETag: '"facts-1"' }))
      .mockResolvedValueOnce(answer(null, 304));

    const first = await problemFactsApi.get('isa-demo', 'simple seq', 2, 'compilation-2');
    const again = await problemFactsApi.get('isa-demo', 'simple seq', 2, 'compilation-2');

    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/v1\/organizations\/isa-demo\/problems\/simple%20seq\/revisions\/2\/compilations\/compilation-2\/facts$/
    );
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('If-None-Match')).toBeNull();
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('If-None-Match')).toBe('"facts-1"');
    expect(first).toEqual(simpleSeq);
    expect(again).toBe(first);
  });

  it('throws a refusal as it comes', async () => {
    fetchMock.mockResolvedValueOnce(
      answer(
        { code: 'not_found', detail: { code: 'not_found', error: 'Compilation not found.' } },
        404
      )
    );
    await expect(problemFactsApi.get('isa-demo', 'p', 1, 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('asks the validation of a drafted package for its facts', async () => {
    fetchMock.mockResolvedValueOnce(answer(validated));
    const facts = await problemFactsApi.validate(new Uint8Array([80, 75, 3, 4]));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/bim\/validate\?include=facts$/);
    expect(facts).toEqual(validated.facts);
  });
});

describe('ranges in the facts', () => {
  it('finds none in a problem of numbers', () => {
    expect(hasRanges(fms as ProblemFacts)).toBe(false);
    expect(rangeCandidates(fms as ProblemFacts)).toEqual([]);
  });

  it('finds a range in any catalog, and lists the eligible candidates that declare one under their written names', () => {
    const facts = structuredClone(simpleSeq) as ProblemFacts;
    facts.candidates[1].values = { latency: { min: 15, max: null } };
    expect(hasRanges(facts)).toBe(true);
    expect(rangeCandidates(facts)).toEqual([
      {
        task: 't1',
        candidate: 'c1b',
        features: [{ name: 'latency', value: { min: 15, max: null } }],
      },
    ]);

    const unused = structuredClone(simpleSeq) as ProblemFacts;
    unused.candidates.push({
      ...unused.candidates[0],
      key: 'spare/x',
      resource: 'spare',
      id: 'x',
      values: { latency: { min: 1, max: 2 } },
    });
    expect(hasRanges(unused)).toBe(true);
    expect(rangeCandidates(unused)).toEqual([]);
  });
});
