import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, renderModule } from '../../../../test/moduleKit';
import OrganizationJoinPage from '.';

const CODE = 'c0de0000c0de0000';
const preview = {
  code: CODE,
  organization: {
    id: 'org-isa-demo',
    slug: 'isa-demo',
    name: 'ISA Demo Group',
    description: 'Compositions of the ISA group.',
    avatar: {},
    public_compositions: 1,
  },
  expires_at: '2026-12-01T00:00:00Z',
  invited_by: { id: 'u-nora', username: 'nora', avatar: null },
};

const renderJoin = (gateway: ReturnType<typeof fakeGateway>, code = CODE) =>
  renderModule(<OrganizationJoinPage />, {
    entry: `/orgs/join/${code}`,
    path: '/orgs/join/:code',
    gateway,
    routes: { '/orgs/:org': <h1>Organization page</h1> },
  });

describe('/orgs/join/:code', () => {
  it('shows the organization and who invited, then joins as a member', async () => {
    const gateway = fakeGateway({
      [`GET /v1/invitations/${CODE}/preview`]: { body: preview },
      [`POST /v1/invitations/${CODE}/join`]: { body: { slug: 'isa-demo' } },
    });
    const { organizations } = renderJoin(gateway);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'ISA Demo Group' })
    ).toBeInTheDocument();
    expect(screen.getByText('@nora invited you to join this organization.')).toBeInTheDocument();
    expect(screen.getByText(/The invitation expires on Dec 1, 2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join ISA Demo Group' }));
    expect(await screen.findByRole('heading', { name: 'You joined!' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open ISA Demo Group' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo'
    );
    expect(organizations.refresh).toHaveBeenCalled();
  });

  it('gives one neutral answer for an unknown, expired or used-up code', async () => {
    renderJoin(
      fakeGateway({
        'GET /v1/invitations/nope/preview': { status: 404, body: { code: 'not_found' } },
      }),
      'nope'
    );
    expect(await screen.findByRole('heading', { name: 'Invalid invitation' })).toBeInTheDocument();
    expect(screen.getByText(/invalid, expired, or has already been used/)).toBeInTheDocument();
  });

  it('takes a member who already belongs to the organization', async () => {
    renderJoin(
      fakeGateway({
        [`GET /v1/invitations/${CODE}/preview`]: { body: preview },
        [`POST /v1/invitations/${CODE}/join`]: { status: 409, body: { code: 'already_member' } },
      })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Join ISA Demo Group' }));
    await waitFor(() => expect(addressNow()).toBe('/orgs/isa-demo'));
  });
});
