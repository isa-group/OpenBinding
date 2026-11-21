import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, ME, orgNode, renderModule } from '../../../../test/moduleKit';
import OrganizationDetailPage from '.';

const group = orgNode('isa-demo', {
  name: 'ISA Demo Group',
  description: 'Compositions of the ISA group.',
  stats: { members: 3, sub_organizations: 1, compositions: 2, problems: 4, runs: 5, studies: 1 },
});
const member = (userId: string, username: string, role: string) => ({
  id: `m-${username}`,
  organization_id: group.id,
  user_id: userId,
  username,
  email: `${username}@example.org`,
  role,
  created_at: '2026-03-04T00:00:00Z',
});
const members = [
  member(ME.id, ME.username, 'OWNER'),
  {
    ...member('u-marco', 'marco', 'MEMBER'),
    display_name: 'Marco Díaz',
    avatar: {
      kind: 'icon',
      assetId: 'leaf',
      backgroundColor: '#212529',
      foregroundColor: '#ffffff',
    },
  },
  member('u-sofia', 'sofia', 'VIEWER'),
];
const memberRoutes = (over: Parameters<typeof fakeGateway>[0] = {}) =>
  fakeGateway({
    'GET /v1/organizations/isa-demo': { body: group },
    'GET /v1/organizations/isa-demo/members': { body: members },
    'GET /v1/organizations/isa-demo/invitations': { body: [] },
    'GET /v1/organizations/isa-demo/hierarchy': {
      body: [
        {
          id: group.id,
          slug: 'isa-demo',
          name: 'ISA Demo Group',
          avatar: {},
          parent_id: null,
          has_access: true,
        },
      ],
    },
    'GET /v1/organizations/isa-demo/compositions': {
      body: { compositions: [], total: 0, limit: 6, offset: 0 },
    },
    ...over,
  });

const renderPage = (entry: string, options: Parameters<typeof renderModule>[1] = {}) =>
  renderModule(<OrganizationDetailPage />, { entry, path: '/orgs/:org/:tab?', ...options });

describe('/orgs/:org', () => {
  it('shows a member the hero with the role, the counts and the tabs as links', async () => {
    renderPage('/orgs/isa-demo', { tree: [group], gateway: memberRoutes() });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' })
    ).toBeInTheDocument();
    expect(screen.getByText('@isa-demo')).toBeInTheDocument();
    expect(screen.getByText('Compositions of the ISA group.')).toBeInTheDocument();
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0);
    const nav = screen.getByRole('navigation', { name: 'Organization sections' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(nav).getByRole('link', { name: 'Members' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo/members'
    );
    expect(within(nav).getByRole('link', { name: 'Audit' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo/audit'
    );
    expect(within(nav).getByRole('link', { name: 'Invitations' })).toBeInTheDocument();
  });

  it('names members by their display name, with their Identity avatar', async () => {
    renderPage('/orgs/isa-demo/members', { tree: [group], gateway: memberRoutes() });
    const marco = (await screen.findByText('Marco Díaz')).closest('li') as HTMLElement;
    expect(within(marco).getByText('@marco')).toBeInTheDocument();
    expect(marco.querySelector('[data-avatar-kind="icon"]')).not.toBeNull();
    const sofia = screen.getByText('@sofia').closest('li') as HTMLElement;
    expect(sofia.querySelector('[data-avatar-kind]')).toBeNull();
  });

  it('saves drafted role changes and removals together, through the batch', async () => {
    const gateway = memberRoutes({
      'POST /v1/organizations/isa-demo/members/batch': ({ body }) => ({
        body: members,
        status: 200,
        headers: {},
        ...{ sent: body },
      }),
    });
    renderPage('/orgs/isa-demo/members', { tree: [group], gateway });
    const role = await screen.findByRole('combobox', { name: 'Role for marco' });
    fireEvent.change(role, { target: { value: 'ADMIN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove sofia' }));
    expect(screen.getByText('2 member changes ready to save')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(gateway).toHaveBeenCalledWith(
        '/v1/organizations/isa-demo/members/batch',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            changes: [
              { user_id: 'u-marco', role: 'ADMIN' },
              { user_id: 'u-sofia', role: null },
            ],
          }),
        })
      )
    );
    expect(await screen.findByText('2 member changes applied together.')).toBeInTheDocument();
  });

  it('hands the organization over with the crown, after asking', async () => {
    const gateway = memberRoutes({ 'PUT /v1/organizations/isa-demo/owner': { body: members } });
    renderPage('/orgs/isa-demo/members', { tree: [group], gateway });
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer ownership to marco' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() =>
      expect(gateway).toHaveBeenCalledWith(
        '/v1/organizations/isa-demo/owner',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ user_id: 'u-marco' }) })
      )
    );
  });

  it('answers the in-place 404 for a tab the role does not open', async () => {
    const viewer = { ...group, effective_role: 'VIEWER' as const };
    renderPage('/orgs/isa-demo/audit', { tree: [viewer], gateway: memberRoutes() });
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });

  it('shows a visitor the public profile, and the 404 for anything else', async () => {
    const gateway = fakeGateway({
      'GET /v1/organizations/isa-demo/profile': {
        body: {
          id: group.id,
          slug: 'isa-demo',
          name: 'ISA Demo Group',
          description: '',
          avatar: {},
          public_compositions: 2,
        },
      },
    });
    const { unmount } = renderPage('/orgs/isa-demo', { user: null, gateway });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' })
    ).toBeInTheDocument();
    expect(screen.getAllByText('Public compositions').length).toBeGreaterThan(0);
    const nav = screen.getByRole('navigation', { name: 'Organization sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map(link => link.textContent)
    ).toEqual(['Overview', 'Compositions']);
    unmount();
    renderPage('/orgs/isa-demo/members', { user: null, gateway });
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });

  it('answers the same 404 for an organization that does not publish', async () => {
    renderPage('/orgs/hidden-lab', {
      user: null,
      gateway: fakeGateway({
        'GET /v1/organizations/hidden-lab/profile': { status: 404, body: { code: 'not_found' } },
      }),
    });
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });

  it('deletes an organization its sole owner types the slug of, saying what goes with it', async () => {
    const lone = { ...group, stats: { ...group.stats!, members: 1 } };
    const gateway = memberRoutes({
      'GET /v1/organizations/isa-demo': { body: lone },
      'GET /v1/organizations/isa-demo/members': { body: [members[0]] },
      'DELETE /v1/organizations/isa-demo': { status: 204 },
    });
    const { organizations } = renderPage('/orgs/isa-demo', {
      tree: [lone],
      gateway,
      routes: { '/me/orgs': <p>Your organizations</p> },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete ISA Demo Group' });
    expect(dialog).toHaveTextContent('1 sub-organization, 2 compositions, 4 problems, 1 study');
    const confirm = within(dialog).getByRole('button', { name: 'Delete organization' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type isa-demo to confirm/), {
      target: { value: 'isa-demo' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(addressNow()).toBe('/me/orgs'));
    expect(organizations.refresh).toHaveBeenCalled();
  });
});
