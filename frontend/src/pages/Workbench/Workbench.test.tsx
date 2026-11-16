import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { loadDraft } from '../../shared/editor/drafts';
import { unzipPackage } from '../../utils/bimZip';
import type { ProblemUpload } from '../../api/problems';
import { checkoutFacts, compiledDocument, digestOf } from '../Cases/fixtures';
import { caseOf, revisionOf } from '../../features/workspace/testKit';
import {
  ENGINE_REF, REGISTRATION_REF, ROOT, SECOND_REGISTRATION, analysis, openWorkbench, packageArchive, packageFile, renderWorkbench,
} from './workbenchTestKit';

const problems = vi.hoisted(() => ({ list: vi.fn(), revisions: vi.fn(), source: vi.fn(), create: vi.fn(), createRevision: vi.fn() }));
const bim = vi.hoisted(() => ({ validate: vi.fn(), templates: vi.fn(), template: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../api/bim', () => ({ bimApi: bim }));
vi.mock('../../components/CodeEditor/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, ariaLabel, readOnly }: { value: string; onChange: (value: string) => void; ariaLabel: string; readOnly?: boolean }) => (
    <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('./BpmnModeler', () => ({ BpmnModeler: () => <div data-testid="bpmn-modeler" /> }));

const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r1 = revisionOf(checkout, 1);
const r2 = revisionOf(checkout, 2);

/** What a save answers: the problem, the revision (new or already there) and its compilation. */
const upload = (revision: number, created: boolean, problem = checkout): ProblemUpload => ({
  problem, revision: revisionOf(problem, revision), created,
  compilation: { id: `compilation-${revision}`, compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'), binding_space: '128', created_at: '2026-04-02T00:00:00Z', current: true },
});

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
    problems.list.mockResolvedValue({ problems: [checkout], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([r1, r2]);
    problems.source.mockResolvedValue(packageArchive('from-version'));
    bim.templates.mockResolvedValue(['demo/01_simple_seq']);
    // The analysis, with the compiled form and its facts when the screen asks for them (`include: 'ir,facts'`).
    bim.validate.mockImplementation((_archive: Uint8Array, options?: { include?: string }) => Promise.resolve(
      options?.include === 'ir,facts' ? analysis({ ir: compiledDocument(), facts: checkoutFacts(), sourceMap: {}, irDigest: 'sha256-ir' }) : analysis(),
    ));
  });

  describe('the page', () => {
    it('opens on a small package, says nothing has been checked yet and lays out the three sources', async () => {
      await openWorkbench();

      expect(screen.getByRole('heading', { level: 1, name: 'Workbench' })).toBeInTheDocument();
      expect(screen.getByText('Write or check a package, see which engines can run it, then save it as a new problem or as a new version of one. A saved version runs from its problem page.')).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Problems' })).toHaveAttribute('href', '/app/isa-demo/problems');
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Workbench')).toHaveAttribute('aria-current', 'page');
      expect(screen.getAllByRole('tab').slice(0, 3).map((tab) => tab.textContent)).toEqual(['Problem version', 'Upload file', 'Template']);
      expect(screen.getByRole('tab', { name: 'Problem version' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText(/Nothing validated yet/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Package actions' })).not.toBeInTheDocument();

      const index = screen.getByRole('navigation', { name: 'BIM resources' });
      for (const text of ['application.json', 'candidates.json', 'optimization.json', 'workflow.bpmn', 'Candidate catalogs']) expect(index).toHaveTextContent(text);
    });

    it('offers the templates under Template', async () => {
      await openWorkbench();
      fireEvent.click(screen.getByRole('tab', { name: 'Template' }));
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

    it('says an organization the account is not in is not available', async () => {
      renderWorkbench({ url: '/app/elsewhere/workbench' });
      expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    });
  });

  describe('checking the package', () => {
    it('shows the compiling state while the gateway reads the package', async () => {
      bim.validate.mockReturnValue(new Promise(() => undefined));
      await openWorkbench();
      validate();

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Compiling the package…');
      expect(status).toHaveTextContent('Reading files → checking each resource → measuring the problem.');
      expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
    });

    it('sends a deterministic BIM ZIP and tells the modes the analysis says can run it from the others', async () => {
      bim.validate.mockResolvedValue(analysis({
        compatibleModes: [
          { engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true },
          { engine: ENGINE_REF, registration: { ...SECOND_REGISTRATION, name: 'not-executable', digest: 'sha256-registration-c' }, mode: 'seeded', compatible: false },
        ],
      }));
      await validated();

      const archive = bim.validate.mock.calls[0][0] as Uint8Array;
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
      bim.validate.mockResolvedValue(analysis({
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
      expect(screen.queryByRole('group', { name: 'Workflow' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Draw the workflow' }));
      const drawing = await screen.findByRole('group', { name: 'Workflow' });
      expect(drawing).toHaveAccessibleDescription(/^Workflow: authenticate, then \(inventory and shipping in parallel\)/);
      expect(bim.validate).toHaveBeenLastCalledWith(expect.any(Uint8Array), { include: 'ir,facts' });
    });
  });

  describe('what the gateway refuses', () => {
    it('lists the 422 problems by file and place, with the fix when there is one, and opens each where it lives', async () => {
      bim.validate.mockRejectedValue(refusal(422, undefined, [
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
      bim.validate.mockRejectedValue(new QuotaError('quota_exceeded', 'used up', { limit_id: 'maxRepositoryStorage', limit: 500, used: 500 }));
      await openWorkbench();
      validate();

      const notice = await screen.findByText('Out of an allowance of your plan (402 · quota_exceeded)');
      const box = notice.closest('.ui-notice') as HTMLElement;
      expect(box).toHaveTextContent('Your plan’s storage is used up (402 · quota_exceeded), so nothing was checked.');
      expect(box).not.toHaveTextContent(/combinations|Too big/);
      expect(screen.queryByText(/Not valid/)).not.toBeInTheDocument();
    });

    it('says the deployment caps the size whatever the plan (422), and a measuring failure is not the package’s fault', async () => {
      bim.validate.mockRejectedValueOnce(Object.assign(refusal(422, 'binding_space_over_technical_limit'), {
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

      bim.validate.mockRejectedValueOnce(Object.assign(refusal(422, 'binding_space_unmeasured'), {
        notice: { limit_id: 'MAX_BINDING_SPACE_LOG10', state: 'unmeasured', source: 'technical', limit: 20 },
      }));
      validate();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The problem’s size couldn’t be measured (422 · binding_space_unmeasured)'));
      expect(screen.getByRole('alert')).toHaveTextContent('not a mistake in your package');
      expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    });

    it('says a package is larger than the deployment takes in one request (413)', async () => {
      bim.validate.mockRejectedValue(refusal(413));
      await openWorkbench();
      validate();
      expect(await screen.findByText('The package is larger than this deployment allows per request (413).')).toBeInTheDocument();
    });

    it('asks to log in again when there is no session (401) and names a credential that cannot validate (403)', async () => {
      bim.validate.mockRejectedValueOnce(refusal(401));
      await openWorkbench();
      validate();
      const gate = await screen.findByRole('alert');
      expect(gate).toHaveTextContent('Checking a package needs a session (401). Log in again; your package is kept in this browser.');
      expect(within(gate).getByRole('link', { name: 'Log in again' })).toHaveAttribute('href', '/login');

      bim.validate.mockRejectedValueOnce(refusal(403, 'api_key_boundary'));
      validate();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This credential doesn’t include “validate instances” (403 · api_key_boundary), so the package can’t be checked with it.'));
    });

    it('offers to check again when the gateway cannot answer', async () => {
      bim.validate.mockRejectedValueOnce(refusal(503));
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

      bim.validate.mockRejectedValueOnce(refusal(422, undefined, [{ code: 'invalid_import', message: 'The replacement package is invalid.', resource: 'application' }]));
      fireEvent.change(screen.getByLabelText('Import .bim.zip'), { target: { files: [packageFile('must-not-replace')] } });
      expect(await screen.findByRole('button', { name: /invalid_import The replacement package is invalid/i })).toBeInTheDocument();
      expect(screen.getByText(/Your current package was kept/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('hello-bim');

      fireEvent.change(screen.getByLabelText('Import .bim.zip'), { target: { files: [packageFile('accepted-workspace')] } });
      expect(await screen.findByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('accepted-workspace');
      expect(bim.validate).toHaveBeenCalledTimes(2);
    });
  });

  describe('where the package comes from', () => {
    it('opens a problem version from the address: the package exactly as it was uploaded', async () => {
      await openWorkbench({ query: '?problem=flujo-checkout&revision=2' });

      expect(await screen.findByText('Loaded version 2')).toBeInTheDocument();
      expect(problems.source).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '2');
      fireEvent.click(await screen.findByRole('button', { name: /instance\.json/i }));
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('from-version'));
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Problem' })).toHaveValue('flujo-checkout'));
    });

    it('opens the newest version of a problem the address names without a version', async () => {
      await openWorkbench({ query: '?problem=flujo-checkout' });
      await waitFor(() => expect(problems.source).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '2'));
    });

    it('loads the version chosen in the problem and problem version selects', async () => {
      problems.source.mockResolvedValue(packageArchive('version-one'));
      await openWorkbench();

      await screen.findByRole('option', { name: 'Flujo de checkout' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Problem' }), { target: { value: 'flujo-checkout' } });
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Problem version' })).toBeEnabled());
      const options = within(screen.getByRole('combobox', { name: 'Problem version' })).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual(['Choose a version…', 'Flujo de checkout · version 2', 'Flujo de checkout · version 1']);
      fireEvent.change(screen.getByRole('combobox', { name: 'Problem version' }), { target: { value: r1.id } });

      expect(await screen.findByText('Loaded version 1')).toBeInTheDocument();
      expect(problems.source).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '1');
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('version-one');
    });

    it('says a version that cannot be opened was not loaded, and tries again on request', async () => {
      problems.source.mockRejectedValue(refusal(404));
      renderWorkbench({ query: '?problem=flujo-checkout&revision=9' });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The problem version couldn’t be loaded');
      expect(alert).toHaveTextContent('That problem version doesn’t exist any more, or you’re not in the organization it belongs to (404). The package was not loaded.');
      expect(screen.queryByRole('navigation', { name: 'BIM resources' })).not.toBeInTheDocument();
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(problems.source.mock.calls.length).toBeGreaterThan(1));
    });

    it('opens a template from the address and shows it already checked', async () => {
      bim.template.mockResolvedValue(packageArchive('guided-example'));
      await openWorkbench({ query: '?template=demo%2F01_simple_seq' });

      expect(await screen.findByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
      expect(bim.template).toHaveBeenCalledWith('demo/01_simple_seq');
      expect(screen.getByRole('tab', { name: 'Template' })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      expect(screen.getByLabelText('Name')).toHaveValue('guided-example');
    });

    it('keeps the unsaved edits of the workspace in the browser, per person, organization and problem version', async () => {
      const first = await openWorkbench();
      fireEvent.click(screen.getByRole('button', { name: /instance\.json/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'kept-in-the-browser' } });
      await waitFor(async () => expect((await loadDraft('user-lucia:problem:isa-demo:new:none'))?.['instance.json']).toContain('kept-in-the-browser'));
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

  describe('saving', () => {
    it('saves the package as a new problem of the organization, named after it', async () => {
      const made = caseOf('hello-bim', 'hello-bim');
      problems.create.mockResolvedValue(upload(1, true, made));
      await validated();

      const bar = screen.getByRole('region', { name: 'Package actions' });
      expect(within(bar).getByRole('combobox', { name: 'Save into problem' })).toHaveValue('');
      expect(within(bar).getByRole('textbox', { name: 'Name of the new problem' })).toHaveValue('hello-bim');
      fireEvent.click(within(bar).getByRole('button', { name: 'Save as a new problem' }));

      expect(await screen.findByText('Saved as version 1 of hello-bim. Run it from its page.')).toBeInTheDocument();
      expect(problems.create).toHaveBeenCalledWith('isa-demo', expect.any(Uint8Array), { name: 'hello-bim', slug: 'hello-bim' });
      expect(screen.getByRole('link', { name: 'Open the problem' })).toHaveAttribute('href', `${ROOT}/problems/hello-bim?version=1`);
    });

    it('saves the package as a new version of the problem it was opened from', async () => {
      problems.createRevision.mockResolvedValue(upload(3, true));
      await openWorkbench({ query: '?problem=flujo-checkout&revision=2' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });

      const target = await screen.findByRole('combobox', { name: 'Save into problem' });
      await waitFor(() => expect(target).toHaveValue('flujo-checkout'));
      fireEvent.click(screen.getByRole('button', { name: 'Save as a new version of Flujo de checkout' }));

      expect(await screen.findByText('Saved as version 3 of Flujo de checkout. Run it from its page.')).toBeInTheDocument();
      expect(problems.createRevision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', expect.any(Uint8Array));
      expect(screen.getByRole('link', { name: 'Open the problem' })).toHaveAttribute('href', `${ROOT}/problems/flujo-checkout?version=3`);
    });

    it('says when the package already is a version: nothing new was saved', async () => {
      problems.createRevision.mockResolvedValue(upload(2, false));
      await validated();

      fireEvent.change(await screen.findByRole('combobox', { name: 'Save into problem' }), { target: { value: 'flujo-checkout' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save as a new version of Flujo de checkout' }));

      expect(await screen.findByText('Unchanged: this is version 2 of Flujo de checkout.')).toBeInTheDocument();
    });

    it.each([
      [refusal(409, 'slug_conflict'), 'That address is already used by another problem in this organization (409 · slug_conflict). Pick another one. Nothing was saved.'],
      [new QuotaError('quota_exceeded', 'full', { limit_id: 'maxProblems', limit: 3 }), 'Your plan has no room for this (402 · quota_exceeded)'],
      [refusal(403, 'forbidden'), 'You need MEMBER in the organization to save, and an API key needs problems:write (403 · forbidden). Nothing was saved.'],
    ])('keeps the package and says why it was not saved (%#)', async (caught, text) => {
      problems.create.mockRejectedValue(caught);
      await validated();
      fireEvent.click(screen.getByRole('button', { name: 'Save as a new problem' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The package wasn’t saved');
      expect(alert).toHaveTextContent(text);
      expect(screen.getByRole('heading', { name: 'Valid package' })).toBeInTheDocument();
    });

    it('lets a VIEWER edit and check but not save into the organization', async () => {
      await openWorkbench({ role: 'VIEWER' });
      validate();
      await screen.findByRole('heading', { name: 'Valid package' });

      const bar = screen.getByRole('region', { name: 'Package actions' });
      expect(bar).toHaveTextContent('You can edit and check here; saving into the organization needs MEMBER.');
      expect(within(bar).getByRole('button', { name: 'Save as a new problem' })).toBeDisabled();
      expect(within(bar).getByRole('button', { name: 'Save as a new problem' })).toHaveAttribute('title', 'Saving into the organization needs MEMBER');
      expect(within(bar).queryByRole('combobox', { name: 'Save into problem' })).not.toBeInTheDocument();
    });

    it('runs nothing itself: no engine to pick, no snapshot and no Solve, only the save that leads to the problem page', async () => {
      await validated();

      expect(screen.queryByRole('button', { name: 'Solve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create snapshot' })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Compatible engine mode' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Run with an engine' })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Package actions' })).toHaveTextContent('it runs from its problem page');
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
      await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(2));
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
      bim.validate.mockResolvedValue(analysis({
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
      expect(screen.queryByText('Saved privately')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy digest' })).toBeInTheDocument();
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
      await waitFor(() => expect(bim.validate).toHaveBeenCalledTimes(1));
      const archive = bim.validate.mock.calls[0][0] as Uint8Array;
      const files = await unzipPackage(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer);
      expect(JSON.parse(files['application.json']).spec.workflow).toEqual({ task: 'hello' });
    });
  });

  it('keeps the digest of a package it received as the fingerprint of the one it checked', async () => {
    bim.validate.mockResolvedValue(analysis({ instanceDigest: digestOf('f') }));
    await validated();
    expect(screen.getByRole('button', { name: 'Copy the instance digest' })).toHaveTextContent('Copy instance digest');
  });
});
