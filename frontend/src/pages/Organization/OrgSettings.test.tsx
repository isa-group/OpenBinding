import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { iker, lucia, member, org, project, renderScreen } from './testKit';
import { OrgSettings } from './OrgSettings';

const api = vi.hoisted(() => ({ adminListUsers: vi.fn() }));
const platform = vi.hoisted(() => ({ updateOrganization: vi.fn(), deleteOrganization: vi.fn(), members: vi.fn(), projects: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab', parent_id: group.id });
const consultora = org('consultora-demo', { name: 'Consultora Demo', effective_role: 'ADMIN' });
const readOnly = org('read-only', { name: 'Read Only Lab', effective_role: 'MEMBER' });

function renderSettings(organizations = [group, lab, consultora, readOnly], slug = 'isa-demo') {
  return renderScreen(<OrgSettings />, { path: '/app/:org/settings', url: `/app/${slug}/settings`, organizations });
}

const refusal = (status: number, code: string, problem?: unknown) => Object.assign(new HttpError(status, 'refused'), { code, problem });

describe('Organization settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.members.mockResolvedValue([member('lucia.vega', 'OWNER', { user_id: lucia.id }), member('marco', 'MEMBER')]);
    platform.projects.mockResolvedValue([project('qos-benchmarks'), project('checkout')]);
    platform.updateOrganization.mockResolvedValue(group);
    platform.deleteOrganization.mockResolvedValue(undefined);
    api.adminListUsers.mockResolvedValue({ users: [] });
  });

  it('frames the page with the title, the role and the side navigation of the settings', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText(/ISA Demo Group · your role/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Organization settings' });
    expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Members & invitations' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
    expect(screen.getByText('/app/isa-demo')).toBeInTheDocument();
    expect(screen.getByText('Current sponsor · RESEARCH plan')).toBeInTheDocument();
  });

  it('renames the organization and points to the audit entry', async () => {
    const { reload } = renderSettings();
    const name = await screen.findByLabelText('Name');
    const save = screen.getByRole('button', { name: 'Save name' });
    expect(save).toBeDisabled();

    fireEvent.change(name, { target: { value: 'ISA Research Group' } });
    fireEvent.click(save);

    await waitFor(() => expect(platform.updateOrganization).toHaveBeenCalledWith('isa-demo', { name: 'ISA Research Group' }));
    expect(await screen.findByText('Name saved as “ISA Research Group”. An audit entry was recorded.')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'See it in the audit log' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
  });

  it('says a rename could not be saved when pricing is down (503)', async () => {
    platform.updateOrganization.mockRejectedValue(new PricingUnavailableError('down'));
    renderSettings();

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Another' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByText('The name couldn’t be saved right now (503 · pricing_unavailable). Try again in a moment.')).toBeInTheDocument();
  });

  describe('where it sits', () => {
    it('blocks a loop and a parent where the account is not ADMIN, and previews the tree after the move', async () => {
      renderSettings();
      const places = within(await screen.findByRole('group', { name: 'New parent' }));

      expect(places.getByRole('radio', { name: /Top level · current/ })).toBeChecked();
      expect(places.getByRole('radio', { name: /QoS Lab/ })).toBeDisabled();
      expect(places.getByText('It sits inside this organization: moving here would make a loop')).toBeInTheDocument();
      expect(places.getByRole('radio', { name: /Read Only Lab/ })).toBeDisabled();
      expect(places.getByText('Needs ADMIN there; you’re MEMBER')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move organization' })).toBeDisabled();

      fireEvent.click(places.getByRole('radio', { name: /Consultora Demo/ }));
      const tree = screen.getByRole('list', { name: 'Organization tree after the move' });
      expect(within(tree).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Consultora Demo', 'ISA Demo Group', 'QoS Lab']);
      expect(screen.getByText('Members of Consultora Demo will inherit their roles here.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move organization' })).toBeEnabled();
    });

    it('moves under a parent', async () => {
      const { reload } = renderSettings();
      fireEvent.click(await screen.findByRole('radio', { name: /Consultora Demo/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));

      await waitFor(() => expect(platform.updateOrganization).toHaveBeenCalledWith('isa-demo', { parent_id: consultora.id }));
      expect(await screen.findByText('Moved ISA Demo Group inside Consultora Demo.')).toBeInTheDocument();
      expect(reload).toHaveBeenCalledOnce();
    });

    it('moves to the top level', async () => {
      renderSettings([group, lab], 'qos-lab');
      fireEvent.click(await screen.findByRole('radio', { name: /^Top level/ }));
      expect(screen.getByText('Only direct members will have roles here.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));

      await waitFor(() => expect(platform.updateOrganization).toHaveBeenCalledWith('qos-lab', { move_to_root: true }));
      expect(await screen.findByText('Moved QoS Lab to the top level.')).toBeInTheDocument();
    });

    it.each([
      ['409 cycle', refusal(409, 'organization_cycle'), 'That move would put the organization inside itself (409 · organization_cycle). Choose another parent.'],
      ['422 ambiguous parent', refusal(422, 'ambiguous_parent'), 'Choose either a new parent or the top level, not both (422 · ambiguous_parent).'],
      ['503 pricing', new PricingUnavailableError('down'), 'Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed.'],
    ])('explains a refusal: %s', async (_name, error, text) => {
      platform.updateOrganization.mockRejectedValue(error);
      renderSettings();
      fireEvent.click(await screen.findByRole('radio', { name: /Consultora Demo/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(text);
    });
  });

  describe('who sponsors it', () => {
    const sponsoredByNora = org('isa-demo', { name: 'ISA Demo Group', billing_sponsor_user_id: 'user-nora' });

    beforeEach(() => {
      platform.members.mockResolvedValue([member('nora', 'OWNER'), member('lucia.vega', 'OWNER', { user_id: lucia.id })]);
    });

    it('lets an OWNER make themselves the sponsor, with no other account to choose', async () => {
      const { reload } = renderSettings([sponsoredByNora]);
      expect(await screen.findByText('nora')).toBeInTheDocument();
      expect(screen.queryByLabelText('New sponsor')).not.toBeInTheDocument();
      expect(screen.getByText(/The new sponsor’s limits are checked first/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Make me the sponsor' }));

      await waitFor(() => expect(platform.updateOrganization).toHaveBeenCalledWith('isa-demo', { billing_sponsor_user_id: lucia.id }));
      expect(await screen.findByText('Sponsor changed. Size limits now come from the new sponsor’s plan.')).toBeInTheDocument();
      expect(reload).toHaveBeenCalledOnce();
    });

    it('shows the current sponsor read-only when the account is the sponsor already, and asks for no sponsor request', async () => {
      renderSettings();

      expect(await screen.findByText('Current sponsor · RESEARCH plan')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Make me the sponsor' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Sponsor requests' })).not.toBeInTheDocument();
      expect(api.adminListUsers).not.toHaveBeenCalled();
    });

    it('does not offer other accounts to an administrator either', async () => {
      api.adminListUsers.mockResolvedValue({ users: [{ id: 'user-pilar', username: 'pilar', plan: 'PRO' }] });
      renderScreen(<OrgSettings />, { path: '/app/:org/settings', url: '/app/isa-demo/settings', organizations: [sponsoredByNora], user: iker });

      await screen.findByRole('button', { name: 'Make me the sponsor' });
      expect(screen.queryByText(/pilar/)).not.toBeInTheDocument();
      expect(api.adminListUsers).not.toHaveBeenCalled();
    });

    it.each([
      ['402 no room', new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 16 }), 'The new sponsor’s plan has no room for this organization and everything under it (402 · sponsor_quota_exceeded). members: 16 of 15 used. Nothing changed.'],
      ['422 must be the caller', refusal(422, 'sponsor_must_be_caller'), 'Only you can make yourself the sponsor (422 · sponsor_must_be_caller). Nothing changed.'],
      ['422 invalid sponsor', refusal(422, 'invalid_sponsor'), 'That account can’t be a sponsor (422 · invalid_sponsor): sponsors must be active accounts.'],
      ['503 pricing', new PricingUnavailableError('down'), 'Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed. Try again in a moment.'],
    ])('explains a refusal: %s', async (_name, error, text) => {
      platform.updateOrganization.mockRejectedValue(error);
      renderSettings([sponsoredByNora]);
      fireEvent.click(await screen.findByRole('button', { name: 'Make me the sponsor' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(text);
    });

    it('is for OWNERs only: an ADMIN can edit the rest but sees why the sponsor is locked', async () => {
      renderSettings([{ ...sponsoredByNora, effective_role: 'ADMIN' }]);

      expect(await screen.findByText('Needs OWNER. Your role here is ADMIN.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Make me the sponsor' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save name' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete organization' })).toBeInTheDocument();
    });
  });

  it('is read-only below ADMIN: nothing to save, move or delete', async () => {
    renderSettings([{ ...group, effective_role: 'MEMBER' }]);

    expect(await screen.findByText(/these settings are read-only/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move organization' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete organization' })).not.toBeInTheDocument();
    expect(screen.getByText('Needs OWNER. Your role here is MEMBER.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Top level/ })).toBeDisabled();
    // The audit log is flagged, not hidden.
    expect(within(screen.getByRole('navigation', { name: 'Organization settings' })).getByText('ADMIN')).toHaveAttribute('title', 'Needs ADMIN');
  });

  describe('deleting', () => {
    it('asks for the address, says what goes with it, and leaves for Home once it is gone', async () => {
      const { reload } = renderSettings();
      const impact = await screen.findByLabelText('What deleting removes');
      await waitFor(() => expect(impact).toHaveTextContent('projects2'));
      expect(impact).toHaveTextContent('sub-organization1');
      expect(impact).toHaveTextContent('direct members2');

      fireEvent.click(screen.getByRole('button', { name: 'Delete organization' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete ISA Demo Group?' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type isa-demo to confirm'), { target: { value: 'isa-dem' } });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type isa-demo to confirm'), { target: { value: 'isa-demo' } });
      fireEvent.click(confirm);

      await waitFor(() => expect(platform.deleteOrganization).toHaveBeenCalledWith('isa-demo'));
      await waitFor(() => expect(reload).toHaveBeenCalled());
      expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    });

    it('keeps the dialog open and explains a refusal for sealed history (409)', async () => {
      platform.deleteOrganization.mockRejectedValue(refusal(409, 'historical_references'));
      renderSettings();

      fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete ISA Demo Group?' });
      fireEvent.change(within(dialog).getByLabelText('Type isa-demo to confirm'), { target: { value: 'isa-demo' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('It has sealed history, so it can’t be deleted (409 · historical_references).');
      expect(screen.queryByText('elsewhere')).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('answers the neutral message for an organization the account cannot see', async () => {
    renderSettings([group], 'ghost');

    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Organization settings' })).not.toBeInTheDocument();
  });
});
