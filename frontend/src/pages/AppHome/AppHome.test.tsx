import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { org, renderScreen, researchUsage } from '../Organization/testKit';
import { AppHome } from './AppHome';

const api = vi.hoisted(() => ({ listOwnJobs: vi.fn(), getOwnUsage: vi.fn(), listNotifications: vi.fn(), markNotificationRead: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab (sub-organización)', parent_id: group.id });
const consultora = org('consultora-demo', { name: 'Consultora Demo', billing_sponsor_user_id: 'user-nora', effective_role: 'VIEWER' });

const job = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-0000000000f2', engine_id: 'minizinc', status: 'running', termination: null, solutions: null,
  created_at: '2026-10-08T08:00:00Z', finished_at: null, ...over,
});

const contractNotice = {
  id: '201', kind: 'contract.changed', subject: 'Your OpenBinding agreement changed', body: '', read_at: null, created_at: '2026-09-01T00:00:00Z',
  payload: { previous: { plan: 'BASIC' }, current: { plan: 'RESEARCH' } },
};

function renderHome(organizations = [group, lab], state?: unknown) {
  return renderScreen(<AppHome />, { path: '/app', url: '/app', organizations, state });
}

describe('Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.organizations.mockResolvedValue([group, lab, consultora]);
    api.listOwnJobs.mockResolvedValue({ jobs: [job(), job({ id: '00000000-0000-0000-0000-0000000000f6', status: 'completed', termination: 'INFEASIBLE', finished_at: '2026-10-08T08:00:40Z' })], total: 2, retention_days: 180 });
    api.getOwnUsage.mockResolvedValue(researchUsage());
    api.listNotifications.mockResolvedValue([contractNotice]);
    api.markNotificationRead.mockResolvedValue({ ...contractNotice, read_at: '2026-10-09T00:00:00Z' });
  });

  it('greets the account and offers the shortcuts that make sense for the current workspace', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, lucia.vega' })).toBeInTheDocument();
    expect(await screen.findByText('Pick up where you left off.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/app/isa-demo/new-project');
    expect(screen.getByRole('link', { name: 'Verify a digest' })).toHaveAttribute('href', '/app/verifier');
    // No project is selected in the workspace, so there is nothing to run or to add a case to.
    expect(screen.queryByRole('link', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('shows the organization tree with the role of each, own or inherited', async () => {
    renderHome();

    const tree = await screen.findByRole('list', { name: 'Organizations' });
    const items = within(tree).getAllByRole('link');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('href', '/app/consultora-demo');
    expect(within(items[0]).getByText('VIEWER')).toBeInTheDocument();
    expect(within(items[0]).getByText(/consultora-demo · own role/)).toBeInTheDocument();

    const root = items.find((item) => item.getAttribute('href') === '/app/isa-demo')!;
    expect(within(root).getByText(/isa-demo · you sponsor it · own role/)).toBeInTheDocument();
    const child = items.find((item) => item.getAttribute('href') === '/app/qos-lab')!;
    expect(within(child).getByText('OWNER')).toHaveAttribute('title', 'Inherited from ISA Demo Group');
    expect(within(child).getByText(/qos-lab · you sponsor it · inherited role/)).toBeInTheDocument();
    // The child sits inside its parent’s list.
    expect(root.closest('li')).toContainElement(child);
    expect(screen.getByText(/the highest of your own role there and the one inherited from above/)).toBeInTheDocument();
  });

  it('lists recent jobs, this month’s limits and the unread notifications', async () => {
    renderHome();

    const activity = await screen.findByRole('region', { name: 'Recent activity' });
    expect(await within(activity).findByText('Running')).toBeInTheDocument();
    expect(within(activity).getByText('No feasible binding')).toBeInTheDocument();
    expect(within(activity).getByText(/finished in 40 s/)).toBeInTheDocument();
    expect(within(activity).getAllByRole('link', { name: /minizinc/ })[0]).toHaveAttribute('href', '/app/jobs');
    expect(within(activity).getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', '/app/jobs');

    const month = screen.getByRole('region', { name: 'This month' });
    expect(await within(month).findByRole('meter', { name: 'Study runs' })).toHaveAttribute('aria-valuenow', '18');
    expect(within(month).getByRole('meter', { name: 'Jobs running now' })).toHaveAttribute('aria-valuemax', '3');
    expect(within(month).getByText(/Monthly limits renew Nov 1, 2026/)).toBeInTheDocument();

    const notices = screen.getByRole('region', { name: 'Unread notifications' });
    expect(await within(notices).findByText('Your OpenBinding agreement changed')).toBeInTheDocument();
    expect(within(notices).getByText('BASIC')).toBeInTheDocument();
    expect(within(notices).getByText('RESEARCH')).toBeInTheDocument();
  });

  it('marks a notification as read and asks for the unread ones again', async () => {
    renderHome();

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith('201'));
    await waitFor(() => expect(api.listNotifications).toHaveBeenCalledTimes(2));
  });

  it('lets a block fail on its own: the others keep working and the failed one can be retried', async () => {
    api.listOwnJobs.mockRejectedValueOnce(new HttpError(503, 'down'));
    renderHome();

    const activity = await screen.findByRole('region', { name: 'Recent activity' });
    expect(await within(activity).findByRole('alert')).toHaveTextContent('Recent jobs couldn’t be loaded (503). The other blocks are unaffected.');
    // The tree and the limits are on the page regardless.
    expect(await screen.findByRole('list', { name: 'Organizations' })).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: 'Study runs' })).toBeInTheDocument();

    fireEvent.click(within(activity).getByRole('button', { name: 'Retry' }));
    expect(await within(activity).findByText('Running')).toBeInTheDocument();
    expect(api.listOwnJobs).toHaveBeenCalledTimes(2);
  });

  it('explains a pricing outage in the limits block alone, and a pending contract', async () => {
    api.getOwnUsage.mockRejectedValue(new PricingUnavailableError('pricing is down'));
    renderHome();

    const month = await screen.findByRole('region', { name: 'This month' });
    expect(await within(month).findByRole('alert')).toHaveTextContent('Your plan limits can’t be loaded right now (503 · pricing_unavailable). Nothing else on this page depends on them.');
    expect(await screen.findByRole('list', { name: 'Organizations' })).toBeInTheDocument();

    api.getOwnUsage.mockResolvedValue({ ...researchUsage(), contract_pending: true });
    fireEvent.click(within(month).getByRole('button', { name: 'Retry' }));
    expect(await within(month).findByText(/Your plan is still being settled \(contract pending\)/)).toBeInTheDocument();
    expect(within(month).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('says the block is not available when the credential lacks the permission (403)', async () => {
    platform.organizations.mockRejectedValue(Object.assign(new HttpError(403, 'forbidden'), { code: 'forbidden' }));
    api.listOwnJobs.mockRejectedValue(Object.assign(new HttpError(403, 'forbidden'), { code: 'forbidden' }));
    renderHome([]);

    expect(await screen.findByText('Not available with this key (needs organizations: read).')).toBeInTheDocument();
    expect(await screen.findByText('Not available with this key (needs jobs: read).')).toBeInTheDocument();
    // A refusal is not an empty account: the first-organization guide must not appear.
    expect(screen.queryByRole('heading', { name: 'Create your first organization' })).not.toBeInTheDocument();
  });

  it('guides an account without organizations to create the first one', async () => {
    platform.organizations.mockResolvedValue([]);
    api.listOwnJobs.mockResolvedValue({ jobs: [], total: 0, retention_days: 180 });
    renderHome([]);

    expect(await screen.findByRole('heading', { name: 'Create your first organization' })).toBeInTheDocument();
    expect(screen.getByText('Let’s set up a place for your work.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create organization' })).toHaveAttribute('href', '/app/organizations/new');
    expect(screen.getByRole('link', { name: 'I have an invitation' })).toHaveAttribute('href', '/invitations/accept');
    expect(await screen.findByText(/organization limit \(5 on RESEARCH\)/)).toBeInTheDocument();
    expect(screen.getByText('You’re not in any organization yet.')).toBeInTheDocument();
    // With no jobs either, the activity block shows a way to the first run.
    expect(await screen.findByText(/No jobs yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Workbench' })).toHaveAttribute('href', '/workbench');
    expect(screen.queryByRole('link', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('confirms an organization that was just deleted', async () => {
    renderHome([group], { deletedOrganization: 'Old Lab' });

    expect(await screen.findByText('Old Lab was deleted, together with everything inside it.')).toBeInTheDocument();
  });
});
