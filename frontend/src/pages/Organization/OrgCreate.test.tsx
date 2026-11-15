import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { catalogFixture } from '../Pricing/pricingFixture';
import { lucia, org } from '../../features/workspace/testKit';
import { member, renderScreen, researchUsage } from './testKit';
import { OrgCreate } from './OrgCreate';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn(), adminListUsers: vi.fn() }));
const platform = vi.hoisted(() => ({ createOrganization: vi.fn(), members: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewerOnly = org('read-only', { name: 'Read Only Lab', effective_role: 'MEMBER' });
const consultora = org('consultora-demo', { name: 'Consultora Demo', effective_role: 'ADMIN' });

const onClose = vi.fn();
const onCreated = vi.fn();

function renderCreate(user = lucia, organizations = [group, viewerOnly, consultora]) {
  return renderScreen(<OrgCreate onClose={onClose} onCreated={onCreated} />, { path: '/app', url: '/app', organizations, user });
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

describe('New organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getOwnUsage.mockResolvedValue(researchUsage());
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
    api.adminListUsers.mockResolvedValue({ users: [] });
    platform.members.mockResolvedValue([member('nora', 'OWNER')]);
    platform.createOrganization.mockResolvedValue(org('distributed-systems-lab', { name: 'Distributed Systems Lab' }));
  });

  it('is the dialog New organization, with the name first and a disabled Create until the name and the address are valid', async () => {
    renderCreate();

    const dialog = screen.getByRole('dialog', { name: 'New organization' });
    expect(within(dialog).getByLabelText('Name')).toHaveFocus();
    expect(within(dialog).queryByRole('list', { name: 'Steps' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create organization' })).toBeDisabled();

    type('Name', 'Distributed Systems Lab');
    expect(screen.getByLabelText('Address')).toHaveValue('distributed-systems-lab');
    expect(screen.getByText('Available to try · can’t be changed later.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeEnabled();

    // Once the address is typed by hand it stops following the name.
    type('Address', 'Bad Address');
    expect(screen.getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Use lowercase letters, numbers and hyphens/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeDisabled();
    type('Address', 'isa-demo');
    expect(screen.getByText('Already used by another organization.')).toBeInTheDocument();
    type('Name', 'Another name');
    expect(screen.getByLabelText('Address')).toHaveValue('isa-demo');
  });

  it('ends at onClose from Cancel, the × button and Escape, and creates nothing', () => {
    renderCreate();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New organization' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(platform.createOrganization).not.toHaveBeenCalled();
  });

  it('offers as parents only the organizations where the account is ADMIN or above', async () => {
    renderCreate();

    const parents = within(screen.getByRole('group', { name: 'Parent organization' }));
    expect(parents.getByRole('radio', { name: /None · top-level organization/ })).toBeChecked();
    expect(parents.getByRole('radio', { name: /ISA Demo Group/ })).toBeEnabled();
    expect(parents.getByRole('radio', { name: /Consultora Demo/ })).toBeEnabled();
    const blocked = parents.getByRole('radio', { name: /Read Only Lab/ });
    expect(blocked).toBeDisabled();
    expect(screen.getByText('Needs ADMIN here; your role is MEMBER')).toBeInTheDocument();
  });

  it('previews the tree, and no sponsor: quotas are per account', async () => {
    renderCreate();
    type('Name', 'Distributed Systems Lab');
    fireEvent.click(screen.getByRole('radio', { name: /ISA Demo Group/ }));

    const preview = screen.getByRole('list', { name: 'Organization tree preview' });
    expect(within(preview).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['IDISA Demo Group', 'DSDistributed Systems LabNEW']);
    expect(screen.getByText(/Everyone with a role in ISA Demo Group gets at least the same role/)).toBeInTheDocument();

    expect(screen.queryByRole('group', { name: 'Sponsor' })).not.toBeInTheDocument();
    expect(screen.queryByText(/sponsor/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('creates the organization under the chosen parent, reloads the workspace and hands the organization over', async () => {
    const { reload } = renderCreate();
    type('Name', 'Distributed Systems Lab');
    fireEvent.click(screen.getByRole('radio', { name: /Consultora Demo/ }));
    submit();

    await waitFor(() => expect(platform.createOrganization).toHaveBeenCalledWith({
      name: 'Distributed Systems Lab', slug: 'distributed-systems-lab', parent_id: consultora.id,
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0]).toMatchObject({ slug: 'distributed-systems-lab' });
    expect(reload).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('when the gateway refuses', () => {
    function fillAndSubmit() {
      renderCreate();
      type('Name', 'Distributed Systems Lab');
      submit();
    }

    it('409: the address is taken, and the way back to the field', async () => {
      platform.createOrganization.mockRejectedValue(Object.assign(new HttpError(409, 'slug in use'), { code: 'slug_conflict' }));
      fillAndSubmit();

      expect(await screen.findByRole('alert')).toHaveTextContent('That address is taken (409 · slug_conflict). Another organization already uses /app/distributed-systems-lab.');
      fireEvent.click(screen.getByRole('button', { name: 'Change the address' }));
      expect(screen.getByLabelText('Address')).toHaveFocus();
      expect(screen.getByLabelText('Address')).toHaveValue('distributed-systems-lab');
      expect(onCreated).not.toHaveBeenCalled();
    });

    it('403: no ADMIN in the parent', async () => {
      platform.createOrganization.mockRejectedValue(Object.assign(new HttpError(403, 'no'), { code: 'organization_forbidden' }));
      renderCreate();
      type('Name', 'Distributed Systems Lab');
      fireEvent.click(screen.getByRole('radio', { name: /Consultora Demo/ }));
      submit();

      expect(await screen.findByText('You need ADMIN in Consultora Demo to add an organization inside it (403 · organization_forbidden). Ask one of its admins, or create it top-level.')).toBeInTheDocument();
    });
  });

});
