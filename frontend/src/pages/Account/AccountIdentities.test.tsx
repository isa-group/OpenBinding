import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalIdentity, UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { forgetPlanChanged, notePlanChanged } from '../../utils/authFlow';
import { catalogFixture } from '../Pricing/pricingFixture';
import { AccountIdentities } from './AccountIdentities';

const api = vi.hoisted(() => ({
  listOwnIdentities: vi.fn(),
  createCasLinkIntent: vi.fn(),
  unlinkOwnIdentity: vi.fn(),
  getPricingCatalog: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ leaveTo: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../utils/navigation', () => navigation);

const person = (plan: string): UserProfile => ({
  id: 'user-id', username: 'lucia', email: 'lucia@example.test', role: 'user', is_active: true, plan, created_at: '2026-03-02T00:00:00Z',
});

const cas: ExternalIdentity = { id: 'i1', provider: 'us-cas', subject: 'lvega1', verifiedAt: '2026-09-01T00:00:00Z' };

const refusal = (status: number, code: string) => {
  const error = new HttpError(status, code);
  error.code = code;
  return error;
};

function renderIdentities(plan = 'BASIC') {
  const auth = { user: person(plan), loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined), isAdmin: false };
  render(
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <AccountIdentities />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return auth;
}

const unlinkDialog = () => screen.findByRole('dialog', { name: 'Unlink your Universidad de Sevilla identity?' });

describe('Identities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetPlanChanged();
    api.listOwnIdentities.mockResolvedValue([]);
    api.createCasLinkIntent.mockResolvedValue('/api/v1/auth/cas/start?mode=link&intent=abc');
    api.unlinkOwnIdentity.mockResolvedValue(undefined);
    api.getPricingCatalog.mockResolvedValue(catalogFixture);
  });

  describe('without a linked identity', () => {
    it('offers to link the Universidad de Sevilla CAS identity without promising a plan', async () => {
      renderIdentities();

      expect(await screen.findByRole('heading', { level: 1, name: 'Identities' })).toBeInTheDocument();
      expect(await screen.findByText('Universidad de Sevilla · CAS')).toBeInTheDocument();
      expect(screen.getByText('Not linked')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Link CAS identity' })).toBeEnabled();
      expect(screen.getByRole('navigation', { name: 'Account' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Identities', current: 'page' })).toBeInTheDocument();
      expect(screen.getByText(/Linking one moves an account on the default plan to RESEARCH automatically, at no extra cost/)).toBeInTheDocument();
      expect(screen.queryByText(/becomes RESEARCH/)).not.toBeInTheDocument();
      expect(screen.queryByText('Plan updated')).not.toBeInTheDocument();
    });

    it('tells once, when the person is back from linking, that their plan is now RESEARCH at no extra cost', async () => {
      notePlanChanged({ from: 'BASIC', to: 'RESEARCH', extraCost: false });
      const { unmount } = render(
        <MemoryRouter>
          <AuthContext.Provider value={{ user: person('RESEARCH'), loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
            <AccountIdentities />
          </AuthContext.Provider>
        </MemoryRouter>,
      );

      expect(await screen.findByText('Your account is now on the RESEARCH plan. There is no extra cost.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText('Your account is now on the RESEARCH plan. There is no extra cost.')).not.toBeInTheDocument();

      // Opening the screen again (a reload) doesn't repeat it.
      unmount();
      renderIdentities('RESEARCH');
      await screen.findByText('Universidad de Sevilla · CAS');
      expect(screen.queryByText(/Your account is now on the RESEARCH plan/)).not.toBeInTheDocument();
    });

    it('starts the CAS round trip with the one-use address the gateway gives', async () => {
      renderIdentities();
      fireEvent.click(await screen.findByRole('button', { name: 'Link CAS identity' }));

      await waitFor(() => expect(navigation.leaveTo).toHaveBeenCalledWith('/api/v1/auth/cas/start?mode=link&intent=abc'));
      expect(api.createCasLinkIntent).toHaveBeenCalledTimes(1);
    });

    it('says institutional sign-in is paused when the pricing has no RESEARCH plan (503)', async () => {
      api.createCasLinkIntent.mockRejectedValue(refusal(503, 'institutional_pricing_invalid'));
      renderIdentities();
      fireEvent.click(await screen.findByRole('button', { name: 'Link CAS identity' }));

      expect(await screen.findByText(
        'Institutional sign-in is paused (503 · institutional_pricing_invalid): the current pricing has no valid RESEARCH plan. Try again later.',
      )).toBeInTheDocument();
      expect(navigation.leaveTo).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Link CAS identity' })).toBeEnabled();
    });
  });

  describe('with a linked identity on a plan that is not RESEARCH', () => {
    beforeEach(() => {
      api.listOwnIdentities.mockResolvedValueOnce([cas]).mockResolvedValue([]);
    });

    it('shows it as verified, without the institutional mark that belongs to the plan', async () => {
      renderIdentities('BASIC');

      expect(await screen.findByText('Verified · linked Sep 1, 2026 · lvega1')).toBeInTheDocument();
      expect(screen.getByText('Verified', { selector: '.ui-chip' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Universidad de Sevilla' })).not.toBeInTheDocument();
    });

    it('unlinks without a typed confirmation, because the plan does not change', async () => {
      const auth = renderIdentities('BASIC');
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      const dialog = within(await unlinkDialog());
      expect(dialog.getByText('Your plan stays as it is. You can link the identity again later.')).toBeInTheDocument();
      expect(dialog.queryByRole('textbox')).not.toBeInTheDocument();
      fireEvent.click(dialog.getByRole('button', { name: 'Unlink' }));

      await waitFor(() => expect(api.unlinkOwnIdentity).toHaveBeenCalledWith('i1', undefined));
      expect(await screen.findByText('Identity unlinked.')).toBeInTheDocument();
      expect(auth.refresh).toHaveBeenCalled();
      expect(await screen.findByText('Not linked')).toBeInTheDocument();
    });

    it('does nothing when the dialog is cancelled', async () => {
      renderIdentities('BASIC');
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
      fireEvent.click(within(await unlinkDialog()).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.unlinkOwnIdentity).not.toHaveBeenCalled();
    });
  });

  describe('with a linked identity on RESEARCH', () => {
    beforeEach(() => {
      api.listOwnIdentities.mockResolvedValueOnce([cas]).mockResolvedValue([]);
    });

    it('shows the institutional mark, which is not a role', async () => {
      renderIdentities('RESEARCH');

      expect(await screen.findByText('Verified · linked Sep 1, 2026 · lvega1')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/us-fama.png');
      expect(screen.getByText('Shown on signed-in pages because your plan includes the institutional identity. It isn’t a role.')).toBeInTheDocument();
    });

    it('shows what changes and will not unlink until DOWNGRADE RESEARCH is typed exactly', async () => {
      renderIdentities('RESEARCH');
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      const dialog = within(await unlinkDialog());
      const change = within(dialog.getByLabelText('Plan change'));
      expect(await change.findByText('3 concurrent jobs')).toBeInTheDocument();
      expect(change.getByText('1 concurrent job')).toBeInTheDocument();
      expect(change.getByText('RESEARCH')).toBeInTheDocument();
      expect(change.getByText('BASIC')).toBeInTheDocument();

      const unlink = dialog.getByRole('button', { name: 'Unlink' });
      expect(unlink).toBeDisabled();
      const field = dialog.getByLabelText('Type DOWNGRADE RESEARCH to confirm');
      fireEvent.change(field, { target: { value: 'downgrade research' } });
      expect(unlink).toBeDisabled();
      fireEvent.change(field, { target: { value: 'DOWNGRADE RESEARCH' } });
      expect(unlink).toBeEnabled();
      expect(api.unlinkOwnIdentity).not.toHaveBeenCalled();
    });

    it('unlinks with the typed phrase, says the plan is back to the default, and refreshes the profile', async () => {
      const auth = renderIdentities('RESEARCH');
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      const dialog = within(await unlinkDialog());
      await dialog.findByText('3 concurrent jobs');
      fireEvent.change(dialog.getByLabelText('Type DOWNGRADE RESEARCH to confirm'), { target: { value: 'DOWNGRADE RESEARCH' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Unlink' }));

      await waitFor(() => expect(api.unlinkOwnIdentity).toHaveBeenCalledWith('i1', 'DOWNGRADE RESEARCH'));
      expect(await screen.findByText('Identity unlinked. Your plan is now BASIC.')).toBeInTheDocument();
      await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    });

    it.each([
      [409, 'research_downgrade_confirmation_required', '409 · research_downgrade_confirmation_required: type DOWNGRADE RESEARCH exactly to confirm the plan change.'],
      [409, 'last_login_method', 'This is your only way to log in (409 · last_login_method). Set a password in Profile & security first, then unlink.'],
      [503, 'pricing_unavailable', 'Your identity and plan were not changed: the pricing service isn’t answering (503 · pricing_unavailable). Try again later.'],
    ])('keeps the dialog open and explains a %i %s refusal', async (status, code, text) => {
      api.unlinkOwnIdentity.mockRejectedValue(refusal(status, code));
      renderIdentities('RESEARCH');
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      const dialog = within(await unlinkDialog());
      fireEvent.change(dialog.getByLabelText('Type DOWNGRADE RESEARCH to confirm'), { target: { value: 'DOWNGRADE RESEARCH' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Unlink' }));

      expect(await dialog.findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('lists any other linked sign-in with a way to remove it', async () => {
    api.listOwnIdentities.mockResolvedValue([{ id: 'i2', provider: 'github', subject: 'lucia-v', verifiedAt: '2026-08-01T00:00:00Z' }]);
    renderIdentities();

    expect(await screen.findByRole('heading', { name: 'Other sign-in identities' })).toBeInTheDocument();
    expect(screen.getByText('Verified · linked Aug 1, 2026 · lucia-v')).toBeInTheDocument();
    expect(screen.getByText('Not linked')).toBeInTheDocument();
  });

  it('explains a refused read (403)', async () => {
    api.listOwnIdentities.mockRejectedValue(refusal(403, 'forbidden'));
    renderIdentities();
    expect(await screen.findByRole('alert')).toHaveTextContent('account:write');
  });

  it('says plainly when the identities cannot be loaded, and tries again on request', async () => {
    api.listOwnIdentities.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderIdentities();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was loaded');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Not linked')).toBeInTheDocument();
  });
});
