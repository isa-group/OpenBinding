import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError, type SponsorProposal } from '../../api/auth';
import { HttpError } from '../../api/client';
import { lucia, member, org, project, renderScreen } from './testKit';
import { OrgSettings } from './OrgSettings';

const api = vi.hoisted(() => ({ adminListUsers: vi.fn(), listOrganizationSponsorProposals: vi.fn(), cancelSponsorProposal: vi.fn() }));
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

/** A request to become the sponsor, as the gateway sends it (`SponsorProposalView`). */
function request(over: Partial<SponsorProposal> = {}): SponsorProposal {
  return {
    id: 'prop-1', organization_id: 'org-isa-demo', organization_slug: 'isa-demo', organization_name: 'ISA Demo Group',
    proposed_user_id: 'user-pilar', proposed_username: 'pilar', proposed_by_user_id: lucia.id, proposed_by_username: 'lucia.vega',
    status: 'pending', created_at: '2026-10-10T09:00:00Z', expires_at: '2099-12-31T09:00:00Z',
    decided_at: null, decided_by_user_id: null, decision_reason: null,
    ...over,
  };
}

describe('Organization settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.members.mockResolvedValue([member('lucia.vega', 'OWNER', { user_id: lucia.id }), member('marco', 'MEMBER')]);
    platform.projects.mockResolvedValue([project('qos-benchmarks'), project('checkout')]);
    platform.updateOrganization.mockResolvedValue(group);
    platform.deleteOrganization.mockResolvedValue(undefined);
    api.adminListUsers.mockResolvedValue({ users: [] });
    api.listOrganizationSponsorProposals.mockResolvedValue([]);
    api.cancelSponsorProposal.mockResolvedValue({ ...request(), status: 'cancelled' });
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

    it('lets an OWNER take over the sponsorship', async () => {
      const { reload } = renderSettings([sponsoredByNora]);
      expect(await screen.findByText('nora')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change sponsor' })).toBeDisabled();

      fireEvent.change(screen.getByLabelText('New sponsor'), { target: { value: 'self' } });
      expect(screen.getByText(/The new sponsor’s limits are checked first/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Change sponsor' }));

      await waitFor(() => expect(platform.updateOrganization).toHaveBeenCalledWith('isa-demo', { billing_sponsor_user_id: lucia.id }));
      expect(await screen.findByText('Sponsor changed. Size limits now come from the new sponsor’s plan.')).toBeInTheDocument();
      expect(reload).toHaveBeenCalledOnce();
    });

    it.each([
      ['402 no room', new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 16 }), 'The new sponsor’s plan has no room for this organization and everything under it (402 · sponsor_quota_exceeded). members: 16 of 15 used. Nothing changed.'],
      ['422 invalid sponsor', refusal(422, 'invalid_sponsor'), 'That account can’t be a sponsor (422 · invalid_sponsor): sponsors must be active accounts.'],
      ['503 pricing', new PricingUnavailableError('down'), 'Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed. Try again in a moment.'],
    ])('explains a refusal: %s', async (_name, error, text) => {
      platform.updateOrganization.mockRejectedValue(error);
      renderSettings([sponsoredByNora]);
      fireEvent.change(await screen.findByLabelText('New sponsor'), { target: { value: 'self' } });
      fireEvent.click(screen.getByRole('button', { name: 'Change sponsor' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(text);
    });

    describe('naming somebody else sends a request', () => {
      const parentOfPilar = org('isa-demo', { name: 'ISA Demo Group', billing_sponsor_user_id: 'user-pilar' });
      const child = org('qos-lab', { name: 'QoS Lab', parent_id: parentOfPilar.id, billing_sponsor_user_id: 'user-nora' });

      function renderChild() {
        return renderSettings([parentOfPilar, child], 'qos-lab');
      }

      async function chooseParentsSponsor() {
        fireEvent.change(await screen.findByLabelText('New sponsor'), { target: { value: 'parent' } });
        expect(screen.getByText(/This sends them a request\. Nothing changes until they accept/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Send sponsor request' }));
      }

      it('shows the card of the request with the person, the expiry, its state and a way to cancel it', async () => {
        const sent = request({ organization_slug: 'qos-lab', organization_name: 'QoS Lab' });
        platform.updateOrganization.mockResolvedValue(sent);
        renderChild();
        await chooseParentsSponsor();

        await waitFor(() => expect(platform.updateOrganization).toHaveBeenCalledWith('qos-lab', { billing_sponsor_user_id: 'user-pilar' }));
        expect(await screen.findByText('Sponsor request sent to pilar. Nothing changes until they accept.')).toBeInTheDocument();
        const card = await screen.findByRole('region', { name: 'Sponsor request sent' });
        expect(within(card).getByText('Pending')).toBeInTheDocument();
        const facts = within(within(card).getByLabelText('Sponsor request'));
        expect(facts.getByText('pilar')).toBeInTheDocument();
        expect(facts.getByText('pending')).toBeInTheDocument();
        expect(facts.getByText('Dec 31, 2099')).toBeInTheDocument();
        expect(within(card).getByText(/has to accept before anything changes/)).toBeInTheDocument();
        expect(within(card).queryByRole('button', { name: 'Replace request' })).not.toBeInTheDocument();
        // The sponsor itself is untouched: nothing was reloaded and the current sponsor is still named.
        expect(screen.getByText('nora')).toBeInTheDocument();

        api.listOrganizationSponsorProposals.mockResolvedValue([{ ...sent, status: 'cancelled' }]);
        fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(api.cancelSponsorProposal).toHaveBeenCalledWith('prop-1'));
        expect(await screen.findByText('Sponsor request cancelled. The sponsor stays as it was.')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Sponsor request sent' })).not.toBeInTheDocument());
      });

      it('lists every request of the organization with its state', async () => {
        api.listOrganizationSponsorProposals.mockResolvedValue([
          request({ id: 'p1' }),
          request({ id: 'p2', proposed_username: 'ines', status: 'accepted', decided_at: '2026-09-01T10:00:00Z' }),
          request({ id: 'p3', proposed_username: 'omar', status: 'declined', decided_at: '2026-08-01T10:00:00Z' }),
          request({ id: 'p4', proposed_username: 'sara', status: 'cancelled', decision_reason: 'replaced' }),
          request({ id: 'p5', proposed_username: 'tomas', status: 'expired', decision_reason: 'expired' }),
        ]);
        renderChild();

        const table = await screen.findByRole('table');
        const rows = within(table).getAllByRole('row').slice(1);
        expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual(['Pending', 'Accepted', 'Declined', 'Cancelled', 'Expired']);
        expect(within(rows[3]).getByText(/Replaced by a newer request/)).toBeInTheDocument();
        expect(within(rows[1]).getByText('ines')).toBeInTheDocument();
      });

      it('offers Replace request when one is waiting and the caller sent it, resending with the replace flag', async () => {
        const waiting = request({ organization_slug: 'qos-lab' });
        api.listOrganizationSponsorProposals.mockResolvedValue([waiting]);
        platform.updateOrganization.mockRejectedValueOnce(refusal(409, 'sponsor_proposal_pending', { detail: { code: 'sponsor_proposal_pending', proposal_id: 'prop-1' } }));
        renderChild();
        await chooseParentsSponsor();

        expect(await screen.findByRole('alert')).toHaveTextContent('A sponsor request is already waiting for an answer (409 · sponsor_proposal_pending).');
        platform.updateOrganization.mockResolvedValueOnce(request({ id: 'prop-2', organization_slug: 'qos-lab' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Replace request' }));

        await waitFor(() => expect(platform.updateOrganization).toHaveBeenLastCalledWith('qos-lab', { billing_sponsor_user_id: 'user-pilar', replace_pending_proposal: true }));
        expect(await screen.findByText('Sponsor request sent to pilar. Nothing changes until they accept.')).toBeInTheDocument();
      });

      it('does not offer Replace when somebody else sent the waiting request, and says to cancel it first', async () => {
        api.listOrganizationSponsorProposals.mockResolvedValue([request({ organization_slug: 'qos-lab', proposed_by_user_id: 'user-nora', proposed_by_username: 'nora' })]);
        platform.updateOrganization.mockRejectedValueOnce(refusal(409, 'sponsor_proposal_pending', { detail: { code: 'sponsor_proposal_pending', proposal_id: 'prop-1' } }));
        renderChild();
        await chooseParentsSponsor();

        // The card is already there from the list; the hint arrives with the refusal.
        await screen.findByText('Someone else sent this request. Cancel it first, then send yours.');
        const card = screen.getByRole('region', { name: 'Sponsor request sent' });
        expect(within(card).queryByRole('button', { name: 'Replace request' })).not.toBeInTheDocument();
        expect(within(card).getByText('Someone else sent this request. Cancel it first, then send yours.')).toBeInTheDocument();
        // An OWNER may cancel it, whoever sent it.
        expect(within(card).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      });

      it('lets an ADMIN see the requests but not cancel one they did not send', async () => {
        api.listOrganizationSponsorProposals.mockResolvedValue([request({ proposed_by_user_id: 'user-nora', proposed_by_username: 'nora' })]);
        renderSettings([{ ...group, effective_role: 'ADMIN' }]);

        const card = await screen.findByRole('region', { name: 'Sponsor request sent' });
        expect(within(card).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Sponsor requests' })).toBeInTheDocument();
      });

      it('keeps the page usable when the requests can not be read', async () => {
        api.listOrganizationSponsorProposals.mockRejectedValue(refusal(503, 'unavailable'));
        renderChild();

        expect(await screen.findByText('The sponsor requests couldn’t be loaded right now.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Change sponsor' })).toBeDisabled();
      });

      it.each([
        ['409 expired', refusal(409, 'sponsor_proposal_expired'), 'This request expired (409 · sponsor_proposal_expired). It can no longer be accepted; ask the owner to send a new one.'],
        ['422 invalid sponsor', refusal(422, 'invalid_sponsor'), 'That account can’t be a sponsor (422 · invalid_sponsor): sponsors must be active accounts.'],
      ])('explains: %s', async (_name, error, text) => {
        platform.updateOrganization.mockRejectedValue(error);
        renderChild();
        await chooseParentsSponsor();

        expect(await screen.findByRole('alert')).toHaveTextContent(text);
      });
    });

    it('is for OWNERs only: an ADMIN can edit the rest but sees why the sponsor is locked', async () => {
      renderSettings([{ ...sponsoredByNora, effective_role: 'ADMIN' }]);

      expect(await screen.findByText('Needs OWNER. Your role here is ADMIN.')).toBeInTheDocument();
      expect(screen.queryByLabelText('New sponsor')).not.toBeInTheDocument();
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
