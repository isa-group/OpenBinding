import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { ProblemUpload } from '../../api/problems';
import { caseOf, org, renderOrgScreen, revisionOf } from '../../features/workspace/testKit';
import { CaseDetail } from './CaseDetail';
import { checkoutFacts, compiledDocument, digestOf } from './fixtures';

const problems = vi.hoisted(() => ({
  get: vi.fn(), revisions: vi.fn(), revision: vi.fn(), compilation: vi.fn(), ir: vi.fn(), source: vi.fn(),
  update: vi.fn(), remove: vi.fn(), createRevision: vi.fn(),
}));
const runs = vi.hoisted(() => ({ list: vi.fn() }));

const facts = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../entities/problem/facts', async (actual) => ({ ...await actual<typeof import('../../entities/problem/facts')>(), problemFactsApi: facts }));
vi.mock('../../api/runs', async () => ({ ...await vi.importActual<typeof import('../../api/runs')>('../../api/runs'), runsApi: runs }));

const owner = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'OWNER' });
const member = org('member-lab', { name: 'Member Lab', effective_role: 'MEMBER' });
const viewer = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const admin = org('qos-lab', { name: 'QoS Lab', effective_role: 'ADMIN' });

const checkout = caseOf('flujo-checkout', 'Flujo de checkout', { description: 'Payments with parallel stock and shipping.' });
const r1 = revisionOf(checkout, 1);
const r2 = revisionOf(checkout, 2);
const root = '/app/isa-demo';

const compilation = {
  id: 'compilation-2', revision_id: r2.id, compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'), binding_space: '4096',
  created_at: '2026-04-02T00:00:00Z', current: true, toolchain: {},
  analysis: { tasks: 3, candidates: 12, constraints: 2, placement: false, bindingSpace: '4096' }, resources: {}, compatible_modes: [],
};

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

/** `orgSlug` other than the organization's own: the address of an organization the account is not in. */
function renderDetail(organization = owner, slug = 'flujo-checkout', address = '') {
  return renderOrgScreen(<><CaseDetail /><Where /></>, {
    path: '/app/:org/problems/:case/:tab?', url: `/app/${organization.slug}/problems/${slug}${address}`, organizations: [organization],
  });
}

const where = () => screen.getByTestId('where').textContent;
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

describe('Problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(checkout);
    problems.revisions.mockResolvedValue([r1, r2]);
    problems.compilation.mockResolvedValue(compilation);
    problems.ir.mockResolvedValue({ id: 'compilation-2', ir_digest: digestOf('c'), ir: compiledDocument(), source_map: {} });
    facts.get.mockResolvedValue(checkoutFacts());
    problems.revision.mockImplementation(async (_org: string, _problem: string, revision: string) => ({
      ...(String(revision) === '1' ? r1 : r2), document: { apiVersion: 'bim/v1', kind: 'Instance' }, files: [], resource_digests: {}, compilations: [],
    }));
    problems.source.mockRejectedValue(refusal(503, 'unavailable'));
    runs.list.mockResolvedValue({ runs: [], total: 0 });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('opens with the name, the address, the description and the number of versions, in the organization', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    expect(screen.getByText('flujo-checkout')).toBeInTheDocument();
    expect(screen.getByText('2 versions')).toBeInTheDocument();
    expect(screen.getByText('Payments with parallel stock and shipping.')).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Problems' })).toHaveAttribute('href', `${root}/problems`);
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
    expect(problems.get).toHaveBeenCalledWith('isa-demo', 'flujo-checkout');
  });

  it('serves the tabs Overview, Runs, Versions, Source and Settings, Overview first, showing the latest version', async () => {
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(tabNames()).toEqual(['Overview', 'Runs', 'Versions', 'Source', 'Settings']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    const version = screen.getByRole('combobox', { name: 'Version' });
    expect(version).toHaveValue('2');
    expect(within(version).getAllByRole('option').map((option) => option.textContent)).toEqual(['Version 2 · latest', 'Version 1']);
    expect(await screen.findByRole('region', { name: 'Identity' })).toBeInTheDocument();
    await waitFor(() => expect(problems.compilation).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2));
  });

  it.each([
    ['/runs', 'Runs'], ['/versions', 'Versions'], ['/source', 'Source'], ['/settings', 'Settings'],
  ])('selects the tab named by the address %s', async (address, label) => {
    renderDetail(owner, 'flujo-checkout', address);

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false');
  });

  it('moves between the tabs by address and keeps the version it shows', async () => {
    renderDetail(owner, 'flujo-checkout', '?version=1');

    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    await waitFor(() => expect(where()).toBe(`${root}/problems/flujo-checkout/source?version=1`));
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(where()).toBe(`${root}/problems/flujo-checkout?version=1`));
  });

  it('answers an unknown tab with Page not found, before reading the problem', async () => {
    renderDetail(owner, 'flujo-checkout', '/history');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(problems.get).not.toHaveBeenCalled();
  });

  it('answers a missing version in neutral words, with a way to all of them', async () => {
    problems.revision.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail(owner, 'flujo-checkout', '?version=9');

    expect(await screen.findByRole('heading', { name: 'This version doesn’t exist (404)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all versions' })).toHaveAttribute('href', `${root}/problems/flujo-checkout/versions`);
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '9');
  });

  it('finds a version named by its package digest when the query is not a number', async () => {
    renderDetail(owner, 'flujo-checkout', `?version=${r1.package_digest}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', r1.package_digest);
  });

  describe('Versions tab', () => {
    it('draws the versions as a timeline, newest first', async () => {
      renderDetail(owner, 'flujo-checkout', '/versions');

      const region = await screen.findByRole('region', { name: 'Versions' });
      expect(within(region).getAllByRole('link', { name: /^Version \d$/ }).map((link) => link.textContent)).toEqual(['Version 2', 'Version 1']);
      expect(within(region).getByText('Latest')).toBeInTheDocument();
      expect(within(region).getByText(/A different package from v1\./)).toBeInTheDocument();
      expect(within(region).getByText(/First version\./)).toBeInTheDocument();
      expect(within(region).getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href', `${root}/problems/flujo-checkout?version=2`);
      expect(within(region).getAllByRole('link', { name: 'Source' })[0]).toHaveAttribute('href', `${root}/problems/flujo-checkout/source?version=2`);
      expect(within(region).getByRole('link', { name: 'Compare with v1' })).toHaveAttribute('href', `${root}/problems/flujo-checkout/versions?from=1&to=2`);
      expect(within(region).getAllByRole('link', { name: 'Run' })[0]).toHaveAttribute('href', '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2');
      expect(region.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    });

    it('sizes each version from the binding space of its current compilation', async () => {
      problems.revision.mockImplementation(async (_org: string, _problem: string, revision: string) => ({
        ...(String(revision) === '1' ? r1 : r2), document: {}, files: [], resource_digests: {},
        compilations: [
          { ...compilation, id: `old-${revision}`, binding_space: '7', current: false },
          { ...compilation, id: `now-${revision}`, binding_space: String(revision) === '1' ? '600' : '1920', current: true },
        ],
      }));
      renderDetail(owner, 'flujo-checkout', '/versions');

      const region = await screen.findByRole('region', { name: 'Versions' });
      expect(await within(region).findByText('≈ 10^3.3')).toBeInTheDocument();
      expect(await within(region).findByText('≈ 10^2.8')).toBeInTheDocument();
    });

    it('copies the exact reference of a version: problem, number and package digest', async () => {
      renderDetail(owner, 'flujo-checkout', '/versions');

      fireEvent.click(await screen.findByRole('button', { name: 'Copy exact reference of version 2' }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`flujo-checkout@2 ${r2.package_digest}`));
    });

    it('does not ask for a comparison before there are two versions', async () => {
      problems.revisions.mockResolvedValue([r1]);
      renderDetail(owner, 'flujo-checkout', '/versions');

      expect(await screen.findByRole('region', { name: 'Versions' })).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Comparing needs two versions' })).toBeInTheDocument();
    });
  });

  describe('Runs tab', () => {
    it('lists the organization’s runs of a version of this problem, from the revision they name', async () => {
      runs.list.mockResolvedValue({ total: 2, runs: [
        { id: 'job-a', engine_id: 'random-search', status: 'completed', termination: 'FEASIBLE', cancellation_requested: false, retry_of_id: null, organization_id: owner.id, created_at: '2026-08-21T10:00:00Z', finished_at: null, revision: { id: r2.id, revision: 2 } },
        { id: 'job-b', engine_id: 'random-search', status: 'completed', termination: 'FEASIBLE', cancellation_requested: false, retry_of_id: null, organization_id: owner.id, created_at: '2026-08-21T11:00:00Z', finished_at: null, revision: { id: 'other', revision: 1 } },
      ] });
      renderDetail(owner, 'flujo-checkout', '/runs');

      const table = await screen.findByRole('region', { name: 'Runs of the problem' });
      expect(within(table).getAllByRole('row')).toHaveLength(2);
      expect(within(table).getByRole('link', { name: 'Run 1' })).toHaveAttribute('href', '/app/isa-demo/runs/job-a');
      expect(runs.list).toHaveBeenCalledWith('isa-demo', { problem: 'flujo-checkout', limit: 200 });
      expect(within(table).getByRole('link', { name: 'Version 2' })).toHaveAttribute('href', `${root}/problems/flujo-checkout?version=2`);
    });
  });

  describe('roles', () => {
    it('gives a MEMBER an upload, the Workbench, a run and a study, but not deleting', async () => {
      renderDetail(member);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.getByRole('button', { name: 'Upload new version' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Edit in the Workbench' })).toHaveAttribute('href', '/app/member-lab/workbench?problem=flujo-checkout&revision=2');
      expect(screen.getByRole('link', { name: 'Run this version' })).toHaveAttribute('href', '/app/member-lab/runs/new?problem=flujo-checkout&revision=2');
      expect(screen.getByRole('link', { name: 'Add to study' })).toHaveAttribute('href', '/app/member-lab/studies/new?case=flujo-checkout&revision=2');
      expect(screen.queryByRole('button', { name: 'Delete problem' })).not.toBeInTheDocument();
    });

    it('lets a VIEWER read and compare, and nothing else', async () => {
      renderDetail(viewer);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.getByRole('note')).toHaveTextContent('You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.');
      expect(screen.queryByRole('button', { name: 'Upload new version' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Run this version' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Edit in the Workbench' })).not.toBeInTheDocument();
    });
  });

  describe('a new version', () => {
    const saved = (revision: number, created: boolean): ProblemUpload => ({
      problem: checkout, revision: revisionOf(checkout, revision), created,
      compilation: { ...compilation, id: `compilation-${revision}` },
    });
    const file = () => new File([new Uint8Array([80, 75, 3, 4])], 'next.bim.zip', { type: 'application/vnd.bim+zip' });

    it('uploads a package as the next version and shows it', async () => {
      problems.createRevision.mockResolvedValue(saved(3, true));
      problems.revisions.mockResolvedValueOnce([r1, r2]).mockResolvedValue([r1, r2, revisionOf(checkout, 3)]);
      renderDetail(member);

      fireEvent.click(await screen.findByRole('button', { name: 'Upload new version' }));
      const dialog = await screen.findByRole('dialog', { name: 'New version of Flujo de checkout' });
      fireEvent.change(within(dialog).getByLabelText('BIM package'), { target: { files: [file()] } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload version' }));

      await waitFor(() => expect(problems.createRevision).toHaveBeenCalledWith('member-lab', 'flujo-checkout', expect.any(File)));
      await waitFor(() => expect(where()).toBe('/app/member-lab/problems/flujo-checkout?version=3'));
      // The page reads the new version list again; the toast survives the redraw.
      expect(await screen.findByRole('option', { name: 'Version 3 · latest' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('Saved as version 3.')).toBeInTheDocument());
    });

    it('says when the package already is a version', async () => {
      problems.createRevision.mockResolvedValue(saved(2, false));
      renderDetail(member);

      fireEvent.click(await screen.findByRole('button', { name: 'Upload new version' }));
      const dialog = await screen.findByRole('dialog', { name: 'New version of Flujo de checkout' });
      fireEvent.change(within(dialog).getByLabelText('BIM package'), { target: { files: [file()] } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload version' }));

      expect(await screen.findByText('Unchanged: this is version 2.')).toBeInTheDocument();
    });
  });

  describe('a problem without versions', () => {
    beforeEach(() => problems.revisions.mockResolvedValue([]));

    it('offers a MEMBER the upload instead of the version tabs', async () => {
      renderDetail(member);

      const guide = await screen.findByRole('region', { name: 'No versions yet' });
      expect(within(guide).getByRole('button', { name: 'Upload a version' })).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Version' })).not.toBeInTheDocument();
    });

    it('does not offer a VIEWER a way to create the first version', async () => {
      renderDetail(viewer);

      const guide = await screen.findByRole('region', { name: 'No versions yet' });
      expect(within(guide).queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Settings', () => {
    it('lets an ADMIN delete the problem with its versions, and goes back to the list', async () => {
      problems.remove.mockResolvedValue(undefined);
      renderDetail(admin, 'flujo-checkout', '/settings');

      fireEvent.click(await screen.findByRole('button', { name: 'Delete problem' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      expect(within(dialog).getByText(/The problem and its versions disappear from QoS Lab/)).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), { target: { value: 'flujo-checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete problem' }));

      await waitFor(() => expect(problems.remove).toHaveBeenCalledWith('qos-lab', 'flujo-checkout'));
      expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    });

    it('keeps a problem that runs used (409 problem_has_runs)', async () => {
      problems.remove.mockRejectedValue(refusal(409, 'problem_has_runs'));
      renderDetail(admin, 'flujo-checkout', '/settings');

      fireEvent.click(await screen.findByRole('button', { name: 'Delete problem' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), { target: { value: 'flujo-checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Runs or studies name a version of this problem, so it can’t be deleted (409 · problem_has_runs).');
    });
  });

  describe('when the problem cannot be read', () => {
    it('says there is no such problem (404) and offers a way back and a retry', async () => {
      problems.get.mockRejectedValueOnce(refusal(404, 'not_found'));
      renderDetail(owner, 'ghost');

      expect(await screen.findByRole('heading', { name: 'No problem with this address in ISA Demo Group (404)' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All problems' })).toHaveAttribute('href', `${root}/problems`);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    });

    it('tells a failure of the gateway from a missing problem', async () => {
      problems.get.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderDetail();

      expect(await screen.findByRole('heading', { name: /The problem couldn’t be loaded \(503 · unavailable\)/ })).toBeInTheDocument();
      expect(screen.getByText(/This says nothing about your access/)).toBeInTheDocument();
    });
  });
});
