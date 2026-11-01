import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseDetail } from './CaseDetail';
import { irDocument, refOf, revisionDocument } from './fixtures';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn(), snapshot: vi.fn(), deleteCase: vi.fn(), projectJobs: vi.fn() }));
const cases = vi.hoisted(() => ({ updateCase: vi.fn(), revision: vi.fn(), resolveVersion: vi.fn(), instance: vi.fn(), analyseSnapshot: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/cases', () => ({ casesApi: cases }));

const owner = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'OWNER' });
const member = org('member-lab', { name: 'Member Lab', effective_role: 'MEMBER' });
const viewer = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const admin = org('qos-lab', { name: 'QoS Lab', effective_role: 'ADMIN' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const checkout = caseOf('flujo-checkout', 'Flujo de checkout', { description: 'Payments with parallel stock and shipping.' });
const app = refOf('checkout-app', '3', '1');
const rules = refOf('sla-hard', '1', '4');
const goal = refOf('weighted-cost-latency', '1', '5');
const r1 = revisionOf(checkout, 1, { document: revisionDocument([['application', 'checkout', app], ['candidateCatalog', 'providers', refOf('providers-eu', '2', '2')], ['constraintSet', 'sla', rules], ['optimization', 'goal', goal]]) });
const r2 = revisionOf(checkout, 2, {
  document: revisionDocument([['application', 'checkout', app], ['candidateCatalog', 'providers', refOf('providers-eu', '3', '3')], ['constraintSet', 'sla', rules], ['optimization', 'goal', goal]]),
  source_snapshot_id: 'snap-2',
});
const root = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

/** `orgSlug` other than the organization's own: the address of an organization the account is not in. */
function renderDetail(organization = owner, slug = 'flujo-checkout', address = '', orgSlug = organization.slug) {
  return renderProjectScreen(<><CaseDetail /><Where /></>, {
    path: '/app/:org/:project/cases/:case/:tab?', url: `/app/${orgSlug}/qos-benchmarks/cases/${slug}${address}`, organizations: [organization],
  });
}

const where = () => screen.getByTestId('where').textContent;
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

describe('Problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([r1, r2]);
    platform.projectJobs.mockResolvedValue([]);
    platform.snapshot.mockResolvedValue({ id: 'snap-2', ownerId: null, instanceDigest: 'x', packageDigest: 'y', archiveSize: 10, createdAt: null, ir: { id: 'ir', digest: 'z', document: irDocument(), sourceMap: null, compilerVersion: '1', createdAt: null } });
    cases.resolveVersion.mockRejectedValue(refusal(404, 'not_found'));
    cases.instance.mockRejectedValue(refusal(404, 'not_found'));
    cases.analyseSnapshot.mockRejectedValue(refusal(404, 'not_found'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('opens with the name, the address, the description and the number of revisions', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    expect(screen.getByText('flujo-checkout')).toBeInTheDocument();
    expect(screen.getByText('2 revisions')).toBeInTheDocument();
    expect(screen.getByText('Payments with parallel stock and shipping.')).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Cases' })).toHaveAttribute('href', `${root}/cases`);
    expect(platform.case).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'flujo-checkout');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('serves the tabs Overview, Runs, Versions, Source and Settings, Overview first, showing the latest version', async () => {
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(tabNames()).toEqual(['Overview', 'Runs', 'Versions', 'Source', 'Settings']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    const version = screen.getByRole('combobox', { name: 'Version' });
    expect(version).toHaveValue('2');
    expect(within(version).getAllByRole('option').map((option) => option.textContent)).toEqual(['Version 2 · latest', 'Version 1']);
    expect(await screen.findByRole('region', { name: 'Identity' })).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-problem-page~1]
  it.each([
    ['/runs', 'Runs'], ['/versions', 'Versions'], ['/source', 'Source'], ['/settings', 'Settings'],
  ])('selects the tab named by the address %s', async (address, label) => {
    renderDetail(owner, 'flujo-checkout', address);

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('moves between the tabs by address and keeps the version it shows', async () => {
    renderDetail(owner, 'flujo-checkout', '?version=1');

    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    await waitFor(() => expect(where()).toBe(`${root}/cases/flujo-checkout/source?version=1`));
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(where()).toBe(`${root}/cases/flujo-checkout?version=1`));
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('shows the version the query names, and a version chosen in the header sets the query', async () => {
    renderDetail(owner, 'flujo-checkout', '/source');

    const version = await screen.findByRole('combobox', { name: 'Version' });
    expect(version).toHaveValue('2');
    expect(await screen.findByRole('region', { name: 'Compiled form (JSON)' })).toBeInTheDocument();
    fireEvent.change(version, { target: { value: '1' } });

    await waitFor(() => expect(where()).toBe(`${root}/cases/flujo-checkout/source?version=1`));
    expect(screen.getByRole('combobox', { name: 'Version' })).toHaveValue('1');
    expect(await screen.findByRole('region', { name: 'Sealed document (JSON)' })).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('answers an unknown tab with Page not found, before reading the problem', async () => {
    renderDetail(owner, 'flujo-checkout', '/history');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Flujo de checkout' })).not.toBeInTheDocument();
    expect(platform.case).not.toHaveBeenCalled();
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('answers a missing version in neutral words, with a way to all of them', async () => {
    cases.revision.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail(owner, 'flujo-checkout', '?version=9');

    expect(await screen.findByRole('heading', { name: 'This revision doesn’t exist (404)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all revisions' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/versions`);
    expect(cases.revision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'flujo-checkout', '9');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('finds a version named by its fingerprint when the query is not a number', async () => {
    cases.revision.mockResolvedValue(r1);
    renderDetail(owner, 'flujo-checkout', `?version=${r1.digest}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Version' })).toHaveValue('1');
    expect(cases.revision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'flujo-checkout', r1.digest);
  });

  describe('a visitor of a public project', () => {
    beforeEach(() => platform.project.mockResolvedValue({ ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null }));

    // [utest->req~frontend-nav-problem-page~1]
    it('sees only Overview, Versions and Source, and nothing to run or change', async () => {
      renderDetail(owner, 'flujo-checkout', '', 'open-lab');

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(tabNames()).toEqual(['Overview', 'Versions', 'Source']);
      expect(screen.queryByRole('link', { name: 'New revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Run this revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Add to study' })).not.toBeInTheDocument();
    });

    // [utest->req~frontend-nav-problem-page~1]
    it.each(['/runs', '/settings'])('answers %s with Page not found', async (address) => {
      renderDetail(owner, 'flujo-checkout', address, 'open-lab');

      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    });
  });

  describe('Versions tab', () => {
    // [utest->req~frontend-nav-problem-page~1]
    it('draws the revisions as a timeline, newest first, with what changed between them', async () => {
      renderDetail(owner, 'flujo-checkout', '/versions');

      const region = await screen.findByRole('region', { name: 'Revisions' });
      expect(within(region).getAllByRole('link', { name: /^Revision \d$/ }).map((link) => link.textContent)).toEqual(['Revision 2', 'Revision 1']);
      expect(within(region).getByText('Latest')).toBeInTheDocument();
      expect(within(region).getByText('Candidate catalog · providers: providers-eu v2 → providers-eu v3')).toBeInTheDocument();
      expect(within(region).getByText('First revision.')).toBeInTheDocument();
      const used = within(region).getByRole('list', { name: 'Library versions of revision 2' });
      expect(within(used).getByText('providers-eu v3').closest('li')).toHaveClass('is-changed');
      expect(within(used).getByText('checkout-app v3').closest('li')).not.toHaveClass('is-changed');
      expect(within(region).getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href', `${root}/cases/flujo-checkout?version=2`);
      expect(within(region).getByRole('link', { name: 'Compiled snapshot' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/source?version=2`);
      expect(within(region).getByRole('link', { name: 'Compare with r1' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/versions?from=1&to=2`);
    });

    it('copies the exact reference of a revision', async () => {
      renderDetail(owner, 'flujo-checkout', '/versions');

      fireEvent.click(await screen.findByRole('button', { name: 'Copy exact reference of revision 2' }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`flujo-checkout@2 ${r2.digest}`));
      expect(await screen.findByText('Copied')).toBeInTheDocument();
    });

    // [utest->req~frontend-nav-problem-page~1]
    it('keeps the history and does not ask for a comparison before there are two revisions', async () => {
      platform.revisions.mockResolvedValue([r1]);
      renderDetail(owner, 'flujo-checkout', '/versions');

      expect(await screen.findByRole('region', { name: 'Revisions' })).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Comparing needs two revisions' })).toBeInTheDocument();
    });
  });

  describe('roles', () => {
    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('gives a MEMBER a new revision in the workbench, a run and the workbench, but not deleting', async () => {
      renderDetail(member);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      const base = '/app/member-lab/qos-benchmarks';
      expect(screen.getByRole('link', { name: 'New revision' })).toHaveAttribute('href', `${base}/workbench?case=flujo-checkout`);
      expect(screen.getByRole('link', { name: 'Run this revision' })).toHaveAttribute('href', `${base}/jobs/new?case=flujo-checkout&revision=2`);
      expect(screen.getByRole('link', { name: 'Open in Workbench' })).toHaveAttribute('href', `${base}/workbench?case=flujo-checkout&revision=${r2.id}`);
      expect(screen.getByRole('link', { name: 'Add to study' })).toHaveAttribute('href', `${base}/studies/new?case=flujo-checkout&revision=2`);
      expect(screen.queryByRole('button', { name: 'Delete case' })).not.toBeInTheDocument();
      for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href'), link.textContent ?? '').not.toMatch(/\/compose([?#]|$)/);
    });

    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('lets a VIEWER read and compare, and nothing else', async () => {
      renderDetail(viewer);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.queryByRole('link', { name: /Compose the first revision/ })).not.toBeInTheDocument();
      for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href'), link.textContent ?? '').not.toMatch(/\/compose([?#]|$)/);
      expect(screen.getByRole('note')).toHaveTextContent('You can read and compare revisions. New revisions need MEMBER; deleting needs ADMIN.');
      expect(screen.queryByRole('link', { name: 'New revision' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open in Workbench' })).toHaveAttribute('href', `/app/read-lab/qos-benchmarks/workbench?case=flujo-checkout&revision=${r2.id}`);
    });
  });

  describe('a case without revisions', () => {
    beforeEach(() => platform.revisions.mockResolvedValue([]));

    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('points a MEMBER to the workbench instead of the version tabs', async () => {
      renderDetail(member);

      const guide = await screen.findByRole('region', { name: 'No revisions yet' });
      expect(within(guide).getByRole('link', { name: 'Compose the first revision' })).toHaveAttribute('href', '/app/member-lab/qos-benchmarks/workbench?case=flujo-checkout');
      expect(screen.queryByRole('combobox', { name: 'Version' })).not.toBeInTheDocument();
      for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href'), link.textContent ?? '').not.toMatch(/\/compose([?#]|$)/);
    });

    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('does not offer a VIEWER a way to create the first revision', async () => {
      renderDetail(viewer);

      const guide = await screen.findByRole('region', { name: 'No revisions yet' });
      expect(within(guide).queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /New revision|Compose the first revision/ })).not.toBeInTheDocument();
      for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href'), link.textContent ?? '').not.toMatch(/\/compose([?#]|$)|\/workbench\?case=/);
    });

    it('lets an ADMIN delete it from Settings, and goes back to the list', async () => {
      platform.deleteCase.mockResolvedValue(undefined);
      renderDetail(admin, 'flujo-checkout', '/settings');

      fireEvent.click(await screen.findByRole('button', { name: 'Delete case' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), { target: { value: 'flujo-checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete case' }));

      await waitFor(() => expect(platform.deleteCase).toHaveBeenCalledWith('qos-lab', 'qos-benchmarks', 'flujo-checkout'));
      expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    });
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('does not let an ADMIN delete a case that holds sealed revisions', async () => {
    renderDetail(admin, 'flujo-checkout', '/settings');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete case' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
    expect(within(dialog).getByText(/2 sealed revisions, so it can’t be deleted/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete case' })).toBeDisabled();
  });

  describe('when the case cannot be read', () => {
    it('says there is no such case (404) and offers a way back and a retry', async () => {
      platform.case.mockRejectedValueOnce(refusal(404, 'not_found'));
      renderDetail(owner, 'ghost');

      expect(await screen.findByRole('heading', { name: 'No case with this address in QoS Benchmarks (404)' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All cases' })).toHaveAttribute('href', `${root}/cases`);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    });

    it('tells a failure of the gateway from a missing case', async () => {
      platform.case.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderDetail();

      expect(await screen.findByRole('heading', { name: /The case couldn’t be loaded \(503 · unavailable\)/ })).toBeInTheDocument();
      expect(screen.getByText(/This says nothing about your access/)).toBeInTheDocument();
    });
  });
});
