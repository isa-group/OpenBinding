import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import type { EngineCatalogEntry } from '../../api/client';
import { Account } from './Account';

const api = vi.hoisted(() => ({
  getOwnUsage: vi.fn(),
  listApiKeys: vi.fn(),
  listOwnJobs: vi.fn(),
  getEngines: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  getJobStatus: vi.fn(),
  listOwnIdentities: vi.fn(),
  listNotifications: vi.fn(),
  getNotificationPreferences: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  user: null as UserProfile | null,
  refresh: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

const user: UserProfile = {
  id: 'user-id',
  username: 'alice',
  email: 'alice@example.test',
  role: 'user',
  is_active: true,
  plan: 'FREE',
  created_at: '2026-01-01T00:00:00Z',
};

const engine: EngineCatalogEntry = {
  id: 'bim.builtin/solver',
  namespace: 'bim.builtin',
  name: 'solver',
  version: '1.0.0',
  digest: `sha256-${'a'.repeat(64)}`,
  ref: {
    namespace: 'bim.builtin',
    name: 'solver',
    version: '1.0.0',
    digest: `sha256-${'a'.repeat(64)}`,
  },
  modes: [],
};

describe('granular API-key creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = user;
    api.getOwnUsage.mockResolvedValue({
      plan: 'FREE',
      contract_pending: false,
      features: { solve: true },
      capabilities: { maxTimeoutSeconds: 300, maxPayloadBytes: 16_777_216 },
      limits: {},
    });
    api.listApiKeys.mockResolvedValue([]);
    api.listOwnJobs.mockResolvedValue({ jobs: [], total: 0, retention_days: 7 });
    api.getEngines.mockResolvedValue([engine]);
    api.listOwnIdentities.mockResolvedValue([]);
    api.listNotifications.mockResolvedValue([]);
    api.getNotificationPreferences.mockResolvedValue({
      inbox: true,
      email_contract_changes: true,
      email_invitations: true,
      email_job_failures: false,
    });
    api.createApiKey.mockResolvedValue({
      id: 'key-id',
      name: 'automation',
      prefix: 'obk_12345678',
      secret: 'obk_12345678_secret',
      created_at: '2026-01-01T00:00:00Z',
      permissions: ['engines:read'],
      engine_access: { all: false, engines: [engine.ref] },
    });
  });

  it('sends the selected permissions and exact Engine revisions', async () => {
    render(<MemoryRouter><Account /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('What this key is for'), {
      target: { value: 'automation' },
    });
    fireEvent.click(screen.getByLabelText(/Read Engines/));
    fireEvent.click(await screen.findByLabelText(/bim\.builtin\/solver/));
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() => expect(api.createApiKey).toHaveBeenCalledWith({
      name: 'automation',
      permissions: ['engines:read'],
      engine_access: { all: false, engines: [engine.ref] },
    }));
    expect(await screen.findByText('obk_12345678_secret')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Administer accounts/)).not.toBeInTheDocument();
  });

  it('requires a permission before creating a key', async () => {
    render(<MemoryRouter><Account /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('Choose at least one permission for this key.')).toBeInTheDocument();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });
});
