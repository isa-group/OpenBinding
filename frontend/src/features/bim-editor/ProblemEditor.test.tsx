import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BimDiagnostic } from '../../api/bim';
import type { Located } from '../../shared/diagnostics/located';
import fmsFacts from '../../test/fixtures/core/fms.facts.json';
import { analysis, checkNow, openProblemEditor, showPane, whereOf } from './editorTestKit';
import { EDITOR_PRODUCER } from './useProblemEditor';

const bim = vi.hoisted(() => ({ validate: vi.fn(), template: vi.fn(), templates: vi.fn() }));
const problems = vi.hoisted(() => ({ list: vi.fn(), revisions: vi.fn(), source: vi.fn(), create: vi.fn(), createRevision: vi.fn() }));
vi.mock('../../api/bim', () => ({ bimApi: bim }));
vi.mock('../../api/problems', () => ({ problemsApi: problems }));
// The code editor as a text box that shows where its cursor was put and how many findings it marks.
vi.mock('../../components/CodeEditor/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, ariaLabel, selection, diagnostics, language }: {
    value: string; onChange: (value: string) => void; ariaLabel: string; selection?: { anchor: number; head?: number }; diagnostics?: readonly Located[]; language?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      data-language={language}
      data-anchor={selection?.anchor}
      data-head={selection?.head}
      data-marks={diagnostics?.length ?? 0}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('./BpmnModeler', () => ({
  BpmnModeler: ({ focusElement }: { focusElement?: string | null }) => <div data-testid="bpmn-modeler" data-focus={focusElement ?? ''} />,
}));

const valid = () => analysis({ facts: fmsFacts });
const finding = (over: Partial<BimDiagnostic>): BimDiagnostic => ({ code: 'feature_value_domain', message: 'candidate feature value is above its declared domain', ...over });
const refused = (diagnostics: BimDiagnostic[]) => ({ valid: false, status: 422, code: 'invalid_instance', message: 'invalid_instance', diagnostics });

const pane = () => screen.getByRole('tab', { selected: true });

describe('ProblemEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bim.validate.mockResolvedValue(valid());
    bim.templates.mockResolvedValue(['demo/01_simple_seq']);
    problems.list.mockResolvedValue({ problems: [{ id: 'p1', slug: 'checkout', name: 'Checkout' }], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([]);
  });

  it('shows the panes of the package, and the engines and problems of its last check', async () => {
    await openProblemEditor({ delay: 10 });
    expect(within(screen.getByRole('tablist', { name: 'Editor panes' })).getAllByRole('tab').map((tab) => tab.textContent))
      .toEqual(['Workflow', 'Candidates', 'Files', 'Forms', 'BPMN']);
    expect(screen.getByText('A blank package')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('pe-check-status')).toHaveTextContent('Valid package'));
    expect(screen.getByRole('group', { name: 'Workflow of the package' })).toBeInTheDocument();
    const engines = screen.getByRole('list', { name: 'Engine modes' });
    expect(within(engines).getByText('random-search 1.0.0')).toBeInTheDocument();
    expect(within(engines).getByText('Can run it')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Problems' })).toHaveTextContent('No issues');

    showPane('Candidates');
    expect(screen.getByRole('region', { name: 'Candidates of each task' })).toBeInTheDocument();
    showPane('Files');
    expect(screen.getByRole('navigation', { name: 'Files of the package' })).toBeInTheDocument();
    expect(await screen.findByLabelText('instance.json source')).toHaveAttribute('data-language', 'json');
    fireEvent.click(screen.getByRole('button', { name: /workflow\.bpmn/ }));
    expect(screen.getByLabelText('workflow.bpmn source')).toHaveAttribute('data-language', 'xml');
    showPane('Forms');
    expect(screen.getByRole('navigation', { name: 'BIM resources' })).toBeInTheDocument();
    showPane('BPMN');
    expect(await screen.findByTestId('bpmn-modeler')).toBeInTheDocument();
  });

  it('opens a finding’s file at its range, and a BPMN finding at its element in the diagram', async () => {
    bim.validate.mockResolvedValue(refused([
      finding({ resource: 'candidates.json', pointer: '/spec/candidates/service-a/features/latency' }),
      finding({ code: 'bpmn_task_ref', message: 'BPMN task \'hello\' has no Application task', resource: 'workflow.bpmn', pointer: '/process/hello', bpmnElement: 'hello' }),
    ]));
    await openProblemEditor();
    checkNow();
    const panel = screen.getByRole('region', { name: 'Problems' });
    await waitFor(() => expect(panel).toHaveTextContent('2 errors'));
    expect(within(panel).getByText('candidates.json')).toBeInTheDocument();
    expect(screen.getByTestId('pe-check-status')).toHaveTextContent('Not valid · 2 problems');

    fireEvent.click(within(panel).getByRole('button', { name: /above its declared domain/ }));
    expect(pane()).toHaveTextContent('Files');
    const source = screen.getByLabelText('candidates.json source') as HTMLTextAreaElement;
    const anchor = Number(source.dataset.anchor);
    expect(source.value.slice(anchor, Number(source.dataset.head))).toBe('10');
    expect(source).toHaveAttribute('data-marks', '1');
    expect(within(screen.getByRole('navigation', { name: 'Files of the package' })).getByRole('button', { name: /candidates\.json/ })).toHaveTextContent('1 finding');

    fireEvent.click(within(panel).getByRole('button', { name: /has no Application task/ }));
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

  it('shows the changes of a file against the package as opened, and undoes, redoes and resets them', async () => {
    await openProblemEditor();
    showPane('Files');
    const source = screen.getByLabelText('instance.json source');
    fireEvent.change(source, { target: { value: (source as HTMLTextAreaElement).value.replace('hello-bim', 'renamed') } });
    expect(screen.getByRole('button', { name: /instance\.json/ })).toHaveTextContent('changed');
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(screen.getAllByText('renamed', { exact: false }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain('hello-bim');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain('renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByLabelText('instance.json source') as HTMLTextAreaElement).value).toContain('hello-bim');
  });

  it('waits for valid JSON before it checks, and says which file it waits for', async () => {
    await openProblemEditor({ delay: 10 });
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    showPane('Files');
    fireEvent.change(screen.getByLabelText('instance.json source'), { target: { value: '{"apiVersion": ' } });
    expect(screen.getByTestId('pe-check-status')).toHaveTextContent('Waiting for valid JSON in instance.json');
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('saves a valid package as a new version of a problem, with the editor as its producer, and links to it', async () => {
    problems.createRevision.mockResolvedValue({ problem: { slug: 'checkout', name: 'Checkout' }, revision: { revision: 4 }, compilation: {}, created: true });
    const { router } = await openProblemEditor({ delay: 10 });
    const save = screen.getByRole('button', { name: 'Save as version…' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog', { name: 'Save the package' });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Checkout' })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Save into problem' }), { target: { value: 'checkout' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as a new version of Checkout' }));

    expect(await screen.findByText('Saved as version 4 of Checkout. Run it from its page.')).toBeInTheDocument();
    expect(problems.createRevision).toHaveBeenCalledWith('isa-demo', 'checkout', expect.any(Uint8Array), { producer: EDITOR_PRODUCER });
    fireEvent.click(screen.getByRole('link', { name: 'Open the problem' }));
    await waitFor(() => expect(whereOf(router)).toBe('/app/isa-demo/problems/checkout?version=4'));
  });

  it('lets a VIEWER edit and check, and not save', async () => {
    await openProblemEditor({ role: 'VIEWER', delay: 10 });
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Save as version…' })).not.toBeInTheDocument();
    expect(screen.getByText('You can edit and check here; saving into the organization needs MEMBER.')).toBeInTheDocument();
  });

  it('opens a template from the Open dialog through the address', async () => {
    const { router } = await openProblemEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Open…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a package' });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'demo/01_simple_seq' })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Template' }), { target: { value: 'demo/01_simple_seq' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open template' }));
    await waitFor(() => expect(whereOf(router)).toBe('/app/isa-demo/problem-editor?template=demo%2F01_simple_seq'));
  });
});
