import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { shortDigest } from '../../utils/digest';
import { caseOf, lucia, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { digestOf, irDocument } from './fixtures';
import { SnapshotDetail } from './SnapshotDetail';

const platform = vi.hoisted(() => ({ project: vi.fn(), snapshot: vi.fn(), snapshotArchive: vi.fn(), cases: vi.fn(), revisions: vi.fn(), publicProjects: vi.fn() }));
const cases = vi.hoisted(() => ({ instance: vi.fn(), analyseSnapshot: vi.fn(), instanceSource: vi.fn(), instanceIr: vi.fn() }));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/cases', () => ({ casesApi: cases }));
vi.mock('../Project/download', () => download);
const rendering = vi.hoisted(() => ({ saveText: vi.fn() }));
const { saveText } = rendering;
vi.mock('../../components/rendering/download', () => rendering);

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const id = '00000000-0000-4000-8000-0000000000e1';
const root = '/app/isa-demo/qos-benchmarks';
const short = shortDigest;

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });
const snapshotOf = (over: Record<string, unknown> = {}) => ({
  id, ownerId: lucia.id, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), archiveSize: 48_213, createdAt: '2026-08-20T10:05:00Z',
  ir: { id: 'ir', digest: digestOf('c'), document: irDocument(), sourceMap: null, compilerVersion: '1.0.0', createdAt: null }, ...over,
});

function renderSnapshot() {
  return renderProjectScreen(<SnapshotDetail />, { path: '/app/:org/:project/snapshots/:snapshot', url: `${root}/snapshots/${id}`, organizations: [group] });
}

async function zipBuffer() {
  const zip = new JSZip();
  zip.file('instance.json', '{"kind":"Instance"}');
  zip.file('application.json', '{"kind":"Application"}');
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('Snapshot detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.snapshot.mockResolvedValue(snapshotOf());
    platform.cases.mockResolvedValue([checkout]);
    platform.revisions.mockResolvedValue([revisionOf(checkout, 1), revisionOf(checkout, 2, { source_snapshot_id: id })]);
    platform.snapshotArchive.mockResolvedValue(new ArrayBuffer(8));
    cases.instance.mockResolvedValue({
      id, kind: 'InstanceSnapshot', instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'),
      fileDigests: { 'instance.json': digestOf('1'), 'application.json': digestOf('2') }, resourceDigests: { app: digestOf('3') }, instance: {}, createdAt: '2026-08-20T10:05:00Z',
    });
    cases.analyseSnapshot.mockResolvedValue({
      valid: true, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'),
      analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '1920' }, compatibleModes: [{}, {}],
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('opens with who made it, when, from which revision, and that it never changes', async () => {
    renderSnapshot();

    expect(await screen.findByRole('heading', { level: 1, name: 'Compiled snapshot' })).toBeInTheDocument();
    const line = screen.getByText(/Made by you/);
    await waitFor(() => expect(line).toHaveTextContent('Made by you · Aug 20, 2026, 10:05 UTC · from Flujo de checkout revision 2 · never changes'));
    expect(within(line).getByRole('link', { name: 'Flujo de checkout' })).toHaveAttribute('href', `${root}/cases/flujo-checkout`);
    expect(screen.getByRole('link', { name: 'Run from this snapshot' })).toHaveAttribute('href', `${root}/jobs/new?snapshot=${id}`);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', `${root}/workbench`);
    expect(within(crumbs).getByText('Snapshot 0000…e1')).toHaveAttribute('aria-current', 'page');
  });

  it('says a member made it when the account is not the owner', async () => {
    platform.snapshot.mockResolvedValue(snapshotOf({ ownerId: 'someone-else' }));
    renderSnapshot();

    expect(await screen.findByText(/Made by a member/)).toBeInTheDocument();
  });

  it('shows the three fingerprints and copies each one whole, or all together', async () => {
    renderSnapshot();

    const section = await screen.findByRole('region', { name: 'Fingerprints' });
    expect(within(section).getByText(short(digestOf('a')))).toBeInTheDocument();
    expect(within(section).getByText(short(digestOf('b')))).toBeInTheDocument();
    expect(within(section).getByText(short(digestOf('c')))).toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Copy full package fingerprint' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(digestOf('b')));
    expect(await within(section).findByText('Copied')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy all fingerprints' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`instance ${digestOf('a')}\npackage ${digestOf('b')}\ncompiled ${digestOf('c')}`));
    expect(await screen.findByRole('button', { name: 'Copied all three' })).toBeInTheDocument();
  });

  it('lists the fingerprint of every file and resource it pins', async () => {
    renderSnapshot();

    const summary = await screen.findByText('Per-file and per-resource fingerprints');
    const details = summary.closest('details') as HTMLDetailsElement;
    details.open = true;
    expect(within(details).getByRole('table', { name: 'Files (2)' })).toBeInTheDocument();
    expect(within(details).getByRole('row', { name: /instance\.json/ })).toHaveTextContent(digestOf('1'));
    expect(within(details).getByRole('table', { name: 'Resources (1)' })).toBeInTheDocument();
  });

  it('names the exact language the compiled form was made with', async () => {
    renderSnapshot();

    const section = await screen.findByRole('region', { name: 'Exact language used' });
    expect(within(section).getByText('Profile · qos-binding/v1')).toBeInTheDocument();
    expect(within(section).getByText('Dialects · qos-dialect/v1')).toBeInTheDocument();
    expect(within(section).getByText('Adapters · qos-adapter@1.0.0')).toBeInTheDocument();
  });

  it('summarizes what the engines receive and links to the model of its revision', async () => {
    renderSnapshot();

    const section = await screen.findByRole('region', { name: 'What the engines receive' });
    const figures = await within(section).findByRole('list', { name: 'What the engines receive' });
    expect(within(figures).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '6tasks', '24candidates', '2rules', '2goal terms', '10^3.3combinations',
    ]);
    expect(within(section).getByText('Exactly 1,920 possible bindings.')).toBeInTheDocument();
    expect(within(section).getByText('2 engine modes can run it.')).toBeInTheDocument();
    expect(await within(section).findByRole('link', { name: 'See the full model of revision 2' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/revisions/2`);
    expect(cases.analyseSnapshot).toHaveBeenCalledWith(id);
  });

  it('hides the summary, and says why, when the analysis is not available (409)', async () => {
    cases.analyseSnapshot.mockRejectedValue(refusal(409, 'analysis_unavailable'));
    renderSnapshot();

    const section = await screen.findByRole('region', { name: 'What the engines receive' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('The compiled form doesn’t match this snapshot any more (409 · analysis unavailable), so its summary is hidden. Downloads and fingerprints are still exact.');
    expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fingerprints' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Downloads' })).toBeInTheDocument();
  });

  it('reads the figures from the compiled form when the plan will not let the gateway analyse it (402)', async () => {
    cases.analyseSnapshot.mockRejectedValue(new QuotaError('instance_complexity_too_large', 'too big'));
    renderSnapshot();

    const section = await screen.findByRole('region', { name: 'What the engines receive' });
    expect(await within(section).findByText(/bigger than your plan allows you to run/)).toBeInTheDocument();
    const figures = within(section).getByRole('list', { name: 'What the engines receive' });
    expect(within(figures).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '6tasks', '24candidates', '2rules', '2goal terms', '10^3.3combinations (up to)',
    ]);
  });

  describe('a package with ranges', () => {
    it('lists the candidates that carry a range and warns that engines taking single values only cannot run it', async () => {
      cases.analyseSnapshot.mockResolvedValue({
        valid: true, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), irDigest: digestOf('c'),
        analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '1920' },
        compatibleModes: [{ compatible: true }, { compatible: false }, { compatible: false }],
      });
      renderSnapshot();

      const ranges = await screen.findByRole('region', { name: 'Range features' });
      expect(ranges).toHaveTextContent('24 candidates have range features');
      expect(ranges).toHaveTextContent('Engines that only accept single values can’t run it (2 of 3 modes listed refuse it).');
      expect(within(ranges).getByRole('link', { name: 'See the engines' })).toHaveAttribute('href', '/engines');
      const list = within(ranges).getByRole('list', { name: 'Candidates with ranges' });
      const third = within(list).getByText('authenticate-3').closest('li') as HTMLElement;
      expect(within(third).getByText('latency ≥ 100')).toHaveAttribute('title', '[100, +∞)');
      expect(within(third).getByText('cost ≤ 0.05')).toHaveAttribute('title', '(−∞, 0.05]');
      const fourth = within(list).getByText('authenticate-4').closest('li') as HTMLElement;
      expect(within(fourth).getByText('latency unbounded')).toHaveAttribute('title', '(−∞, +∞)');
    });

    it('says nothing about ranges when the package has none', async () => {
      const plain = irDocument() as { spec: { candidates: { providers: { candidates: Record<string, { features: Record<string, unknown> }> } } } };
      for (const candidate of Object.values(plain.spec.candidates.providers.candidates)) candidate.features = { latency: 10, cost: 1 };
      platform.snapshot.mockResolvedValue(snapshotOf({ ir: { id: 'ir', digest: digestOf('c'), document: plain, sourceMap: null, compilerVersion: '1.0.0', createdAt: null } }));
      renderSnapshot();

      await screen.findByRole('list', { name: 'What the engines receive' });
      expect(screen.queryByRole('region', { name: 'Range features' })).not.toBeInTheDocument();
    });
  });

  describe('downloads', () => {
    it('hands the package archive to the browser', async () => {
      const buffer = new ArrayBuffer(16);
      platform.snapshotArchive.mockResolvedValue(buffer);
      renderSnapshot();

      const card = await screen.findByRole('button', { name: /^Package archive/ });
      expect(card).toHaveTextContent('47.1 KiB (48,213 bytes)');
      fireEvent.click(card);

      await waitFor(() => expect(download.saveBytes).toHaveBeenCalledWith(buffer, `snapshot-${id}.bim.zip`, 'application/zip'));
      expect(await within(card).findByText('Downloaded')).toBeInTheDocument();
    });

    it('hands over the source files as uploaded, and the compiled form as JSON', async () => {
      cases.instanceSource.mockResolvedValue(new ArrayBuffer(4));
      cases.instanceIr.mockResolvedValue({ kind: 'BindingProblem' });
      renderSnapshot();

      fireEvent.click(await screen.findByRole('button', { name: /^Source files/ }));
      await waitFor(() => expect(download.saveBytes).toHaveBeenCalledWith(expect.any(ArrayBuffer), `snapshot-${id}-source.bim.zip`, 'application/vnd.bim+zip'));
      fireEvent.click(screen.getByRole('button', { name: /^Compiled form\s*For tools/ }));
      await waitFor(() => expect(cases.instanceIr).toHaveBeenCalledWith(id));
      await waitFor(() => expect(download.saveBytes).toHaveBeenCalledWith(expect.anything(), `snapshot-${id}-compiled.json`, 'application/json'));
      const saved = download.saveBytes.mock.calls.find((call) => call[1] === `snapshot-${id}-compiled.json`);
      expect(JSON.parse(new TextDecoder().decode(saved?.[0] as ArrayBuffer))).toEqual({ kind: 'BindingProblem' });
    });

    it('says when a download did not finish and offers it again', async () => {
      cases.instanceSource.mockRejectedValueOnce(refusal(403, 'forbidden')).mockResolvedValue(new ArrayBuffer(4));
      renderSnapshot();

      const card = await screen.findByRole('button', { name: /^Source files/ });
      fireEvent.click(card);
      expect(await within(card).findByText('The download didn’t finish (403 · forbidden).')).toBeInTheDocument();
      expect(download.saveBytes).not.toHaveBeenCalled();
      expect(card).toBeEnabled();
      fireEvent.click(card);
      expect(await within(card).findByText('Downloaded')).toBeInTheDocument();
    });
  });

  describe('source tab', () => {
    const openSourceTab = async () => {
      await screen.findByRole('heading', { level: 1, name: 'Compiled snapshot' });
      fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    };

    // [utest->req~frontend-snapshot-source-tab~1]
    it('opens on the overview, with the source in its own tab and the archive untouched', async () => {
      renderSnapshot();
      await screen.findByRole('heading', { level: 1, name: 'Compiled snapshot' });

      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('heading', { name: 'Fingerprints' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Compiled form (JSON)' })).not.toBeInTheDocument();
      expect(screen.queryByText('View source')).not.toBeInTheDocument();
      expect(platform.snapshotArchive).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-snapshot-source-tab~1]
    it('shows the compiled form as a source view with a download, without requesting the archive', async () => {
      renderSnapshot();
      await openSourceTab();

      const view = screen.getByRole('region', { name: 'Compiled form (JSON)' });
      expect(view).toHaveTextContent('"kind": "BindingProblem"');
      expect(screen.queryByRole('heading', { name: 'Fingerprints' })).not.toBeInTheDocument();
      fireEvent.click(within(view).getByRole('button', { name: 'Download Compiled form (JSON)' }));
      expect(saveText).toHaveBeenCalledWith(expect.stringContaining('"kind": "BindingProblem"'), `snapshot-${id}-compiled.json`, 'application/json');
      expect(platform.snapshotArchive).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-snapshot-source-tab~1]
    it('browses the files of the package, loading the archive only when that view opens', async () => {
      platform.snapshotArchive.mockResolvedValue(await zipBuffer());
      renderSnapshot();
      await openSourceTab();
      expect(platform.snapshotArchive).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Files in the package' }));
      const list = await screen.findByRole('list', { name: 'Files in the package' });
      expect(platform.snapshotArchive).toHaveBeenCalledTimes(1);
      expect(within(list).getAllByRole('button').map((button) => button.querySelector('code')?.textContent).sort()).toEqual(['application.json', 'instance.json']);
      fireEvent.click(within(list).getByRole('button', { name: /instance\.json/ }));
      const view = await screen.findByRole('region', { name: 'instance.json' });
      await waitFor(() => expect(view).toHaveTextContent('{"kind":"Instance"}'));
      fireEvent.click(within(view).getByRole('button', { name: 'Download instance.json' }));
      expect(saveText).toHaveBeenCalledWith('{"kind":"Instance"}', 'instance.json', 'text/plain');
    });
  });

  describe('when the snapshot cannot be shown', () => {
    it('answers a snapshot that is not the account’s like one that does not exist (404)', async () => {
      platform.snapshot.mockRejectedValue(refusal(404, 'not_found'));
      renderSnapshot();

      expect(await screen.findByRole('heading', { name: 'Snapshot not found' })).toBeInTheDocument();
      expect(screen.getByText(/Otherwise we answer as if it didn’t exist \(404\)/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All cases' })).toHaveAttribute('href', `${root}/cases`);
      expect(screen.queryByRole('region', { name: 'Fingerprints' })).not.toBeInTheDocument();
    });

    it('says the API key lacks the permission (403)', async () => {
      platform.snapshot.mockRejectedValue(refusal(403, 'forbidden'));
      renderSnapshot();

      expect(await screen.findByText('This API key doesn’t include “read instances” (403). Use a session or a key with that permission.')).toBeInTheDocument();
    });

    it('offers a retry when the gateway fails', async () => {
      platform.snapshot.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderSnapshot();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The snapshot couldn’t be loaded (503 · unavailable).');
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Compiled snapshot' })).toBeInTheDocument();
    });

    it('shows the project gate when the project is not there for this account', async () => {
      platform.project.mockRejectedValue(refusal(404, 'not_found'));
      renderSnapshot();

      expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    });
  });

  it('keeps the page when there is no compiled form', async () => {
    platform.snapshot.mockResolvedValue(snapshotOf({ ir: null }));
    cases.analyseSnapshot.mockRejectedValue(refusal(404, 'not_found'));
    renderSnapshot();

    expect(await screen.findByText('The compiled form isn’t stored, so the language it used can’t be listed.')).toBeInTheDocument();
    expect(await screen.findByText('There is no compiled form to summarize for this snapshot.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy all fingerprints' })).toBeInTheDocument();
    expect(screen.getByText('not stored')).toBeInTheDocument();
  });
});
