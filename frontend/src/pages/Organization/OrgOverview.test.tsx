import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { addressNow, lucia, member, org, project, renderScreen, researchUsage } from './testKit';
import { OrgOverview } from './OrgOverview';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
const platform = vi.hoisted(() => ({ projects: vi.fn(), members: vi.fn(), createProject: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab (sub-organización)', parent_id: group.id });

const benchmarks = project('qos-benchmarks', { name: 'QoS Benchmarks', description: 'Reference binding cases.', visibility: 'public', updated_at: '2026-10-08T00:00:00Z' });
const checkout = project('checkout-privado', { name: 'Checkout (privado)', description: 'Internal payments case.' });

function renderOverview(organizations = [group, lab], slug = 'isa-demo', loading = false) {
  return renderScreen(<OrgOverview />, { path: '/app/:org', url: `/app/${slug}`, organizations, loading });
}

describe('Organization overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.projects.mockResolvedValue([benchmarks, checkout]);
    platform.members.mockResolvedValue([member('lucia.vega', 'OWNER', { user_id: lucia.id })]);
    api.getOwnUsage.mockResolvedValue(researchUsage());
  });

  it('introduces the organization: address, role and where it comes from, sponsor and creation date', async () => {
    renderOverview();

    const title = await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' });
    const hero = title.closest('header')!;
    expect(within(hero).getByText('/app/isa-demo')).toBeInTheDocument();
    expect(within(hero).getByText('OWNER')).toBeInTheDocument();
    expect(within(hero).getByText('Your own role', { selector: 'small' })).toBeInTheDocument();
    expect(within(hero).getByText('lucia.vega (you)')).toBeInTheDocument();
    expect(within(hero).getByText(/created Mar 3, 2026/)).toBeInTheDocument();
  });

  it('offers the actions that the role allows: an OWNER sees all of them', async () => {
    renderOverview();

    const title = await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' });
    const hero = within(title.closest('header')!);
    expect(hero.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(hero.queryByRole('link', { name: 'Library' })).toBeNull();
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/\/(library|resources)([/?#]|$)/);
    expect(hero.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
    expect(hero.getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
    expect(hero.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/isa-demo/settings');
  });

  it('gives a MEMBER the button to create but not the audit log, and a VIEWER neither', async () => {
    const { unmount } = renderOverview([{ ...group, effective_role: 'MEMBER' }]);
    expect(await screen.findByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Add' })).not.toBeInTheDocument();
    unmount();

    platform.projects.mockResolvedValue([]);
    renderOverview([{ ...group, effective_role: 'VIEWER' }]);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create the first project' })).not.toBeInTheDocument();
    expect(screen.getByText('You’re a VIEWER here, so you can’t create projects. A MEMBER or above can.')).toBeInTheDocument();
  });

  it('lists the projects as cards and narrows them with the search box', async () => {
    renderOverview();

    const card = await screen.findByRole('link', { name: /QoS Benchmarks/ });
    expect(card).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
    expect(within(card).getByText('Public')).toBeInTheDocument();
    expect(within(card).getByText('Reference binding cases.')).toBeInTheDocument();
    expect(within(card).getByText(/Updated Oct 8, 2026/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Checkout \(privado\)/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Projects/ })).toHaveTextContent('Projects2');

    const search = screen.getByRole('searchbox', { name: 'Find a project' });
    fireEvent.change(search, { target: { value: 'checkout' } });
    expect(screen.queryByRole('link', { name: /QoS Benchmarks/ })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No project matches “zzz”.')).toBeInTheDocument();
  });

  it('invites an ADMIN to create the first project when there are none', async () => {
    platform.projects.mockResolvedValue([]);
    renderOverview([{ ...group, effective_role: 'ADMIN' }]);

    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create the first project' })).toHaveAttribute('href', '/app/isa-demo?create=project');
  });

  describe('the dialog New project', () => {
    beforeEach(() => {
      platform.createProject.mockImplementation(async (_org: string, value: { slug: string; name: string }) => project(value.slug, { name: value.name }));
    });

    it('opens from the New project button with create=project in the address', async () => {
      renderOverview();
      fireEvent.click(await screen.findByRole('button', { name: 'New project' }));

      expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
      expect(addressNow()).toBe('/app/isa-demo?create=project');
    });

    it('is open when the address holds create=project', async () => {
      renderScreen(<OrgOverview />, { path: '/app/:org', url: '/app/isa-demo?create=project', organizations: [group, lab] });

      expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    });

    it('goes back to the organization on Cancel, returns the focus to New project and creates nothing', async () => {
      renderScreen(<OrgOverview />, { path: '/app/:org', url: '/app/isa-demo?create=project', organizations: [group, lab] });
      const dialog = await screen.findByRole('dialog', { name: 'New project' });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(addressNow()).toBe('/app/isa-demo');
      expect(screen.getByRole('button', { name: 'New project' })).toHaveFocus();
      expect(platform.createProject).not.toHaveBeenCalled();
    });

    it('creating demo-two closes the dialog and opens the project', async () => {
      renderScreen(<OrgOverview />, { path: '/app/:org', url: '/app/isa-demo?create=project', organizations: [group, lab] });
      const dialog = await screen.findByRole('dialog', { name: 'New project' });

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'demo-two' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

      await waitFor(() => expect(addressNow()).toBe('/app/isa-demo/demo-two'));
      expect(platform.createProject).toHaveBeenCalledWith('isa-demo', expect.objectContaining({ name: 'demo-two', slug: 'demo-two' }));
    });
  });

  it('lets the projects block fail without taking the rest of the page with it', async () => {
    platform.projects.mockRejectedValueOnce(new HttpError(500, 'boom'));
    renderOverview();

    expect(await screen.findByText('Projects couldn’t be loaded (500). Sub-organizations and usage are unaffected.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sub-organizations' })).toBeInTheDocument();
    expect(await screen.findByText('Up to 5')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: /QoS Benchmarks/ })).toBeInTheDocument();
    expect(platform.projects).toHaveBeenCalledTimes(2);
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

  it('shows what the sponsor’s plan allows, from the sponsor’s own plan, without inventing a count', async () => {
    renderOverview();

    const room = (await screen.findByRole('heading', { name: 'Sponsor’s room' })).closest('section')!;
    expect(await within(room).findByText('Up to 5')).toBeInTheDocument();
    expect(within(room).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(room).getByText('Up to 5 GiB')).toBeInTheDocument();
    expect(within(room).getByText('Counted across every organization you sponsor.')).toBeInTheDocument();
  });

  it('does not pretend to know the room of a sponsor who is someone else', async () => {
    platform.members.mockResolvedValue([member('nora', 'OWNER')]);
    renderOverview([{ ...group, billing_sponsor_user_id: 'user-nora' }]);

    expect(await screen.findByText(/nora’s plan is visible only to them/)).toBeInTheDocument();
    expect(screen.getByText('nora')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('answers the same neutral message whether the organization does not exist or the account is not in it', async () => {
    renderOverview([group], 'ghost');

    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(screen.getByText(/It doesn’t exist, or you’re not a member\. We show the same message either way/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('link', { name: 'Explore public projects' })).toHaveAttribute('href', '/explore');
    expect(platform.projects).not.toHaveBeenCalled();
  });

  it('waits for the workspace instead of answering “not available” too early', async () => {
    renderOverview([], 'isa-demo', true);

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Organization not available' })).not.toBeInTheDocument());
  });
});
