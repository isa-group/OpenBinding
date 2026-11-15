import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { config } from '../../config';
import { org } from '../../features/workspace/testKit';
import { addressNow, renderScreen, researchUsage } from '../Organization/testKit';
import { AppHome } from './AppHome';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), listNotifications: vi.fn(), markNotificationRead: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), createOrganization: vi.fn(), members: vi.fn() }));
const runsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/runs', async () => ({ ...await vi.importActual<typeof import('../../api/runs')>('../../api/runs'), runsApi }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab (sub-organización)', parent_id: group.id });
const consultora = org('consultora-demo', { name: 'Consultora Demo', effective_role: 'VIEWER' });

const job = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-0000000000f2', engine_id: 'minizinc', status: 'running', termination: null, cancellation_requested: false,
  retry_of_id: null, organization_id: group.id, created_at: '2026-10-08T08:00:00Z', finished_at: null, ...over,
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
    localStorage.clear();
    runsApi.list.mockResolvedValue({ runs: [job(), job({ id: '00000000-0000-0000-0000-0000000000f6', status: 'completed', termination: 'INFEASIBLE', finished_at: '2026-10-08T08:00:40Z' })], total: 2 });
    api.getOwnUsage.mockResolvedValue(researchUsage());
    api.listNotifications.mockResolvedValue([contractNotice]);
    api.markNotificationRead.mockResolvedValue({ ...contractNotice, read_at: '2026-10-09T00:00:00Z' });
  });

  it('greets the account and offers the shortcuts that make sense for the current workspace', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, lucia.vega' })).toBeInTheDocument();
    expect(await screen.findByText('Pick up where you left off.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New problem' })).toHaveAttribute('href', '/app/isa-demo/problems?create=problem');
    expect(screen.queryByRole('link', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Verify a digest' })).not.toBeInTheDocument();
    // Runs belong to the organization: the workspace's organization is enough to start one.
    expect(screen.getByRole('link', { name: 'Run' })).toHaveAttribute('href', '/app/isa-demo/runs/new');
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
    expect(within(root).getByText(/isa-demo · own role/)).toBeInTheDocument();
    const child = items.find((item) => item.getAttribute('href') === '/app/qos-lab')!;
    expect(within(child).getByText('OWNER')).toHaveAttribute('title', 'Inherited from ISA Demo Group');
    expect(within(child).getByText(/qos-lab · inherited role/)).toBeInTheDocument();
    // The child sits inside its parent’s list.
    expect(root.closest('li')).toContainElement(child);
    expect(screen.getByText(/the highest of your own role there and the one inherited from above/)).toBeInTheDocument();
  });

  it('lists the recent runs of the first organization, your plan with the native consoles, and the unread notifications', async () => {
    renderHome();

    const activity = await screen.findByRole('region', { name: 'Recent activity' });
    expect(await within(activity).findByText('Running')).toBeInTheDocument();
    expect(within(activity).getByText('No feasible binding')).toBeInTheDocument();
    expect(within(activity).getByText(/finished in 40 s/)).toBeInTheDocument();
    expect(within(activity).getAllByText('minizinc').length).toBeGreaterThan(0);
    expect(activity).not.toHaveTextContent('00000000');
    expect(runsApi.list).toHaveBeenCalledWith('isa-demo', { limit: 5 });
    // Each run opens its page in the organization; there is no account-wide run history.
    const rows = within(activity).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(rows).toContain('/app/isa-demo/runs/00000000-0000-0000-0000-0000000000f2');
    expect(within(activity).getByRole('link', { name: 'All runs of ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo/runs');
    expect(rows).not.toContain('/app/runs');

    const plan = screen.getByRole('region', { name: 'Your plan' });
    expect(await within(plan).findByText('RESEARCH')).toBeInTheDocument();
    expect(within(plan).getByText('Up to 4')).toBeInTheDocument();
    expect(within(plan).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(plan).getByRole('link', { name: 'Plan' })).toHaveAttribute('href', '/app/account/usage');
    expect(within(plan).getByRole('link', { name: 'SPACE' })).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(within(plan).getByRole('link', { name: 'SPHERE' })).toHaveAttribute('href', config.sphereUrl);

    const notices = screen.getByRole('region', { name: 'Unread notifications' });
    expect(await within(notices).findByText('Your OpenBinding agreement changed')).toBeInTheDocument();
    expect(within(notices).getByText('BASIC')).toBeInTheDocument();
    expect(within(notices).getByText('RESEARCH')).toBeInTheDocument();
  });

  it('says there is no remote plan instead of leaving the Plan value blank', async () => {
    api.getOwnUsage.mockResolvedValue({ ...researchUsage(), plan: '' });
    renderHome();

    const plan = screen.getByRole('region', { name: 'Your plan' });
    expect(await within(plan).findByText('No remote plan (local demo)')).toBeInTheDocument();
  });

  it('marks a notification as read and asks for the unread ones again', async () => {
    renderHome();

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith('201'));
    await waitFor(() => expect(api.listNotifications).toHaveBeenCalledTimes(2));
  });

  it('lets a block fail on its own: the others keep working and the failed one can be retried', async () => {
    runsApi.list.mockRejectedValueOnce(new HttpError(503, 'down'));
    renderHome();

    const activity = await screen.findByRole('region', { name: 'Recent activity' });
    expect(await within(activity).findByRole('alert')).toHaveTextContent('Recent runs couldn’t be loaded (503). The other blocks are unaffected.');
    // The tree and the plan are on the page regardless.
    expect(await screen.findByRole('list', { name: 'Organizations' })).toBeInTheDocument();
    expect(await screen.findByText('Up to 4')).toBeInTheDocument();

    fireEvent.click(within(activity).getByRole('button', { name: 'Retry' }));
    expect(await within(activity).findByText('Running')).toBeInTheDocument();
    expect(runsApi.list).toHaveBeenCalledTimes(2);
  });

  it('explains a pricing outage in the plan block alone, and a pending contract', async () => {
    api.getOwnUsage.mockRejectedValue(new PricingUnavailableError('pricing is down'));
    renderHome();

    const plan = await screen.findByRole('region', { name: 'Your plan' });
    expect(await within(plan).findByRole('alert')).toHaveTextContent('Your plan can’t be loaded right now (503 · pricing_unavailable). Nothing else on this page depends on it.');
    expect(within(plan).getByRole('link', { name: 'SPACE' })).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(await screen.findByRole('list', { name: 'Organizations' })).toBeInTheDocument();

    api.getOwnUsage.mockResolvedValue({ ...researchUsage(), contract_pending: true });
    fireEvent.click(within(plan).getByRole('button', { name: 'Retry' }));
    expect(await within(plan).findByText(/Your plan is still being settled \(contract pending\)/)).toBeInTheDocument();
    expect(within(plan).queryByText('Up to 4')).not.toBeInTheDocument();
  });

  it('says the block is not available when the credential lacks the permission (403)', async () => {
    platform.organizations.mockRejectedValue(Object.assign(new HttpError(403, 'forbidden'), { code: 'forbidden' }));
    const view = renderHome([]);

    expect(await screen.findByText('Not available with this key (needs organizations: read).')).toBeInTheDocument();
    // A refusal is not an empty account: the first-organization guide must not appear.
    expect(screen.queryByRole('heading', { name: 'Create your first organization' })).not.toBeInTheDocument();
    view.unmount();

    platform.organizations.mockResolvedValue([group]);
    runsApi.list.mockRejectedValue(Object.assign(new HttpError(403, 'forbidden'), { code: 'forbidden' }));
    renderHome();
    expect((await screen.findByText('jobs:read')).closest('p')).toHaveTextContent('Not available with this key (needs jobs:read).');
  });

  it('shows the recent runs of the organization last visited', async () => {
    localStorage.setItem('openbinding.lastOrganization', 'qos-lab');
    renderHome();

    await screen.findByRole('region', { name: 'Recent activity' });
    await waitFor(() => expect(runsApi.list).toHaveBeenCalledWith('qos-lab', { limit: 5 }));
  });

  it('guides an account without organizations to create the first one', async () => {
    platform.organizations.mockResolvedValue([]);
    runsApi.list.mockResolvedValue({ runs: [], total: 0 });
    renderHome([]);

    expect(await screen.findByRole('heading', { name: 'Create your first organization' })).toBeInTheDocument();
    expect(screen.getByText('Let’s set up a place for your work.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create organization' })).toHaveAttribute('href', '/app?create=organization');
    expect(screen.getByRole('link', { name: 'I have an invitation' })).toHaveAttribute('href', '/invitations/accept');
    expect(screen.getByText('You’re not in any organization yet.')).toBeInTheDocument();
    // With no jobs either, the activity block shows a way to the first run.
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check a package' })).toHaveAttribute('href', '/workbench');
    expect(screen.queryByRole('link', { name: 'New project' })).not.toBeInTheDocument();
  });

  describe('the dialog New organization', () => {
    beforeEach(() => {
      platform.createOrganization.mockResolvedValue(org('lab-two', { name: 'lab-two' }));
    });

    it('opens from the New organization button with create=organization in the address', async () => {
      renderHome();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'New organization' }));

      expect(await screen.findByRole('dialog', { name: 'New organization' })).toBeInTheDocument();
      expect(addressNow()).toBe('/app?create=organization');
    });

    it('is open when the address holds create=organization', async () => {
      renderScreen(<AppHome />, { path: '/app', url: '/app?create=organization', organizations: [group, lab] });

      expect(await screen.findByRole('dialog', { name: 'New organization' })).toBeInTheDocument();
    });

    it('goes back to /app on Cancel, returns the focus to New organization and creates nothing', async () => {
      renderScreen(<AppHome />, { path: '/app', url: '/app?create=organization', organizations: [group, lab] });
      const dialog = await screen.findByRole('dialog', { name: 'New organization' });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(addressNow()).toBe('/app');
      expect(screen.getByRole('button', { name: 'New organization' })).toHaveFocus();
      expect(platform.createOrganization).not.toHaveBeenCalled();
    });

    it('closes on Escape too', async () => {
      renderScreen(<AppHome />, { path: '/app', url: '/app?create=organization', organizations: [group, lab] });
      const dialog = await screen.findByRole('dialog', { name: 'New organization' });

      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(addressNow()).toBe('/app');
    });

    it('creating lab-two closes the dialog and opens /app/lab-two', async () => {
      renderScreen(<AppHome />, { path: '/app', url: '/app?create=organization', organizations: [group, lab] });
      const dialog = await screen.findByRole('dialog', { name: 'New organization' });

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'lab-two' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create organization' }));

      await waitFor(() => expect(addressNow()).toBe('/app/lab-two'));
      expect(platform.createOrganization).toHaveBeenCalledWith(expect.objectContaining({ name: 'lab-two', slug: 'lab-two' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('confirms an organization that was just deleted', async () => {
    renderHome([group], { deletedOrganization: 'Old Lab' });

    expect(await screen.findByText('Old Lab was deleted, together with everything inside it.')).toBeInTheDocument();
  });
});
