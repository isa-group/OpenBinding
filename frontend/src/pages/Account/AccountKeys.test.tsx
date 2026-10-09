import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeySummary, UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { AccountKeys } from './AccountKeys';

const api = vi.hoisted(() => ({ listApiKeys: vi.fn(), getOwnUsage: vi.fn(), revokeApiKey: vi.fn(), rotateApiKey: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));

const pablo: UserProfile = {
  id: 'user-id', username: 'pablo', email: 'pablo@example.test', role: 'user', is_active: true, plan: 'PRO', created_at: '2026-05-05T00:00:00Z',
};

const DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;

const reader: ApiKeySummary = {
  id: 'k1', name: 'ci-lectura-resultados', prefix: 'obk_demo0001', created_at: '2026-09-01T00:00:00Z', last_used_at: '2026-10-08T00:00:00Z',
  expires_at: '2099-12-31T00:00:00Z', permissions: ['jobs:read', 'studies:read'], engine_access: { all: true, engines: [] },
  // The API sends null for every restriction that is not set.
  boundary: { methods: ['GET'], organizations: ['isa-demo'], projects: null, resource_kinds: ['jobs', 'studies'], slugs: null } as unknown as ApiKeySummary['boundary'],
};

const runner: ApiKeySummary = {
  id: 'k2', name: 'ejecucion-engine-fijo', prefix: 'obk_demo0002', created_at: '2026-09-10T00:00:00Z', last_used_at: null, expires_at: null,
  permissions: ['engines:read', 'engines:execute'],
  engine_access: { all: false, engines: [{ namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: DIGEST }] },
  boundary: {},
};

const usageWith = (apiKeys: number | null) => ({
  plan: 'PRO', contract_pending: false, features: {}, capabilities: { apiKeys },
  limits: apiKeys === null ? {} : { apiKeys: { limit_id: 'apiKeys', limit: apiKeys, used: 2, remaining: Math.max(0, apiKeys - 2), unit: 'key' } },
});

function renderKeys() {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: pablo, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <AccountKeys />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const card = (name: string) => screen.findByRole('article', { name });

describe('API keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listApiKeys.mockResolvedValue([reader, runner]);
    api.getOwnUsage.mockResolvedValue(usageWith(25));
    api.revokeApiKey.mockResolvedValue(undefined);
  });

  it('lists the keys with their prefix, dates, permissions, engines and limits', async () => {
    renderKeys();

    expect(await screen.findByRole('heading', { level: 1, name: 'API keys' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New key' })).toHaveAttribute('href', '/app/account/keys/new');
    expect(screen.getByRole('link', { name: 'API keys', current: 'page' })).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Active keys' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('2 of 25 keys')).toBeInTheDocument();

    const first = within(await card('ci-lectura-resultados'));
    expect(first.getByText('Active')).toBeInTheDocument();
    expect(first.getByText('obk_demo0001…')).toBeInTheDocument();
    expect(first.getByText('· created Sep 1, 2026 · last used Oct 8, 2026 · expires Dec 31, 2099')).toBeInTheDocument();
    expect(first.getByText('jobs:read')).toBeInTheDocument();
    expect(first.getByText('All engines, including future ones')).toBeInTheDocument();
    for (const label of ['GET only', 'org isa-demo', 'jobs, studies']) expect(first.getByText(label)).toBeInTheDocument();

    const second = within(await card('ejecucion-engine-fijo'));
    expect(second.getByText(/last used never · no expiry/)).toBeInTheDocument();
    expect(second.getByText('Only bim.builtin/random-search@1.0.0 (sha256-b2c3…d4e5)')).toBeInTheDocument();
    expect(second.getByText('No extra limits')).toBeInTheDocument();
  });

  it('marks a key whose expiry has passed', async () => {
    api.listApiKeys.mockResolvedValue([{ ...reader, expires_at: '2020-01-01T00:00:00Z' }]);
    renderKeys();

    const first = within(await card('ci-lectura-resultados'));
    expect(first.getByText('Expired')).toBeInTheDocument();
    expect(first.getByText(/expired Jan 1, 2020/)).toBeInTheDocument();
  });

  it('copies a prefix, which is not a secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderKeys();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy prefix of ci-lectura-resultados' }));

    expect(writeText).toHaveBeenCalledWith('obk_demo0001');
    expect(await screen.findByRole('button', { name: 'Copy prefix of ci-lectura-resultados' })).toHaveTextContent('Copied');
  });

  it('says there are no keys and offers the first one', async () => {
    api.listApiKeys.mockResolvedValue([]);
    renderKeys();

    expect(await screen.findByText('No API keys')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first key' })).toHaveAttribute('href', '/app/account/keys/new');
    expect(screen.getByText('0 of 25 keys')).toBeInTheDocument();
  });

  it('warns when the plan’s key limit is reached, since creating one now returns 402', async () => {
    api.getOwnUsage.mockResolvedValue(usageWith(2));
    renderKeys();

    expect(await screen.findByText(/You’ve reached your plan’s API key limit \(2\)\./)).toBeInTheDocument();
    expect(screen.getByText(/creating one now returns 402/)).toBeInTheDocument();
  });

  it('reads an unlimited plan as unlimited', async () => {
    api.getOwnUsage.mockResolvedValue(usageWith(null));
    renderKeys();
    expect(await screen.findByText('2 of unlimited keys')).toBeInTheDocument();
  });

  describe('revoking', () => {
    it('asks first, and only revokes on confirmation', async () => {
      api.listApiKeys.mockResolvedValueOnce([reader, runner]).mockResolvedValueOnce([runner]);
      renderKeys();

      fireEvent.click(await screen.findByRole('button', { name: 'Revoke ci-lectura-resultados' }));
      const dialog = within(screen.getByRole('dialog', { name: 'Revoke “ci-lectura-resultados”?' }));
      expect(dialog.getByText(/This can’t be undone/)).toBeInTheDocument();
      fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      expect(api.revokeApiKey).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Revoke ci-lectura-resultados' }));
      fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

      await waitFor(() => expect(api.revokeApiKey).toHaveBeenCalledWith('k1'));
      expect(await screen.findByText('“ci-lectura-resultados” was revoked.')).toBeInTheDocument();
      expect(await card('ejecucion-engine-fijo')).toBeInTheDocument();
      expect(screen.queryByRole('article', { name: 'ci-lectura-resultados' })).not.toBeInTheDocument();
    });

    it('says the key is gone when it no longer exists (404) and refreshes the list', async () => {
      api.revokeApiKey.mockRejectedValue(new HttpError(404, 'not_found'));
      api.listApiKeys.mockResolvedValueOnce([reader, runner]).mockResolvedValueOnce([runner]);
      renderKeys();

      fireEvent.click(await screen.findByRole('button', { name: 'Revoke ci-lectura-resultados' }));
      fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

      expect(await screen.findByText('That key no longer exists or isn’t yours (404). The list was refreshed.')).toBeInTheDocument();
      await waitFor(() => expect(api.listApiKeys).toHaveBeenCalledTimes(2));
    });
  });

  describe('rotating', () => {
    const rotated = { ...reader, secret: 'obk_demo0001_ONLY-SHOWN-ONCE' };

    it('shows the new secret once, and only lets it go after it is confirmed as stored', async () => {
      api.rotateApiKey.mockResolvedValue(rotated);
      renderKeys();

      fireEvent.click(await screen.findByRole('button', { name: 'Rotate ci-lectura-resultados' }));
      const confirm = within(screen.getByRole('dialog', { name: 'Rotate “ci-lectura-resultados”?' }));
      expect(confirm.getByText(/the current one stops working immediately/)).toBeInTheDocument();
      fireEvent.click(confirm.getByRole('button', { name: 'Rotate key' }));

      const dialog = await screen.findByRole('dialog', { name: 'Copy your new secret now' });
      expect(within(dialog).getByText('obk_demo0001_ONLY-SHOWN-ONCE')).toBeInTheDocument();
      expect(within(dialog).getByText(/The previous secret of “ci-lectura-resultados” has stopped working; permissions didn’t change\./)).toBeInTheDocument();
      expect(api.rotateApiKey).toHaveBeenCalledWith('k1');

      const done = within(dialog).getByRole('button', { name: 'Done' });
      expect(done).toBeDisabled();
      expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: 'Copy your new secret now' })).toBeInTheDocument();

      fireEvent.click(within(dialog).getByLabelText('I’ve stored the secret somewhere safe'));
      expect(done).toBeEnabled();
      fireEvent.click(done);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain('ONLY-SHOWN-ONCE');
    });

    it('does not rotate on cancel', async () => {
      renderKeys();
      fireEvent.click(await screen.findByRole('button', { name: 'Rotate ci-lectura-resultados' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(api.rotateApiKey).not.toHaveBeenCalled();
    });

    it('reports a key that is gone (404) instead of showing a secret', async () => {
      api.rotateApiKey.mockRejectedValue(new HttpError(404, 'not_found'));
      renderKeys();

      fireEvent.click(await screen.findByRole('button', { name: 'Rotate ci-lectura-resultados' }));
      fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

      expect(await screen.findByText('That key no longer exists or isn’t yours (404). The list was refreshed.')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('explains a refused read (403)', async () => {
    api.listApiKeys.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderKeys();
    expect(await screen.findByRole('alert')).toHaveTextContent('keys:read');
  });

  it('says plainly when the keys cannot be loaded, and tries again on request', async () => {
    api.listApiKeys.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderKeys();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was loaded');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await card('ci-lectura-resultados')).toBeInTheDocument();
  });
});
