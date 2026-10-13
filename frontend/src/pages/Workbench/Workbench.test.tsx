import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { unzipPackage } from '../../utils/bimZip';
import { digestOf, irDocument, refOf, revisionDocument } from '../Cases/fixtures';
import { caseOf, project, revisionOf } from '../Project/testKit';
import {
  ENGINE_REF, REGISTRATION_REF, ROOT, SECOND_REGISTRATION, analysis, openWorkbench, packageArchive, packageFile, renderWorkbench,
} from './workbenchTestKit';

const platform = vi.hoisted(() => ({ project: vi.fn(), cases: vi.fn(), caseRevisions: vi.fn(), snapshotArchive: vi.fn(), publicProjects: vi.fn() }));
const client = vi.hoisted(() => ({
  getBimExamples: vi.fn(), getBimExamplePackage: vi.fn(), createBimJob: vi.fn(), createConfiguredBimJob: vi.fn(),
  getV1Job: vi.fn(), getOwnUsage: vi.fn(), getPricingCatalog: vi.fn(),
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
vi.mock('../../components/Artifacts/ArtifactVersionPicker', () => ({
  ArtifactVersionPicker: ({ onSelect }: { onSelect: (artifact: never, version: never) => void }) => (
    <button type="button" onClick={() => onSelect({} as never, { id: 'configuration-1', ref: { namespace: 'isa-demo', name: 'rs-60s', version: '1', versionDigest: `sha256-${'d'.repeat(64)}` } } as never)}>
      Pick a sealed configuration
    </button>
  ),
}));

const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r1 = revisionOf(checkout, 1);
const r2 = revisionOf(checkout, 2);

const refusal = (status: number, code?: string, diagnostics: unknown[] = []) => Object.assign(new HttpError(status, 'refused'), { code, diagnostics });
const validate = () => fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

/** Validate the package that is open and wait for the valid summary. */
async function validated() {
  await openWorkbench();
  validate();
  await screen.findByRole('heading', { name: 'Valid package' });
}

const completedJob = {
  id: 'job-1',
  status: 'completed',
  result: {
    termination: 'FEASIBLE',
    solutions: [{ decision: { kind: 'binding', binding: { hello: { resource: 'catalog', id: 'service-a' } } }, metrics: { latency: 10 } }],
  },
};

describe('Workbench', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([checkout]);
    platform.caseRevisions.mockResolvedValue([r1, r2]);
    platform.publicProjects.mockResolvedValue([]);
    client.getBimExamples.mockResolvedValue(['demo/01_simple_seq']);
    client.getOwnUsage.mockResolvedValue({
      plan: 'RESEARCH', capabilities: { maxPayloadBytes: 134_217_728, maxInstanceComplexityLog10: 20 }, features: {}, contract_pending: false,
    });
    client.getPricingCatalog.mockResolvedValue(null);
    client.createBimJob.mockResolvedValue({ id: 'job-1', status: 'queued', irDigest: 'sha256-ir' });
    client.getV1Job.mockResolvedValue(completedJob);
    workbench.validate.mockResolvedValue(analysis());
    workbench.snapshot.mockResolvedValue({ id: 'snapshot-1', irDigest: 'sha256-ir' });
    workbench.ir.mockResolvedValue(irDocument());
  });

  describe('the page', () => {
    it('opens on a small package, says nothing has been checked yet and lays out the three sources', async () => {
      await openWorkbench();

      expect(screen.getByRole('heading', { level: 1, name: 'Workbench' })).toBeInTheDocument();
      expect(screen.getByText('Check a package, see which engines can run it, then snapshot, run or save it as a case revision.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Generate a synthetic instance' })).toHaveAttribute('href', '/app/generator');
      expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Cases' })).toHaveAttribute('aria-current', 'page');
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Workbench')).toHaveAttribute('aria-current', 'page');
      expect(screen.getAllByRole('tab').slice(0, 3).map((tab) => tab.textContent)).toEqual(['Case revision', 'Upload file', 'Example']);
      expect(screen.getByRole('tab', { name: 'Case revision' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText(/Nothing validated yet/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Package actions' })).not.toBeInTheDocument();

      const index = screen.getByRole('navigation', { name: 'BIM resources' });
      for (const text of ['application.json', 'candidates.json', 'optimization.json', 'workflow.bpmn', 'Candidate catalogs']) expect(index).toHaveTextContent(text);
    });

    it('offers the backend examples under Example', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Example' }));
      expect(await screen.findByRole('option', { name: 'demo/01_simple_seq' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Examples' })).toHaveAttribute('href', '/examples');
    });

    it('keeps the package import control keyboard-focusable', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Upload file' }));

      const importInput = screen.getByLabelText('Import .bim.zip');
      expect(importInput).toHaveAttribute('type', 'file');
      expect(importInput).toHaveClass('sr-only');
      importInput.focus();
      expect(importInput).toHaveFocus();
      expect(await screen.findByText('Up to 128 MiB on your plan (RESEARCH)')).toBeInTheDocument();
    });

    it('says a project it cannot reach is not found', async () => {
      platform.project.mockRejectedValue(refusal(404));
      renderWorkbench();
      expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    });
  });

  describe('checking the package', () => {
    it('shows the compiling state while the gateway reads the package', async () => {
      workbench.validate.mockReturnValue(new Promise(() => undefined));
      await openWorkbench();
      validate();

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Compiling the package…');
      expect(status).toHaveTextContent('Reading files → checking each resource → measuring the problem.');
      expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
    });

    it('sends a deterministic BIM ZIP and lists only the modes the analysis says can run it', async () => {
      workbench.validate.mockResolvedValue(analysis({
        compatibleModes: [
          { engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true },
          { engine: ENGINE_REF, registration: { ...SECOND_REGISTRATION, name: 'not-executable', digest: 'sha256-registration-c' }, mode: 'seeded', compatible: false },
        ],
      }));
      await validated();

      const archive = workbench.validate.mock.calls[0][0] as Uint8Array;
      expect(archive).toBeInstanceOf(Uint8Array);
      expect(Array.from(archive.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
      const files = await unzipPackage(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer);
      expect(JSON.parse(files['instance.json']).spec.resources).toEqual({
        application: { application: 'application.json', workflow: 'workflow.bpmn' },
        candidateCatalog: { catalog: 'candidates.json' },
        optimization: { optimization: 'optimization.json' },
      });

      const modes = screen.getByRole('combobox', { name: 'Compatible engine mode' });
      expect(within(modes).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Validate to select…', 'random-search · seeded · random-search-deployment@1.0.0+builtin.a',
      ]);
    });

    it('shows the valid package, its fingerprints and what is inside it', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await validated();

      expect(screen.getByText('hello-bim · qos-binding/v1')).toBeInTheDocument();
      const instance = screen.getByRole('button', { name: 'Copy the instance fingerprint' });
      expect(instance).toHaveTextContent('Instance · sha256-aaaa…aaaa');
      expect(screen.getByRole('button', { name: 'Copy the package fingerprint' })).toHaveTextContent('Package · sha256-bbbb…bbbb');
      expect(screen.getByRole('button', { name: 'Copy the compiled fingerprint' })).toHaveTextContent('Compiled · sha256-cccc…cccc');
      fireEvent.click(instance);
      await waitFor(() => expect(instance).toHaveTextContent('Instance · copied'));
      expect(writeText).toHaveBeenCalledWith(`sha256-${'a'.repeat(64)}`);

      const counts = within(screen.getByRole('list', { name: 'What the package holds' })).getAllByRole('listitem');
      expect(counts.map((item) => item.textContent)).toEqual(['1tasks', '2candidates', '0rules', '1goal terms', 'Noneplacement']);
      expect(document.querySelector('.binding-space-card')).toHaveTextContent('128');
      expect(screen.getByRole('tab', { name: 'What’s inside' })).toHaveAttribute('aria-selected', 'true');
    });

    it('explains the engines: which can run the package, which cannot and why, and which are registered', async () => {
      workbench.validate.mockResolvedValue(analysis({
        compatibleModes: [
          { engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true },
          {
            engine: { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: 'sha256-e' },
            registration: { namespace: 'lucia-vega', name: 'edge-solver-eu', version: '1', digest: 'sha256-r' },
            mode: 'placement',
            compatible: false,
            diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }],
          },
        ],
      }));
      await validated();
      fireEvent.click(screen.getByRole('tab', { name: /Engines that can run it/ }));

      const table = screen.getByRole('table', { name: 'Engine modes and whether they can run this package' });
      const rows = within(table).getAllByRole('row');
      expect(rows).toHaveLength(3);
      expect(within(rows[1]).getByText('Yes')).toBeInTheDocument();
      expect(rows[1]).toHaveTextContent('Runs through bim.builtin/random-search-deployment@1.0.0+builtin.a.');
      expect(within(rows[1]).queryByText('Registered')).not.toBeInTheDocument();
      expect(rows[2]).toHaveTextContent('edge-solver 0.3.1');
      expect(within(rows[2]).getByText('Registered')).toBeInTheDocument();
      expect(within(rows[2]).getByText('No')).toBeInTheDocument();
      expect(rows[2]).toHaveTextContent('It cannot read a RoutingOverlay.');
    });

    it('lists each file of the package with what it holds, and leads back to the editor', async () => {
      await validated();
      fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));

      const files = within(screen.getByRole('list', { name: 'Files in the package' })).getAllByRole('listitem');
      expect(files.map((item) => item.querySelector('strong')?.textContent)).toEqual([
        'instance.json', 'application.json', 'candidates.json', 'optimization.json', 'workflow.bpmn',
      ]);
      expect(files[0]).toHaveTextContent('Root of the package · 4 resources');
      expect(files[1]).toHaveTextContent('1 task and 1 quality metric');
      expect(files[2]).toHaveTextContent('1 candidate with 1 quality column');
      expect(files[3]).toHaveTextContent('Goal · 1 criterion');
      expect(files[4]).toHaveTextContent('Workflow diagram · 1 task');

      fireEvent.click(within(files[2]).getByRole('button', { name: 'Edit candidates.json' }));
      const index = screen.getByRole('navigation', { name: 'BIM resources' });
      expect(within(index).getByRole('button', { name: /candidates\.json/ })).toHaveAttribute('aria-current', 'true');
      expect(screen.getByLabelText('service-a QoS latency')).toHaveValue(10);
    });

    it('draws the workflow once the package has been compiled', async () => {
      await validated();
      expect(screen.queryByRole('img', { name: /^Workflow:/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Draw the workflow' }));
      const drawing = await screen.findByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel/ });
      expect(drawing).toBeInTheDocument();
      expect(workbench.snapshot).toHaveBeenCalledTimes(1);
      expect(workbench.ir).toHaveBeenCalledWith('snapshot-1');
    });
  });

  describe('what the gateway refuses', () => {
    it('lists the 422 problems by file and place, with the fix when there is one, and opens each where it lives', async () => {
      workbench.validate.mockRejectedValue(refusal(422, undefined, [
        { code: 'missing_metric', message: 'latency is required', resource: 'catalog', jsonPointer: '/spec/candidates/service-a/features/latency', fix: 'Add a finite value with a unit.' },
        { code: 'unsupported_bpmn', message: 'The task is not executable.', resource: 'workflow', bpmnElement: 'hello' },
      ]));
      await openWorkbench();
      validate();

      expect(await screen.findByText('Not valid · 2 problems (422)')).toBeInTheDocument();
      const problems = within(screen.getByRole('list', { name: 'Diagnostics' })).getAllByRole('listitem');
      expect(problems).toHaveLength(2);
      expect(problems[0]).toHaveTextContent('candidates.json');
      expect(problems[0]).toHaveTextContent('/spec/candidates/service-a/features/latency');
      expect(problems[0]).toHaveTextContent('Fix: Add a finite value with a unit.');
      expect(problems[1]).toHaveTextContent('BPMN element hello');
      expect(screen.queryByRole('region', { name: 'Package actions' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /unsupported_bpmn The task is not executable/i }));
      expect(await screen.findByTestId('bpmn-modeler')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /missing_metric latency is required/i }));
      const source = (await screen.findByLabelText('candidates.json source')) as HTMLTextAreaElement;
      expect(source.value).toContain('service-a');
    });

    it('says a package is too big for the plan (402) without inventing how far over it is', async () => {
      workbench.validate.mockRejectedValue(new QuotaError('instance_complexity', 'too complex', { limit_id: 'maxInstanceComplexityLog10', limit: 9 }));
      await openWorkbench();
      validate();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Too big for your plan (402 · instance_complexity)');
      expect(alert).toHaveTextContent('Your RESEARCH plan allows up to');
      expect(alert.querySelector('sup')).toHaveTextContent('9');
      expect(alert).toHaveTextContent('The server doesn’t report the measured size in this answer, so we can’t show how far over it is.');
      expect(within(alert).getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');

      fireEvent.click(within(alert).getByRole('button', { name: 'Reduce candidates' }));
      const index = screen.getByRole('navigation', { name: 'BIM resources' });
      expect(within(index).getByRole('button', { name: /candidates\.json/ })).toHaveAttribute('aria-current', 'true');
    });

    it('says a package is larger than the plan takes in one request (413), from the gateway and before sending', async () => {
      workbench.validate.mockRejectedValue(refusal(413));
      await openWorkbench();
      validate();
      expect(await screen.findByText('The file is larger than your plan allows per request (128 MiB) · 413.')).toBeInTheDocument();
    });

    it('does not send a file that is over the plan’s ceiling', async () => {
      client.getOwnUsage.mockResolvedValue({ plan: 'RESEARCH', capabilities: { maxPayloadBytes: 100 }, features: {}, contract_pending: false });
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Upload file' }));
      expect(await screen.findByText('Up to 100 bytes on your plan (RESEARCH)')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Import .bim.zip'), { target: { files: [packageFile('too-big')] } });
      expect(await screen.findByText('The file is larger than your plan allows per request (100 bytes) · 413.')).toBeInTheDocument();
      expect(workbench.validate).not.toHaveBeenCalled();
    });

    it('asks to log in again when there is no session (401) and names a credential that cannot validate (403)', async () => {
      workbench.validate.mockRejectedValueOnce(refusal(401));
      await openWorkbench();
      validate();
      const gate = await screen.findByRole('alert');
      expect(gate).toHaveTextContent('Checking a package needs a session (401). Log in again; your package is kept in this browser.');
      expect(within(gate).getByRole('link', { name: 'Log in again' })).toHaveAttribute('href', '/login');

      workbench.validate.mockRejectedValueOnce(refusal(403, 'api_key_boundary'));
      validate();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This credential doesn’t include “validate instances” (403 · api_key_boundary), so the package can’t be checked with it.'));
    });

    it('offers to check again when the gateway cannot answer', async () => {
      workbench.validate.mockRejectedValueOnce(refusal(503));
      await openWorkbench();
      validate();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The package couldn’t be checked');
      expect(alert).toHaveTextContent('A service OpenBinding depends on isn’t answering (503), so nothing was checked.');
      fireEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
      expect(await screen.findByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
    });

    it('keeps the workspace when an imported file is refused, and replaces it when it is accepted', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Upload file' }));

      workbench.validate.mockRejectedValueOnce(refusal(422, undefined, [{ code: 'invalid_import', message: 'The replacement package is invalid.', resource: 'application' }]));
      fireEvent.change(screen.getByLabelText('Import .bim.zip'), { target: { files: [packageFile('must-not-replace')] } });
      expect(await screen.findByRole('button', { name: /invalid_import The replacement package is invalid/i })).toBeInTheDocument();
      expect(screen.getByText(/Your current package was kept/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('hello-bim');

      fireEvent.change(screen.getByLabelText('Import .bim.zip'), { target: { files: [packageFile('accepted-workspace')] } });
      expect(await screen.findByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('accepted-workspace');
      expect(workbench.validate).toHaveBeenCalledTimes(2);
    });
  });

  describe('where the package comes from', () => {
    it('opens a case revision from the address with its registered resources', async () => {
      const version = refOf('checkout-app', '3', '1');
      const registered = revisionOf(checkout, 2, { document: revisionDocument([['application', 'checkout', version]]) });
      platform.caseRevisions.mockResolvedValue([r1, registered]);
      await openWorkbench({ query: `?case=flujo-checkout&revision=${registered.id}` });

      expect(await screen.findByText('Loaded revision 2')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('isa-demo/checkout-app@3');
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Case' })).toHaveValue('flujo-checkout'));
    });

    it('reads the files of the snapshot a revision came from when it holds local files', async () => {
      const local = revisionOf(checkout, 2, { document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'x' }, spec: { profile: 'qos-binding/v1', resources: { application: { application: 'application.json' } } } }, source_snapshot_id: 'snap-2' });
      platform.caseRevisions.mockResolvedValue([r1, local]);
      platform.snapshotArchive.mockResolvedValue(packageArchive('from-snapshot'));
      await openWorkbench({ query: `?case=flujo-checkout&revision=${local.id}` });

      await waitFor(() => expect(platform.snapshotArchive).toHaveBeenCalledWith('snap-2'));
      fireEvent.click(await screen.findByRole('button', { name: /instance\.json/i }));
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('from-snapshot'));
    });

    it('loads the revision chosen in the case and revision selects', async () => {
      const version = refOf('checkout-app', '1', '2');
      platform.caseRevisions.mockResolvedValue([revisionOf(checkout, 1, { document: revisionDocument([['application', 'checkout', version]]) }), r2]);
      await openWorkbench();

      await screen.findByRole('option', { name: 'Flujo de checkout' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Case' }), { target: { value: 'flujo-checkout' } });
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Revision' })).toBeEnabled());
      const options = within(screen.getByRole('combobox', { name: 'Revision' })).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual(['Choose a revision…', 'Flujo de checkout · revision 2', 'Flujo de checkout · revision 1']);
      fireEvent.change(screen.getByRole('combobox', { name: 'Revision' }), { target: { value: r1.id } });

      expect(await screen.findByText('Loaded revision 1')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('isa-demo/checkout-app@1');
    });

    it('says a revision that cannot be opened was not loaded, and tries again on request', async () => {
      renderWorkbench({ query: '?case=flujo-checkout&revision=missing' });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The case revision couldn’t be loaded');
      expect(alert).toHaveTextContent('That case revision doesn’t exist any more, or you’re not in the organization it belongs to (404). The package was not loaded.');
      expect(screen.queryByRole('navigation', { name: 'BIM resources' })).not.toBeInTheDocument();
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(platform.caseRevisions.mock.calls.length).toBeGreaterThan(2));
    });

    it('opens an example from the address and shows it already checked', async () => {
      client.getBimExamplePackage.mockResolvedValue(packageArchive('guided-example'));
      await openWorkbench({ query: '?example=demo%2F01_simple_seq' });

      expect(await screen.findByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
      expect(client.getBimExamplePackage).toHaveBeenCalledWith('demo/01_simple_seq');
      expect(screen.getByRole('tab', { name: 'Example' })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('guided-example');
    });

    it('keeps the unsaved edits of the workspace in the browser, per address', async () => {
      const first = await openWorkbench();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'kept-in-the-browser' } });
      await waitFor(() => expect(localStorage.getItem(`bim-v1-draft:user-lucia:${ROOT}/workbench::`)).toContain('kept-in-the-browser'));
      first.unmount();

      await openWorkbench();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('kept-in-the-browser');
    });

    it('undoes and resets edits, and exports the package as a .bim.zip', async () => {
      const created = vi.fn().mockReturnValue('blob:bim');
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: created });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
      const downloads: string[] = [];
      const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });

      await openWorkbench();
      expect(screen.getByRole('button', { name: 'Undo edit' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'roundtrip-workspace' } });
      expect(screen.getByRole('button', { name: 'Undo edit' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Export .bim.zip' }));
      expect(downloads).toEqual(['roundtrip-workspace.bim.zip']);
      const blob = created.mock.calls[0][0] as Blob;
      expect(blob.type).toBe('application/vnd.bim+zip');

      fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }));
      expect(screen.getByLabelText('Name')).toHaveValue('hello-bim');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'again' } });
      fireEvent.click(screen.getByRole('button', { name: 'Reset workspace' }));
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('hello-bim');
      anchorClick.mockRestore();
    });
  });

  describe('snapshot and revision', () => {
    it('makes one private snapshot, reuses it for the run, and forgets it when the package changes', async () => {
      await validated();
      const bar = screen.getByRole('region', { name: 'Package actions' });
      fireEvent.click(within(bar).getByRole('button', { name: 'Create snapshot' }));

      expect(await screen.findByText('Snapshot created. It is private to your account and never changes.')).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Snapshot created' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/snapshots/snapshot-1`);
      expect(await screen.findByRole('img', { name: /^Workflow:/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));
      await screen.findByRole('cell', { name: 'service-a' });
      expect(workbench.snapshot).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'changed' } });
      expect(screen.queryByRole('region', { name: 'Package actions' })).not.toBeInTheDocument();
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });
      expect(within(screen.getByRole('region', { name: 'Package actions' })).getByRole('button', { name: 'Create snapshot' })).toBeInTheDocument();
    });

    it('names the refusal when the snapshot cannot be made', async () => {
      workbench.snapshot.mockRejectedValue(refusal(413));
      await validated();
      fireEvent.click(screen.getByRole('button', { name: 'Create snapshot' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The snapshot couldn’t be made');
      expect(alert).toHaveTextContent('This package is larger than your plan allows per request (413), so no snapshot was made.');
    });

    it('saves the package as a revision of the chosen case, with the snapshot it came from', async () => {
      workbench.saveRevision.mockResolvedValue(revisionOf(checkout, 3));
      await openWorkbench({ query: '?case=flujo-checkout' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });

      const target = await screen.findByRole('combobox', { name: 'Save into case' });
      await waitFor(() => expect(target).toHaveValue('flujo-checkout'));
      const save = screen.getByRole('button', { name: 'Save as case revision' });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);

      expect(await screen.findByText('Revision 3 of Flujo de checkout saved and sealed.')).toBeInTheDocument();
      expect(workbench.saveRevision).toHaveBeenCalledWith(
        'isa-demo', 'qos-benchmarks', 'flujo-checkout', expect.objectContaining({ apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'hello-bim' } }), 'snapshot-1',
      );
      expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `${ROOT}/cases/flujo-checkout/revisions/3`);
    });

    it('says when the same content was already a revision, and asks for a case first', async () => {
      workbench.saveRevision.mockResolvedValue(r2);
      await validated();

      const save = screen.getByRole('button', { name: 'Save as case revision' });
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute('title', 'Choose the case to save into');
      fireEvent.change(await screen.findByRole('combobox', { name: 'Save into case' }), { target: { value: 'flujo-checkout' } });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);

      expect(await screen.findByText('Same content as revision 2, so no new revision was needed.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'See revisions' })).toHaveAttribute('href', `${ROOT}/cases/flujo-checkout`);
    });

    it('keeps the package and says why a revision was not saved (403)', async () => {
      workbench.saveRevision.mockRejectedValue(refusal(403, 'forbidden'));
      await openWorkbench({ query: '?case=flujo-checkout' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });
      const save = screen.getByRole('button', { name: 'Save as case revision' });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The revision wasn’t saved');
      expect(alert).toHaveTextContent('You need MEMBER in the organization to save a revision, and an API key needs projects:write (403 · forbidden). Nothing was saved.');
      expect(screen.getByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
    });

    it('lets a VIEWER snapshot and run but not save into the project', async () => {
      await openWorkbench({ role: 'VIEWER' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });

      const bar = screen.getByRole('region', { name: 'Package actions' });
      expect(bar).toHaveTextContent('You can snapshot and run with your own account; saving into this project needs MEMBER.');
      expect(within(bar).getByRole('button', { name: 'Save as case revision' })).toBeDisabled();
      expect(within(bar).getByRole('button', { name: 'Save as case revision' })).toHaveAttribute('title', 'Saving into this project needs MEMBER');
      expect(within(bar).queryByRole('combobox', { name: 'Save into case' })).not.toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Create snapshot' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Solve' })).toBeEnabled();
    });
  });

  describe('running', () => {
    it('keeps multiple executable registrations distinct and solves with the selected exact pins', async () => {
      workbench.validate.mockResolvedValue(analysis({
        compatibleModes: [
          { engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true },
          { engine: ENGINE_REF, registration: SECOND_REGISTRATION, mode: 'seeded', compatible: true },
        ],
      }));
      await validated();

      const second = await screen.findByRole('option', { name: 'random-search · seeded · random-search-eu@2.0.0' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Compatible engine mode' }), { target: { value: (second as HTMLOptionElement).value } });
      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

      await waitFor(() => expect(client.createBimJob).toHaveBeenCalledWith('snapshot-1', ENGINE_REF, SECOND_REGISTRATION, 'seeded'));
    });

    it('validates first when Solve is pressed on a package nobody checked, and renders the decision by its declared kind', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

      expect(await screen.findByRole('cell', { name: 'service-a' })).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: 'hello' })).toBeInTheDocument();
      expect(document.querySelector('.wb-result-summary')).toHaveTextContent('1 solution(s) · FEASIBLE');
      expect(screen.getByRole('region', { name: 'Solution 1' })).toHaveTextContent('latency10');
      expect(client.createBimJob).toHaveBeenCalledWith('snapshot-1', ENGINE_REF, REGISTRATION_REF, 'seeded');
      expect(workbench.validate).toHaveBeenCalledTimes(1);
    });

    it('polls a running job until it completes', async () => {
      client.getV1Job.mockResolvedValueOnce({ id: 'job-1', status: 'running' }).mockResolvedValue(completedJob);
      await validated();
      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

      expect(await screen.findByText('Running: the engine is searching…')).toBeInTheDocument();
      expect(await screen.findByRole('cell', { name: 'service-a' }, { timeout: 4000 })).toBeInTheDocument();
      expect(client.getV1Job).toHaveBeenCalledTimes(2);
    });

    it('stops asking for the job when the screen closes', async () => {
      client.getV1Job.mockResolvedValue({ id: 'job-1', status: 'running' });
      const view = await openWorkbench();
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });
      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));
      expect(await screen.findByText('Running: the engine is searching…')).toBeInTheDocument();

      view.unmount();
      const asked = client.getV1Job.mock.calls.length;
      expect(client.getV1Job.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
      await new Promise((resolve) => setTimeout(resolve, 1400));
      expect(client.getV1Job).toHaveBeenCalledTimes(asked);
    });

    it('says why a run did not finish', async () => {
      client.getV1Job.mockResolvedValue({ id: 'job-1', status: 'failed', error: 'The deployment didn’t answer within the budget.' });
      await validated();
      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The run did not finish');
      expect(alert).toHaveTextContent('The deployment didn’t answer within the budget.');
      expect(within(alert).getByRole('link', { name: 'See jobs' })).toHaveAttribute('href', `${ROOT}/jobs`);
    });

    describe('with range features', () => {
      const edge = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: 'sha256-e' };
      const edgeRegistration = { namespace: 'lucia-vega', name: 'edge-solver-eu', version: '1', digest: 'sha256-r' };
      const REASON = 'This package has range features; this engine only accepts single values';
      /** The diagnostic the gateway sends for a mode that does not declare interval values (docs/ERRORS.md); the pointers are optional. */
      const rangeDiagnostic = {
        code: 'unsupported_capability_value', category: 'featureValues', unsupported: ['interval'], allowed: ['scalar'],
        message: 'mode does not support requested featureValues values',
        resource: 'candidates.json', pointer: '/spec/candidates/service-a/features/latency', irPath: '/spec/candidates/catalog/candidates/service-a/features/latency',
      };
      const refusedForRanges = { engine: edge, registration: edgeRegistration, mode: 'placement', compatible: false, diagnostics: [{ code: 'unsupported_capability_value', message: 'interval is not declared' }] };

      /** Gives the first candidate a range from the form of candidates.json, then checks the package again. */
      async function makeRange(open = true) {
        fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Edit candidates.json' }));
        fireEvent.click(within(screen.getByRole('group', { name: 'latency for service-a: value or range' })).getByRole('button', { name: 'Range' }));
        if (open) fireEvent.click(screen.getByLabelText('latency for service-a: no upper limit'));
        validate();
        await waitFor(() => expect(workbench.validate).toHaveBeenCalledTimes(2));
        await screen.findByRole('heading', { name: 'Valid package' });
      }

      it('edits a quality as a number or as a range, open or not, in the candidate form', async () => {
        await validated();
        fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Edit candidates.json' }));

        expect(screen.getByLabelText('service-a QoS latency')).toHaveValue(10);
        fireEvent.click(within(screen.getByRole('group', { name: 'latency for service-a: value or range' })).getByRole('button', { name: 'Range' }));
        expect(screen.queryByLabelText('service-a QoS latency')).not.toBeInTheDocument();
        expect(screen.getByLabelText('latency for service-a min')).toHaveValue('10');
        fireEvent.change(screen.getByLabelText('latency for service-a max'), { target: { value: '20' } });
        fireEvent.click(screen.getByLabelText('latency for service-a: no lower limit'));

        expect(screen.getByLabelText('latency for service-a min')).toHaveValue('−∞');
        expect(screen.getByLabelText('latency for service-a max')).toHaveValue('20');
        // Back to a single value: the cell asks first, because the range is wider than a point.
        fireEvent.click(within(screen.getByRole('group', { name: 'latency for service-a: value or range' })).getByRole('button', { name: 'Value' }));
        expect(screen.getByRole('alertdialog')).toHaveTextContent('Convert to 20? This drops the lower limit (no limit).');
        fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
        expect(screen.getByLabelText('service-a QoS latency')).toHaveValue(20);
      });

      it('lists the modes that only take single values as off, with the reason, once a candidate has a range', async () => {
        workbench.validate.mockResolvedValue(analysis({
          compatibleModes: [{ engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true }, refusedForRanges],
        }));
        await validated();
        const modes = screen.getByRole('combobox', { name: 'Compatible engine mode' });
        // No range yet: the list is what it always was.
        expect(within(modes).getAllByRole('option')).toHaveLength(2);
        expect(document.querySelector('.wb-range-note')).toBeNull();

        await makeRange();

        const options = within(screen.getByRole('combobox', { name: 'Compatible engine mode' })).getAllByRole('option');
        expect(options.map((option) => option.textContent)).toEqual([
          'Validate to select…', 'random-search · seeded · random-search-deployment@1.0.0+builtin.a',
          'edge-solver · placement · edge-solver-eu@1 — can’t run ranges',
        ]);
        expect(options[2]).toBeDisabled();
        expect(options[1]).toBeEnabled();
        const note = document.querySelector('.wb-range-note') as HTMLElement;
        expect(note).toHaveTextContent(`1 engine mode is off. ${REASON}.`);
        expect(within(note).getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
        expect(within(note).getByRole('button', { name: 'Edit the candidates' })).toBeInTheDocument();
      });

      it('gives the reason in the table of engines too', async () => {
        workbench.validate.mockResolvedValue(analysis({
          compatibleModes: [{ engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true }, refusedForRanges],
        }));
        await validated();
        await makeRange();
        fireEvent.click(screen.getByRole('tab', { name: /Engines that can run it/ }));

        const rows = within(screen.getByRole('table', { name: 'Engine modes and whether they can run this package' })).getAllByRole('row');
        expect(rows[2]).toHaveTextContent(REASON);
      });

      it('explains a run the engine refused for ranges, with the pointers, and leads to Engines and to the candidates', async () => {
        client.createBimJob.mockRejectedValue(refusal(422, 'engine_mode_incompatible', [{ code: 'profile_incompatible', message: 'mode profile differs' }, { ...rangeDiagnostic }]));
        await validated();
        fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('This engine only accepts single values');
        expect(alert).toHaveTextContent('Pick a mode that declares interval values, or edit those candidates to use single values.');
        expect(alert).toHaveTextContent('The gateway pointed at candidates.json#/spec/candidates/service-a/features/latency.');
        expect(alert).not.toHaveTextContent('mode profile differs.');
        expect(within(alert).getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
        expect(within(alert).getByRole('button', { name: 'Edit the candidates' })).toBeInTheDocument();
      });

      it('explains the same refusal without a pointer from the gateway, naming the compiled value instead', async () => {
        client.createBimJob.mockRejectedValue(refusal(422, 'engine_mode_incompatible', [{ ...rangeDiagnostic, resource: undefined, pointer: undefined }]));
        await validated();
        fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('This engine only accepts single values');
        expect(alert).toHaveTextContent('The gateway pointed at /spec/candidates/catalog/candidates/service-a/features/latency.');
      });

      it('explains the refusal when the range diagnostic has no pointer at all', async () => {
        client.createBimJob.mockRejectedValue(refusal(422, 'engine_mode_incompatible', [{ code: 'unsupported_capability_value', message: 'mode does not support requested featureValues values' }]));
        await validated();
        fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('This engine only accepts single values');
        expect(alert).not.toHaveTextContent('The gateway pointed at');
      });

      it('explains a job that failed with the same code', async () => {
        client.getV1Job.mockResolvedValue({ id: 'job-1', status: 'failed', error: 'unsupported_capability_value: unsupported ["interval"]' });
        await validated();
        fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('This engine only accepts single values');
      });
    });

    it('runs a sealed execution configuration instead of an engine mode', async () => {
      client.createConfiguredBimJob.mockResolvedValue({ id: 'job-1', status: 'queued', irDigest: 'sha256-ir' });
      await validated();

      fireEvent.click(screen.getByRole('button', { name: 'Pick a sealed configuration' }));
      expect(screen.getByText('Using sealed configuration rs-60s@1.')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Compatible engine mode' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Solve' }));

      await waitFor(() => expect(client.createConfiguredBimJob).toHaveBeenCalledWith(
        'snapshot-1', { namespace: 'isa-demo', name: 'rs-60s', version: '1', versionDigest: `sha256-${'d'.repeat(64)}` },
      ));
      fireEvent.click(screen.getByRole('button', { name: 'Use engine selection instead' }));
      expect(screen.getByRole('combobox', { name: 'Compatible engine mode' })).toBeEnabled();
    });
  });

  describe('the source', () => {
    it('keeps raw JSON, YAML and the compiled form behind View source', async () => {
      await validated();
      expect(screen.queryByLabelText('instance.json source')).not.toBeInTheDocument();
      expect(screen.queryByRole('tablist', { name: 'Source views' })).not.toBeInTheDocument();

      const toggle = screen.getByRole('button', { name: 'View source' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(await screen.findByLabelText('instance.json source')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'YAML view' }));
      expect(((await screen.findByLabelText('instance.json YAML view')) as HTMLTextAreaElement).value).toContain('apiVersion: "bim/v1"');

      fireEvent.click(screen.getByRole('tab', { name: 'Compiled IR' }));
      fireEvent.click(screen.getByRole('button', { name: 'Compile IR' }));
      expect(await screen.findByLabelText('Compiled binding problem IR')).toBeInTheDocument();
      expect(screen.getByText('snapshot-1')).toBeInTheDocument();
      expect(screen.getByText('sha256-ir')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Recompile IR' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Source diff' }));
      expect(screen.getByText('Unchanged')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'diffed' } });
      expect(screen.getByText('Modified')).toBeInTheDocument();
      expect(screen.getByLabelText('Changes to instance.json')).toHaveTextContent('"name": "diffed"');
    });

    it('reports invalid BPMN XML without replacing the last valid source or diagram', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('button', { name: 'View source' }));
      fireEvent.click(await screen.findByRole('tab', { name: 'BPMN XML' }));
      fireEvent.change(await screen.findByLabelText('workflow.bpmn XML source'), { target: { value: '<bpmn:definitions><broken>' } });
      expect(await screen.findByRole('button', { name: /bpmn-editor BPMN XML was not applied/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /workflow\.bpmn/i }));
      fireEvent.click(screen.getByRole('tab', { name: 'JSON source' }));
      const accepted = (await screen.findByLabelText('workflow.bpmn source')) as HTMLTextAreaElement;
      expect(accepted.value).toContain('<?xml version=');
      expect(accepted.value).not.toContain('<broken>');
      expect(await screen.findByTestId('bpmn-modeler')).toBeInTheDocument();
    });

    it('edits the native workflow JSON of the application', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('button', { name: 'View source' }));
      fireEvent.click(await screen.findByRole('tab', { name: 'Workflow JSON' }));
      const editor = await screen.findByLabelText('Native workflow JSON');
      fireEvent.change(editor, { target: { value: '{"task":"hello"}' } });
      validate();
      await waitFor(() => expect(workbench.validate).toHaveBeenCalledTimes(1));
      const archive = workbench.validate.mock.calls[0][0] as Uint8Array;
      const files = await unzipPackage(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer);
      expect(JSON.parse(files['application.json']).spec.workflow).toEqual({ task: 'hello' });
    });
  });

  it('keeps the digest of a package it received as the fingerprint of the one it checked', async () => {
    workbench.validate.mockResolvedValue(analysis({ instanceDigest: digestOf('f') }));
    await validated();
    expect(screen.getByRole('button', { name: 'Copy the instance fingerprint' })).toHaveTextContent('Instance · sha256-ffff…ffff');
  });
});
