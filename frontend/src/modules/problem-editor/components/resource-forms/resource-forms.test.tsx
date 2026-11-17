import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveDraft } from '../../../core/editor/drafts';
import { DEFAULT_FILES } from '../../utils/documents';
import { analysis, DRAFT_SCOPE, sentFiles } from '../../utils/editorTestKit';
import { checkNow, openProblemEditor, showCode, showPane } from '../../utils/renderTestKit';

// The forms of the problem editor: they edit the documents of the package in place, and what the gateway checks is what they wrote.

const problems = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  revisions: vi.fn(),
  source: vi.fn(),
  create: vi.fn(),
  createRevision: vi.fn(),
}));
const bim = vi.hoisted(() => ({ validate: vi.fn(), templates: vi.fn(), template: vi.fn() }));

vi.mock('../../../problem/api/problemsClient', () => ({ problemsApi: problems }));
vi.mock('../../../core/api/bim', () => ({ bimApi: bim }));
vi.mock('../../../core/components/code-editor', async () => ({
  default: (await import('../../utils/codeEditorTestKit')).default,
}));
vi.mock('../bpmn-modeler', () => ({ BpmnModeler: () => <div data-testid="bpmn-modeler" /> }));

/** The files the gateway was asked to check on a call of the validation. */
const checkedFiles = (call?: number) => sentFiles(bim.validate, call);

/** The editor with its package on screen, at the Forms pane. */
async function openForms() {
  await openProblemEditor();
  showPane('Forms');
}

describe('ProblemEditor · forms of the package', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    problems.list.mockResolvedValue({ problems: [], total: 0, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([]);
    bim.templates.mockResolvedValue([]);
    bim.validate.mockResolvedValue(analysis());
  });

  it('rejects invalid and duplicate renames visibly and restores the stored identifier', async () => {
    await openForms();
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
    expect(screen.getByText('The application/workflow reference already exists.')).toHaveAttribute(
      'role',
      'alert'
    );

    fireEvent.click(screen.getByRole('button', { name: /application\.json/i }));
    fireEvent.change(screen.getByLabelText('New feature id'), { target: { value: 'cost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add feature' }));
    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add feature binding' }));
    const alias = screen.getByLabelText('latency feature alias');
    fireEvent.change(alias, { target: { value: 'cost' } });
    fireEvent.blur(alias);
    expect(alias).toHaveValue('latency');
    expect(screen.getByRole('alert')).toHaveTextContent('cost feature alias already exists');
  });

  it('edits Instance metadata, profile, local resources, and registered references transactionally', async () => {
    await openForms();
    fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'edited-instance' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.2.0' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Edited through the compact form' },
    });
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'custom-profile/v1' } });

    fireEvent.change(screen.getByLabelText('application/workflow reference type'), {
      target: { value: 'registered' },
    });
    fireEvent.change(screen.getByLabelText('application/workflow namespace'), {
      target: { value: 'acme.workflows' },
    });
    fireEvent.change(screen.getByLabelText('application/workflow registered name'), {
      target: { value: 'checkout' },
    });
    fireEvent.change(screen.getByLabelText('application/workflow registered version'), {
      target: { value: '2.0.0' },
    });
    fireEvent.change(screen.getByLabelText('application/workflow digest'), {
      target: { value: `sha256-${'a'.repeat(64)}` },
    });

    fireEvent.change(screen.getByLabelText('New resource role'), {
      target: { value: 'constraintSet' },
    });
    fireEvent.change(screen.getByLabelText('New resource id'), {
      target: { value: 'sharedConstraints' },
    });
    fireEvent.change(screen.getByLabelText('New resource package file'), {
      target: { value: 'candidates.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add local reference' }));

    showCode();
    expect(
      ((await screen.findByLabelText('instance.json source')) as HTMLTextAreaElement).value
    ).toContain('custom-profile/v1');

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    const instance = JSON.parse((await checkedFiles())['instance.json']);
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

  it('edits Optimization criteria, normalization, and explicit penalties with the keys of the schema', async () => {
    await saveDraft(DRAFT_SCOPE, {
      ...DEFAULT_FILES,
      'instance.json': JSON.stringify({
        apiVersion: 'bim/v1',
        kind: 'Instance',
        metadata: { name: 'goal-editor' },
        spec: {
          profile: 'qos-binding/v1',
          resources: {
            application: { application: 'application.json' },
            constraintSet: { qualityConstraints: 'constraints.json' },
            optimization: { optimization: 'optimization.json' },
          },
        },
      }),
      'application.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'Application',
        metadata: { name: 'app' },
        spec: {
          tasks: { hello: 'http' },
          features: { latency: { unit: 'ms' }, duration: { unit: 'ms' }, cost: { unit: 'eur' } },
          workflow: { task: { resource: 'application', id: 'hello' } },
        },
      }),
      'constraints.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'ConstraintSet',
        metadata: { name: 'constraints' },
        spec: {
          constraints: {
            softLatency: { assert: 'features.latency >= 0', enforcement: 'soft', penalty: 1 },
            hardCost: { assert: 'features.cost >= 0', enforcement: 'hard' },
          },
        },
      }),
    });
    await openForms();
    fireEvent.click(await screen.findByRole('button', { name: /optimization\.json/i }));

    // The strategy and its weights are chosen when the package runs: the Optimization has no such controls.
    expect(screen.queryByLabelText('Strategy')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Objective type')).not.toBeInTheDocument();

    // A criterion points to a feature the Application declares: those are the options.
    const feature = screen.getByLabelText('Criterion 1 feature');
    expect(
      within(feature)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['latency · ms', 'duration · ms', 'cost · eur']);
    fireEvent.change(feature, { target: { value: 'application/duration' } });
    fireEvent.change(screen.getByLabelText('Criterion 1 direction'), {
      target: { value: 'maximize' },
    });
    fireEvent.click(screen.getByLabelText('Criterion 1 normalize'));
    fireEvent.change(screen.getByLabelText('Criterion 1 normalization minimum'), {
      target: { value: '-5' },
    });
    fireEvent.change(screen.getByLabelText('Criterion 1 normalization maximum'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByLabelText('Criterion 1 normalization clamp'));
    const criterionId = screen.getByLabelText('Criterion 1 id');
    fireEvent.change(criterionId, { target: { value: 'duration' } });
    fireEvent.blur(criterionId);

    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    // The new criterion starts on a feature that no other criterion uses.
    expect(screen.getByLabelText('Criterion 2 feature')).toHaveValue('application/latency');
    fireEvent.change(screen.getByLabelText('Criterion 2 feature'), {
      target: { value: 'application/cost' },
    });
    const duplicate = screen.getByLabelText('Criterion 2 id');
    fireEvent.change(duplicate, { target: { value: 'duration' } });
    fireEvent.blur(duplicate);
    expect(duplicate).toHaveValue('criterion2');
    expect(screen.getByRole('alert')).toHaveTextContent('The duration criterion already exists.');

    // The soft rule is offered as a penalty, the hard one is not, and a rule can be linked only once.
    fireEvent.click(screen.getByRole('button', { name: 'Add penalty' }));
    expect(
      within(screen.getByLabelText('Penalty 1 rule'))
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['softLatency · qualityConstraints']);
    expect(screen.getByRole('button', { name: 'Add penalty' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Penalty 1 weight'), { target: { value: '3' } });

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    const optimization = JSON.parse((await checkedFiles())['optimization.json']);
    expect(optimization.spec).toEqual({
      criteria: [
        {
          id: 'duration',
          feature: { resource: 'application', id: 'duration' },
          direction: 'maximize',
          normalize: { min: -5, max: 25, clamp: true },
        },
        {
          id: 'criterion2',
          feature: { resource: 'application', id: 'cost' },
        },
      ],
      penalties: [{ constraint: { resource: 'qualityConstraints', id: 'softLatency' }, weight: 3 }],
    });
  });

  it('removes every criterion for a package that asks only for a feasible binding', async () => {
    await openForms();
    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove criterion' }));
    expect(
      screen.getByText(/No criteria: the package asks only for a feasible binding/)
    ).toBeInTheDocument();

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    expect(JSON.parse((await checkedFiles())['optimization.json']).spec).toEqual({ criteria: [] });
  });

  it('authors Application tasks, typed predicates, and feature definitions in the compact form', async () => {
    await openForms();
    fireEvent.click(screen.getByRole('button', { name: /application\.json/i }));

    fireEvent.click(screen.getByLabelText('hello predicate enabled'));
    fireEvent.change(screen.getByLabelText('hello predicate'), {
      target: { value: 'candidate.properties.region == "eu"' },
    });
    fireEvent.change(screen.getByLabelText('latency unit'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('latency direction'), { target: { value: 'maximize' } });
    fireEvent.change(screen.getByLabelText('latency scope'), {
      target: { value: 'selectedCandidate' },
    });
    fireEvent.change(screen.getByLabelText('latency domain'), { target: { value: 'ratio' } });
    fireEvent.change(screen.getByLabelText('latency aggregation'), {
      target: { value: 'product' },
    });
    fireEvent.change(screen.getByLabelText('latency neutral'), { target: { value: '1' } });

    fireEvent.change(screen.getByLabelText('New feature id'), {
      target: { value: 'availability' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add feature' }));
    fireEvent.change(screen.getByLabelText('availability unit'), { target: { value: 'ratio' } });
    fireEvent.change(screen.getByLabelText('availability direction'), {
      target: { value: 'maximize' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText('task2 capability'), { target: { value: 'queue' } });

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    const application = JSON.parse((await checkedFiles())['application.json']);
    expect(application.spec.tasks).toEqual({
      hello: {
        kind: 'service',
        requires: { type: 'http', predicate: 'candidate.properties.region == "eu"' },
      },
      task2: 'queue',
    });
    expect(application.spec.metrics).toBeUndefined();
    expect(application.spec.features).toEqual({
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
    await openForms();
    fireEvent.click(screen.getByRole('button', { name: /application\.json/i }));
    fireEvent.change(screen.getByLabelText('New feature id'), { target: { value: 'cost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add feature' }));
    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));

    fireEvent.blur(screen.getByLabelText('latency feature alias'), {
      target: { value: 'responseTime' },
    });
    // A binding names a feature the Application declares: the cost one is bound by choosing it, under its own name.
    expect(
      within(screen.getByLabelText('responseTime feature'))
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['latency · ms', 'cost · 1']);
    fireEvent.change(screen.getByLabelText('Feature to bind'), {
      target: { value: 'application/cost' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add feature binding' }));
    // A feature is bound by one alias only.
    expect(
      within(screen.getByLabelText('responseTime feature')).getByRole('option', {
        name: 'cost · 1',
      })
    ).toBeDisabled();
    expect(screen.getByLabelText('service-a QoS responseTime')).toHaveValue(10);

    fireEvent.click(screen.getByRole('button', { name: 'Add candidate' }));
    fireEvent.change(screen.getByLabelText('candidate2 capability 1 type'), {
      target: { value: 'http' },
    });
    fireEvent.change(screen.getByLabelText('candidate2 capability 1 properties'), {
      target: { value: '{"protocol":"https"}' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add capability' })[1]);
    fireEvent.change(screen.getByLabelText('candidate2 capability 2 type'), {
      target: { value: 'grpc' },
    });
    fireEvent.change(screen.getByLabelText('candidate2 properties'), {
      target: { value: '{"region":"us"}' },
    });
    fireEvent.change(screen.getByLabelText('candidate2 QoS responseTime'), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByLabelText('candidate2 QoS cost'), { target: { value: '5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove candidate' })[0]);

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    const catalog = JSON.parse((await checkedFiles())['candidates.json']);
    expect(catalog.spec.metricBindings).toBeUndefined();
    expect(catalog.spec.featureBindings).toEqual({
      responseTime: { resource: 'application', id: 'latency' },
      cost: { resource: 'application', id: 'cost' },
    });
    expect(catalog.spec.candidates).toEqual({
      candidate2: {
        provides: [{ type: 'http', properties: { protocol: 'https' } }, 'grpc'],
        properties: { region: 'us' },
        features: { responseTime: 8, cost: 5 },
      },
    });
  });

  it('says what a package lacks to compile across its documents, and writes it with one action', async () => {
    await saveDraft(DRAFT_SCOPE, {
      'instance.json': JSON.stringify({
        apiVersion: 'bim/v1',
        kind: 'Instance',
        metadata: { name: 'across-documents' },
        spec: {
          profile: 'qos-binding/v1',
          resources: {
            application: { application: 'application.json' },
            candidateCatalog: { catalog: 'candidates.json' },
            constraintSet: { rules: 'constraints.json' },
            optimization: { optimization: 'optimization.json' },
          },
        },
      }),
      'application.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'Application',
        metadata: { name: 'app' },
        spec: {
          tasks: { hello: 'http' },
          features: { latency: { unit: 'ms' }, cost: { unit: 'eur' } },
          workflow: { task: { resource: 'application', id: 'hello' } },
        },
      }),
      'candidates.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'CandidateCatalog',
        metadata: { name: 'catalog' },
        spec: {
          featureBindings: {
            latency: { resource: 'application', id: 'latency' },
            speed: { resource: 'application', id: 'speed' },
          },
          candidates: {
            'service-a': {
              provides: 'http',
              features: { latency: 10 },
              provider: { resource: 'catalog', id: 'ghost' },
            },
          },
        },
      }),
      'constraints.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'ConstraintSet',
        metadata: { name: 'rules' },
        spec: {
          constraints: {
            soft1: { assert: 'features.latency >= 0', enforcement: 'soft', penalty: 1 },
          },
        },
      }),
      'optimization.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'Optimization',
        metadata: { name: 'goal' },
        spec: {
          criteria: [
            { id: 'latency', feature: { resource: 'application', id: 'latency' } },
            { id: 'cost', feature: { resource: 'application', id: 'cost' } },
          ],
        },
      }),
    });
    await openForms();

    // The catalog: a provider that is not declared, a binding to a feature the Application does not declare, a value the goal asks for.
    fireEvent.click(await screen.findByRole('button', { name: /candidates\.json/i }));
    expect(screen.getByText('This provider is not declared in the catalog')).toBeInTheDocument();
    expect(screen.getByText('The Application does not declare this feature')).toBeInTheDocument();
    expect(
      screen.getByText('Some candidates give no value to a feature the Optimization uses')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('service-a provider')).toHaveDisplayValue(
      'catalog/ghost (not declared)'
    );
    expect(screen.getByLabelText('speed feature')).toHaveDisplayValue(
      'application/speed (not declared)'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Declare ghost' }));
    expect(
      screen.queryByText('This provider is not declared in the catalog')
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('service-a provider')).toHaveDisplayValue('ghost');
    fireEvent.change(screen.getByLabelText('speed feature'), {
      target: { value: 'application/cost' },
    });
    expect(
      screen.queryByText('The Application does not declare this feature')
    ).not.toBeInTheDocument();

    // The rules: the soft one is not in the goal yet, and a button puts it there.
    fireEvent.click(screen.getByRole('button', { name: /constraints\.json/i }));
    expect(screen.getByText('The Optimization does not list this rule yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add soft1 to the Optimization' }));
    expect(
      screen.queryByText('The Optimization does not list this rule yet')
    ).not.toBeInTheDocument();

    // The goal: the units differ, so it asks for a scale and Normalize writes one for each.
    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));
    expect(screen.getByText('These criteria need a scale')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Normalize' }));
    expect(screen.queryByText('These criteria need a scale')).not.toBeInTheDocument();
    expect(screen.queryByText('Soft rules without a penalty')).not.toBeInTheDocument();

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    const files = await checkedFiles();
    const catalog = JSON.parse(files['candidates.json']);
    expect(catalog.spec.providers).toEqual({ ghost: {} });
    expect(catalog.spec.featureBindings.speed).toEqual({ resource: 'application', id: 'cost' });
    const optimization = JSON.parse(files['optimization.json']);
    expect(
      optimization.spec.criteria.map((criterion: { normalize: unknown }) => criterion.normalize)
    ).toEqual([
      { min: 0, max: 1, clamp: false },
      { min: 0, max: 1, clamp: false },
    ]);
    expect(optimization.spec.penalties).toEqual([
      { constraint: { resource: 'rules', id: 'soft1' }, weight: 1 },
    ]);
  });

  it('offers nothing to point to when the Application declares no feature, and sends the person there', async () => {
    await saveDraft(DRAFT_SCOPE, {
      ...DEFAULT_FILES,
      'application.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'Application',
        metadata: { name: 'app' },
        spec: {
          tasks: { hello: 'http' },
          features: {},
          workflow: { task: { resource: 'application', id: 'hello' } },
        },
      }),
    });
    await openForms();
    fireEvent.click(await screen.findByRole('button', { name: /optimization\.json/i }));
    expect(screen.getByText('The Application declares no features')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add criterion' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Open application.json' }));
    expect(await screen.findByLabelText('New feature id')).toBeInTheDocument();
  });

  it('authors RoutingOverlay and the complete Placement topology without opening the source', async () => {
    await saveDraft(DRAFT_SCOPE, {
      'instance.json': JSON.stringify({
        apiVersion: 'bim/v1',
        kind: 'Instance',
        metadata: { name: 'topology-editor' },
        spec: {
          profile: 'qos-binding/v1',
          resources: { candidateCatalog: { routing: 'routing.json', placement: 'placement.json' } },
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
    });
    await openForms();

    fireEvent.click(await screen.findByRole('button', { name: /routing\.json/i }));
    expect(screen.getByRole('heading', { name: 'Routing policy' })).toBeInTheDocument();
    expect(screen.getByText('Σ 1.000')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Route 1 probability'), { target: { value: '0.65' } });
    fireEvent.change(screen.getByLabelText('Route 2 probability'), { target: { value: '0.35' } });
    expect(screen.getByText('Σ 1.000')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /placement\.json/i }));
    expect(screen.getByRole('heading', { name: 'Placement overview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pools' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('p_edge pool Capacity memory amount'), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add pool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add demand' }));
    fireEvent.change(screen.getByLabelText('demand 1 Candidate id'), {
      target: { value: 'service-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Network 1 latency'), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add transition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add capacity rule' }));
    fireEvent.click(screen.getByLabelText('Enable global latency'));

    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    const files = await checkedFiles();
    const routing = JSON.parse(files['routing.json']);
    const placement = JSON.parse(files['placement.json']);
    expect(routing.spec.entries.map((entry: { probability: number }) => entry.probability)).toEqual(
      [0.65, 0.35]
    );
    expect(placement.spec.pools.p_edge.capacity.memory).toBe(8);
    expect(placement.spec.pools.pool2).toEqual({ capacity: {} });
    expect(placement.spec.demands[0]).toMatchObject({
      candidate: { resource: 'catalog', id: 'service-a' },
      pool: { id: 'p_edge' },
    });
    expect(placement.spec.network[0].latency).toBe(7.5);
    expect(placement.spec.events.event1.pool.id).toBe('p_edge');
    expect(placement.spec.transitions.transition1.maximum).toBe(0);
    expect(placement.spec.capacityRules).toEqual([
      { resources: ['memory'], scope: 'selectedCandidate' },
    ]);
    expect(placement.spec.globalLatency).toEqual({
      feature: { resource: 'application', id: 'latency' },
      includeExecution: true,
      exclusive: 'routing',
      parallel: 'max',
    });
    expect(placement.spec.transitions.transition1.feature).toEqual({
      resource: 'application',
      id: 'latency',
    });
    expect(placement.spec.transitions.transition1.metric).toBeUndefined();
  }, 15000);

  it('creates schema-valid expression AST and keeps an invalid AST draft out of the package', async () => {
    await saveDraft(DRAFT_SCOPE, {
      'instance.json': JSON.stringify({
        apiVersion: 'bim/v1',
        kind: 'Instance',
        metadata: { name: 'constraints-editor' },
        spec: {
          profile: 'qos-binding/v1',
          resources: { constraintSet: { constraints: 'constraints.json' } },
        },
      }),
      'constraints.json': JSON.stringify({
        apiVersion: 'qos-binding/v1',
        kind: 'ConstraintSet',
        metadata: { name: 'constraints' },
        spec: { constraints: {} },
      }),
    });
    await openForms();
    fireEvent.click(await screen.findByRole('button', { name: /constraints\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add AST constraint' }));

    const assertion = screen.getByLabelText('constraint1 assertion');
    expect(JSON.parse((assertion as HTMLTextAreaElement).value)).toEqual({
      op: 'gte',
      left: { path: 'features.latency' },
      right: { literal: 0 },
    });

    fireEvent.change(assertion, {
      target: { value: '{"call":">=","args":[{"path":"features.latency"},0]}' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a BIM expression AST');
    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse((await checkedFiles())['constraints.json']).spec.constraints.constraint1.assert
    ).toEqual({
      op: 'gte',
      left: { path: 'features.latency' },
      right: { literal: 0 },
    });

    fireEvent.change(assertion, {
      target: {
        value: '{"op":"lte","left":{"path":["features","latency"]},"right":{"literal":25}}',
      },
    });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    checkNow();
    await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(2));
    expect(
      JSON.parse((await checkedFiles())['constraints.json']).spec.constraints.constraint1.assert
    ).toEqual({
      op: 'lte',
      left: { path: ['features', 'latency'] },
      right: { literal: 25 },
    });
  });
});
