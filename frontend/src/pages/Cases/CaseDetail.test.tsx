import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseDetail } from './CaseDetail';
import { irDocument, refOf, revisionDocument } from './fixtures';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn(), snapshot: vi.fn(), deleteCase: vi.fn() }));
const cases = vi.hoisted(() => ({ updateCase: vi.fn() }));

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

function renderDetail(organization = owner, slug = 'flujo-checkout') {
  return renderProjectScreen(<CaseDetail />, {
    path: '/app/:org/:project/cases/:case', url: `/app/${organization.slug}/qos-benchmarks/cases/${slug}`, organizations: [organization],
  });
}

describe('Case detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([r1, r2]);
    platform.snapshot.mockResolvedValue({ id: 'snap-2', ownerId: null, instanceDigest: 'x', packageDigest: 'y', archiveSize: 10, createdAt: null, ir: { id: 'ir', digest: 'z', document: irDocument(), sourceMap: null, compilerVersion: '1', createdAt: null } });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

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

  it('draws the revisions as a timeline, newest first, with what changed between them', async () => {
    renderDetail();

    const region = await screen.findByRole('region', { name: 'Revisions' });
    expect(within(region).getAllByRole('link', { name: /^Revision \d$/ }).map((link) => link.textContent)).toEqual(['Revision 2', 'Revision 1']);
    expect(within(region).getByText('Latest')).toBeInTheDocument();
    expect(within(region).getByText('Candidate catalog · providers: providers-eu v2 → providers-eu v3')).toBeInTheDocument();
    expect(within(region).getByText('First revision.')).toBeInTheDocument();
    const used = within(region).getByRole('list', { name: 'Library versions of revision 2' });
    expect(within(used).getByText('providers-eu v3').closest('li')).toHaveClass('is-changed');
    expect(within(used).getByText('checkout-app v3').closest('li')).not.toHaveClass('is-changed');
    expect(within(region).getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href', `${root}/cases/flujo-checkout/revisions/2`);
    expect(within(region).getByRole('link', { name: 'Compiled snapshot' })).toHaveAttribute('href', `${root}/snapshots/snap-2`);
  });

  it('copies the exact reference of a revision', async () => {
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy exact reference of revision 2' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`flujo-checkout@2 ${r2.digest}`));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows the latest revision at a glance: the workflow and four figures', async () => {
    renderDetail();

    const glance = await screen.findByRole('region', { name: 'Latest revision at a glance' });
    expect(await within(glance).findByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel, then pay-card \(70%\) or pay-transfer \(30%\), then notify$/ })).toBeInTheDocument();
    const figures = within(within(glance).getByRole('list', { name: 'Latest revision figures' })).getAllByRole('listitem');
    expect(figures.map((item) => item.textContent)).toEqual(['6tasks (5 get a provider)', '24candidates in total', '2rules (1 must, 1 should)', '2things to optimize']);
    expect(within(glance).getByRole('link', { name: 'See the full revision' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/revisions/2`);
    expect(platform.snapshot).toHaveBeenCalledWith('snap-2');
  });

  it('keeps the timeline when the model of the latest revision cannot be read, and offers a retry', async () => {
    platform.snapshot.mockRejectedValueOnce(refusal(404, 'not_found'));
    renderDetail();

    const glance = await screen.findByRole('region', { name: 'Latest revision at a glance' });
    expect(await within(glance).findByText(/couldn’t be read \(404 · not_found\)/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Revisions' })).toBeInTheDocument();
    fireEvent.click(within(glance).getByRole('button', { name: 'Retry' }));
    expect(await within(glance).findByRole('img', { name: /^Workflow: authenticate/ })).toBeInTheDocument();
  });

  it('says so when the latest revision has no compiled snapshot', async () => {
    platform.revisions.mockResolvedValue([r1]);
    renderDetail();

    expect(await screen.findByText(/Revision 1 has no compiled snapshot/)).toBeInTheDocument();
    expect(platform.snapshot).not.toHaveBeenCalled();
    expect(screen.getByText('1 revision')).toBeInTheDocument();
  });

  describe('roles', () => {
    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('gives a MEMBER a new revision in the workbench, the comparison, a run and the workbench, but not deleting', async () => {
      renderDetail(member);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      const base = '/app/member-lab/qos-benchmarks';
      expect(screen.getByRole('link', { name: 'New revision' })).toHaveAttribute('href', `${base}/workbench?case=flujo-checkout`);
      expect(screen.getByRole('link', { name: 'Compare revisions' })).toHaveAttribute('href', `${base}/cases/flujo-checkout/compare`);
      expect(screen.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', `${base}/jobs/new?case=flujo-checkout&revision=2`);
      expect(screen.getByRole('link', { name: 'Open in Workbench' })).toHaveAttribute('href', `${base}/workbench?case=flujo-checkout&revision=${r2.id}`);
      expect(screen.getByRole('button', { name: 'Edit description' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete case' })).not.toBeInTheDocument();
    });

    it('lets a VIEWER read and compare, and nothing else', async () => {
      renderDetail(viewer);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.getByRole('note')).toHaveTextContent('You can read and compare revisions. New revisions need MEMBER; deleting needs ADMIN.');
      expect(screen.queryByRole('link', { name: 'New revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit description' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete case' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Compare revisions' })).toBeInTheDocument();
    });

    it('does not offer a comparison before there are two revisions', async () => {
      platform.revisions.mockResolvedValue([r1]);
      renderDetail();

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.queryByRole('link', { name: 'Compare revisions' })).not.toBeInTheDocument();
      expect(screen.getByText('Compare revisions')).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('description', () => {
    it('is edited in place by a MEMBER and saved with the gateway', async () => {
      cases.updateCase.mockResolvedValue({ ...checkout, description: 'Catalog grown to eight candidates.' });
      renderDetail(member);

      fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
      const box = screen.getByLabelText('Description');
      expect(box).toHaveValue('Payments with parallel stock and shipping.');
      fireEvent.change(box, { target: { value: '  Catalog grown to eight candidates.  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(cases.updateCase).toHaveBeenCalledWith('member-lab', 'qos-benchmarks', 'flujo-checkout', { description: 'Catalog grown to eight candidates.' }));
      expect(await screen.findByText('Description saved.')).toBeInTheDocument();
      expect(screen.getByText('Catalog grown to eight candidates.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    });

    it('keeps the editor open and says why when the gateway refuses', async () => {
      cases.updateCase.mockRejectedValue(refusal(403, 'forbidden'));
      renderDetail(member);

      fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('You need MEMBER in the organization to edit a case (403 · forbidden). Nothing changed.');
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });

    it('can be abandoned', async () => {
      renderDetail(member);

      fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
      expect(cases.updateCase).not.toHaveBeenCalled();
    });
  });

  describe('a case without revisions', () => {
    beforeEach(() => platform.revisions.mockResolvedValue([]));

    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('points a MEMBER to the workbench instead of the timeline', async () => {
      renderDetail(member);

      const guide = await screen.findByRole('region', { name: 'No revisions yet' });
      expect(within(guide).getByRole('link', { name: 'Compose the first revision' })).toHaveAttribute('href', '/app/member-lab/qos-benchmarks/workbench?case=flujo-checkout');
      expect(screen.queryByRole('region', { name: 'Revisions' })).not.toBeInTheDocument();
    });

    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('does not offer a VIEWER a way to create the first revision', async () => {
      renderDetail(viewer);

      const guide = await screen.findByRole('region', { name: 'No revisions yet' });
      expect(within(guide).queryByRole('link')).not.toBeInTheDocument();
    });

    it('lets an ADMIN delete it, and goes back to the list', async () => {
      platform.deleteCase.mockResolvedValue(undefined);
      renderDetail(admin);

      fireEvent.click(await screen.findByRole('button', { name: 'Delete case' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), { target: { value: 'flujo-checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete case' }));

      await waitFor(() => expect(platform.deleteCase).toHaveBeenCalledWith('qos-lab', 'qos-benchmarks', 'flujo-checkout'));
      expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    });
  });

  it('does not let an ADMIN delete a case that holds sealed revisions', async () => {
    renderDetail(admin);

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
