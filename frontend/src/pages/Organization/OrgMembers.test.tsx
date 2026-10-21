import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { OrganizationMember } from '../../api/platform';
import { iker, member, org, renderScreen, researchUsage } from './testKit';
import { OrgMembers } from './OrgMembers';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
const platform = vi.hoisted(() => ({ members: vi.fn(), updateMembersBatch: vi.fn(), inviteMember: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const lab = org('qos-lab', { name: 'QoS Lab', parent_id: group.id });

const lucia = member('lucia', 'OWNER');
const marco = member('marco', 'MEMBER');
const sofia = member('sofia', 'VIEWER');

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderMembers(organizations = [group, lab], slug = 'isa-demo') {
  return renderScreen(<OrgMembers />, { path: '/app/:org/settings/members', url: `/app/${slug}/settings/members`, organizations });
}

const rowOf = (text: RegExp | string) => screen.getByRole('row', { name: text });
const roleSelect = (name: string) => screen.getByLabelText(`Role for ${name}`);

describe('Members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.members.mockImplementation(async (slug: string) => (slug === 'isa-demo' ? [lucia, marco, sofia] : [{ ...marco, role: 'ADMIN' as const, organization_id: lab.id }]));
    platform.updateMembersBatch.mockResolvedValue([lucia, { ...marco, role: 'ADMIN' as const }, sofia]);
    api.getOwnUsage.mockResolvedValue(researchUsage());
  });

  it('lists who is in with the role they hold here, the effective one and when they were added', async () => {
    renderMembers();

    expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeInTheDocument();
    expect(await screen.findByText('ISA Demo Group · 3 people with a role')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Person', 'Role here', 'Effective role', 'Added', 'Actions']);

    const own = rowOf(/lucia@example\.test/);
    expect(within(own).getByText('(you)')).toBeInTheDocument();
    expect(within(own).getByLabelText('Role for lucia')).toHaveValue('OWNER');
    expect(within(own).getByText('Own role')).toBeInTheDocument();
    expect(within(own).getByText('Mar 4, 2026')).toBeInTheDocument();
    expect(roleSelect('marco')).toHaveValue('MEMBER');
    expect(screen.getByRole('navigation', { name: 'Organization settings' })).toBeInTheDocument();
    expect(screen.getByText(/unique members across everything you sponsor/)).toHaveTextContent('Your plan allows up to 15 unique members');
  });

  it('tells apart the role someone holds here from the one that reaches them from a parent', async () => {
    renderMembers([group, lab], 'qos-lab');

    expect(await screen.findByText('QoS Lab · 3 people with a role')).toBeInTheDocument();
    const inheritedOnly = rowOf(/lucia@example\.test/);
    expect(within(inheritedOnly).getByLabelText('Role for lucia')).toHaveValue('__none');
    expect(within(inheritedOnly).getByText('Inherited from ISA Demo Group')).toBeInTheDocument();
    expect(within(inheritedOnly).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();

    const both = rowOf(/marco@example\.test/);
    expect(within(both).getByLabelText('Role for marco')).toHaveValue('ADMIN');
    expect(within(both).getByText('Own role (higher than inherited MEMBER)')).toBeInTheDocument();
    expect(within(both).getByRole('button', { name: 'Remove marco' })).toBeInTheDocument();
    expect(platform.members).toHaveBeenCalledWith('isa-demo');
  });

  it('queues a role change, lets it be undone, and applies the queue in one batch', async () => {
    const { reload } = renderMembers();
    await screen.findByLabelText('Role for marco');
    const queue = screen.getByRole('complementary', { name: /Pending changes/ });
    expect(within(queue).getByText('Change a role or remove someone in the table. Changes wait here until you apply them.')).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();

    fireEvent.change(roleSelect('marco'), { target: { value: 'ADMIN' } });
    expect(within(queue).getByText('MEMBER')).toBeInTheDocument();
    expect(within(queue).getAllByText('ADMIN').length).toBeGreaterThan(0);
    expect(within(queue).getByRole('button', { name: 'Apply 1 change' })).toBeEnabled();

    fireEvent.click(within(queue).getByRole('button', { name: 'Undo change for marco' }));
    expect(roleSelect('marco')).toHaveValue('MEMBER');
    expect(within(queue).getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();

    fireEvent.change(roleSelect('marco'), { target: { value: 'ADMIN' } });
    fireEvent.click(within(queue).getByRole('button', { name: 'Apply 1 change' }));

    await waitFor(() => expect(platform.updateMembersBatch).toHaveBeenCalledWith('isa-demo', [{ user_id: 'user-marco', role: 'ADMIN' }]));
    expect(await screen.findByText('1 change applied together. They’re recorded in the audit log.')).toBeInTheDocument();
    expect(roleSelect('marco')).toHaveValue('ADMIN');
    expect(within(queue).getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();
    expect(reload).toHaveBeenCalledOnce();
    // The side navigation and the confirmation both lead to the audit log.
    const toAudit = screen.getAllByRole('link', { name: 'Audit log' });
    expect(toAudit).toHaveLength(2);
    expect(toAudit.every((link) => link.getAttribute('href') === '/app/isa-demo/settings/audit')).toBe(true);
  });

  it('queues a removal as a null role and shows it as pending', async () => {
    renderMembers();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove sofia' }));
    expect(screen.getByRole('button', { name: 'Remove sofia' })).toHaveTextContent('Will be removed');
    const queue = screen.getByRole('complementary', { name: /Pending changes/ });
    expect(within(queue).getByText('Removed')).toBeInTheDocument();

    fireEvent.click(within(queue).getByRole('button', { name: 'Apply 1 change' }));
    await waitFor(() => expect(platform.updateMembersBatch).toHaveBeenCalledWith('isa-demo', [{ user_id: 'user-sofia', role: null }]));
  });

  it('stops queueing at the 100 changes a batch can hold', async () => {
    const many: OrganizationMember[] = Array.from({ length: 101 }, (_, index) => member(`person${index}`, 'MEMBER'));
    platform.members.mockResolvedValue([lucia, ...many]);
    renderMembers();

    await screen.findByLabelText('Role for person0');
    for (const person of many) fireEvent.change(roleSelect(person.username!), { target: { value: 'VIEWER' } });

    const queue = screen.getByRole('complementary', { name: /Pending changes/ });
    expect(within(queue).getByRole('button', { name: 'Apply 100 changes' })).toBeEnabled();
    expect(within(queue).getByText(/The queue is full: a batch holds at most 100 changes/)).toBeInTheDocument();
  });

  describe('when the gateway refuses the batch', () => {
    async function stage() {
      renderMembers();
      fireEvent.change(await screen.findByLabelText('Role for lucia'), { target: { value: 'VIEWER' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    }

    it('409: at least one OWNER must remain, and the queue is kept', async () => {
      platform.updateMembersBatch.mockRejectedValue(refusal(409, 'last_owner'));
      await stage();

      expect(await screen.findByRole('alert')).toHaveTextContent('At least one OWNER must remain (409 · last_owner). Keep someone as OWNER, or make another person OWNER in the same batch.');
      expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeEnabled();
    });

    it('402: the sponsor has no seats left, with the ways out', async () => {
      platform.updateMembersBatch.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'members', limit: 15, used: 15 }));
      await stage();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The sponsor has no member seats left (402 · sponsor_quota_exceeded): 15 of 15 used. Nothing changed.');
      expect(within(alert).getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/app/account/usage');
      expect(within(alert).getByRole('link', { name: 'Change sponsor' })).toHaveAttribute('href', '/app/isa-demo/settings');
    });

    it('422: someone in the batch is not a member', async () => {
      platform.updateMembersBatch.mockRejectedValue(refusal(422, 'member_mismatch'));
      await stage();

      expect(await screen.findByRole('alert')).toHaveTextContent('One of these people isn’t a member of this organization (422 · member_mismatch). Refresh and try again.');
    });

    it('503: pricing cannot be checked, nothing changed', async () => {
      platform.updateMembersBatch.mockRejectedValue(new PricingUnavailableError('down'));
      await stage();

      expect(await screen.findByRole('alert')).toHaveTextContent('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed; try again in a moment.');
    });
  });

  describe('inviting', () => {
    const invitation = { id: 'inv-1', organization_id: group.id, email: 'invitada@example.test', role: 'ADMIN' as const, expires_at: '2026-10-15T00:00:00Z', token: 'obi_abc123_one-time-secret' };

    it('shows the one-time code once, and lists the invitation as pending', async () => {
      platform.inviteMember.mockResolvedValue(invitation);
      renderMembers();

      fireEvent.click(await screen.findByRole('button', { name: 'Invite by email' }));
      const dialog = await screen.findByRole('dialog', { name: 'Invite to ISA Demo Group' });
      fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'nope' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a valid email address (422).');

      fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'invitada@example.test' } });
      fireEvent.change(within(dialog).getByLabelText('Role when they join'), { target: { value: 'ADMIN' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));

      await waitFor(() => expect(platform.inviteMember).toHaveBeenCalledWith('isa-demo', { email: 'invitada@example.test', role: 'ADMIN' }));
      const created = await screen.findByRole('dialog', { name: 'Invitation created' });
      expect(within(created).getByText(/Shown only once\./)).toBeInTheDocument();
      expect(within(created).getByText('obi_abc123_one-time-secret')).toBeInTheDocument();
      expect(within(created).getByRole('button', { name: 'Copy invitation code' })).toBeInTheDocument();
      expect(within(created).getByRole('link', { name: 'accept invitation' })).toHaveAttribute('href', '/invitations/accept');
      // It cannot be dismissed by accident: no close button.
      expect(within(created).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

      fireEvent.click(within(created).getByRole('button', { name: 'I’ve saved it' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('obi_abc123_one-time-secret')).not.toBeInTheDocument();
      const pending = rowOf(/invitada@example\.test/);
      expect(within(pending).getByText('Invitation pending')).toBeInTheDocument();
      expect(within(pending).getByText('Expires Oct 15, 2026')).toBeInTheDocument();
    });

    it('explains a refusal inside the dialog', async () => {
      platform.inviteMember.mockRejectedValue(refusal(403, 'organization_forbidden'));
      renderMembers();

      fireEvent.click(await screen.findByRole('button', { name: 'Invite by email' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'invitada@example.test' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('You need ADMIN here to invite (403 · organization_forbidden).');
    });
  });

  it('is read-only below ADMIN: the table, no queue to fill, no invitations', async () => {
    renderMembers([{ ...group, effective_role: 'VIEWER' }]);

    expect(await screen.findByText(/you can see who’s in, but changing roles and inviting need ADMIN/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Role for marco')).not.toBeInTheDocument();
    // Both the role held here and the effective one are plain labels.
    expect(within(rowOf(/marco@example\.test/)).getAllByText('MEMBER', { selector: '.org-role' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByText('Only admins can change roles.')).toBeInTheDocument();
    expect(screen.queryByText('To confirm')).not.toBeInTheDocument();
  });

  describe('the OWNER role is for owners', () => {
    it('disables the OWNER option for an ADMIN, with the reason one screen-reader announcement away', async () => {
      renderMembers([{ ...group, effective_role: 'ADMIN' }]);

      expect(await screen.findByLabelText('Role for marco')).toBeInTheDocument();
      expect(screen.queryByText('To confirm')).not.toBeInTheDocument();
      expect(within(roleSelect('marco')).getByRole('option', { name: 'OWNER' })).toBeDisabled();
      expect(within(roleSelect('marco')).getByRole('option', { name: 'ADMIN' })).toBeEnabled();
      const note = document.getElementById('owner-role-note');
      expect(note).toHaveTextContent('Only an owner can grant the owner role.');
      expect(roleSelect('marco')).toHaveAccessibleDescription(/Only an owner can grant the owner role\./);
    });

    it('does not let an ADMIN change or remove an OWNER', async () => {
      renderMembers([{ ...group, effective_role: 'ADMIN' }]);

      expect(await screen.findByLabelText('Role for lucia')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove lucia' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove lucia' })).toHaveAccessibleDescription(/Only an owner can change or remove an owner\./);
      // The people below OWNER are still theirs to manage.
      expect(roleSelect('marco')).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Remove marco' })).toBeEnabled();
    });

    it('leaves OWNER available to an OWNER, who can also change another OWNER', async () => {
      platform.members.mockResolvedValue([lucia, member('ines', 'OWNER'), marco]);
      renderMembers();

      expect(await screen.findByLabelText('Role for ines')).toBeEnabled();
      expect(within(roleSelect('marco')).getByRole('option', { name: 'OWNER' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Remove ines' })).toBeEnabled();
      expect(document.getElementById('owner-role-note')).toBeNull();
    });

    it('keeps what the gateway allows a platform administrator who already has ADMIN access', async () => {
      renderScreen(<OrgMembers />, { path: '/app/:org/settings/members', url: '/app/isa-demo/settings/members', organizations: [{ ...group, effective_role: 'ADMIN' }], user: iker });

      expect(await screen.findByLabelText('Role for marco')).toBeInTheDocument();
      expect(within(roleSelect('marco')).getByRole('option', { name: 'OWNER' })).toBeEnabled();
      expect(roleSelect('lucia')).toBeEnabled();
    });

    it('marks the row the gateway refused and says the batch changed nothing (403 owner_role_requires_owner)', async () => {
      platform.updateMembersBatch.mockRejectedValue(Object.assign(new HttpError(403, 'Only an owner can grant the owner role.'), {
        code: 'owner_role_requires_owner',
        problem: { code: 'owner_role_requires_owner', detail: { code: 'owner_role_requires_owner', error: 'Only an owner can grant the owner role.', index: 1, user_id: 'user-sofia' } },
      }));
      renderMembers();
      fireEvent.change(await screen.findByLabelText('Role for marco'), { target: { value: 'ADMIN' } });
      fireEvent.change(roleSelect('sofia'), { target: { value: 'OWNER' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Only an owner can grant the owner role. The change for sofia was refused (403 · owner_role_requires_owner), so nothing changed');
      const refused = rowOf(/sofia@example\.test/);
      expect(refused).toHaveClass('is-rejected');
      expect(within(refused).getByText(/Refused: Only an owner can grant the owner role\./)).toBeInTheDocument();
      expect(roleSelect('sofia')).toBeInvalid();
      expect(rowOf(/marco@example\.test/)).not.toHaveClass('is-rejected');
      // The whole queue is still there, for the person to fix.
      expect(screen.getByRole('button', { name: 'Apply 2 changes' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Undo change for sofia' }));
      expect(rowOf(/sofia@example\.test/)).not.toHaveClass('is-rejected');
    });

    it('finds the refused person by the index of the batch when the gateway sends no id', async () => {
      platform.updateMembersBatch.mockRejectedValue(Object.assign(new HttpError(403, 'refused'), {
        code: 'owner_role_requires_owner', problem: { detail: { code: 'owner_role_requires_owner', index: 0 } },
      }));
      renderMembers();
      fireEvent.change(await screen.findByLabelText('Role for marco'), { target: { value: 'ADMIN' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('The change for marco was refused');
      expect(rowOf(/marco@example\.test/)).toHaveClass('is-rejected');
    });

    it('disables OWNER in the invitation for an ADMIN, and explains the refusal if the gateway still says no', async () => {
      platform.inviteMember.mockRejectedValue(refusal(403, 'owner_role_requires_owner'));
      renderMembers([{ ...group, effective_role: 'ADMIN' }]);

      fireEvent.click(await screen.findByRole('button', { name: 'Invite by email' }));
      const dialog = await screen.findByRole('dialog');
      const role = within(dialog).getByLabelText('Role when they join');
      expect(within(role).getByRole('option', { name: /^OWNER/ })).toBeDisabled();
      expect(role).toHaveAccessibleDescription('Only an owner can grant the owner role.');

      fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'invitada@example.test' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only an owner can grant the owner role. Choose another role (403 · owner_role_requires_owner).');
    });

    it('lets an OWNER invite as OWNER', async () => {
      renderMembers();

      fireEvent.click(await screen.findByRole('button', { name: 'Invite by email' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(within(dialog).getByLabelText('Role when they join')).getByRole('option', { name: /^OWNER/ })).toBeEnabled();
    });
  });

  it('offers to invite when you are the only member', async () => {
    platform.members.mockResolvedValue([lucia]);
    renderMembers();

    expect(await screen.findByText('You’re the only member so far. Invite people by email; they choose to accept.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite someone' })).toBeInTheDocument();
  });

  it('reports a failed load with a retry, and answers the neutral message for an unknown organization', async () => {
    platform.members.mockRejectedValueOnce(new HttpError(503, 'down'));
    renderMembers();

    expect(await screen.findByText('Members couldn’t be loaded (503). Nothing was changed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Role for marco')).toBeInTheDocument();

    renderMembers([group], 'ghost');
    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
  });
});
