import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BimDiagnostic, BimRefusal } from '../../../../api/bim';
import { HttpError } from '../../../../api/client';
import type { CompositionVersionView, ProblemFacts } from '../../../core/api/types';
import { draftScope, loadDraft, saveDraft } from '../../../core/editor/drafts';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import refusedBody from '../../../../test/fixtures/core/refused.validate.json';
import { DEFAULT_FILES } from './documents';
import { analysis, archiveOf, packageFilesNamed, sentFiles } from './editorTestKit';
import {
  CHECK_DELAY_MS,
  EDITOR_PRODUCER,
  unparsedFiles,
  useProblemEditor,
  type ProblemEditorOptions,
} from './useProblemEditor';

const bim = vi.hoisted(() => ({ validate: vi.fn(), template: vi.fn(), templates: vi.fn() }));
const problems = vi.hoisted(() => ({
  revisions: vi.fn(),
  source: vi.fn(),
  create: vi.fn(),
  createRevision: vi.fn(),
}));
const compositions = vi.hoisted(() => ({ get: vi.fn(), version: vi.fn() }));
vi.mock('../../../../api/bim', () => ({ bimApi: bim }));
vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: compositions }));

const DELAY = 30;
const facts = fmsFacts as unknown as ProblemFacts;
const valid = (over: Record<string, unknown> = {}) => analysis({ facts, ...over });
const refusal = (
  diagnostics: BimDiagnostic[] = refusedBody.diagnostics as BimDiagnostic[]
): BimRefusal => ({
  valid: false,
  status: 422,
  code: 'invalid_instance',
  message: refusedBody.detail,
  diagnostics,
});

const options = (over: Partial<ProblemEditorOptions> = {}): ProblemEditorOptions => ({
  org: 'isa-demo',
  userId: 'user-lucia',
  problem: null,
  revision: null,
  template: null,
  delay: DELAY,
  ...over,
});

function editor(over: Partial<ProblemEditorOptions> = {}) {
  return renderHook((props: ProblemEditorOptions) => useProblemEditor(props), {
    initialProps: options(over),
  });
}

async function ready(over: Partial<ProblemEditorOptions> = {}) {
  const view = editor(over);
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  return view;
}

const revisionRow = (revision: number) => ({
  id: `rev-${revision}`,
  revision,
  package_digest: `sha256-${revision}`,
});
const edit = (files: Record<string, string>, name: string) => ({
  ...files,
  'instance.json': files['instance.json'].replace(/"name": "[^"]*"/, `"name": "${name}"`),
});

describe('the problem editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bim.validate.mockResolvedValue(valid());
    bim.templates.mockResolvedValue([]);
  });

  it('checks within the compile budget A-7 names', () => {
    expect(CHECK_DELAY_MS).toBe(2000);
  });

  describe('opens', () => {
    it('a template the gateway accepts, in place of the draft, already checked with its facts', async () => {
      await saveDraft(
        draftScope({
          user: 'user-lucia',
          kind: 'problem',
          org: 'isa-demo',
          entity: 'new',
          base: 'none',
        }),
        packageFilesNamed('kept')
      );
      bim.template.mockResolvedValue(archiveOf(packageFilesNamed('from-template')));
      const { result } = await ready({ template: 'demo/01_simple_seq' });

      expect(bim.template).toHaveBeenCalledWith('demo/01_simple_seq');
      expect(result.current.origin).toEqual({ kind: 'template', template: 'demo/01_simple_seq' });
      expect(JSON.parse(result.current.files['instance.json']).metadata.name).toBe('from-template');
      expect(bim.validate).toHaveBeenCalledTimes(1);
      expect(bim.validate.mock.calls[0][1]).toMatchObject({
        include: ['facts'],
        acceptRefusal: true,
      });
      expect(result.current.facts).toBe(facts);
      expect(result.current.dirty).toBe(false);
      // The checked template is not sent again.
      await new Promise(resolve => setTimeout(resolve, DELAY * 3));
      expect(bim.validate).toHaveBeenCalledTimes(1);
    });

    it('the kept draft when the gateway refuses the template, and says why', async () => {
      await saveDraft(
        draftScope({
          user: 'user-lucia',
          kind: 'problem',
          org: 'isa-demo',
          entity: 'new',
          base: 'none',
        }),
        packageFilesNamed('kept')
      );
      bim.template.mockResolvedValue(archiveOf(packageFilesNamed('from-template')));
      bim.validate.mockResolvedValueOnce(refusal());
      const { result } = await ready({ template: 'demo/broken' });

      expect(result.current.origin).toEqual({ kind: 'draft', revision: null });
      expect(JSON.parse(result.current.files['instance.json']).metadata.name).toBe('kept');
      expect(result.current.templateIssue).toMatchObject({
        template: 'demo/broken',
        message: refusedBody.detail,
      });
    });

    it('the draft kept for a problem version over its source', async () => {
      await saveDraft(
        draftScope({
          user: 'user-lucia',
          kind: 'problem',
          org: 'isa-demo',
          entity: 'checkout',
          base: '1',
        }),
        packageFilesNamed('kept')
      );
      const { result } = await ready({ problem: 'checkout', revision: '1' });

      expect(result.current.origin).toEqual({ kind: 'draft', revision: 1 });
      expect(problems.source).not.toHaveBeenCalled();
    });

    it('the source of the newest problem version when nothing is kept', async () => {
      problems.revisions.mockResolvedValue([revisionRow(1), revisionRow(2)]);
      problems.source.mockResolvedValue(archiveOf(packageFilesNamed('version-2')));
      const { result } = await ready({ problem: 'checkout' });

      expect(problems.source).toHaveBeenCalledWith('isa-demo', 'checkout', 2);
      expect(result.current.origin).toEqual({ kind: 'revision', revision: 2 });
      expect(JSON.parse(result.current.files['instance.json']).metadata.name).toBe('version-2');
    });

    it('the blank package with nothing else, and says when a version cannot be read', async () => {
      const blank = await ready();
      expect(blank.result.current.origin).toEqual({ kind: 'blank' });
      expect(blank.result.current.files).toEqual(DEFAULT_FILES);

      problems.revisions.mockRejectedValue(new HttpError(404, 'Problem not found.'));
      const { result } = await ready({ problem: 'ghost', revision: '3' });
      expect(result.current.loadIssue).toMatchObject({ status: 404 });
    });
  });

  describe('checks', () => {
    it('once the package has been still for the delay, with the facts, and not while a JSON file does not parse', async () => {
      const { result } = await ready();
      await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
      act(() => {
        result.current.commit(now => edit(now, 'first'));
      });
      act(() => {
        result.current.commit(now => edit(now, 'second'));
      });
      await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(2));
      expect(JSON.parse((await sentFiles(bim.validate))['instance.json']).metadata.name).toBe(
        'second'
      );

      act(() => {
        result.current.commit(now => ({ ...now, 'candidates.json': '{"apiVersion": ' }));
      });
      expect(result.current.unparsed).toEqual(['candidates.json']);
      await new Promise(resolve => setTimeout(resolve, DELAY * 3));
      expect(bim.validate).toHaveBeenCalledTimes(2);
      expect(unparsedFiles({ 'a.json': '{}', 'b.json': '{', 'c.bpmn': '<x' })).toEqual(['b.json']);
    });

    it('aborts the check in flight when the package changes', async () => {
      const signals: AbortSignal[] = [];
      bim.validate.mockImplementation(
        (_archive: Uint8Array, { signal }: { signal: AbortSignal }) => {
          signals.push(signal);
          // As fetch does: the request in flight fails once it is aborted.
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          );
        }
      );
      const { result } = await ready();
      await waitFor(() => expect(signals).toHaveLength(1));
      act(() => {
        result.current.commit(now => edit(now, 'changed'));
      });
      expect(signals[0].aborted).toBe(true);
      await waitFor(() => expect(signals).toHaveLength(2));
    });

    it('pauses for the Retry-After of a 429, says so, and checks the same package again after it', async () => {
      const busy = Object.assign(new HttpError(429, 'Too many checks.'), {
        code: 'rate_limited',
        retryAfter: 1,
      });
      bim.validate.mockRejectedValueOnce(busy);
      const { result } = await ready();

      await waitFor(() =>
        expect(result.current.pausedMessage).toBe('Checks paused, resuming in 1 s')
      );
      expect(result.current.checkIssue).toBeNull();
      await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(2), { timeout: 3000 });
      await waitFor(() => expect(result.current.pausedMessage).toBeNull());
      expect(result.current.last?.valid).toBe(true);
    });

    it('keeps the facts of the last valid package, stale, while the gateway refuses the package, and locates the findings', async () => {
      const { result } = await ready();
      await waitFor(() => expect(result.current.facts).toBe(facts));
      expect(result.current.stale).toBe(false);

      bim.validate.mockResolvedValueOnce(
        refusal([
          {
            code: 'feature_value_domain',
            message: 'above its domain',
            resource: 'candidates.json',
            pointer: '/spec/candidates/service-a/features/latency',
          },
        ])
      );
      act(() => {
        result.current.commit(now => ({
          ...now,
          'candidates.json': now['candidates.json'].replace('"latency": 10', '"latency": 900'),
        }));
      });
      await waitFor(() => expect(result.current.stale).toBe(true));
      expect(result.current.facts).toBe(facts);
      expect(result.current.savable).toBe(false);
      const [finding] = result.current.diagnostics;
      expect(finding).toMatchObject({
        code: 'feature_value_domain',
        severity: 'error',
        where: { kind: 'text', file: 'candidates.json' },
      });
      const where = finding.where as { from: number; to: number };
      expect(result.current.files['candidates.json'].slice(where.from, where.to)).toBe('900');
    });

    it('says a refusal that is not about the package once, and checks again on demand', async () => {
      bim.validate.mockRejectedValueOnce(new HttpError(503, 'The compiler is restarting.'));
      const { result } = await ready();
      await waitFor(() => expect(result.current.checkIssue).toMatchObject({ kind: 'unavailable' }));
      act(() => result.current.checkNow());
      await waitFor(() => expect(result.current.checkIssue).toBeNull());
      expect(bim.validate).toHaveBeenCalledTimes(2);
    });
  });

  describe('saves', () => {
    const upload = (created: boolean) => ({
      problem: { slug: 'checkout', name: 'Checkout' },
      revision: { revision: 3 },
      compilation: {},
      created,
    });

    it('a new problem and a new version as the problem editor made them, and forgets the draft once a version is new', async () => {
      problems.create.mockResolvedValue({
        ...upload(true),
        problem: { slug: 'hello-bim', name: 'hello-bim' },
      });
      problems.createRevision.mockResolvedValue(upload(true));
      const { result } = await ready();
      const scope = draftScope({
        user: 'user-lucia',
        kind: 'problem',
        org: 'isa-demo',
        entity: 'new',
        base: 'none',
      });
      await waitFor(async () => expect(await loadDraft(scope)).not.toBeNull());

      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.save({ kind: 'new', name: 'hello-bim', slug: 'hello-bim' });
      });
      expect(outcome).toMatchObject({ kind: 'created' });
      expect(problems.create).toHaveBeenCalledWith('isa-demo', expect.any(Uint8Array), {
        slug: 'hello-bim',
        name: 'hello-bim',
        producer: EDITOR_PRODUCER,
      });
      expect(await loadDraft(scope)).toBeNull();

      await act(async () => {
        outcome = await result.current.save({ kind: 'version', problem: 'checkout' });
      });
      expect(problems.createRevision).toHaveBeenCalledWith(
        'isa-demo',
        'checkout',
        expect.any(Uint8Array),
        { producer: 'openbinding-problem-editor' }
      );
    });

    it('says when the package already is a version, and words a refusal', async () => {
      problems.createRevision
        .mockResolvedValueOnce(upload(false))
        .mockRejectedValueOnce(new HttpError(403, 'Saving needs MEMBER.'));
      const { result } = await ready();
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.save({ kind: 'version', problem: 'checkout' });
      });
      expect(outcome).toMatchObject({ kind: 'unchanged', upload: { revision: { revision: 3 } } });
      await act(async () => {
        outcome = await result.current.save({ kind: 'version', problem: 'checkout' });
      });
      expect(outcome).toMatchObject({ kind: 'refused', message: expect.stringContaining('(403)') });
    });
  });

  it('highlights the candidates a composition version chose', async () => {
    const version = fmsVersion as unknown as CompositionVersionView;
    compositions.get.mockResolvedValue({ value: { name: 'FMS line' }, etag: null });
    compositions.version.mockResolvedValue(version);
    const { result } = await ready({ composition: 'fms', compositionVersion: '1.0.0' });

    await waitFor(() => expect(result.current.overlay).not.toBeNull());
    expect(compositions.version).toHaveBeenCalledWith('isa-demo', 'fms', '1.0.0');
    const binding = version.evaluations.find(item => item.current)?.binding;
    expect(result.current.overlay).toMatchObject({
      composition: 'fms',
      name: 'FMS line',
      label: '1.0.0',
      selection: binding,
    });
    expect(result.current.overlay?.linked).toMatch(/^fms@\d+$/);
  });
});
