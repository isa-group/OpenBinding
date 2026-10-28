import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, type CorpusGeneratedResponse, type InstanceGeneratedResponse } from '../../api/client';
import type { Organization } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { AuthContext } from '../../contexts/auth';
import { digestOf } from '../Cases/fixtures';
import { iker, lucia, org, project } from '../Project/testKit';
import { GeneratorLab } from './GeneratorLab';

const generator = vi.hoisted(() => ({ instance: vi.fn(), corpus: vi.fn(), convertLegacy: vi.fn() }));
const platform = vi.hoisted(() => ({ projects: vi.fn() }));

const { saveText } = vi.hoisted(() => ({ saveText: vi.fn() }));

vi.mock('../../components/rendering/download', () => ({ saveText }));
vi.mock('../../api/generator', () => ({ generatorApi: generator }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const isaDemo = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const qosLab = org('qos-lab', { name: 'QoS Lab', effective_role: 'OWNER' });
const readLab = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project('qos-benchmarks', { name: 'QoS Benchmarks' })],
  'qos-lab': [project('placement-edge', { name: 'Placement edge', organization_id: 'org-qos-lab' })],
  'read-lab': [project('read-only', { name: 'Read only', organization_id: 'org-read-lab' })],
};

function renderLab({ user = lucia as UserProfile | null, organizations = [isaDemo, qosLab, readLab] as Organization[] } = {}) {
  const context: PlatformOutletContext = { organizations, projects: [], organization: organizations[0], project: undefined, loading: false, reload: vi.fn() };
  return render(
    <MemoryRouter initialEntries={['/app/generator']}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user?.role === 'admin' }}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="/app/generator" element={<GeneratorLab />} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const generated = (over: Partial<InstanceGeneratedResponse> = {}): InstanceGeneratedResponse => ({
  name: 'generated_qaco',
  package_digest: digestOf('1'),
  instance_digest: digestOf('2'),
  compilation_digest: digestOf('3'),
  snapshot_id: null,
  case_id: null,
  target_engines: ['minizinc-csp'],
  workload_features: {},
  files: { 'instance.json': { apiVersion: 'bim/v1', kind: 'Instance' }, 'workflow.bpmn': '<bpmn:definitions/>' },
  actual_constraint_count: 1,
  ...over,
});

const corpus = (count: number): CorpusGeneratedResponse => ({
  name: 'generated_qaco',
  count,
  instances: Array.from({ length: count }, (_, index) => ({
    name: `generated_qaco_${index + 1}`, package_digest: digestOf('4'), compilation_digest: digestOf('5'), workload_features: {}, actual_constraint_count: 1,
  })),
});

const generate = () => fireEvent.click(screen.getByRole('button', { name: 'Generate instance' }));
const preview = () => screen.getByRole('region', { name: 'Preview' });
const keepIt = () => screen.getByRole('region', { name: 'Keep it' });
const refusal = (status: number, code?: string, problem?: unknown) => Object.assign(new HttpError(status, 'refused'), { code, problem });

describe('Generator lab', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    platform.projects.mockImplementation(async (slug: string) => projectsOf[slug] ?? []);
    generator.instance.mockResolvedValue(generated());
  });

  describe('the page', () => {
    it('opens on one instance with default settings and nothing generated yet', async () => {
      renderLab();

      expect(screen.getByRole('heading', { level: 1, name: 'Generator lab' })).toBeInTheDocument();
      expect(screen.getByText(/A research tool; results are labelled synthetic\./)).toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Generator lab')).toHaveAttribute('aria-current', 'page');
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['One instance', 'Batch', 'Convert old format']);
      expect(screen.getByLabelText('Tasks')).toHaveValue(6);
      expect(screen.getByLabelText('Candidates per task')).toHaveValue(5);
      expect(screen.getByLabelText('Random seed')).toHaveValue('42');
      expect(screen.getByRole('radio', { name: 'Even spread' })).toBeChecked();
      expect(within(preview()).getByText('Default settings shown. Generate to see the structure.')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: /How the latency of the providers is spread between 50 and 300 milliseconds/ })).toBeInTheDocument();
      expect(generator.instance).not.toHaveBeenCalled();
    });

    it('keeps the less common settings behind Advanced settings', () => {
      renderLab();
      const advanced = screen.getByText('Advanced settings').closest('details');
      expect(advanced).not.toHaveAttribute('open');
      expect(advanced).toContainElement(screen.getByLabelText('Control flow (%)'));
      expect(screen.getByLabelText('Control flow (%)')).toHaveValue(50);
      expect(screen.getByLabelText('Instance name')).toHaveValue('generated_qaco');
      expect(screen.getByRole('checkbox', { name: /Guarantee feasibility/ })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'evolutionary-heuristics' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'random-search' })).not.toBeChecked();
    });
  });

  describe('one instance', () => {
    it('generates with the settings, shows the generating state, and then the structure with its figures', async () => {
      let finish: (value: InstanceGeneratedResponse) => void = () => undefined;
      generator.instance.mockReturnValue(new Promise<InstanceGeneratedResponse>((resolve) => { finish = resolve; }));
      renderLab();

      fireEvent.change(screen.getByLabelText('Random seed'), { target: { value: '7' } });
      fireEvent.click(screen.getByRole('radio', { name: 'Bell curve' }));
      generate();

      expect(await within(preview()).findByText('Generating…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Generate instance' })).toBeDisabled();
      expect(generator.instance).toHaveBeenCalledWith(expect.objectContaining({
        name: 'generated_qaco', tasks: 6, candidates: 5, seed: 7, control_flow: 50, guarantee_feasibility: true, optimization_mode: 'weighted',
      }));
      const sent = generator.instance.mock.calls[0][0];
      expect(sent.persist).toBeUndefined();
      expect(sent.features[1].distribution).toMatchObject({ kind: 'normal', mean: 175 });

      finish(generated());
      const chain = await within(preview()).findByRole('list', { name: 'Workflow of 6 tasks, in sequence' });
      expect(within(chain).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['t1→', 't2→', 't3→', 't4→', 't5→', 't6']);
      const facts = within(preview());
      expect(facts.getByText('Combinations').nextSibling).toHaveTextContent('≈ 10^4.2');
      expect(facts.getByText('Seed').nextSibling).toHaveTextContent('7');
      expect(facts.getByText('Rules').nextSibling).toHaveTextContent('1');
      expect(facts.getByText('Synthetic · fingerprint sha256-1111…1111')).toBeInTheDocument();
      expect(facts.queryByText('Default settings shown. Generate to see the structure.')).not.toBeInTheDocument();
    });

    it('always sends a seed, so keeping the result keeps the one that was previewed', async () => {
      renderLab();
      fireEvent.change(screen.getByLabelText('Random seed'), { target: { value: '' } });
      generate();
      await within(preview()).findByRole('list', { name: /Workflow of/ });
      const seed = generator.instance.mock.calls[0][0].seed;
      expect(Number.isInteger(seed)).toBe(true);
      expect(within(preview()).getByText('Seed').nextSibling).toHaveTextContent(String(seed));
    });

    // [utest->req~frontend-generator-files-source-view~1]
    it('shows the files behind View source and clears the preview when a setting changes', async () => {
      renderLab();
      generate();
      await within(preview()).findByRole('list', { name: /Workflow of/ });

      fireEvent.click(within(preview()).getByText('View source'));
      expect(within(preview()).getByRole('combobox', { name: 'File' })).toHaveValue('instance.json');
      const instanceView = within(preview()).getByRole('region', { name: 'instance.json' });
      expect(within(instanceView).getByText(/"apiVersion": "bim\/v1"/)).toBeInTheDocument();
      fireEvent.click(within(instanceView).getByRole('button', { name: 'Download instance.json' }));
      expect(saveText).toHaveBeenLastCalledWith(expect.stringContaining('"apiVersion": "bim/v1"'), 'instance.json', 'text/plain');

      fireEvent.change(within(preview()).getByRole('combobox', { name: 'File' }), { target: { value: 'workflow.bpmn' } });
      const bpmnView = within(preview()).getByRole('region', { name: 'workflow.bpmn' });
      expect(within(bpmnView).getByText('<bpmn:definitions/>')).toBeInTheDocument();
      expect(within(preview()).queryByRole('region', { name: 'instance.json' })).not.toBeInTheDocument();
      fireEvent.click(within(bpmnView).getByRole('button', { name: 'Download workflow.bpmn' }));
      expect(saveText).toHaveBeenLastCalledWith('<bpmn:definitions/>', 'workflow.bpmn', 'text/plain');

      fireEvent.change(screen.getByLabelText('Tasks'), { target: { value: '8' } });
      expect(within(preview()).getByText('Default settings shown. Generate to see the structure.')).toBeInTheDocument();
    });

    it('marks the fields that cannot be generated (422) without asking the server', async () => {
      renderLab();
      fireEvent.change(screen.getByLabelText('Tasks'), { target: { value: '1' } });
      fireEvent.change(screen.getByLabelText('To (ms)'), { target: { value: '40' } });
      generate();

      expect(await screen.findByText('Check the highlighted fields (422): the numbers have to be inside what the generator accepts, and “to” has to be above “from”.')).toBeInTheDocument();
      expect(screen.getByLabelText('Tasks')).toBeInvalid();
      expect(screen.getByText('Tasks: a whole number from 2 to 1000.')).toBeInTheDocument();
      expect(screen.getByLabelText('To (ms)')).toBeInvalid();
      expect(screen.getByText('The highest latency must be above the lowest.')).toBeInTheDocument();
      expect(generator.instance).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText('Tasks'), { target: { value: '6' } });
      expect(screen.getByLabelText('Tasks')).not.toBeInvalid();
    });

    it('shows the server’s 422 on the form, with the field it names', async () => {
      generator.instance.mockRejectedValue(refusal(422, 'validation_error', { code: 'validation_error', detail: 'Request validation failed', diagnostics: [{ code: 'value_error', message: 'Too many candidates for these tasks', in: 'body', pointer: '/candidates', loc: ['body', 'candidates'] }] }));
      renderLab();
      generate();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('These settings can’t be generated (422 · invalid generation config): the server rejected the combination.');
      expect(screen.getByLabelText('Candidates per task')).toBeInvalid();
      expect(screen.getByText('Too many candidates for these tasks')).toBeInTheDocument();
      expect(within(preview()).getByText('Default settings shown. Generate to see the structure.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Generate instance' })).toBeEnabled();
    });

    it('says when the service cannot answer', async () => {
      generator.instance.mockRejectedValue(refusal(503));
      renderLab();
      generate();
      expect(await screen.findByRole('alert')).toHaveTextContent('A service OpenBinding depends on isn’t answering (503), so nothing was generated. Try again in a moment.');
    });
  });

  describe('a batch', () => {
    it('generates the same settings many times and shows the figures of each', async () => {
      generator.corpus.mockResolvedValue(corpus(3));
      renderLab();
      fireEvent.click(screen.getByRole('tab', { name: 'Batch' }));
      expect(screen.getByText('Same settings as a single instance, repeated as many times as you ask for.')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('How many instances'), { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate batch' }));

      const instances = await within(preview()).findByRole('list', { name: 'Instances of the batch' });
      expect(within(instances).getAllByRole('listitem')).toHaveLength(3);
      expect(generator.corpus).toHaveBeenCalledWith({
        count: 3, name: 'generated_qaco', persist: false, base_config: expect.objectContaining({ tasks: 6, candidates: 5, seed: 42 }),
      });
      expect(within(preview()).getByText('Instances').nextSibling).toHaveTextContent('3');
      expect(within(preview()).getByText('Tasks each').nextSibling).toHaveTextContent('6');
      expect(within(preview()).getByText('Combinations each').nextSibling).toHaveTextContent('≈ 10^4.2');
      expect(generator.instance).not.toHaveBeenCalled();
    });

    it('does not ask for more than 100 instances', async () => {
      renderLab();
      fireEvent.click(screen.getByRole('tab', { name: 'Batch' }));
      fireEvent.change(screen.getByLabelText('How many instances'), { target: { value: '101' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate batch' }));
      expect(await screen.findByText('How many instances: a whole number from 1 to 100.')).toBeInTheDocument();
      expect(generator.corpus).not.toHaveBeenCalled();
    });

    it('keeps the batch as a collection of the project', async () => {
      generator.corpus.mockResolvedValue(corpus(2));
      renderLab();
      fireEvent.click(screen.getByRole('tab', { name: 'Batch' }));
      fireEvent.change(screen.getByLabelText('How many instances'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate batch' }));
      await within(preview()).findByRole('list', { name: 'Instances of the batch' });

      await within(keepIt()).findByRole('option', { name: 'QoS Benchmarks · ISA Demo Group' });
      expect(within(keepIt()).queryByRole('button', { name: 'Open in Workbench' })).not.toBeInTheDocument();
      fireEvent.click(within(keepIt()).getByRole('button', { name: 'Save to project' }));

      expect(await within(keepIt()).findByText('Saved to QoS Benchmarks · ISA Demo Group as a collection of synthetic instances.')).toBeInTheDocument();
      expect(generator.corpus).toHaveBeenLastCalledWith({
        count: 2, name: 'generated_qaco', persist: true, project_id: 'project-qos-benchmarks', collection_name: 'generated_qaco',
        base_config: expect.objectContaining({ tasks: 6 }),
      });
      expect(within(keepIt()).getByRole('link', { name: 'See the project’s cases' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/collections');
    });
  });

  describe('converting an old-format instance', () => {
    it('converts pasted text into a package and shows what came out', async () => {
      generator.convertLegacy.mockResolvedValue(generated({ name: 'converted_legacy', target_engines: [] }));
      renderLab();
      fireEvent.click(screen.getByRole('tab', { name: 'Convert old format' }));

      const convert = screen.getByRole('button', { name: 'Convert to a package' });
      expect(convert).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Or paste its text'), { target: { value: 'TASK 1 CANDIDATES 5' } });
      fireEvent.click(convert);

      expect(await within(preview()).findByText('Name')).toBeInTheDocument();
      expect(generator.convertLegacy).toHaveBeenCalledWith({
        raw_text: 'TASK 1 CANDIDATES 5', name: 'converted_legacy', repair_empty_branches: true, guarantee_feasibility: true, tension: 0.7,
      });
      expect(within(preview()).getByText('Files').nextSibling).toHaveTextContent('2');
      expect(within(preview()).getByText('Engines it suits').nextSibling).toHaveTextContent('any');
    });

    it('reads the instance from a file', async () => {
      renderLab();
      fireEvent.click(screen.getByRole('tab', { name: 'Convert old format' }));
      fireEvent.change(screen.getByLabelText('Old-format instance file'), { target: { files: [new File(['TASK 2'], 'legacy.txt', { type: 'text/plain' })] } });

      expect(await screen.findByText('Loaded legacy.txt')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Or paste its text')).toHaveValue('TASK 2'));
      expect(screen.getByRole('button', { name: 'Convert to a package' })).toBeEnabled();
    });

    it('says when the text cannot be read (422)', async () => {
      generator.convertLegacy.mockRejectedValue(refusal(422));
      renderLab();
      fireEvent.click(screen.getByRole('tab', { name: 'Convert old format' }));
      fireEvent.change(screen.getByLabelText('Or paste its text'), { target: { value: 'nonsense' } });
      fireEvent.click(screen.getByRole('button', { name: 'Convert to a package' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That text can’t be converted (422 · invalid legacy instance): the server could not read it as an old-format instance.');
    });
  });

  describe('keeping the result', () => {
    it('offers the projects where the person is at least a MEMBER and keeps nothing until something is generated', async () => {
      renderLab();
      await within(keepIt()).findByRole('option', { name: 'QoS Benchmarks · ISA Demo Group' });
      const options = within(keepIt()).getAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual(['QoS Benchmarks · ISA Demo Group', 'Placement edge · QoS Lab']);
      expect(within(keepIt()).getByRole('button', { name: 'Save to project' })).toBeDisabled();
      expect(within(keepIt()).getByText('Generate something first; then you can keep it.')).toBeInTheDocument();
      expect(platform.projects).not.toHaveBeenCalledWith('read-lab');
    });

    it('saves the same instance that was previewed, as a case of the chosen project', async () => {
      renderLab();
      await within(keepIt()).findByRole('option', { name: 'QoS Benchmarks · ISA Demo Group' });
      fireEvent.change(screen.getByLabelText('Random seed'), { target: { value: '9' } });
      generate();
      await within(preview()).findByRole('list', { name: /Workflow of/ });

      fireEvent.change(within(keepIt()).getByRole('combobox', { name: 'Project' }), { target: { value: 'project-placement-edge' } });
      fireEvent.click(within(keepIt()).getByRole('button', { name: 'Save to project' }));

      expect(await within(keepIt()).findByText('Saved to Placement edge · QoS Lab as a synthetic instance.')).toBeInTheDocument();
      const [preview1, saved] = generator.instance.mock.calls.map(([params]) => params);
      expect(saved).toEqual({ ...preview1, persist: true, project_id: 'project-placement-edge', case_name: 'generated_qaco' });
      expect(saved.seed).toBe(9);
      expect(within(keepIt()).getByRole('link', { name: 'See the project’s cases' })).toHaveAttribute('href', '/app/qos-lab/placement-edge/cases');
    });

    it.each([
      [404, 'That project no longer exists or you lost access (404).'],
      [403, 'You can generate, but you don’t have permission to add to that project (403).'],
      [401, 'Saving to a project needs an account (401).'],
    ])('says what a %i means when saving', async (status, text) => {
      renderLab();
      await within(keepIt()).findByRole('option', { name: 'QoS Benchmarks · ISA Demo Group' });
      generate();
      await within(preview()).findByRole('list', { name: /Workflow of/ });
      generator.instance.mockRejectedValue(refusal(status));
      fireEvent.click(within(keepIt()).getByRole('button', { name: 'Save to project' }));

      expect(await within(keepIt()).findByRole('alert')).toHaveTextContent(text);
      expect(within(preview()).getByRole('list', { name: /Workflow of/ })).toBeInTheDocument();
    });

    it('hands the generated package to the workbench of the project as its draft', async () => {
      renderLab();
      await within(keepIt()).findByRole('option', { name: 'QoS Benchmarks · ISA Demo Group' });
      generate();
      await within(preview()).findByRole('list', { name: /Workflow of/ });

      fireEvent.click(within(keepIt()).getByRole('button', { name: 'Open in Workbench' }));

      expect(await screen.findByText('elsewhere')).toBeInTheDocument();
      const draft = JSON.parse(localStorage.getItem('bim-v1-draft:user-lucia:/app/isa-demo/qos-benchmarks/workbench::') ?? '{}');
      expect(Object.keys(draft)).toEqual(['instance.json', 'workflow.bpmn']);
      expect(JSON.parse(draft['instance.json'])).toEqual({ apiVersion: 'bim/v1', kind: 'Instance' });
      expect(draft['workflow.bpmn']).toBe('<bpmn:definitions/>');
    });

    it('says a visitor can generate but not save', async () => {
      renderLab({ user: null });
      fireEvent.click(screen.getByRole('tab', { name: 'Batch' }));
      expect(screen.getByText('Keeping a corpus needs an account; without one you only see the preview.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'One instance' }));
      generate();
      await within(preview()).findByRole('list', { name: /Workflow of/ });

      const keep = keepIt();
      expect(keep).toHaveTextContent('Saving to a project needs an account (401).');
      expect(within(keep).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
      expect(within(keep).queryByRole('button', { name: 'Save to project' })).not.toBeInTheDocument();
      expect(platform.projects).not.toHaveBeenCalled();
    });

    it('says there is no project to add to when the person is only a VIEWER everywhere', async () => {
      renderLab({ organizations: [readLab] });
      expect(await within(keepIt()).findByRole('option', { name: 'No project where you can add' })).toBeInTheDocument();
      expect(within(keepIt()).getByRole('combobox', { name: 'Project' })).toBeDisabled();
    });
  });

  it('offers no engine calibration, not even to a platform administrator', () => {
    renderLab({ user: iker });

    expect(screen.queryByRole('tab', { name: /calibrate/i })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
  });
});
