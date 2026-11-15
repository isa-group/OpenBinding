import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { unzipPackage } from '../../utils/bimZip';
import { digestOf, irDocument, refOf, revisionDocument } from '../Cases/fixtures';
import { caseOf, project, revisionOf } from '../../features/workspace/testKit';
import {
  ENGINE_REF, REGISTRATION_REF, ROOT, SECOND_REGISTRATION, analysis, openWorkbench, packageArchive, packageFile, renderWorkbench,
} from './workbenchTestKit';

const platform = vi.hoisted(() => ({ project: vi.fn(), cases: vi.fn(), caseRevisions: vi.fn(), snapshotArchive: vi.fn() }));
const client = vi.hoisted(() => ({ getBimExamples: vi.fn(), getBimExamplePackage: vi.fn(), getOwnUsage: vi.fn(), getPricingCatalog: vi.fn() }));
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

describe('Workbench', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([checkout]);
    platform.caseRevisions.mockResolvedValue([r1, r2]);
    client.getBimExamples.mockResolvedValue(['demo/01_simple_seq']);
    client.getOwnUsage.mockResolvedValue({
      plan: 'RESEARCH', capabilities: { maxRepositoryStorage: 500 }, features: {}, contract_pending: false,
    });
    client.getPricingCatalog.mockResolvedValue(null);
    workbench.validate.mockResolvedValue(analysis());
    workbench.snapshot.mockResolvedValue({ id: 'snapshot-1', irDigest: 'sha256-ir' });
    workbench.ir.mockResolvedValue(irDocument());
  });

  describe('the page', () => {
    it('opens on a small package, says nothing has been checked yet and lays out the three sources', async () => {
      await openWorkbench();

      expect(screen.getByRole('heading', { level: 1, name: 'Workbench' })).toBeInTheDocument();
      expect(screen.getByText('Write or check a package, see which engines can run it, then snapshot it or save it as a problem version. A saved version runs from its problem page.')).toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Problems' })).toHaveAttribute('aria-current', 'page');
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Workbench')).toHaveAttribute('aria-current', 'page');
      expect(screen.getAllByRole('tab').slice(0, 3).map((tab) => tab.textContent)).toEqual(['Problem version', 'Upload file', 'Example']);
      expect(screen.getByRole('tab', { name: 'Problem version' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText(/Nothing validated yet/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Package actions' })).not.toBeInTheDocument();

      const index = screen.getByRole('navigation', { name: 'BIM resources' });
      for (const text of ['application.json', 'candidates.json', 'optimization.json', 'workflow.bpmn', 'Candidate catalogs']) expect(index).toHaveTextContent(text);
    });

    it('offers the backend examples under Example', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Example' }));
      expect(await screen.findByRole('option', { name: 'demo/01_simple_seq' })).toBeInTheDocument();
    });

    it('keeps the package import control keyboard-focusable', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Upload file' }));

      const importInput = screen.getByLabelText('Import .bim.zip');
      expect(importInput).toHaveAttribute('type', 'file');
      expect(importInput).toHaveClass('sr-only');
      importInput.focus();
      expect(importInput).toHaveFocus();
      expect(await screen.findByText('The gateway refuses packages larger than this deployment allows')).toBeInTheDocument();
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

    it('sends a deterministic BIM ZIP and tells the modes the analysis says can run it from the others', async () => {
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

      fireEvent.click(screen.getByRole('tab', { name: /Engines that can run it/ }));
      const rows = within(screen.getByRole('table', { name: 'Engine modes and whether they can run this package' })).getAllByRole('row');
      expect(rows).toHaveLength(3);
      expect(within(rows[1]).getByText('Yes')).toBeInTheDocument();
      expect(within(rows[2]).getByText('No')).toBeInTheDocument();
    });

    it('shows the valid package, copy buttons for its digests and what is inside it', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await validated();

      expect(screen.getByText('hello-bim · qos-binding/v1')).toBeInTheDocument();
      const instance = screen.getByRole('button', { name: 'Copy the instance digest' });
      expect(instance).toHaveTextContent('Copy instance digest');
      expect(screen.getByRole('button', { name: 'Copy the package digest' })).toHaveTextContent('Copy package digest');
      expect(screen.getByRole('button', { name: 'Copy the compiled digest' })).toHaveTextContent('Copy compiled digest');
      expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
      fireEvent.click(instance);
      await waitFor(() => expect(instance).toHaveTextContent('Instance digest copied'));
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

    it('says an allowance of the plan is used up (402), and shows no plan ceiling for the size of a problem', async () => {
      workbench.validate.mockRejectedValue(new QuotaError('quota_exceeded', 'used up', { limit_id: 'maxRepositoryStorage', limit: 500, used: 500 }));
      await openWorkbench();
      validate();

      const notice = await screen.findByText('Out of an allowance of your plan (402 · quota_exceeded)');
      const box = notice.closest('.ui-notice') as HTMLElement;
      expect(box).toHaveTextContent('Your plan’s storage is used up (402 · quota_exceeded), so nothing was checked.');
      expect(box).not.toHaveTextContent(/combinations|Too big/);
      expect(screen.queryByText(/Not valid/)).not.toBeInTheDocument();
    });

    it('says the deployment caps the size whatever the plan (422), and a measuring failure is not the package’s fault', async () => {
      workbench.validate.mockRejectedValueOnce(Object.assign(refusal(422, 'binding_space_over_technical_limit'), {
        notice: { limit_id: 'MAX_BINDING_SPACE_LOG10', state: 'exhausted', source: 'technical', limit: 6, used: 9 },
        bindingSpace: { log10: 9, digits: 10 },
      }));
      await openWorkbench();
      validate();
      const capped = await screen.findByRole('alert');
      expect(capped).toHaveTextContent('Over this deployment’s size limit (422 · binding_space_over_technical_limit)');
      expect(capped).toHaveTextContent('whatever the plan, so a larger plan won’t change it');
      expect(capped).toHaveTextContent('about 10⁹ combinations');
      expect(within(capped).queryByRole('link', { name: 'Compare plans' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Not valid/)).not.toBeInTheDocument();

      workbench.validate.mockRejectedValueOnce(Object.assign(refusal(422, 'binding_space_unmeasured'), {
        notice: { limit_id: 'MAX_BINDING_SPACE_LOG10', state: 'unmeasured', source: 'technical', limit: 20 },
      }));
      validate();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The problem’s size couldn’t be measured (422 · binding_space_unmeasured)'));
      expect(screen.getByRole('alert')).toHaveTextContent('not a mistake in your package');
      expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    });

    it('says a package is larger than the deployment takes in one request (413)', async () => {
      workbench.validate.mockRejectedValue(refusal(413));
      await openWorkbench();
      validate();
      expect(await screen.findByText('The package is larger than this deployment allows per request (413).')).toBeInTheDocument();
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
    it('opens a problem version from the address with its registered resources', async () => {
      const version = refOf('checkout-app', '3', '1');
      const registered = revisionOf(checkout, 2, { document: revisionDocument([['application', 'checkout', version]]) });
      platform.caseRevisions.mockResolvedValue([r1, registered]);
      await openWorkbench({ query: `?case=flujo-checkout&revision=${registered.id}` });

      expect(await screen.findByText('Loaded version 2')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('isa-demo/checkout-app@3');
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Problem' })).toHaveValue('flujo-checkout'));
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

    it('loads the version chosen in the problem and problem version selects', async () => {
      const version = refOf('checkout-app', '1', '2');
      platform.caseRevisions.mockResolvedValue([revisionOf(checkout, 1, { document: revisionDocument([['application', 'checkout', version]]) }), r2]);
      await openWorkbench();

      await screen.findByRole('option', { name: 'Flujo de checkout' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Problem' }), { target: { value: 'flujo-checkout' } });
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Problem version' })).toBeEnabled());
      const options = within(screen.getByRole('combobox', { name: 'Problem version' })).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual(['Choose a version…', 'Flujo de checkout · version 2', 'Flujo de checkout · version 1']);
      fireEvent.change(screen.getByRole('combobox', { name: 'Problem version' }), { target: { value: r1.id } });

      expect(await screen.findByText('Loaded version 1')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'BIM resources' })).toHaveTextContent('isa-demo/checkout-app@1');
    });

    it('says a version that cannot be opened was not loaded, and tries again on request', async () => {
      renderWorkbench({ query: '?case=flujo-checkout&revision=missing' });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The problem version couldn’t be loaded');
      expect(alert).toHaveTextContent('That problem version doesn’t exist any more, or you’re not in the organization it belongs to (404). The package was not loaded.');
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

  describe('snapshot and problem version', () => {
    it('makes one private snapshot, reuses it, and forgets it when the package changes', async () => {
      await validated();
      const bar = screen.getByRole('region', { name: 'Package actions' });
      fireEvent.click(within(bar).getByRole('button', { name: 'Create snapshot' }));

      expect(await screen.findByText('Snapshot created. It is private to your account and never changes.')).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Snapshot created' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/problems`);
      expect(await screen.findByRole('img', { name: /^Workflow:/ })).toBeInTheDocument();

      fireEvent.click(within(bar).getByRole('button', { name: 'Snapshot created' }));
      await waitFor(() => expect(workbench.ir).toHaveBeenCalledTimes(2));
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
      expect(alert).toHaveTextContent('This package is larger than this deployment allows per request (413), so no snapshot was made.');
    });

    it('opens the snapshot on the Source tab of the problem version that was sealed from it', async () => {
      platform.caseRevisions.mockResolvedValue([r1, r2, revisionOf(checkout, 3, { source_snapshot_id: 'snapshot-1' })]);
      await openWorkbench({ query: '?case=flujo-checkout' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Save into problem' })).toHaveValue('flujo-checkout'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save as problem version' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Create snapshot' }));

      expect(await screen.findByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/problems/flujo-checkout/source?version=3`);
    });

    it('opens the problem list for a snapshot that no version of the chosen problem came from', async () => {
      await openWorkbench({ query: '?case=flujo-checkout' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save as problem version' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Create snapshot' }));

      expect(await screen.findByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/problems`);
    });

    it('saves the package as a version of the chosen problem, with the snapshot it came from', async () => {
      workbench.saveRevision.mockResolvedValue(revisionOf(checkout, 3, { source_snapshot_id: 'snapshot-1' }));
      await openWorkbench({ query: '?case=flujo-checkout' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });

      const target = await screen.findByRole('combobox', { name: 'Save into problem' });
      await waitFor(() => expect(target).toHaveValue('flujo-checkout'));
      const save = screen.getByRole('button', { name: 'Save as problem version' });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);

      expect(await screen.findByText('Version 3 of Flujo de checkout saved and sealed. Run it from its page.')).toBeInTheDocument();
      expect(workbench.saveRevision).toHaveBeenCalledWith(
        'isa-demo', 'qos-benchmarks', 'flujo-checkout', expect.objectContaining({ apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'hello-bim' } }), 'snapshot-1',
      );
      expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `${ROOT}/problems/flujo-checkout?version=3`);
      expect(screen.getByRole('link', { name: 'Open snapshot' })).toHaveAttribute('href', `${ROOT}/problems/flujo-checkout/source?version=3`);
    });

    it('says when the same content was already a version, and asks for a problem first', async () => {
      workbench.saveRevision.mockResolvedValue(r2);
      await validated();

      const save = screen.getByRole('button', { name: 'Save as problem version' });
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute('title', 'Choose the problem to save into');
      fireEvent.change(await screen.findByRole('combobox', { name: 'Save into problem' }), { target: { value: 'flujo-checkout' } });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);

      expect(await screen.findByText('Same content as version 2, so no new version was needed.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'See versions' })).toHaveAttribute('href', `${ROOT}/problems/flujo-checkout/versions`);
    });

    it('keeps the package and says why a version was not saved (403)', async () => {
      workbench.saveRevision.mockRejectedValue(refusal(403, 'forbidden'));
      await openWorkbench({ query: '?case=flujo-checkout' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });
      const save = screen.getByRole('button', { name: 'Save as problem version' });
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The version wasn’t saved');
      expect(alert).toHaveTextContent('You need MEMBER in the organization to save a version, and an API key needs projects:write (403 · forbidden). Nothing was saved.');
      expect(screen.getByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
    });

    it('lets a VIEWER snapshot but not save into the project', async () => {
      await openWorkbench({ role: 'VIEWER' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });

      const bar = screen.getByRole('region', { name: 'Package actions' });
      expect(bar).toHaveTextContent('You can snapshot with your own account; saving into this project needs MEMBER.');
      expect(within(bar).getByRole('button', { name: 'Save as problem version' })).toBeDisabled();
      expect(within(bar).getByRole('button', { name: 'Save as problem version' })).toHaveAttribute('title', 'Saving into this project needs MEMBER');
      expect(within(bar).queryByRole('combobox', { name: 'Save into problem' })).not.toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Create snapshot' })).toBeEnabled();
    });

    it('runs nothing itself: no engine to pick, no sealed configuration and no Solve, only the save that leads to the problem page', async () => {
      await validated();

      expect(screen.queryByRole('button', { name: 'Solve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Run…' })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Compatible engine mode' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Execution configuration/)).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Run with an engine' })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Package actions' })).toHaveTextContent('saved as a version of a problem, which runs from its page');
    });
  });

  describe('with range features', () => {
    const edge = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: 'sha256-e' };
    const edgeRegistration = { namespace: 'lucia-vega', name: 'edge-solver-eu', version: '1', digest: 'sha256-r' };
    const REASON = 'This package has range features; this engine only accepts single values';
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

    it('turns off, in the check result, a mode that only takes single values once a candidate has a range, with the reason', async () => {
      workbench.validate.mockResolvedValue(analysis({
        compatibleModes: [{ engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true }, refusedForRanges],
      }));
      await validated();
      await makeRange();
      fireEvent.click(screen.getByRole('tab', { name: /Engines that can run it/ }));

      const rows = within(screen.getByRole('table', { name: 'Engine modes and whether they can run this package' })).getAllByRole('row');
      expect(rows[2]).toHaveTextContent(REASON);
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
      expect(screen.getByText('Saved privately')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy digest' })).toBeInTheDocument();
      expect(screen.queryByText('snapshot-1')).not.toBeInTheDocument();
      expect(screen.queryByText('sha256-ir')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Recompile IR' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Source diff' }));
      expect(screen.getByText('Unchanged')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'diffed' } });
      expect(screen.getByText('Modified')).toBeInTheDocument();
      const changes = screen.getByRole('region', { name: 'Changes to instance.json' });
      expect(changes).toHaveTextContent('"name": "diffed"');
      const text = changes.querySelector('pre')?.textContent ?? '';
      expect(text).toMatch(/^\+ *"name": "diffed",?$/m);
      expect(text).toMatch(/^- *"name": "(?!diffed")/m);
      expect(changes.querySelector('pre')).not.toBeNull();
      expect(within(changes).getByRole('button', { name: 'Copy Changes to instance.json' })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Copy the instance digest' })).toHaveTextContent('Copy instance digest');
  });
});
