import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, type EngineRegistrationRevision } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { EngRegistrations } from './EngRegistrations';
import {
  EDGE_SOLVER, PAUSED_SOLVER, REPORT_FAILED, REPORT_PENDING, REPORT_VERIFIED, SHARED_SOLVER, SOLVER_IN_REVIEW, reportOf, usageOf,
} from './fixtures';

const api = vi.hoisted(() => ({
  listEngineRegistrations: vi.fn(),
  adminListEngineRegistrations: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  getOwnUsage: vi.fn(),
  activateEngineRegistration: vi.fn(),
  deactivateEngineRegistration: vi.fn(),
  requestEngineRegistrationPublication: vi.fn(),
  deleteEngineRegistration: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const lucia: UserProfile = {
  id: 'lucia-id', username: 'lucia.vega', email: 'lucia@example.test', role: 'user', plan: 'RESEARCH', is_active: true, created_at: '2026-01-01T00:00:00Z',
};
const iker: UserProfile = { ...lucia, id: 'iker-id', username: 'iker.mora', role: 'admin' };

// The first render of a file is slow on a busy machine.
configure({ asyncUtilTimeout: 5000 });

function refusal(status: number, code: string, diagnostics: unknown[] = []): HttpError {
  const error = new HttpError(status, code);
  error.code = code;
  error.diagnostics = diagnostics;
  return error;
}

function renderPage(options: { user?: UserProfile; entry?: string } = {}) {
  const user = options.user ?? lucia;
  return render(
    <MemoryRouter initialEntries={[options.entry ?? '/app/engines/registrations']}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        <EngRegistrations />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const MINE = [EDGE_SOLVER, PAUSED_SOLVER, SOLVER_IN_REVIEW, SHARED_SOLVER];

function row(name: string, version: string) {
  return screen.getByRole('row', { name: `${name} ${version}` });
}

describe('eng-registrations · my engines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listEngineRegistrations.mockResolvedValue(MINE);
    api.adminListEngineRegistrations.mockResolvedValue([SOLVER_IN_REVIEW]);
    api.getOwnUsage.mockResolvedValue(usageOf('RESEARCH', 3, 5));
    api.getEngineRegistrationReport.mockImplementation(async (ref: EngineRegistrationRevision) => (
      reportOf(ref, ref.name === 'edge-solver' ? REPORT_VERIFIED : ref.name === 'paused-solver' ? REPORT_FAILED : REPORT_PENDING)
    ));
    api.activateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: true }));
    api.deactivateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: false }));
    api.requestEngineRegistrationPublication.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'pending_review' }));
    api.deleteEngineRegistration.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists each registration with its use, its publication state and the result of its last check', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'My engines' })).toBeInTheDocument();
    const edge = await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    expect(within(edge).getByRole('link', { name: 'edge-solver' })).toHaveAttribute('href', expect.stringContaining('/app/engines/registrations/edge-solver?namespace=lucia.vega&version=0.3.1&digest=sha256-'));
    expect(within(edge).getByText('Active')).toBeInTheDocument();
    expect(within(edge).getByText('Private')).toBeInTheDocument();
    expect(await within(edge).findByText('Passed')).toBeInTheDocument();
    expect(await within(row('paused-solver', '1.2.0')).findByText('Failed')).toBeInTheDocument();
    expect(within(row('paused-solver', '1.2.0')).getByText('Inactive')).toBeInTheDocument();
    expect(await within(row('region-solver', '1.0.0')).findByText('Not checked yet')).toBeInTheDocument();
    expect(within(row('region-solver', '1.0.0')).getByText('Waiting for review')).toBeInTheDocument();
  });

  it('shows the room the plan leaves for federated engines, with a way to the usage page', async () => {
    renderPage();
    expect(await screen.findByText('3 of 5 used')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all your limits' })).toHaveAttribute('href', '/app/account/usage');
    expect(screen.getByRole('link', { name: 'Register an engine' })).toHaveAttribute('href', '/app/engines/new');
  });

  it('gives a published engine of someone else no owner actions', async () => {
    renderPage();
    const shared = await screen.findByRole('row', { name: 'shared-solver 2.0.0' });
    expect(within(shared).getByText(/published by another account/)).toBeInTheDocument();
    expect(within(shared).getByText('Published')).toBeInTheDocument();
    expect(within(shared).queryByRole('button')).not.toBeInTheDocument();
    expect(within(shared).queryByRole('link', { name: /credential/i })).not.toBeInTheDocument();
  });

  it('narrows the list by use and publication', async () => {
    renderPage();
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    const filters = screen.getByRole('group', { name: 'Filter' });
    fireEvent.click(within(filters).getByRole('button', { name: 'Inactive' }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('row', { name: 'paused-solver 1.2.0' })).toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: 'Waiting for review' }));
    expect(screen.getByRole('row', { name: 'region-solver 1.0.0' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'edge-solver 0.3.1' })).not.toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: 'Published' }));
    expect(screen.getByRole('row', { name: 'shared-solver 2.0.0' })).toBeInTheDocument();
  });

  it('says so when nothing matches a filter', async () => {
    api.listEngineRegistrations.mockResolvedValue([EDGE_SOLVER]);
    renderPage();
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter' })).getByRole('button', { name: 'Published' }));
    expect(screen.getByText('No engine matches this filter')).toBeInTheDocument();
  });

  it('invites the first registration when there is none', async () => {
    api.listEngineRegistrations.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('You haven’t registered an engine')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Register an engine' })).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Engine registrations' })).not.toBeInTheDocument();
  });

  it('keeps accounts being unavailable (503) apart from an empty list, and retries', async () => {
    api.listEngineRegistrations.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderPage();
    expect(await screen.findByText('Accounts are unavailable right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('You haven’t registered an engine')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('row', { name: 'edge-solver 0.3.1' })).toBeInTheDocument();
  });

  it('asks the person to log in again when the session ended (401)', async () => {
    api.listEngineRegistrations.mockRejectedValue(refusal(401, 'unauthorized'));
    renderPage();
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in again' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('region', { name: 'Engine registrations' })).not.toBeInTheDocument();
  });

  it('turns a review link down for someone who is not an administrator (403) and shows their own engines instead', async () => {
    api.adminListEngineRegistrations.mockRejectedValue(refusal(403, 'forbidden'));
    renderPage({ entry: '/app/engines/registrations?review=true' });
    expect(await screen.findByText('Only administrators can filter by “waiting for review” (403)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Only waiting for review/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show my engines' }));
    expect(await screen.findByRole('row', { name: 'edge-solver 0.3.1' })).toBeInTheDocument();
  });

  it('lets an administrator list only what waits for review, with a way to review it', async () => {
    renderPage({ user: iker });
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    fireEvent.click(screen.getByLabelText(/Only waiting for review/));
    const waiting = await screen.findByRole('row', { name: 'region-solver 1.0.0' });
    expect(api.adminListEngineRegistrations).toHaveBeenCalledOnce();
    expect(within(waiting).getByRole('link', { name: 'Review region-solver 1.0.0' })).toHaveAttribute('href', '/app/admin/moderation');
    expect(screen.queryByRole('row', { name: 'edge-solver 0.3.1' })).not.toBeInTheDocument();

    api.adminListEngineRegistrations.mockResolvedValue([]);
    fireEvent.click(screen.getByLabelText(/Only waiting for review/));
    fireEvent.click(screen.getByLabelText(/Only waiting for review/));
    expect(await screen.findByText('Nothing is waiting for review')).toBeInTheDocument();
  });

  it('activates a registration, which re-checks it, and reloads the list', async () => {
    renderPage();
    await screen.findByRole('row', { name: 'paused-solver 1.2.0' });
    fireEvent.click(screen.getByRole('button', { name: 'Activate paused-solver 1.2.0' }));
    expect(await screen.findByText('paused-solver passed its check and is active for you.')).toBeInTheDocument();
    expect(api.activateEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ name: 'paused-solver' }));
    await waitFor(() => expect(api.listEngineRegistrations).toHaveBeenCalledTimes(2));
  });

  it('says when an activation is refused because the deployment does not conform, and points at the checks', async () => {
    api.activateEngineRegistration.mockRejectedValueOnce(refusal(409, 'conformance_failed', REPORT_FAILED.checks));
    renderPage();
    await screen.findByRole('row', { name: 'paused-solver 1.2.0' });
    fireEvent.click(screen.getByRole('button', { name: 'Activate paused-solver 1.2.0' }));
    expect(await screen.findByText('Your deployment didn’t pass (409 · conformance_failed)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the checks' })).toHaveAttribute('href', expect.stringContaining('/app/engines/registrations/paused-solver?'));
    expect(screen.getByText(/engine did not solve the deterministic conformance problem/)).toBeInTheDocument();
  });

  it('deactivates a private registration at once', async () => {
    renderPage();
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate edge-solver 0.3.1' }));
    expect(await screen.findByText('Deactivated. You can’t pick it for new jobs until you activate it again.')).toBeInTheDocument();
    expect(api.deactivateEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver' }));
  });

  it('asks before requesting publication, and not at all for a registration that is inactive', async () => {
    renderPage();
    await screen.findByRole('row', { name: 'paused-solver 1.2.0' });
    fireEvent.click(screen.getByRole('button', { name: 'Request publication of paused-solver 1.2.0' }));
    expect(screen.getByText('Activate it first')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.requestEngineRegistrationPublication).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Request publication of edge-solver 0.3.1' }));
    const dialog = screen.getByRole('dialog', { name: 'Request publication of edge-solver?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request publication' }));
    expect(await screen.findByText('Publication requested. An administrator will review it.')).toBeInTheDocument();
    expect(api.requestEngineRegistrationPublication).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the 409 the gateway gives when publication cannot be requested', async () => {
    api.requestEngineRegistrationPublication.mockRejectedValueOnce(refusal(409, 'registration_inactive'));
    renderPage();
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    fireEvent.click(screen.getByRole('button', { name: 'Request publication of edge-solver 0.3.1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Request publication' }));
    expect(await screen.findByText('It’s inactive (409 · registration_inactive)')).toBeInTheDocument();
  });

  it('deletes only after the registration’s name is typed', async () => {
    renderPage();
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete edge-solver 0.3.1' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete edge-solver 0.3.1?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete registration' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'edge' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'edge-solver' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await screen.findByText('Deleted edge-solver 0.3.1.')).toBeInTheDocument();
    expect(api.deleteEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver' }));
  });

  it('opens the credential from the list, where it can be replaced, and offers it only while the registration can change', async () => {
    api.listEngineRegistrations.mockResolvedValue([EDGE_SOLVER, { ...EDGE_SOLVER, name: 'live-solver', status: 'published' as const }]);
    renderPage();
    const edge = await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    expect(within(edge).getByRole('link', { name: 'Replace the credential of edge-solver 0.3.1' })).toHaveAttribute('href', expect.stringMatching(/#credential$/));
    expect(within(screen.getByRole('row', { name: 'live-solver 0.3.1' })).queryByRole('link', { name: /credential/ })).not.toBeInTheDocument();
  });

  it('asks before pausing a published engine that others may be using', async () => {
    api.listEngineRegistrations.mockResolvedValue([{ ...EDGE_SOLVER, status: 'published' as const }]);
    renderPage();
    await screen.findByRole('row', { name: 'edge-solver 0.3.1' });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate edge-solver 0.3.1' }));
    expect(api.deactivateEngineRegistration).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Deactivate edge-solver?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Deactivated. Nobody can pick it for new jobs until you activate it again.')).toBeInTheDocument();
  });
});
