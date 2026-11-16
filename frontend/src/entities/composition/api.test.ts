import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readApiError } from '../../modules/core/api/errors';
import version from '../../test/fixtures/core/fms.version.json';
import { clearCompositionContentCache, compositionsApi, languageApi } from './api';

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 304 || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const YAML_TEXT =
  'syntaxVersion: "1.0"\ncomposition: shop\nversion: 1.0.0\nkind: application\nworkflow: pick\nbinding: {pick: {candidate: c_pick}}\nvalues: {}\n';

describe('compositionsApi', () => {
  const fetchMock = vi.fn<typeof fetch>();

  const url = (call = 0) => String(fetchMock.mock.calls[call][0]);
  const init = (call = 0) => fetchMock.mock.calls[call][1] ?? {};
  const header = (name: string, call = 0) => new Headers(init(call).headers).get(name);

  beforeEach(() => {
    localStorage.clear();
    clearCompositionContentCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends a text to seal as YAML, and tells a new version (201) from the one that already held it (200)', async () => {
    const sealed = { version, evaluation: version.evaluations[0], diagnostics: [] };
    fetchMock.mockResolvedValueOnce(answer(sealed, 201)).mockResolvedValueOnce(answer(sealed, 200));

    const first = await compositionsApi.seal('isa demo', 'fms', YAML_TEXT);
    const again = await compositionsApi.seal('isa demo', 'fms', YAML_TEXT);

    expect(url()).toMatch(/\/v1\/organizations\/isa%20demo\/compositions\/fms\/versions$/);
    expect(init().method).toBe('POST');
    expect(header('Content-Type')).toBe('application/yaml');
    expect(init().body).toBe(YAML_TEXT);
    expect(first).toEqual({ created: true, result: sealed });
    expect(again.created).toBe(false);
  });

  it('checks and lints a text as YAML', async () => {
    fetchMock.mockImplementation(async () => answer({ valid: true, diagnostics: [] }));
    await compositionsApi.check('isa-demo', 'fms', YAML_TEXT);
    await languageApi.validate(YAML_TEXT);
    await languageApi.parse(YAML_TEXT);

    expect(url(0)).toMatch(/\/compositions\/fms\/versions\/check$/);
    expect(url(1)).toMatch(/\/v1\/compositions\/validate$/);
    expect(url(2)).toMatch(/\/v1\/compositions\/parse$/);
    for (const call of [0, 1, 2]) expect(header('Content-Type', call)).toBe('application/yaml');
  });

  it('writes a document as its canonical text and compares two texts as JSON', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(YAML_TEXT, { status: 200, headers: { 'Content-Type': 'application/yaml' } })
      )
      .mockResolvedValueOnce(
        answer({
          general: [],
          sections: [],
          totals: { added: 0, removed: 0, changed: 0 },
          isEmpty: true,
        })
      );

    expect(await languageApi.serialise({ composition: 'shop' })).toBe(YAML_TEXT);
    expect(header('Content-Type', 0)).toBe('application/json');
    await languageApi.diffDocuments('a: 1', 'a: 2');
    expect(JSON.parse(String(init(1).body))).toEqual({ before: 'a: 1', after: 'a: 2' });
  });

  it('tells a fork (201) from a slug taken in the target (200)', async () => {
    const existing = { id: 'c-1', slug: 'fms', name: 'FMS' };
    fetchMock
      .mockResolvedValueOnce(answer({ composition: {}, version, droppedProblem: false }, 201))
      .mockResolvedValueOnce(answer({ nameTaken: true, existingComposition: existing }, 200));

    const body = { version: '1.0.0', targetOrganization: 'lab-other', dropProblem: false };
    expect((await compositionsApi.fork('isa-demo', 'fms', body)).status).toBe('forked');
    expect(await compositionsApi.fork('isa-demo', 'fms', body)).toEqual({
      status: 'nameTaken',
      existing,
    });
  });

  it('tells a new derivation and re-evaluation from one that existed', async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer({ content: YAML_TEXT, document: {}, values: {}, diagnostics: [] }, 200)
      )
      .mockResolvedValueOnce(answer(version.evaluations[0], 201));

    expect(
      (await compositionsApi.derive('isa-demo', 'fms', { version: '1.0.0', seal: false })).created
    ).toBe(false);
    expect(await compositionsApi.reevaluate('isa-demo', 'fms', '1.0.0')).toEqual({
      created: true,
      evaluation: version.evaluations[0],
    });
    expect(url(1)).toMatch(/\/compositions\/fms\/versions\/1\.0\.0\/evaluations$/);
  });

  it('keeps the ETag of a composition and sends it back as If-Match', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ slug: 'fms' }, 200, { ETag: '"c-3"' }))
      .mockResolvedValueOnce(answer({ slug: 'fms' }, 200, { ETag: '"c-4"' }));

    const read = await compositionsApi.get('isa-demo', 'fms');
    const changed = await compositionsApi.update('isa-demo', 'fms', { name: 'Fleet' }, read.etag);

    expect(read.etag).toBe('"c-3"');
    expect(init(1).method).toBe('PATCH');
    expect(header('If-Match', 1)).toBe('"c-3"');
    expect(changed.etag).toBe('"c-4"');
  });

  it('asks for versions with their include list, order and date bounds, and pages until the total', async () => {
    const row = { ...version, document: undefined };
    fetchMock
      .mockResolvedValueOnce(
        answer({
          versions: Array.from({ length: 200 }, () => row),
          total: 201,
          limit: 200,
          offset: 0,
        })
      )
      .mockResolvedValueOnce(answer({ versions: [row], total: 201, limit: 200, offset: 200 }));

    const rows = await compositionsApi.allVersions('isa-demo', 'fms', {
      include: ['analytics'],
      order: 'oldest',
      createdAfter: '2026-01-01T00:00:00Z',
      createdBefore: '2026-02-01T00:00:00Z',
    });

    expect(rows).toHaveLength(201);
    const first = new URL(url(0));
    expect(first.searchParams.get('include')).toBe('analytics');
    expect(first.searchParams.get('order')).toBe('oldest');
    expect(first.searchParams.get('created_after')).toBe('2026-01-01T00:00:00Z');
    expect(first.searchParams.get('created_before')).toBe('2026-02-01T00:00:00Z');
    expect(first.searchParams.get('limit')).toBe('200');
    expect(new URL(url(1)).searchParams.get('offset')).toBe('200');
  });

  it('reads one version with its document, and lists without empty parameters', async () => {
    fetchMock.mockImplementation(async () => answer(version));
    await compositionsApi.version('isa-demo', 'fms', '1', { document: true });
    await compositionsApi.list('isa-demo', { sort: 'updated', q: '' });
    await compositionsApi.publicList({ organization: 'lab-other' });
    await compositionsApi.list('isa-demo', { problem: 'checkout-flow', limit: 200 });

    expect(url(0)).toMatch(/\/compositions\/fms\/versions\/1\?include=document$/);
    expect(url(1)).toMatch(/\/v1\/organizations\/isa-demo\/compositions\?sort=updated$/);
    expect(url(2)).toMatch(/\/v1\/compositions\?organization=lab-other$/);
    expect(url(3)).toMatch(
      /\/v1\/organizations\/isa-demo\/compositions\?problem=checkout-flow&limit=200$/
    );
  });

  it('caches the text of a version and revalidates it with If-None-Match', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(YAML_TEXT, { status: 200, headers: { ETag: '"sha-1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    const first = await compositionsApi.content('isa-demo', 'fms', 'v-1');
    const again = await compositionsApi.content('isa-demo', 'fms', 'v-1');

    expect(url(0)).toMatch(/\/versions\/v-1\/content$/);
    expect(header('If-None-Match', 0)).toBeNull();
    expect(header('If-None-Match', 1)).toBe('"sha-1"');
    expect(first).toBe(YAML_TEXT);
    expect(again).toBe(YAML_TEXT);
  });

  it('throws refusals in both envelopes, which readApiError reads alike', async () => {
    const diagnostic = {
      code: 'c2y_task_unbound',
      message: 'Task ship has no binding entry.',
      severity: 'error',
      path: 'workflow',
      pointer: '/workflow',
      span: null,
    };
    fetchMock
      .mockResolvedValueOnce(
        answer(
          {
            type: 'about:blank',
            title: 'composition_invalid',
            status: 422,
            code: 'composition_invalid',
            detail: 'The document is not valid.',
            diagnostics: [diagnostic],
          },
          422
        )
      )
      .mockResolvedValueOnce(
        answer(
          { code: 'not_found', detail: { code: 'not_found', error: 'Composition not found.' } },
          404
        )
      )
      .mockResolvedValueOnce(
        answer(
          {
            code: 'precondition_failed',
            detail: { code: 'precondition_failed', error: 'Changed.' },
          },
          412,
          { ETag: '"c-9"' }
        )
      )
      .mockResolvedValueOnce(
        answer(
          { code: 'composition_busy', detail: { code: 'composition_busy', error: 'Busy.' } },
          429,
          { 'Retry-After': '1' }
        )
      );

    const refused = async (call: Promise<unknown>) =>
      readApiError(
        await call.then(
          () => null,
          (error: unknown) => error
        )
      );

    const invalid = await refused(languageApi.parse('workflow: {seq: [pick, ship]}'));
    expect(invalid).toMatchObject({ status: 422, code: 'composition_invalid' });
    expect(invalid.diagnostics[0]).toMatchObject({
      code: 'c2y_task_unbound',
      pointer: '/workflow',
    });

    expect(await refused(compositionsApi.get('lab-other', 'secret'))).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Composition not found.',
    });
    expect(
      await refused(compositionsApi.update('isa-demo', 'fms', { name: 'x' }, '"c-3"'))
    ).toMatchObject({ status: 412, etag: '"c-9"' });
    expect(await refused(compositionsApi.check('isa-demo', 'fms', YAML_TEXT))).toMatchObject({
      status: 429,
      code: 'composition_busy',
      retryAfter: 1,
    });
  });
});
