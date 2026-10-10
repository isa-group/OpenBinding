import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipPackage } from '../../utils/bimZip';
import { project } from '../Project/testKit';
import { DEFAULT_FILES } from './bimDocuments';
import { ROOT, analysis, openWorkbench } from './workbenchTestKit';

// The contract between the workbench and the compiler of the gateway. `src/test/fixtures/bim-package` holds the package the workbench
// writes (the default one, and variants after typical edits of its forms); `openbinding-gateway/tests/test_b6_workbench_package.py`
// compiles those very files with the real compiler. So a change of what the forms write fails here until the fixtures follow it, and
// the fixtures only ever change together with a package the compiler accepts. The `form-flow` variant is a package built with nothing but
// the forms, including the parts the compiler checks across documents (a provider the catalog declares, a binding to a feature of the
// Application, a penalty for a soft rule, a scale for criteria in different units); `test_b7_form_flows.py` compiles it and refuses the
// same package without each of those parts.

const platform = vi.hoisted(() => ({ project: vi.fn(), cases: vi.fn(), caseRevisions: vi.fn(), snapshotArchive: vi.fn() }));
const client = vi.hoisted(() => ({
  getBimExamples: vi.fn(), getBimExamplePackage: vi.fn(), createBimJob: vi.fn(), getV1Job: vi.fn(), getOwnUsage: vi.fn(), getPricingCatalog: vi.fn(),
}));
const workbench = vi.hoisted(() => ({ validate: vi.fn(), snapshot: vi.fn(), ir: vi.fn(), saveRevision: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
vi.mock('../../api/workbench', () => ({ workbenchApi: workbench }));
vi.mock('../../components/CodeEditor/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, ariaLabel, readOnly }: { value: string; onChange: (value: string) => void; ariaLabel: string; readOnly?: boolean }) => (
    <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('./BpmnModeler', () => ({ BpmnModeler: () => <div data-testid="bpmn-modeler" /> }));
vi.mock('../../components/Artifacts/ArtifactVersionPicker', () => ({ ArtifactVersionPicker: () => <span>Sealed configurations</span> }));

const DRAFT_KEY = `bim-v1-draft:user-lucia:${ROOT}/workbench::`;

const sources = import.meta.glob<string>('../../test/fixtures/bim-package/**/*.{json,bpmn}', { query: '?raw', import: 'default', eager: true });

/** A file of the reference package, by its path under `bim-package/` (`candidates.json`, `open-range/candidates.json`). */
function reference(path: string): string {
  const source = sources[`../../test/fixtures/bim-package/${path}`];
  if (source === undefined) throw new Error(`The reference file ${path} is missing from src/test/fixtures/bim-package.`);
  return source;
}

const referenceJson = (path: string): unknown => JSON.parse(reference(path));

/** The files the gateway was asked to check on a call of the validation. */
async function checkedFiles(callIndex = workbench.validate.mock.calls.length - 1) {
  const archive = workbench.validate.mock.calls[callIndex][0] as Uint8Array;
  const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
  return unzipPackage(buffer);
}

async function validated() {
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
  await waitFor(() => expect(workbench.validate).toHaveBeenCalledTimes(1));
  return checkedFiles();
}

describe('Workbench · the package it writes is the package the compiler is tested with', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    platform.project.mockResolvedValue(project('qos-benchmarks', { name: 'QoS Benchmarks' }));
    platform.cases.mockResolvedValue([]);
    platform.caseRevisions.mockResolvedValue([]);
    client.getBimExamples.mockResolvedValue([]);
    client.getOwnUsage.mockResolvedValue({ plan: 'RESEARCH', capabilities: {}, limits: {}, features: {}, contract_pending: false });
    client.getPricingCatalog.mockResolvedValue(null);
    workbench.validate.mockResolvedValue(analysis());
  });

  it('has one reference file for every file of the default package, with the same name and content', () => {
    expect(Object.keys(DEFAULT_FILES).sort()).toEqual(['application.json', 'candidates.json', 'instance.json', 'optimization.json', 'workflow.bpmn']);
    for (const [path, source] of Object.entries(DEFAULT_FILES)) {
      if (path.endsWith('.json')) expect(JSON.parse(source), path).toEqual(referenceJson(path));
      else expect(source.trim(), path).toBe(reference(path).trim());
    }
  });

  it('sends the default package to the gateway as the reference files hold it', async () => {
    await openWorkbench();
    const files = await validated();
    expect(Object.keys(files).sort()).toEqual(Object.keys(DEFAULT_FILES).sort());
    for (const path of Object.keys(files)) {
      if (path.endsWith('.json')) expect(JSON.parse(files[path]), path).toEqual(referenceJson(path));
      else expect(files[path].trim(), path).toBe(reference(path).trim());
    }
  });

  it('writes the open-range variant after adding a candidate and giving its latency a range with no upper limit', async () => {
    await openWorkbench();
    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add candidate' }));
    fireEvent.change(screen.getByLabelText('candidate2 capability 1 type'), { target: { value: 'http' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'latency for candidate2: value or range' })).getByRole('button', { name: 'Range' }));
    fireEvent.change(screen.getByLabelText('latency for candidate2 min'), { target: { value: '100' } });
    fireEvent.click(screen.getByLabelText('latency for candidate2: no upper limit'));

    const files = await validated();
    expect(JSON.parse(files['candidates.json'])).toEqual(referenceJson('open-range/candidates.json'));
    for (const path of ['instance.json', 'application.json', 'optimization.json']) expect(JSON.parse(files[path]), path).toEqual(referenceJson(path));
  });

  it('writes the with-rules variant after adding a hard and a soft rule and the penalty that activates the soft one', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      ...DEFAULT_FILES,
      'instance.json': reference('with-rules/instance.json'),
      'constraints.json': JSON.stringify({
        apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', metadata: { name: 'hello-constraints' }, spec: { constraints: {} },
      }),
    }));
    await openWorkbench();
    fireEvent.click(await screen.findByRole('button', { name: /constraints\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add CEL constraint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add AST constraint' }));
    fireEvent.change(screen.getByLabelText('constraint2 enforcement'), { target: { value: 'soft' } });

    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));
    // The penalty form offers the soft rules of the package: the soft one is the only choice, and it is already chosen.
    fireEvent.click(screen.getByRole('button', { name: 'Add penalty' }));
    expect(screen.getByLabelText('Penalty 1 rule')).toHaveValue('constraints/constraint2');

    const files = await validated();
    for (const path of ['instance.json', 'constraints.json', 'optimization.json']) {
      expect(JSON.parse(files[path]), path).toEqual(referenceJson(`with-rules/${path}`));
    }
    for (const path of ['application.json', 'candidates.json']) expect(JSON.parse(files[path]), path).toEqual(referenceJson(path));
  });

  it('writes a complete package with only the forms: provider, candidates, a hard and a soft rule with its penalty, and two normalized criteria', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      ...DEFAULT_FILES,
      'constraints.json': JSON.stringify({
        apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', metadata: { name: 'hello-constraints' }, spec: { constraints: {} },
      }),
    }));
    await openWorkbench();

    // A second feature, in another unit.
    fireEvent.click(screen.getByRole('button', { name: /application\.json/i }));
    fireEvent.change(screen.getByLabelText('New feature id'), { target: { value: 'cost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add feature' }));
    fireEvent.change(screen.getByLabelText('cost unit'), { target: { value: 'eur' } });

    // The rules file joins the package.
    fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
    fireEvent.change(screen.getByLabelText('New resource id'), { target: { value: 'constraints' } });
    fireEvent.change(screen.getByLabelText('New resource package file'), { target: { value: 'constraints.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add local reference' }));

    // A hard rule and a soft one; the soft one is listed in the Optimization with one click, from the rules.
    fireEvent.click(await screen.findByRole('button', { name: /constraints\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add CEL constraint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add AST constraint' }));
    fireEvent.change(screen.getByLabelText('constraint2 enforcement'), { target: { value: 'soft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add constraint2 to the Optimization' }));
    expect(screen.queryByRole('button', { name: 'Add constraint2 to the Optimization' })).not.toBeInTheDocument();

    // A feature binding for the new feature, a provider declared on the way, and a second candidate that uses it.
    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add feature binding' }));
    fireEvent.change(screen.getByLabelText('service-a QoS cost'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('service-a provider'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByLabelText('service-a new provider id'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and use' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add candidate' }));
    fireEvent.change(screen.getByLabelText('candidate2 capability 1 type'), { target: { value: 'http' } });
    fireEvent.change(screen.getByLabelText('candidate2 provider'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('candidate2 QoS latency'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('candidate2 QoS cost'), { target: { value: '0.8' } });
    expect(screen.queryByText('Some candidates give no value to a feature the Optimization uses')).not.toBeInTheDocument();

    // Two criteria in different units: the form asks for a scale, and Normalize writes it.
    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }));
    expect(screen.getByText('These criteria need a scale')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Normalize' }));
    expect(screen.queryByText('These criteria need a scale')).not.toBeInTheDocument();

    const files = await validated();
    for (const path of ['instance.json', 'application.json', 'candidates.json', 'constraints.json', 'optimization.json']) {
      expect(JSON.parse(files[path]), path).toEqual(referenceJson(`form-flow/${path}`));
    }
    expect(files['workflow.bpmn'].trim()).toBe(reference('workflow.bpmn').trim());
  }, 15000);

  it('declares the provider a candidate is given in the catalog, and offers no binding when every feature is bound', async () => {
    await openWorkbench();
    fireEvent.click(screen.getByRole('button', { name: /candidates\.json/i }));
    // The default package binds its only feature, so the form has nothing left to bind.
    expect(screen.getByRole('button', { name: 'Add feature binding' })).toBeDisabled();
    expect(screen.getByText('Every feature of the Application is bound.')).toBeInTheDocument();
    // Giving a candidate a provider declares it: the candidate points to the catalog that declares it.
    fireEvent.change(screen.getByLabelText('service-a provider'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByLabelText('service-a new provider id'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and use' }));
    expect(screen.getByLabelText('service-a provider')).toHaveValue('acme');

    const catalog = JSON.parse((await validated())['candidates.json']);
    expect(catalog.spec.providers).toEqual({ acme: {} });
    expect(catalog.spec.candidates['service-a'].provider).toEqual({ resource: 'catalog', id: 'acme' });
  });

  it('writes the criterion renamed and normalized as the schema names them', async () => {
    await openWorkbench();
    fireEvent.click(screen.getByRole('button', { name: /optimization\.json/i }));
    const id = screen.getByLabelText('Criterion 1 id');
    fireEvent.change(id, { target: { value: 'response' } });
    fireEvent.blur(id);
    fireEvent.click(screen.getByLabelText('Criterion 1 normalize'));

    const files = await validated();
    expect(JSON.parse(files['optimization.json'])).toEqual({
      apiVersion: 'qos-binding/v1',
      kind: 'Optimization',
      metadata: { name: 'hello-optimization' },
      spec: { criteria: [{ id: 'response', feature: { resource: 'application', id: 'latency' }, normalize: { min: 0, max: 1, clamp: false } }] },
    });
  });
});
