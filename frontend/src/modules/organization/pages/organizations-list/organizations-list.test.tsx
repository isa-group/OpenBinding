import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeGateway, orgNode, renderModule } from '../../../../test/moduleKit';
import { filterTree } from '../../utils/filter-tree';
import OrganizationsListPage from '.';

const lab = orgNode('qos-lab', {
  name: 'QoS Lab',
  parent_id: 'org-isa-demo',
  role_source: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
});
const group = orgNode('isa-demo', { name: 'ISA Demo Group', children: [lab] });
const partner = orgNode('partner-lab', { name: 'Partner Lab', effective_role: 'ADMIN' });
const reader = orgNode('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const tree = [group, partner, reader];

describe('/me/orgs', () => {
  it('lists the tree with roles, counts every organization and opens a branch', async () => {
    renderModule(<OrganizationsListPage />, { tree });
    expect(screen.getByRole('heading', { name: 'Your organizations' })).toBeInTheDocument();
    expect(screen.getByText('4 organizations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo'
    );
    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'QoS Lab' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand ISA Demo Group' }));
    expect(await screen.findByRole('link', { name: 'QoS Lab' })).toBeInTheDocument();
    expect(screen.getByText('Inherited from ISA Demo Group')).toBeInTheDocument();
  });

  it('keeps the ancestors of a match when searching', () => {
    renderModule(<OrganizationsListPage />, { tree });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search organizations' }), {
      target: { value: 'qos' },
    });
    expect(screen.getByRole('link', { name: 'ISA Demo Group' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'QoS Lab' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Partner Lab' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search organizations' }), {
      target: { value: 'nothing' },
    });
    expect(screen.getByText(/No organizations match/)).toBeInTheDocument();
  });

  it('moves an organization from its menu, for phones and keyboards', async () => {
    const gateway = fakeGateway({ 'PATCH /v1/organizations/partner-lab': { body: partner } });
    const { organizations } = renderModule(<OrganizationsListPage />, { tree, gateway });
    expect(screen.queryByRole('button', { name: 'Move Read Lab to…' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Partner Lab to…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Partner Lab' });
    const select = within(dialog).getByRole('combobox', { name: 'New parent' });
    // Only an organization the account administers can be the new parent, never a viewer's.
    expect(within(select).queryByRole('option', { name: /Read Lab/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'org-isa-demo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(gateway).toHaveBeenCalledWith(
        '/v1/organizations/partner-lab',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ parent_id: 'org-isa-demo' }),
        })
      )
    );
    expect(
      await screen.findByText('Partner Lab is now part of ISA Demo Group.')
    ).toBeInTheDocument();
    expect(organizations.refresh).toHaveBeenCalled();
  });

  it('says why a move was refused', async () => {
    const gateway = fakeGateway({
      'PATCH /v1/organizations/partner-lab': {
        status: 403,
        body: {
          code: 'organization_forbidden',
          detail: { code: 'organization_forbidden', error: 'no' },
        },
      },
    });
    renderModule(<OrganizationsListPage />, { tree, gateway });
    fireEvent.click(screen.getByRole('button', { name: 'Move Partner Lab to…' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'New parent' }), {
      target: { value: 'org-isa-demo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(
      await screen.findByText('Only an admin of both organizations can move it there.')
    ).toBeInTheDocument();
  });

  it('shows the personal organization apart from the teams, and never moves it', () => {
    const mine = orgNode('ana', { name: 'ana PERSONAL', is_personal: true });
    renderModule(<OrganizationsListPage />, { tree: [mine, ...tree] });
    const personal = screen.getByRole('region', { name: 'Personal' });
    expect(within(personal).getByRole('link', { name: 'ana PERSONAL' })).toHaveAttribute(
      'href',
      '/orgs/ana'
    );
    const teams = screen.getByRole('region', { name: 'Teams' });
    expect(within(teams).queryByRole('link', { name: 'ana PERSONAL' })).not.toBeInTheDocument();
    expect(within(teams).getByRole('link', { name: 'ISA Demo Group' })).toBeInTheDocument();
    expect(screen.getByText('5 organizations')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move ana PERSONAL to…' })).not.toBeInTheDocument();
    // Nor does it take a branch: the move dialog never offers it as a parent.
    fireEvent.click(screen.getByRole('button', { name: 'Move Partner Lab to…' }));
    const select = within(screen.getByRole('dialog', { name: 'Move Partner Lab' })).getByRole(
      'combobox',
      { name: 'New parent' }
    );
    expect(within(select).queryByRole('option', { name: /ana PERSONAL/ })).not.toBeInTheDocument();
  });

  it('has no Personal section without a personal organization', () => {
    renderModule(<OrganizationsListPage />, { tree });
    expect(screen.queryByRole('region', { name: 'Personal' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Teams' })).toBeInTheDocument();
  });

  it('invites a newcomer to create or join an organization', () => {
    renderModule(<OrganizationsListPage />, { tree: [] });
    expect(screen.getByText('No organizations yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create organization' })).toHaveAttribute(
      'href',
      '/orgs/new'
    );
  });

  it('offers to try again when the list could not be loaded', () => {
    renderModule(<OrganizationsListPage />, {
      tree: [],
      organizations: { error: 'The gateway is not answering.' },
    });
    expect(screen.getByText('The gateway is not answering.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('filterTree', () => {
  it('prunes a branch to the path that leads to a match', () => {
    const [kept] = filterTree(tree, 'qos');
    expect(kept.slug).toBe('isa-demo');
    expect(kept.children?.map(child => child.slug)).toEqual(['qos-lab']);
    expect(filterTree(tree, '')).toHaveLength(3);
  });
});
