import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { unzipPackage } from '../../utils/bimZip';
import { InstanceWorkspace } from './InstanceWorkspace';

interface TestAnalysisResponse {
  valid: boolean;
  compatibleModes: Array<{
    engine: { namespace: string; name: string; version: string; digest: string };
    registration: { namespace: string; name: string; version: string; digest: string };
    mode: string;
    compatible: boolean;
  }>;
  diagnostics: Array<Record<string, unknown>>;
}

const api = vi.hoisted(() => ({
  getBimExamples: vi.fn(async () => ['demo/01_simple_seq']),
  getBimExamplePackage: vi.fn(),
  analyzeBimPackage: vi.fn(async (archive: Uint8Array): Promise<TestAnalysisResponse> => {
    void archive;
    return {
      valid: true,
      compatibleModes: [{
        engine: { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' },
        registration: { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1.0.0+builtin.a', digest: 'sha256-registration-a' },
        mode: 'seeded',
        compatible: true,
      }],
      diagnostics: [],
    };
  }),
  createBimSnapshot: vi.fn(async () => ({ id: 'snapshot-1', irDigest: 'sha256-ir' })),
  createBimJob: vi.fn(async () => ({ id: 'job-1', status: 'queued', irDigest: 'sha256-ir' })),
  getV1Job: vi.fn(async () => ({
    status: 'completed',
    result: {
      termination: 'FEASIBLE',
      solutions: [{ decision: { kind: 'binding', binding: { hello: { resource: 'catalog', id: 'service-a' } } }, metrics: { latency: 10 } }],
    },
  })),
}));

const ENGINE_REF = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
const REGISTRATION_REF = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1.0.0+builtin.a', digest: 'sha256-registration-a' };

vi.mock('../../api/client', () => ({ apiClient: api }));
vi.mock('../../components/CodeEditor/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) => <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock('./BpmnModeler', () => ({ BpmnModeler: () => <div aria-label="BPMN modeler" /> }));

async function analyzedFiles(callIndex = api.analyzeBimPackage.mock.calls.length - 1) {
  const archive = api.analyzeBimPackage.mock.calls[callIndex][0] as Uint8Array;
  const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
  return unzipPackage(buffer);
}

describe('BIM Instance Workspace', () => {
  const renderWorkspace = () => render(<MemoryRouter><InstanceWorkspace /></MemoryRouter>);

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    api.analyzeBimPackage.mockResolvedValue({
      valid: true,
      compatibleModes: [{
        engine: ENGINE_REF,
        registration: REGISTRATION_REF,
        mode: 'seeded',
        compatible: true,
      }],
      diagnostics: [],
    });
  });

  it('starts from modular BIM v1 files and obtains examples from the backend', async () => {
    renderWorkspace();
    expect(screen.getByRole('heading', { name: 'BIM Instance Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('application.json');
    expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('candidates.json');
    expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('Candidate catalogs');
    expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('workflow.bpmn');
    await waitFor(() => expect(screen.getByRole('option', { name: 'demo/01_simple_seq' })).toBeInTheDocument());
  });

  it('keeps the package import control keyboard-focusable', () => {
    renderWorkspace();

    const importInput = screen.getByLabelText('Import .bim.zip');
    expect(importInput).toHaveAttribute('type', 'file');
    expect(importInput).toHaveClass('sr-only');
    importInput.focus();
    expect(importInput).toHaveFocus();
  });

  it('rejects invalid and duplicate renames visibly and restores the stored identifier', () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));

    const role = screen.getByLabelText('application/application role');
    fireEvent.change(role, { target: { value: 'invalid role' } });
    fireEvent.blur(role);
    expect(role).toHaveValue('application');
    expect(screen.getByRole('alert')).toHaveTextContent('Start with a letter');

    fireEvent.change(role, { target: { value: 'application' } });
    const resourceId = screen.getByLabelText('application/application resource id');
    fireEvent.change(resourceId, { target: { value: 'workflow' } });
    fireEvent.blur(resourceId);
    expect(resourceId).toHaveValue('application');
    expect(screen.getByText('The application/workflow reference already exists.')).toHaveAttribute('role', 'alert');

    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));
    fireEvent.change(screen.getByLabelText('New metric alias'), { target: { value: 'cost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add metric binding' }));
    const alias = screen.getByLabelText('latency metric alias');
    fireEvent.change(alias, { target: { value: 'cost' } });
    fireEvent.blur(alias);
    expect(alias).toHaveValue('latency');
    expect(screen.getByRole('alert')).toHaveTextContent('cost metric alias already exists');
  });

  it('sends a deterministic BIM ZIP and filters modes from authoritative analysis', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'random-search · seeded · random-search-deployment@1.0.0+builtin.a' })).toBeInTheDocument());
    const archive = api.analyzeBimPackage.mock.calls[0][0] as Uint8Array;
    expect(archive).toBeInstanceOf(Uint8Array);
    expect(Array.from(archive.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
    const files = await unzipPackage(buffer);
    const instance = JSON.parse(files['instance.json']);
    expect(instance.spec.resources).toEqual({
      application: { application: 'application.json', workflow: 'workflow.bpmn' },
      candidateCatalog: { catalog: 'candidates.json' },
      optimization: { optimization: 'optimization.json' },
    });
  });

  it('keeps multiple executable registrations distinct and solves with the selected exact pins', async () => {
    const secondRegistration = {
      namespace: 'acme',
      name: 'random-search-eu',
      version: '2.0.0',
      digest: 'sha256-registration-b',
    };
    api.analyzeBimPackage.mockResolvedValueOnce({
      valid: true,
      compatibleModes: [{
        engine: ENGINE_REF,
        registration: REGISTRATION_REF,
        mode: 'seeded',
        compatible: true,
      }, {
        engine: ENGINE_REF,
        registration: secondRegistration,
        mode: 'seeded',
        compatible: true,
      }, {
        engine: ENGINE_REF,
        registration: { ...secondRegistration, name: 'not-executable', digest: 'sha256-registration-c' },
        mode: 'seeded',
        compatible: false,
      }],
      diagnostics: [],
    });
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    const secondOption = await screen.findByRole('option', { name: 'random-search · seeded · random-search-eu@2.0.0' });
    expect(screen.queryByRole('option', { name: /not-executable/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Compatible engine mode' }), {
      target: { value: (secondOption as HTMLOptionElement).value },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

    await waitFor(() => expect(api.createBimJob).toHaveBeenCalledWith(
      'snapshot-1',
      ENGINE_REF,
      secondRegistration,
      'seeded',
    ));
  });

  it('opens a localized resource diagnostic in expert source', async () => {
    api.analyzeBimPackage.mockResolvedValueOnce({
      valid: false,
      compatibleModes: [],
      diagnostics: [{ code: 'missing_metric', message: 'latency is required', resource: 'catalog', jsonPointer: '/spec/candidates/service-a/metrics/latency' }],
    });
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    const diagnostic = await screen.findByRole('button', { name: /missing_metric latency is required/i });
    fireEvent.click(diagnostic);
    expect(await screen.findByLabelText('candidates.json expert source')).toBeInTheDocument();
  });

  it('renders decisions by their declared kind', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Solve' }));
    await waitFor(() => expect(screen.getByRole('cell', { name: 'hello' })).toBeInTheDocument());
    expect(document.querySelector('.workspace-result-summary')).toHaveTextContent('FEASIBLE');
    expect(screen.getByRole('cell', { name: 'hello' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'service-a' })).toBeInTheDocument();
    expect(api.createBimJob).toHaveBeenCalledWith(
      'snapshot-1',
      ENGINE_REF,
      REGISTRATION_REF,
      'seeded',
    );
  });

  it('edits Instance metadata, profile, local resources, and registered references transactionally', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'edited-instance' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.2.0' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Edited through the compact form' } });
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'custom-profile/v1' } });

    fireEvent.change(screen.getByLabelText('application/workflow reference type'), { target: { value: 'registered' } });
    fireEvent.change(screen.getByLabelText('application/workflow namespace'), { target: { value: 'acme.workflows' } });
    fireEvent.change(screen.getByLabelText('application/workflow registered name'), { target: { value: 'checkout' } });
    fireEvent.change(screen.getByLabelText('application/workflow registered version'), { target: { value: '2.0.0' } });
    fireEvent.change(screen.getByLabelText('application/workflow digest'), { target: { value: `sha256-${'a'.repeat(64)}` } });

    fireEvent.change(screen.getByLabelText('New resource role'), { target: { value: 'constraintSet' } });
    fireEvent.change(screen.getByLabelText('New resource id'), { target: { value: 'sharedConstraints' } });
    fireEvent.change(screen.getByLabelText('New resource package file'), { target: { value: 'candidates.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add local reference' }));

    fireEvent.click(screen.getByRole('button', { name: 'Expert source' }));
    expect((screen.getByLabelText('instance.json expert source') as HTMLTextAreaElement).value).toContain('custom-profile/v1');

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    const files = await analyzedFiles();
    const instance = JSON.parse(files['instance.json']);
    expect(instance.metadata).toEqual({
      name: 'edited-instance',
      version: '1.2.0',
      description: 'Edited through the compact form',
    });
    expect(instance.spec.profile).toBe('custom-profile/v1');
    expect(instance.spec.resources.application.workflow).toEqual({
      namespace: 'acme.workflows',
      name: 'checkout',
      version: '2.0.0',
      digest: `sha256-${'a'.repeat(64)}`,
    });
    expect(instance.spec.resources.constraintSet.sharedConstraints).toBe('candidates.json');
  });

  it('edits Optimization strategy, terms, normalization, and explicit penalties', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));

    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: 'lexicographic' } });
    fireEvent.change(screen.getByLabelText('Term 1 metric id'), { target: { value: 'duration' } });
    fireEvent.change(screen.getByLabelText('Term 1 direction'), { target: { value: 'maximize' } });
    fireEvent.change(screen.getByLabelText('Term 1 weight'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByLabelText('Term 1 normalize'));
    fireEvent.change(screen.getByLabelText('Term 1 normalization minimum'), { target: { value: '-5' } });
    fireEvent.change(screen.getByLabelText('Term 1 normalization maximum'), { target: { value: '25' } });
    fireEvent.click(screen.getByLabelText('Term 1 normalization clamp'));

    fireEvent.click(screen.getByRole('button', { name: 'Add objective term' }));
    fireEvent.change(screen.getByLabelText('Term 2 metric resource'), { target: { value: 'application' } });
    fireEvent.change(screen.getByLabelText('Term 2 metric id'), { target: { value: 'cost' } });
    fireEvent.change(screen.getByLabelText('Term 2 weight'), { target: { value: '1.5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add penalty' }));
    fireEvent.change(screen.getByLabelText('Penalty 1 constraint resource'), { target: { value: 'qualityConstraints' } });
    fireEvent.change(screen.getByLabelText('Penalty 1 constraint id'), { target: { value: 'softLatency' } });
    fireEvent.change(screen.getByLabelText('Penalty 1 weight'), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    const files = await analyzedFiles();
    const optimization = JSON.parse(files['optimization.json']);
    expect(optimization.spec).toEqual({
      type: 'MONO',
      mode: 'lexicographic',
      terms: [{
        metric: { resource: 'application', id: 'duration' },
        direction: 'maximize',
        weight: 2.5,
        normalize: { min: -5, max: 25, clamp: true },
      }, {
        metric: { resource: 'application', id: 'cost' },
        weight: 1.5,
      }],
      penalties: [{ constraint: { resource: 'qualityConstraints', id: 'softLatency' }, weight: 3 }],
    });
  });

  it('enforces MONO, MULTI, and MANY objective cardinality while authoring', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));

    fireEvent.change(screen.getByLabelText('Objective type'), { target: { value: 'MULTI' } });
    expect(screen.getByText('2 objectives')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove term' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Remove term' }).every((button) => button.hasAttribute('disabled'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Add objective term' }));
    expect(screen.getByText('3 objectives')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add objective term' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove term' })[2]);
    expect(screen.getByText('2 objectives')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Objective type'), { target: { value: 'MANY' } });
    expect(screen.getByText('3 objectives')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove term' }).every((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Add objective term' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: 'satisfy' } });
    expect(screen.getByLabelText('Objective type')).toHaveValue('MONO');
    expect(screen.getByText('0 objectives')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add objective term' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    const files = await analyzedFiles();
    expect(JSON.parse(files['optimization.json']).spec).toMatchObject({ type: 'MONO', mode: 'satisfy', terms: [] });
  });

  it('authors Application tasks, typed predicates, and metric definitions in the compact form', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /application\.json/i }));

    fireEvent.click(screen.getByLabelText('hello predicate enabled'));
    fireEvent.change(screen.getByLabelText('hello predicate'), {
      target: { value: 'candidate.properties.region == "eu"' },
    });
    fireEvent.change(screen.getByLabelText('latency unit'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('latency direction'), { target: { value: 'maximize' } });
    fireEvent.change(screen.getByLabelText('latency scope'), { target: { value: 'selectedCandidate' } });
    fireEvent.change(screen.getByLabelText('latency domain'), { target: { value: 'ratio' } });
    fireEvent.change(screen.getByLabelText('latency aggregation'), { target: { value: 'product' } });
    fireEvent.change(screen.getByLabelText('latency neutral'), { target: { value: '1' } });

    fireEvent.change(screen.getByLabelText('New metric id'), { target: { value: 'availability' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add metric' }));
    fireEvent.change(screen.getByLabelText('availability unit'), { target: { value: 'ratio' } });
    fireEvent.change(screen.getByLabelText('availability direction'), { target: { value: 'maximize' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText('task2 capability'), { target: { value: 'queue' } });

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    const files = await analyzedFiles();
    const application = JSON.parse(files['application.json']);
    expect(application.spec.tasks).toEqual({
      hello: {
        kind: 'service',
        requires: {
          type: 'http',
          predicate: 'candidate.properties.region == "eu"',
        },
      },
      task2: 'queue',
    });
    expect(application.spec.metrics).toEqual({
      latency: {
        unit: 's',
        domain: 'ratio',
        direction: 'maximize',
        scope: 'selectedCandidate',
        aggregation: 'product',
        neutral: 1,
      },
      availability: {
        type: 'number',
        unit: 'ratio',
        domain: 'real',
        direction: 'maximize',
        scope: 'invocation',
        aggregation: 'sum',
      },
    });
  });

  it('authors catalog bindings, capabilities, properties, QoS values, and candidate deletion', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));

    fireEvent.blur(screen.getByLabelText('latency metric alias'), { target: { value: 'responseTime' } });
    fireEvent.change(screen.getByLabelText('responseTime metric id'), { target: { value: 'latency' } });
    fireEvent.change(screen.getByLabelText('New metric alias'), { target: { value: 'cost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add metric binding' }));
    expect(screen.getByLabelText('service-a QoS responseTime')).toHaveValue(10);

    fireEvent.click(screen.getByRole('button', { name: 'Add candidate' }));
    fireEvent.change(screen.getByLabelText('candidate2 capability 1 type'), { target: { value: 'http' } });
    fireEvent.change(screen.getByLabelText('candidate2 capability 1 properties'), { target: { value: '{"protocol":"https"}' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add capability' })[1]);
    fireEvent.change(screen.getByLabelText('candidate2 capability 2 type'), { target: { value: 'grpc' } });
    fireEvent.change(screen.getByLabelText('candidate2 properties'), { target: { value: '{"region":"us"}' } });
    fireEvent.change(screen.getByLabelText('candidate2 QoS responseTime'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('candidate2 QoS cost'), { target: { value: '5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove candidate' })[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    const files = await analyzedFiles();
    const catalog = JSON.parse(files['candidates.json']);
    expect(catalog.spec.metricBindings).toEqual({
      responseTime: { resource: 'application', id: 'latency' },
      cost: { resource: 'application', id: 'cost' },
    });
    expect(catalog.spec.candidates).toEqual({
      candidate2: {
        provides: [{ type: 'http', properties: { protocol: 'https' } }, 'grpc'],
        properties: { region: 'us' },
        metrics: { responseTime: 8, cost: 5 },
      },
    });
  });

  it('authors RoutingOverlay and the complete Placement topology without expert JSON', async () => {
    localStorage.setItem('bim-v1-draft', JSON.stringify({
      'instance.json': JSON.stringify({
        apiVersion: 'bim/v1',
        kind: 'Instance',
        metadata: { name: 'topology-editor' },
        spec: {
          profile: 'qos-binding/v1',
          resources: {
            application: { routing: 'routing.json', placement: 'placement.json' },
          },
        },
      }),
      'routing.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'RoutingOverlay',
        metadata: { name: 'routing' },
        spec: {
          entries: [
            { target: { resource: 'application', id: 'branch-a' }, probability: 0.5 },
            { target: { resource: 'application', id: 'branch-b' }, probability: 0.5 },
          ],
        },
      }),
      'placement.json': JSON.stringify({
        apiVersion: 'qos-binding-placement/v1',
        kind: 'Placement',
        metadata: { name: 'placement' },
        spec: {
          pools: { p_edge: { kind: 'edge', capacity: { memory: 4 } } },
          defaults: { memory: 1 },
        },
      }),
    }));
    renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: /routing\.json/i }));
    expect(screen.getByRole('heading', { name: 'Routing policy' })).toBeInTheDocument();
    expect(screen.getByText('Σ 1.000')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Route 1 probability'), { target: { value: '0.65' } });
    fireEvent.change(screen.getByLabelText('Route 2 probability'), { target: { value: '0.35' } });
    expect(screen.getByText('Σ 1.000')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /placement\.json/i }));
    expect(screen.getByRole('heading', { name: 'Placement overview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pools' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('p_edge pool Capacity memory amount'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add pool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add demand' }));
    fireEvent.change(screen.getByLabelText('demand 1 Candidate id'), { target: { value: 'service-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Network 1 latency'), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add transition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add capacity rule' }));
    fireEvent.click(screen.getByLabelText('Enable global latency'));

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    const files = await analyzedFiles();
    const routing = JSON.parse(files['routing.json']);
    const placement = JSON.parse(files['placement.json']);
    expect(routing.spec.entries.map((entry: { probability: number }) => entry.probability)).toEqual([0.65, 0.35]);
    expect(placement.spec.pools.p_edge.capacity.memory).toBe(8);
    expect(placement.spec.pools.pool2).toEqual({ capacity: {} });
    expect(placement.spec.demands[0]).toMatchObject({ candidate: { resource: 'catalog', id: 'service-a' }, pool: { id: 'p_edge' } });
    expect(placement.spec.network[0].latency).toBe(7.5);
    expect(placement.spec.events.event1.pool.id).toBe('p_edge');
    expect(placement.spec.transitions.transition1.maximum).toBe(0);
    expect(placement.spec.capacityRules).toEqual([{ resources: ['memory'], scope: 'selectedCandidate' }]);
    expect(placement.spec.globalLatency).toEqual({
      metric: { resource: 'application', id: 'latency' },
      includeExecution: true,
      exclusive: 'routing',
      parallel: 'max',
    });
  });

  it('creates schema-valid expression AST and keeps an invalid AST draft out of the package', async () => {
    localStorage.setItem('bim-v1-draft', JSON.stringify({
      'instance.json': JSON.stringify({
        apiVersion: 'bim/v1',
        kind: 'Instance',
        metadata: { name: 'constraints-editor' },
        spec: { profile: 'qos-binding/v1', resources: { constraintSet: { constraints: 'constraints.json' } } },
      }),
      'constraints.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'ConstraintSet',
        metadata: { name: 'constraints' },
        spec: { constraints: {} },
      }),
    }));
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /constraints\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add AST constraint' }));

    const assertion = screen.getByLabelText('constraint1 assertion');
    expect(JSON.parse((assertion as HTMLTextAreaElement).value)).toEqual({
      op: 'gte',
      left: { path: 'metrics.latency' },
      right: { literal: 0 },
    });

    fireEvent.change(assertion, { target: { value: '{"call":">=","args":[{"path":"metrics.latency"},0]}' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a BIM expression AST');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(1));
    let files = await analyzedFiles();
    expect(JSON.parse(files['constraints.json']).spec.constraints.constraint1.assert).toEqual({
      op: 'gte',
      left: { path: 'metrics.latency' },
      right: { literal: 0 },
    });

    fireEvent.change(assertion, { target: { value: '{"op":"lte","left":{"path":["metrics","latency"]},"right":{"literal":25}}' } });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBimPackage).toHaveBeenCalledTimes(2));
    files = await analyzedFiles();
    expect(JSON.parse(files['constraints.json']).spec.constraints.constraint1.assert).toEqual({
      op: 'lte',
      left: { path: ['metrics', 'latency'] },
      right: { literal: 25 },
    });
  });
});
