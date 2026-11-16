import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { lucia, org } from '../../features/workspace/testKit';
import { member, renderScreen, researchUsage } from './testKit';
import { OrgOverview } from './OrgOverview';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
const platform = vi.hoisted(() => ({ members: vi.fn(), studies: vi.fn() }));
const problems = vi.hoisted(() => ({ list: vi.fn() }));
const runsApi = vi.hoisted(() => ({ list: vi.fn() }));
const compositionsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../api/runs', async () => ({ ...await vi.importActual<typeof import('../../api/runs')>('../../api/runs'), runsApi }));
vi.mock('../../entities/composition/api', async () => ({
  ...await vi.importActual<typeof import('../../entities/composition/api')>('../../entities/composition/api'), compositionsApi,
}));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab (sub-organización)', parent_id: group.id });

function renderOverview(organizations = [group, lab], slug = 'isa-demo', loading = false) {
  return renderScreen(<OrgOverview />, { path: '/app/:org', url: `/app/${slug}`, organizations, loading });
}

describe('Organization overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.members.mockResolvedValue([member('lucia.vega', 'OWNER', { user_id: lucia.id })]);
    api.getOwnUsage.mockResolvedValue(researchUsage());
    problems.list.mockResolvedValue({ problems: [], total: 0, limit: 5, offset: 0 });
    compositionsApi.list.mockResolvedValue({ compositions: [], total: 0, limit: 5, offset: 0 });
    runsApi.list.mockResolvedValue({ runs: [], total: 0 });
    platform.studies.mockResolvedValue([]);
  });

  it('introduces the organization: address, role and where it comes from, and creation date', async () => {
    renderOverview();

    const title = await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' });
    const hero = title.closest('header')!;
    expect(within(hero).getByText('/app/isa-demo')).toBeInTheDocument();
    expect(within(hero).getByText('OWNER')).toBeInTheDocument();
    expect(within(hero).getByText('Your own role', { selector: 'small' })).toBeInTheDocument();
    expect(within(hero).getByText(/Created Mar 3, 2026/)).toBeInTheDocument();
    expect(within(hero).queryByText(/sponsor/i)).not.toBeInTheDocument();
  });

  it('offers the actions that the role allows: an OWNER sees all of them', async () => {
    renderOverview();

    const title = await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' });
    const hero = within(title.closest('header')!);
    expect(hero.getByRole('link', { name: 'Upload BIM package' })).toHaveAttribute('href', '/app/isa-demo/problems?create=problem');
    expect(hero.queryByRole('link', { name: 'Library' })).toBeNull();
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/\/(library|resources)([/?#]|$)/);
    expect(hero.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
    expect(hero.getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
    expect(hero.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/isa-demo/settings');
  });

  it('gives a MEMBER the upload but not the audit log, and a VIEWER neither', async () => {
    const { unmount } = renderOverview([{ ...group, effective_role: 'MEMBER' }]);
    expect(await screen.findByRole('link', { name: 'Upload BIM package' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Add' })).not.toBeInTheDocument();
    unmount();

    renderOverview([{ ...group, effective_role: 'VIEWER' }]);
    expect(await screen.findByText(/You’re a VIEWER here: you read everything/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upload BIM package' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Upload' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ New run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ New composition' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All compositions' })).toHaveAttribute('href', '/app/isa-demo/compositions');
  });

  it('has no projects: no grid, no search and no New project', async () => {
    renderOverview();

    await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' });
    expect(screen.queryByRole('heading', { name: /^Projects/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Find a project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/create=project/);
  });

  it('lets one panel fail without taking the rest of the page with it', async () => {
    problems.list.mockRejectedValueOnce(new HttpError(500, 'boom'));
    renderOverview();

    expect(await screen.findByText('Problems couldn’t be loaded (500).')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sub-organizations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Runs/ })).toBeInTheDocument();
  });

  it('shows the sub-organizations with their role and where it comes from, and the way up', async () => {
    renderOverview();

    const subs = (await screen.findByRole('heading', { name: 'Sub-organizations' })).closest('section')!;
    const child = within(subs).getByRole('link', { name: /QoS Lab/ });
    expect(child).toHaveAttribute('href', '/app/qos-lab');
    expect(within(child).getByText('Inherited from ISA Demo Group')).toBeInTheDocument();
    expect(within(subs).getByRole('link', { name: '+ Add' })).toHaveAttribute('href', '/app?create=organization');

    // From the child, the breadcrumb leads back to the parent.
    renderOverview([group, lab], 'qos-lab');
    const crumbs = (await screen.findAllByRole('navigation', { name: 'Breadcrumb' }))[1];
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
    expect(within(crumbs).getByText(/QoS Lab/)).toHaveAttribute('aria-current', 'page');
  });

  it('switches to another organization from the selector', async () => {
    renderOverview();

    fireEvent.change(await screen.findByLabelText('Switch organization'), { target: { value: 'qos-lab' } });

    expect(await screen.findByRole('heading', { level: 1, name: /QoS Lab/ })).toBeInTheDocument();
  });

  it('answers the same neutral message whether the organization does not exist or the account is not in it', async () => {
    renderOverview([group], 'ghost');

    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(screen.getByText(/It doesn’t exist, or you’re not a member\. We show the same message either way/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');
    expect(screen.queryByRole('link', { name: /Explore/ })).not.toBeInTheDocument();
    expect(problems.list).not.toHaveBeenCalled();
  });

  it('waits for the workspace instead of answering “not available” too early', async () => {
    renderOverview([], 'isa-demo', true);

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Organization not available' })).not.toBeInTheDocument());
  });

  it('leads with the organization’s compositions: how many, the latest five, and the way to all of them', async () => {
    compositionsApi.list.mockResolvedValue({
      compositions: [{
        id: 'c1', slug: 'fleet-routing', name: 'Fleet routing', description: '', kind: 'workflow', archived: false, visibility: 'public',
        organization: { id: group.id, slug: 'isa-demo', name: 'ISA Demo Group' }, created_by_id: lucia.id, created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z', version_count: 3,
        latest_version: { id: 'v3', label: '1.2.0', ordinal: 3, values_status: 'declared', created_at: '2026-10-02T00:00:00Z' },
      }],
      total: 9, limit: 5, offset: 0,
    });
    renderOverview();

    const panel = (await screen.findByRole('heading', { name: /^Compositions/ })).closest('section')!;
    expect(compositionsApi.list).toHaveBeenCalledWith('isa-demo', { archived: false, sort: 'updated', limit: 5 });
    const row = await within(panel).findByRole('link', { name: /Fleet routing/ });
    expect(row).toHaveAttribute('href', '/app/isa-demo/compositions/fleet-routing');
    expect(row).toHaveTextContent('Workflow · version 1.2.0 · Oct 2, 2026');
    expect(within(panel).getByText('9')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'All compositions' })).toHaveAttribute('href', '/app/isa-demo/compositions');
    expect(within(panel).getByRole('link', { name: '+ New composition' })).toHaveAttribute('href', '/app/isa-demo/compositions?create=composition');
    // The compositions come before the problems.
    const problemsPanel = screen.getByRole('heading', { name: /^Problems/ }).closest('section')!;
    expect(panel.compareDocumentPosition(problemsPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says how to start when the organization has no composition, and lets the section fail alone', async () => {
    const view = renderOverview();
    const panel = (await screen.findByRole('heading', { name: /^Compositions/ })).closest('section')!;
    expect(await within(panel).findByText(/^None yet\. A composition is the binding the organization keeps/)).toBeInTheDocument();
    view.unmount();

    compositionsApi.list.mockRejectedValueOnce(new HttpError(500, 'boom'));
    renderOverview();
    expect(await screen.findByText('Compositions couldn’t be loaded (500).')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Problems/ })).toBeInTheDocument();
  });

  it('lists the organization’s newest problems and leads to all of them', async () => {
    problems.list.mockResolvedValue({
      problems: [{
        id: 'p1', organization_id: group.id, slug: 'checkout-flow', name: 'Checkout flow', description: '', created_by_id: lucia.id,
        created_at: '2026-04-02T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
        latest_revision: { id: 'r2', revision: 2, package_digest: `sha256-${'2'.repeat(64)}`, created_at: '2026-08-20T10:05:00Z' },
      }],
      total: 7, limit: 5, offset: 0,
    });
    renderOverview();

    const panel = (await screen.findByRole('heading', { name: /^Problems/ })).closest('section')!;
    expect(problems.list).toHaveBeenCalledWith('isa-demo', { limit: 5 });
    expect(await within(panel).findByRole('link', { name: /Checkout flow/ })).toHaveAttribute('href', '/app/isa-demo/problems/checkout-flow');
    expect(within(panel).getByText('7')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'All problems' })).toHaveAttribute('href', '/app/isa-demo/problems');
  });

  it('lists the organization’s newest runs, whoever launched them, and leads to all of them', async () => {
    runsApi.list.mockResolvedValue({
      runs: [{
        id: 'run-1', engine_id: 'random-search', status: 'completed', termination: 'FEASIBLE', cancellation_requested: false, retry_of_id: null,
        organization_id: group.id, created_at: '2026-10-01T09:00:00Z', finished_at: '2026-10-01T09:01:00Z',
        problem: { id: 'p1', slug: 'checkout-flow', name: 'Checkout flow' }, created_by: { id: 'user-ana', username: 'ana' },
      }],
      total: 12,
    });
    renderOverview();

    const panel = (await screen.findByRole('heading', { name: /^Runs/ })).closest('section')!;
    expect(runsApi.list).toHaveBeenCalledWith('isa-demo', { limit: 5 });
    expect(await within(panel).findByRole('link', { name: /Checkout flow/ })).toHaveAttribute('href', '/app/isa-demo/runs/run-1');
    expect(within(panel).getByText('12')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '/app/isa-demo/runs');
    expect(within(panel).getByRole('link', { name: '+ New run' })).toHaveAttribute('href', '/app/isa-demo/runs/new');
  });

  it('lists the organization’s studies and leads to all of them', async () => {
    platform.studies.mockResolvedValue([{
      id: 'study-1', organization_id: group.id, slug: 'engines-vs-seeds', name: 'Engines × seeds', description: '', archived: false,
      definition: { revision_ids: ['r1', 'r2'], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] }, definition_digest: 'd',
      state: 'ready', created_by_id: lucia.id, created_at: '2026-10-01T09:00:00Z',
    }]);
    renderOverview();

    const panel = (await screen.findByRole('heading', { name: /^Studies/ })).closest('section')!;
    expect(platform.studies).toHaveBeenCalledWith('isa-demo');
    expect(await within(panel).findByRole('link', { name: /Engines × seeds/ })).toHaveAttribute('href', '/app/isa-demo/studies/engines-vs-seeds');
    expect(within(panel).getByText(/2 problem versions · 2 engines/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'All studies' })).toHaveAttribute('href', '/app/isa-demo/studies');
    expect(within(panel).getByRole('link', { name: '+ New study' })).toHaveAttribute('href', '/app/isa-demo/studies/new');
  });
});
