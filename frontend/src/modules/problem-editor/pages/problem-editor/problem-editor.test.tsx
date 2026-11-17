import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BimDiagnostic } from '../../../core/api/bim';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import { addressNow } from '../../../../test/moduleKit';
import { problemPath } from '../../../../routes/paths/problems';
import { unzipPackage } from '../../../core/utils/bimZip';
import { loadDraft, saveDraft } from '../../../core/editor/drafts';
import { CARRY_SCOPE, EDITOR_PRODUCER } from '../../hooks/useProblemEditor';
import { analysis, BLANK_LATENCY, blankFacts, packageFilesNamed } from '../../utils/editorTestKit';
import {
  checkNow,
  fileMenu,
  openProblemEditor,
  showCode,
  showPane,
} from '../../utils/renderTestKit';

const bim = vi.hoisted(() => ({ validate: vi.fn(), template: vi.fn(), templates: vi.fn() }));
const problems = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  revisions: vi.fn(),
  source: vi.fn(),
  create: vi.fn(),
  createRevision: vi.fn(),
}));
vi.mock('../../../core/api/bim', () => ({ bimApi: bim }));
vi.mock('../../../problem/api/problemsClient', () => ({ problemsApi: problems }));
// Monaco needs a real browser: the code editor is a text area that shows where its caret was put and how many markers it has.
vi.mock('../../../core/components/code-editor', async () => ({
  default: (await import('../../utils/codeEditorTestKit')).default,
}));
vi.mock('../../components/bpmn-modeler', () => ({
  BpmnModeler: ({ focusElement }: { focusElement?: string | null }) => (
    <div data-testid="bpmn-modeler" data-focus={focusElement ?? ''} />
  ),
}));

const valid = () => analysis({ facts: fmsFacts });
const finding = (over: Partial<BimDiagnostic>): BimDiagnostic => ({
  code: 'feature_value_domain',
  message: 'candidate feature value is above its declared domain',
  ...over,
});
const refused = (diagnostics: BimDiagnostic[]) => ({
  valid: false,
  status: 422,
  code: 'invalid_instance',
  message: 'invalid_instance',
  diagnostics,
});

const pane = () => screen.getByRole('tab', { selected: true });
const status = () => screen.getByTestId('pe-check-status');
const mode = (name: 'Visual' | 'Code') => screen.getByRole('button', { name });

describe('/problem-editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bim.validate.mockResolvedValue(valid());
    bim.templates.mockResolvedValue(['demo/01_simple_seq']);
    problems.get.mockResolvedValue({ id: 'p1', slug: 'checkout', name: 'Checkout' });
    problems.list.mockResolvedValue({
      problems: [{ id: 'p1', slug: 'checkout', name: 'Checkout' }],
      total: 1,
      limit: 200,
      offset: 0,
    });
    problems.revisions.mockResolvedValue([]);
  });

  it('shows the panes of the package, its files, and the engines and problems of its last check', async () => {
    await openProblemEditor({ delay: 10 });
    expect(screen.getByRole('heading', { level: 1, name: 'Problem editor' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('tablist', { name: 'Editor panes' }))
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['Workflow', 'Candidates', 'Rules', 'Forms', 'BPMN']);
    expect(screen.getByText('A blank package')).toBeInTheDocument();

    await waitFor(() => expect(status()).toHaveTextContent('Valid package'));
    expect(screen.getByRole('group', { name: 'Workflow of the package' })).toBeInTheDocument();
    const engines = screen.getByRole('list', { name: 'Engine modes' });
    expect(within(engines).getByText('random-search 1.0.0')).toBeInTheDocument();
    expect(within(engines).getByText('Can run it')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Problems' })).toHaveTextContent('No issues');

    showPane('Candidates');
    expect(screen.getByRole('region', { name: 'Candidates of each task' })).toBeInTheDocument();
    showPane('Forms');
    expect(screen.getByRole('navigation', { name: 'BIM resources' })).toBeInTheDocument();
    showPane('BPMN');
    expect(await screen.findByTestId('bpmn-modeler')).toBeInTheDocument();

    showCode();
    expect(mode('Code')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('navigation', { name: 'Files of the package' })).toBeInTheDocument();
    expect(await screen.findByLabelText('instance.json source')).toHaveAttribute(
      'data-language',
      'json'
    );
    fireEvent.click(screen.getByRole('button', { name: /workflow\.bpmn/ }));
    expect(screen.getByLabelText('workflow.bpmn source')).toHaveAttribute('data-language', 'xml');
  });

  it('opens a finding’s file at its range in Code, and a BPMN finding at its element in the diagram', async () => {
    bim.validate.mockResolvedValue(
      refused([
        finding({
          resource: 'candidates.json',
          pointer: '/spec/candidates/service-a/features/latency',
        }),
        finding({
          code: 'bpmn_task_ref',
          message: "BPMN task 'hello' has no Application task",
          resource: 'workflow.bpmn',
          pointer: '/process/hello',
          bpmnElement: 'hello',
        }),
      ])
    );
    await openProblemEditor();
    checkNow();
    const panel = screen.getByRole('region', { name: 'Problems' });
    await waitFor(() => expect(panel).toHaveTextContent('2 errors'));
    expect(within(panel).getByText('candidates.json')).toBeInTheDocument();
    expect(status()).toHaveTextContent('Not valid · 2 problems');

    fireEvent.click(within(panel).getByRole('button', { name: /above its declared domain/ }));
    expect(mode('Code')).toHaveAttribute('aria-pressed', 'true');
    const source = screen.getByLabelText('candidates.json source') as HTMLTextAreaElement;
    await waitFor(() => expect(source.dataset.anchor).toBeDefined());
    expect(source.value.slice(Number(source.dataset.anchor), Number(source.dataset.head))).toBe(
      '10'
    );
    expect(source).toHaveAttribute('data-marks', '1');
    expect(
      within(screen.getByRole('navigation', { name: 'Files of the package' })).getByRole('button', {
        name: /candidates\.json/,
      })
    ).toHaveTextContent('1 finding');

    fireEvent.click(within(panel).getByRole('button', { name: /has no Application task/ }));
    expect(mode('Visual')).toHaveAttribute('aria-pressed', 'true');
    expect(pane()).toHaveTextContent('BPMN');
    expect(await screen.findByTestId('bpmn-modeler')).toHaveAttribute('data-focus', 'hello');
  });

  it('selects a task of the workflow in Candidates', async () => {
    await openProblemEditor({ delay: 10 });
    const graph = await screen.findByRole('group', { name: 'Workflow of the package' });
    fireEvent.click(within(graph).getByRole('button', { name: /^T2/ }));
    expect(pane()).toHaveTextContent('Candidates');
    expect(screen.getByRole('combobox', { name: 'Task' })).toHaveValue('T2');
    expect(screen.getByRole('region', { name: 'Candidates for T2' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Candidates for T1' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Task' }), { target: { value: '' } });
    expect(screen.getByRole('region', { name: 'Candidates for T1' })).toBeInTheDocument();
  });

  it('edits a value in the matrix: the check’s finding shows on its cell and in Code, the fix passes, and each edit is one undo step', async () => {
    bim.validate.mockImplementation(async (archive: Uint8Array) => {
      const files = await unzipPackage(
        archive.buffer.slice(
          archive.byteOffset,
          archive.byteOffset + archive.byteLength
        ) as ArrayBuffer
      );
      const latency = JSON.parse(files['candidates.json']).spec.candidates['service-a'].features
        .latency;
      return latency === 900
        ? refused([finding({ resource: 'candidates.json', pointer: BLANK_LATENCY })])
        : analysis({ facts: blankFacts(latency) });
    });
    await openProblemEditor();
    checkNow();
    await waitFor(() => expect(status()).toHaveTextContent('Valid package'));
    showPane('Candidates');
    const table = () => screen.getByRole('table', { name: /Task hello/ });
    const value = () => within(table()).getByRole('textbox', { name: 'latency for service-a' });

    fireEvent.change(value(), { target: { value: '900' } });
    expect(within(table()).getByText('Pending check')).toBeInTheDocument();
    checkNow();
    await waitFor(() => expect(status()).toHaveTextContent('Not valid · 1 problem'));
    expect(screen.getByText('Stale: showing the last valid package.')).toBeInTheDocument();
    expect(within(table()).getByText('Pending check')).toBeInTheDocument();

    fireEvent.click(
      within(table()).getByRole('button', {
        name: 'candidate feature value is above its declared domain',
      })
    );
    expect(mode('Code')).toHaveAttribute('aria-pressed', 'true');
    const source = screen.getByLabelText('candidates.json source') as HTMLTextAreaElement;
    await waitFor(() => expect(source.dataset.anchor).toBeDefined());
    expect(source.value.slice(Number(source.dataset.anchor), Number(source.dataset.head))).toBe(
      '900'
    );

    showPane('Candidates');
    fireEvent.change(value(), { target: { value: '20' } });
    checkNow();
    await waitFor(() => expect(status()).toHaveTextContent('Valid package'));
    expect(within(table()).queryByText('Pending check')).toBeNull();
    expect(within(table()).queryByRole('button', { name: /above its declared domain/ })).toBeNull();

    fileMenu('Undo');
    expect(value()).toHaveValue('900');
    expect(within(table()).getByText('Pending check')).toBeInTheDocument();
  });

  it('opens a rule of the Rules pane in its file, at the range the package writes it', async () => {
    const facts = blankFacts();
    facts.constraints = [
      {
        id: 'optimization/first',
        enforcement: 'hard',
        expression: { kind: 'literal', value: true },
        when: null,
        penalty: null,
        origin: {
          resource: 'optimization',
          path: 'optimization.json',
          pointer: '/spec/criteria/0/id',
        },
      },
    ];
    bim.validate.mockResolvedValue(analysis({ facts }));
    await openProblemEditor();
    checkNow();
    await waitFor(() => expect(status()).toHaveTextContent('Valid package'));
    showPane('Rules');
    expect(screen.getByRole('region', { name: 'Optimization optimization' })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open optimization/first in optimization.json at /spec/criteria/0/id',
      })
    );
    expect(mode('Code')).toHaveAttribute('aria-pressed', 'true');
    const source = screen.getByLabelText('optimization.json source') as HTMLTextAreaElement;
    await waitFor(() => expect(source.dataset.anchor).toBeDefined());
    expect(source.value.slice(Number(source.dataset.anchor), Number(source.dataset.head))).toBe(
      '"latency"'
    );
  });

  it('shows the changes of a file against the package as opened, and undoes, redoes and resets them', async () => {
    await openProblemEditor();
    showCode();
    const source = screen.getByLabelText('instance.json source');
    fireEvent.change(source, {
      target: { value: (source as HTMLTextAreaElement).value.replace('hello-bim', 'renamed') },
    });
    expect(screen.getByRole('button', { name: /instance\.json/ })).toHaveTextContent('changed');
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(
      within(screen.getByRole('region', { name: 'Changes in instance.json' })).getAllByText(
        'renamed',
        { exact: false }
      ).length
    ).toBeGreaterThan(0);

    fileMenu('Undo');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain(
      'hello-bim'
    );
    fileMenu('Redo');
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain(
      'renamed'
    );
    fileMenu('Reset');
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain(
      'hello-bim'
    );
  });

  it('waits for valid JSON before it checks, and says which file it waits for', async () => {
    await openProblemEditor({ delay: 10 });
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    showCode();
    fireEvent.change(screen.getByLabelText('instance.json source'), {
      target: { value: '{"apiVersion": ' },
    });
    expect(status()).toHaveTextContent('Waiting for valid JSON in instance.json');
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('saves a valid package as a new version of a problem, with the editor as its producer, and links to it', async () => {
    problems.createRevision.mockResolvedValue({
      problem: { slug: 'checkout', name: 'Checkout' },
      revision: { revision: 4 },
      compilation: {},
      created: true,
    });
    await openProblemEditor({ delay: 10 });
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog', { name: 'Save the package' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'New version' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /Checkout/ }));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save as a new version of Checkout' })
    );

    expect(
      await screen.findByText('Saved as version 4 of Checkout. Run it from its page.')
    ).toBeInTheDocument();
    expect(problems.createRevision).toHaveBeenCalledWith(
      'isa-demo',
      'checkout',
      expect.any(Uint8Array),
      { producer: EDITOR_PRODUCER }
    );
    fireEvent.click(screen.getByRole('link', { name: 'Open the problem' }));
    await waitFor(() =>
      expect(addressNow()).toBe(problemPath('isa-demo', 'checkout', undefined, { version: 4 }))
    );
  });

  it('saves a new problem into an organization the account writes, named after the package', async () => {
    problems.create.mockResolvedValue({
      problem: { slug: 'hello-bim', name: 'hello-bim' },
      revision: { revision: 1 },
      compilation: {},
      created: true,
    });
    await openProblemEditor({ delay: 10 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the package' });
    expect(within(dialog).getByRole('button', { name: 'New problem' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(dialog).getByDisplayValue('hello-bim')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as a new problem' }));
    expect(
      await screen.findByText('Saved as version 1 of hello-bim. Run it from its page.')
    ).toBeInTheDocument();
    expect(problems.create).toHaveBeenCalledWith('isa-demo', expect.any(Uint8Array), {
      slug: 'hello-bim',
      name: 'hello-bim',
      producer: EDITOR_PRODUCER,
    });
  });

  it('lets a VIEWER edit and check, and offers no organization to save into', async () => {
    await openProblemEditor({ role: 'VIEWER', delay: 10 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the package' });
    expect(within(dialog).getByRole('button', { name: 'Save as a new problem' })).toBeDisabled();
  });

  it('lets a visitor edit, check and download, stores nothing, and carries the package through the sign-in', async () => {
    await openProblemEditor({ user: null, org: null, delay: 10 });
    await waitFor(() => expect(status()).toHaveTextContent('Valid package'));
    expect(bim.validate).toHaveBeenCalledWith(expect.any(Uint8Array), {
      include: ['facts'],
      signal: expect.anything(),
      acceptRefusal: true,
    });
    expect(screen.getByRole('note')).toHaveTextContent('Nothing is stored');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.queryByRole('menuitem', { name: 'Open a problem version…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'File' }));

    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(addressNow()).toBe('/authentication'));
    expect(Object.keys((await loadDraft(CARRY_SCOPE)) ?? {})).toContain('instance.json');
  });

  it('opens the package a visitor kept, once signed in, and forgets it', async () => {
    await saveDraft(CARRY_SCOPE, packageFilesNamed('carried'));
    await openProblemEditor({ org: null, query: '?carry=1' });
    expect(screen.getByText('Your draft, kept in this browser')).toBeInTheDocument();
    showCode();
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain(
      'carried'
    );
    await waitFor(() => expect(addressNow()).toBe('/problem-editor'));
    expect(await loadDraft(CARRY_SCOPE)).toBeNull();
  });

  it('opens a template from the Open dialog through the address', async () => {
    await openProblemEditor();
    fileMenu('Open a template…');
    const dialog = await screen.findByRole('dialog', { name: 'Open a package' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'demo/01_simple_seq' }));
    await waitFor(() => expect(addressNow()).toBe('/problem-editor?template=demo%2F01_simple_seq'));
  });

  it('names the problem version it was opened on', async () => {
    problems.revisions.mockResolvedValue([{ id: 'r2', revision: 2 }]);
    problems.source.mockResolvedValue(
      (await import('../../utils/editorTestKit')).archiveOf(packageFilesNamed('checkout'))
    );
    await openProblemEditor({ query: '?problem=checkout&revision=2' });
    expect(screen.getByText('Loaded version 2 of checkout')).toBeInTheDocument();
    expect(await screen.findByTitle('Editing Checkout from version 2')).toHaveTextContent(
      'Editing Checkout · from v2'
    );
  });
});
