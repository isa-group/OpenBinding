import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, apiClient } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { clearSessionEnded, forgetCasExchanges, forgetCasFlow, forgetPlanChanged, peekPlanChanged, readCasFlow, rememberCasFlow } from '../../utils/authFlow';
import { CasCallback } from './CasCallback';

const exchange = vi.spyOn(apiClient, 'exchangeCasCode');

const person = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  id: 'u1', username: 'lucia', email: 'lucia@example.org', role: 'user', plan: 'FREE', is_active: true,
  created_at: '2026-01-01T00:00:00Z', ...overrides,
});

function problem(status: number, code?: string) {
  const error = new HttpError(status, 'refused');
  error.code = code;
  return error;
}

function renderAt(search: string, user: UserProfile | null = person()) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <MemoryRouter initialEntries={[`/auth/cas/callback${search}`]}>
      <AuthContext.Provider
        value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh, isAdmin: false }}
      >
        <Routes>
          <Route path="/auth/cas/callback" element={<CasCallback />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return { refresh, view };
}

describe('CasCallback', () => {
  beforeEach(() => {
    exchange.mockReset();
    clearSessionEnded();
    forgetCasFlow();
    forgetCasExchanges();
    forgetPlanChanged();
  });

  describe('a plan changed by signing in', () => {
    it('keeps the change the exchange reports, for the screen the person lands on', async () => {
      exchange.mockResolvedValue({ from: 'BASIC', to: 'RESEARCH', extra_cost: false });
      renderAt('?code=one-time-code&plan_changed=RESEARCH');

      await screen.findByRole('heading', { name: 'You’re signed in' });
      expect(peekPlanChanged()).toEqual({ from: 'BASIC', to: 'RESEARCH', extraCost: false });
    });

    it('takes the redirect’s plan_changed when the exchange says nothing', async () => {
      exchange.mockResolvedValue(null);
      renderAt('?code=one-time-code&plan_changed=RESEARCH');

      await screen.findByRole('heading', { name: 'You’re signed in' });
      expect(peekPlanChanged()).toEqual({ from: null, to: 'RESEARCH', extraCost: false });
    });

    it('keeps nothing when the plan did not change, and ignores a value that is not a plan name', async () => {
      exchange.mockResolvedValue(null);
      renderAt('?code=plain');
      await screen.findByRole('heading', { name: 'You’re signed in' });
      expect(peekPlanChanged()).toBeNull();

      forgetCasExchanges();
      renderAt('?code=other&plan_changed=%3Cb%3Eboom%3C%2Fb%3E');
      await waitFor(() => expect(screen.getAllByRole('heading', { name: 'You’re signed in' })).toHaveLength(2));
      expect(exchange).toHaveBeenCalledTimes(2);
      expect(peekPlanChanged()).toBeNull();
    });

    it('keeps nothing when the exchange fails', async () => {
      exchange.mockRejectedValue(problem(401, 'cas_code_invalid'));
      renderAt('?code=spent&plan_changed=RESEARCH', null);

      await screen.findByRole('alert');
      expect(peekPlanChanged()).toBeNull();
    });
  });

  it.each([
    ['cas_unavailable', 'Institutional sign-in is unavailable right now (503).', true],
    ['cas_state_invalid', 'This sign-in attempt has expired (cas_state_invalid).', true],
    ['cas_ticket_invalid', 'The university didn’t accept this sign-in (cas_ticket_invalid).', true],
    ['account_inactive', 'This account is deactivated (account_inactive).', false],
    ['identity_in_use', 'This identity is already linked to another account.', false],
    ['account_collision', 'An account with these details already exists.', false],
    ['pricing_unavailable', 'The pricing service didn’t answer (503 · pricing_unavailable).', true],
    ['institutional_pricing_invalid', 'Institutional sign-in is paused (503 · institutional_pricing_invalid).', false],
    ['cas_error', 'The sign-in couldn’t be finished (cas_error).', true],
  ])('names the failure the gateway reports as ?error=%s, and says what to do next', (reportedCode, title, canRetry) => {
    renderAt(`?error=${reportedCode}`, null);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(exchange).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
    const retry = screen.queryByRole('link', { name: 'Try again' });
    if (canRetry) expect(retry).toHaveAttribute('href', expect.stringContaining('/v1/auth/cas/start?mode=login'));
    else expect(retry).not.toBeInTheDocument();
  });

  it('sends a signed-in person back to Identities to try linking again', () => {
    rememberCasFlow('link');
    renderAt('?error=cas_ticket_invalid');

    expect(screen.getByRole('link', { name: 'Try again from Account › Identities' })).toHaveAttribute('href', '/app/account/identities');
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('remembers where the person was heading when they try the CAS sign-in again', () => {
    rememberCasFlow('login', '/app/org/project');
    renderAt('?error=cas_state_invalid', null);

    // The browser would leave for the university; the test only watches what is remembered on the way out.
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(screen.getByRole('link', { name: 'Try again' }));
    expect(readCasFlow()).toEqual({ mode: 'login', returnTo: '/app/org/project' });
  });

  it('exchanges the one-time code once and refreshes the session', async () => {
    exchange.mockResolvedValue(null);
    const { refresh } = renderAt('?code=one-time-code');

    expect(screen.getByRole('heading', { name: 'Finishing sign-in…' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'You’re signed in' })).toBeInTheDocument();
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith('one-time-code');
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText('Universidad de Sevilla · CAS · log in')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('link', { name: 'Account › Identities' })).toHaveAttribute('href', '/app/account/identities');
  });

  it('keeps the plan the account has when it is not institutional', async () => {
    exchange.mockResolvedValue(null);
    renderAt('?code=one-time-code', person({ plan: 'FREE' }));

    expect(await screen.findByText(/Your plan stays FREE; RESEARCH applies only when the pricing grants it\./)).toBeInTheDocument();
    expect(screen.queryByText('Universidad de Sevilla · verified')).not.toBeInTheDocument();
  });

  it('shows the institution mark only when the account is institutional, never from the email', async () => {
    exchange.mockResolvedValue(null);
    renderAt('?code=one-time-code', person({ plan: 'RESEARCH', email: 'lucia@us.es' }));

    expect(await screen.findByText('Universidad de Sevilla · verified')).toBeInTheDocument();
    expect(screen.getByText(/qualifies for RESEARCH under the current pricing/)).toBeInTheDocument();
    expect(screen.getByAltText('Universidad de Sevilla')).toHaveAttribute('src', '/brands/us-fama.png');
    expect(screen.getByText(/it doesn’t give admin or organization permissions/)).toBeInTheDocument();
  });

  it('does not take an e-mail at us.es for an institutional account', async () => {
    exchange.mockResolvedValue(null);
    renderAt('?code=one-time-code', person({ plan: 'FREE', email: 'lucia@us.es' }));

    await screen.findByRole('heading', { name: 'You’re signed in' });
    expect(screen.queryByAltText('Universidad de Sevilla')).not.toBeInTheDocument();
  });

  it('takes the “link identity” flow back to the identities screen', async () => {
    rememberCasFlow('link');
    exchange.mockResolvedValue(null);
    renderAt('?code=one-time-code');

    expect(screen.getByText('Universidad de Sevilla · CAS · link identity')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Identity linked' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to my account' })).toHaveAttribute('href', '/app/account/identities');
    expect(readCasFlow()).toBeNull();
  });

  it('goes where the person was heading when the login started', async () => {
    rememberCasFlow('login', '/app/org/project');
    exchange.mockResolvedValue(null);
    renderAt('?code=one-time-code');

    expect(await screen.findByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app/org/project');
  });

  it('does not spend the code twice when the screen is mounted again after it signed the person in', async () => {
    // Signing in changes the account, and the interface below the account provider is mounted again.
    rememberCasFlow('login', '/app/org/project');
    exchange.mockResolvedValue(null);
    const { view } = renderAt('?code=one-time-code');
    await screen.findByRole('heading', { name: 'You’re signed in' });

    view.unmount();
    renderAt('?code=one-time-code');

    expect(await screen.findByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app/org/project');
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('shows the same refusal to a screen that is mounted again, without asking again', async () => {
    exchange.mockRejectedValue(problem(401, 'cas_code_invalid'));
    const { view } = renderAt('?code=spent', null);
    await screen.findByRole('alert');

    view.unmount();
    renderAt('?code=spent', null);

    expect(await screen.findByRole('alert')).toHaveTextContent('This code can’t be used.');
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('explains the missing code and offers the way back', () => {
    renderAt('');

    expect(screen.getByRole('heading', { name: 'There’s no code to finish sign-in' })).toBeInTheDocument();
    expect(exchange).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
  });

  it('says a code was invalid or already used', async () => {
    exchange.mockRejectedValue(problem(401, 'cas_code_invalid'));
    renderAt('?code=spent', null);

    expect(await screen.findByRole('alert')).toHaveTextContent('This code can’t be used.');
    expect(screen.getByRole('heading', { name: 'Sign-in stopped' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toBeInTheDocument();
  });

  it('names the invalid institutional pricing (503) and points to the password log in', async () => {
    exchange.mockRejectedValue(problem(503, 'institutional_pricing_invalid'));
    renderAt('?code=any', null);

    expect(await screen.findByRole('alert')).toHaveTextContent('Institutional sign-in is paused (503 · institutional_pricing_invalid).');
    expect(screen.getByText(/You can still log in with a password\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Service status' })).toHaveAttribute('href', '/status');
  });

  it('reports a CAS outage without blaming the code', async () => {
    exchange.mockRejectedValue(problem(503, 'cas_unavailable'));
    renderAt('?code=any', null);

    expect(await screen.findByRole('alert')).toHaveTextContent('Institutional sign-in is unavailable right now (503).');
  });

  it('explains an identity that is already linked to another account', async () => {
    exchange.mockRejectedValue(problem(409, 'identity_in_use'));
    renderAt('?code=any');

    expect(await screen.findByRole('heading', { name: 'This identity can’t be used here' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('This identity is already linked to another account.');
    expect(screen.getByRole('link', { name: 'Go to Account › Identities' })).toHaveAttribute('href', '/app/account/identities');
  });

  it('reads a failure the gateway reported in the address, when it does', () => {
    renderAt('?error=identity_in_use');

    expect(screen.getByRole('status')).toHaveTextContent('This identity is already linked to another account.');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('never renders what the address says about an error, only what it recognises', () => {
    renderAt('?error=%3Cb%3Eboom%3C%2Fb%3E', null);

    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This code can’t be used.');
  });

  it('forgets a remembered flow when the page was opened without a code', async () => {
    rememberCasFlow('link');
    renderAt('');

    await waitFor(() => expect(readCasFlow()).toBeNull());
  });
});
