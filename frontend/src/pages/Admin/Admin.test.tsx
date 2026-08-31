import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import type { EngineRegistrationRevision } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { Admin } from './Admin';

const api = vi.hoisted(() => ({
  adminListUsers: vi.fn(),
  adminListEngineRegistrations: vi.fn(),
  adminGetUserUsage: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  adminApproveEngineRegistration: vi.fn(),
  adminRejectEngineRegistration: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const self: UserProfile = {
  id: 'admin-id',
  username: 'admin',
  email: 'admin@example.test',
  role: 'admin',
  is_active: true,
  plan: 'PRO',
  created_at: '2026-01-01T00:00:00Z',
};

function registration(namespace: string, name: string, status: EngineRegistrationRevision['status']): EngineRegistrationRevision {
  return { namespace, name, version: '1.0.0', digest: `sha256-${name.padEnd(64, 'a').slice(0, 64)}`, status, active: true };
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('tr')!;
}

describe('EngineRegistration administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.adminListUsers.mockResolvedValue({ users: [], total: 0, offset: 0, limit: 25 });
    api.adminListEngineRegistrations.mockResolvedValue([
      registration('alice', 'pending-foreign', 'pending_review'),
    ]);
    api.getEngineRegistrationReport.mockResolvedValue({
      ...registration('alice', 'pending-foreign', 'pending_review'),
      openapiDigest: `sha256-${'b'.repeat(64)}`,
      openapi: { openapi: '3.1.0' },
      engine: { apiVersion: 'bim/v1', kind: 'Engine', metadata: { namespace: 'alice', name: 'solver', version: '1.0.0' }, spec: { modes: [] } },
      report: { status: 'verified' },
    });
    api.adminApproveEngineRegistration.mockResolvedValue(registration('alice', 'pending-foreign', 'published'));
    api.adminRejectEngineRegistration.mockResolvedValue(registration('alice', 'pending-foreign', 'rejected'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows only explicit publication requests and moderation actions', async () => {
    render(
      <MemoryRouter>
        <AuthContext.Provider value={{
          user: self,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          isAdmin: true,
        }}>
          <Admin />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.adminListEngineRegistrations).toHaveBeenCalled());
    expect(api.adminListEngineRegistrations).toHaveBeenCalledWith();
    expect(screen.queryByText('Show every registration')).not.toBeInTheDocument();
    expect(within(row('alice/pending-foreign')).getByRole('button', { name: 'Review contract' })).toBeInTheDocument();
    expect(within(row('alice/pending-foreign')).getByRole('button', { name: 'Approve publication' })).toBeInTheDocument();
    expect(within(row('alice/pending-foreign')).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    fireEvent.click(within(row('alice/pending-foreign')).getByRole('button', { name: 'Review contract' }));
    expect(await screen.findByText('Verification report')).toBeInTheDocument();
    expect(api.getEngineRegistrationReport).toHaveBeenCalledOnce();

    fireEvent.click(within(row('alice/pending-foreign')).getByRole('button', { name: 'Approve publication' }));
    await waitFor(() => expect(api.adminApproveEngineRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'alice', name: 'pending-foreign', status: 'pending_review' }),
    ));
  });

  it('requires confirmation before rejecting a publication request', async () => {
    render(
      <MemoryRouter>
        <AuthContext.Provider value={{
          user: self,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          isAdmin: true,
        }}>
          <Admin />
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.adminListEngineRegistrations).toHaveBeenCalled());

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(within(row('alice/pending-foreign')).getByRole('button', { name: 'Reject' }));
    expect(api.adminRejectEngineRegistration).not.toHaveBeenCalled();

    fireEvent.click(within(row('alice/pending-foreign')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.adminRejectEngineRegistration).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledWith('Reject publication of alice/pending-foreign? The registration will become private to its owner again.');
  });
});
