import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, orgNode, renderModule } from '../../../../test/moduleKit';
import CreateOrganizationPage from '.';

const group = orgNode('isa-demo', { name: 'ISA Demo Group' });
const reader = orgNode('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });

describe('/orgs/new', () => {
  it('creates an organization under the parent the address names, and opens it', async () => {
    const gateway = fakeGateway({
      'POST /v1/organizations': ({ body }) => ({
        status: 201,
        body: orgNode('distributed-lab', { name: (body as { name: string }).name }),
      }),
    });
    const { organizations } = renderModule(<CreateOrganizationPage />, {
      entry: '/orgs/new?parent=isa-demo',
      path: '/orgs/new',
      tree: [group, reader],
      gateway,
      routes: { '/orgs/:org': <p>Organization page</p> },
    });
    expect(screen.getByRole('button', { name: /Parent organization/ })).toHaveTextContent(
      'ISA Demo Group'
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Distributed Lab' } });
    expect(screen.getByText('distributed-lab')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Systems.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(addressNow()).toBe('/orgs/distributed-lab'));
    expect(gateway).toHaveBeenCalledWith(
      '/v1/organizations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Distributed Lab',
          description: 'Systems.',
          parent_id: 'org-isa-demo',
        }),
      })
    );
    expect(organizations.refresh).toHaveBeenCalled();
  });

  it('offers only the organizations the account administers as parents', () => {
    renderModule(<CreateOrganizationPage />, { tree: [group, reader] });
    fireEvent.click(screen.getByRole('button', { name: /Parent organization/ }));
    expect(screen.getByRole('option', { name: /ISA Demo Group/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Read Lab/ })).not.toBeInTheDocument();
  });

  it('never offers a personal organization as the parent, and says why the gateway refuses one', async () => {
    const mine = orgNode('alex-rivera', { name: 'alex.rivera PERSONAL', is_personal: true });
    const gateway = fakeGateway({
      'POST /v1/organizations': {
        status: 409,
        body: {
          code: 'personal_organization',
          detail: { code: 'personal_organization', error: 'cannot be given sub-organizations' },
        },
      },
    });
    renderModule(<CreateOrganizationPage />, {
      entry: '/orgs/new?parent=alex-rivera',
      path: '/orgs/new',
      tree: [group, mine],
      gateway,
    });
    // Named by the address or not, it is never chosen nor listed.
    expect(screen.getByRole('button', { name: /Parent organization/ })).not.toHaveTextContent(
      'alex.rivera PERSONAL'
    );
    fireEvent.click(screen.getByRole('button', { name: /Parent organization/ }));
    expect(screen.getByRole('option', { name: /ISA Demo Group/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /alex\.rivera PERSONAL/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Under Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(
      await screen.findByText(
        'A personal organization takes no sub-organizations. Choose another parent, or none.'
      )
    ).toBeInTheDocument();
  });

  it('says a taken name is taken', async () => {
    const gateway = fakeGateway({
      'POST /v1/organizations': { status: 409, body: { code: 'slug_conflict', detail: 'taken' } },
    });
    renderModule(<CreateOrganizationPage />, { gateway });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Taken Lab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText('That name is taken. Try another one.')).toBeInTheDocument();
  });
});
