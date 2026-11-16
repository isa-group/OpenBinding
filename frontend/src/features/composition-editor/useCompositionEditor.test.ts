import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { CompositionDiagnosticView } from '../../modules/core/api/types';
import { draftScope, loadDraft, saveDraft } from '../../shared/editor/drafts';
import {
  CHECK_DELAY_MS,
  VALIDATE_DELAY_MS,
  linkedProblemOf,
  starterFor,
  useCompositionEditor,
  type CompositionEditorOptions,
} from './useCompositionEditor';

const api = vi.hoisted(() => ({ content: vi.fn(), check: vi.fn(), seal: vi.fn() }));
const language = vi.hoisted(() => ({
  validate: vi.fn(),
  parse: vi.fn(),
  serialise: vi.fn(),
  schema: vi.fn(),
}));
vi.mock('../../entities/composition/api', () => ({ compositionsApi: api, languageApi: language }));
const factsApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../entities/problem/facts', () => ({ problemFactsApi: factsApi }));

const DECLARED =
  'syntaxVersion: "1.0"\ncomposition: order-desk\nversion: 1.2.0\nkind: application\nworkflow: pick\nbinding: {pick: {candidate: c_pick}}\nvalues: {}\n';
const LINKED = DECLARED.replace(
  'workflow:',
  'problem: {ref: isa-demo/problems/checkout-flow@2, compilation: sha256-abc}\nworkflow:'
);

const options = (over: Partial<CompositionEditorOptions> = {}): CompositionEditorOptions => ({
  org: 'isa-demo',
  composition: { slug: 'order-desk', kind: 'application' },
  version: { id: 'v3', label: '1.2.0' },
  userId: 'user-lucia',
  delays: { validate: 20, check: 80 },
  ...over,
});

const finding = (
  code: string,
  pointer: string,
  line: number,
  severity: CompositionDiagnosticView['severity'] = 'error'
): CompositionDiagnosticView => ({
  code,
  message: `${code} at ${pointer}`,
  severity,
  path: pointer.slice(1).replaceAll('/', '.'),
  pointer,
  span: { line, column: 1, end_line: line, end_column: 5 },
});

const clean = { valid: true, diagnostics: [] };

function editor(over: Partial<CompositionEditorOptions> = {}) {
  return renderHook((props: CompositionEditorOptions) => useCompositionEditor(props), {
    initialProps: options(over),
  });
}

describe('the composition editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.content.mockResolvedValue(DECLARED);
    language.validate.mockResolvedValue(clean);
    language.schema.mockResolvedValue({ properties: {} });
    factsApi.get.mockResolvedValue({ tasks: [], features: [], candidates: [] });
  });

  it('checks within the budgets A-7 names', () => {
    expect(VALIDATE_DELAY_MS).toBe(600);
    expect(CHECK_DELAY_MS).toBe(1500);
  });

  it('starts from the version’s text, with the draft kept for it on top, and discards it back to the version', async () => {
    const scope = draftScope({
      user: 'user-lucia',
      kind: 'composition',
      org: 'isa-demo',
      entity: 'order-desk',
      base: 'v3',
    });
    await saveDraft(scope, { 'composition.yaml': `${DECLARED}# kept\n` });
    const { result } = editor();

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.content).toHaveBeenCalledWith('isa-demo', 'order-desk', 'v3');
    expect(result.current.text).toBe(`${DECLARED}# kept\n`);
    expect(result.current.dirty).toBe(true);
    expect(result.current.label).toBe('1.2.0');

    act(() => {
      result.current.discard();
    });
    expect(result.current.text).toBe(DECLARED);
    act(() => {
      result.current.undo();
    });
    expect(result.current.text).toBe(`${DECLARED}# kept\n`);
    await waitFor(async () =>
      expect(await loadDraft(scope)).toEqual({ 'composition.yaml': `${DECLARED}# kept\n` })
    );
  });

  it('starts a composition with no version from the starter, named after it', async () => {
    const { result } = editor({
      composition: { slug: 'lab-flow', kind: 'pipeline' },
      version: null,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.content).not.toHaveBeenCalled();
    expect(result.current.text).toBe(starterFor({ slug: 'lab-flow', kind: 'pipeline' }));
    expect(result.current.text).toMatch(/^composition: lab-flow$/m);
    expect(result.current.text).toMatch(/^kind: pipeline$/m);
    expect(result.current.dirty).toBe(false);
  });

  it('writes the label into the document’s version and reads it back', async () => {
    const { result } = editor();
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setLabel('1.3.0'));
    expect(result.current.text).toBe(DECLARED.replace('version: 1.2.0', 'version: 1.3.0'));
    expect(result.current.label).toBe('1.3.0');
  });

  it('lints every text, and checks only a valid text that links a problem, after the lint has answered for it', async () => {
    language.validate.mockImplementation(async (text: string) =>
      text.includes('broken')
        ? { valid: false, diagnostics: [finding('c2y_kind_unknown', '/kind', 4)] }
        : clean
    );
    api.check.mockResolvedValue({
      valid: true,
      values_status: 'verified',
      values: { cost: { value: 3, unit: 'USD/month' } },
      content: LINKED,
      diagnostics: [],
    });
    const { result } = editor();
    await waitFor(() =>
      expect(language.validate).toHaveBeenCalledWith(DECLARED, expect.any(AbortSignal))
    );
    await new Promise(resolve => setTimeout(resolve, 150));
    // A declared text is never checked.
    expect(api.check).not.toHaveBeenCalled();

    act(() => result.current.setText(LINKED));
    await waitFor(() =>
      expect(api.check).toHaveBeenCalledWith(
        'isa-demo',
        'order-desk',
        LINKED,
        expect.any(AbortSignal)
      )
    );
    const linted = language.validate.mock.invocationCallOrder.at(-1) ?? 0;
    expect(linted).toBeLessThan(api.check.mock.invocationCallOrder[0]);
    await waitFor(() => expect(result.current.check?.values_status).toBe('verified'));
    expect(linkedProblemOf(LINKED, 'isa-demo')).toEqual({
      problem: 'checkout-flow',
      revision: '2',
      compilation: 'sha256-abc',
    });
    await waitFor(() =>
      expect(factsApi.get).toHaveBeenCalledWith('isa-demo', 'checkout-flow', '2', 'sha256-abc')
    );

    const broken = LINKED.replace('kind: application', 'kind: broken');
    act(() => result.current.setText(broken));
    await waitFor(() => expect(result.current.errors).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(result.current.check).toBeNull();
  });

  it('merges the lint and the check into one list, once per code and pointer, located in the text', async () => {
    api.content.mockResolvedValue(LINKED);
    language.validate.mockResolvedValue({
      valid: true,
      diagnostics: [finding('c2y_value_differs', '/values/cost', 9, 'warning')],
    });
    api.check.mockResolvedValue({
      valid: true,
      values_status: 'verified',
      values: {},
      content: LINKED,
      diagnostics: [
        finding('c2y_value_differs', '/values/cost', 9, 'warning'),
        finding('c2y_constraint_soft', '/binding', 7, 'warning'),
      ],
    });
    const { result } = editor();

    await waitFor(() =>
      expect(result.current.diagnostics.map(item => item.code)).toEqual([
        'c2y_value_differs',
        'c2y_constraint_soft',
      ])
    );
    expect(result.current.diagnostics[1].where).toMatchObject({ kind: 'text', line: 7, column: 1 });
    expect(result.current.errors).toBe(0);
  });

  it('pauses on 429 for the Retry-After the gateway names, says so, then lints the same text once more', async () => {
    language.validate.mockRejectedValueOnce(
      Object.assign(new HttpError(429, 'Too many requests.'), {
        code: 'rate_limited',
        retryAfter: 1,
      })
    );
    language.validate.mockResolvedValue({
      valid: false,
      diagnostics: [finding('c2y_kind_unknown', '/kind', 4)],
    });
    const { result } = editor();

    await waitFor(() =>
      expect(result.current.pausedMessage).toBe('Checks paused, resuming in 1 s')
    );
    expect(result.current.diagnostics).toEqual([]);
    await waitFor(() => expect(result.current.errors).toBe(1), { timeout: 3000 });
    expect(result.current.pausedMessage).toBeNull();
    expect(language.validate).toHaveBeenCalledTimes(2);
    expect(language.validate.mock.calls.map(([text]) => text)).toEqual([DECLARED, DECLARED]);
  });

  it('changes the document through parse and serialise, as one undo step', async () => {
    language.parse.mockResolvedValue({
      document: { version: '1.2.0', kind: 'application' },
      diagnostics: [],
    });
    language.serialise.mockResolvedValue(DECLARED.replace('kind: application', 'kind: system'));
    const { result } = editor();
    await waitFor(() => expect(result.current.ready).toBe(true));

    let done: unknown;
    await act(async () => {
      done = await result.current.mutate(document => ({ ...document, kind: 'system' }));
    });
    expect(done).toEqual({ ok: true });
    expect(language.serialise).toHaveBeenCalledWith({ version: '1.2.0', kind: 'system' });
    expect(result.current.text).toMatch(/^kind: system$/m);
    act(() => {
      result.current.undo();
    });
    expect(result.current.text).toBe(DECLARED);

    language.parse.mockRejectedValueOnce(
      Object.assign(new HttpError(422, 'invalid'), { code: 'composition_invalid' })
    );
    await act(async () => {
      done = await result.current.mutate(document => document);
    });
    expect(done).toEqual({
      ok: false,
      message: 'The visual editor changes a valid document: fix the problems in the code first.',
    });
  });
});
