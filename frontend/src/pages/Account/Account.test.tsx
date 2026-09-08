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
  markAllNotificationsRead: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateOwnProfile: vi.fn(),
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
  }, 15000);

  it('requires a permission before creating a key', async () => {
    render(<MemoryRouter><Account /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('Choose at least one permission for this key.')).toBeInTheDocument();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it('renders top-level key metrics summary bar with plan, quota, keys, and solves', async () => {
    api.getOwnUsage.mockResolvedValue({
      plan: 'FREE',
      contract_pending: false,
      features: { solve: true },
      capabilities: { maxTimeoutSeconds: 300, maxPayloadBytes: 16_777_216 },
      limits: {
        solves: { limit_id: 'solves', limit: 100, used: 25, unit: 'jobs', renews_at: '2026-10-01T00:00:00Z' },
      },
    });
    api.listApiKeys.mockResolvedValue([
      {
        id: 'key-1',
        name: 'test-key',
        prefix: 'obk_abc12345',
        created_at: '2026-01-01T00:00:00Z',
        permissions: ['engines:read'],
        engine_access: { all: true, engines: [] },
      },
    ]);
    api.listOwnJobs.mockResolvedValue({
      jobs: [
        {
          id: 'job-1',
          engine_id: 'bim.builtin/solver',
          status: 'completed',
          termination: 'OPTIMAL',
          solutions: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
      retention_days: 14,
    });

    render(<MemoryRouter><Account /></MemoryRouter>);

    expect(await screen.findByText('Account & Security Hub')).toBeInTheDocument();
    expect(screen.getByText('Active Plan')).toBeInTheDocument();
    expect(screen.getByText('Quota Consumption')).toBeInTheDocument();
    expect(screen.getByText('Active API Keys')).toBeInTheDocument();
    expect(screen.getByText('Recent Solves')).toBeInTheDocument();

    // Check values in metrics
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('14d Window')).toBeInTheDocument();
  });

  it('allows navigating between category tabs', async () => {
    render(<MemoryRouter><Account /></MemoryRouter>);

    const overviewTab = await screen.findByRole('tab', { name: /Overview & Quotas/i });
    const servicesTab = screen.getByRole('tab', { name: /Connected Services/i });
    const keysTab = screen.getByRole('tab', { name: /API Keys/i });
    const historyTab = screen.getByRole('tab', { name: /Execution History/i });

    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    expect(servicesTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(servicesTab);
    expect(servicesTab).toHaveAttribute('aria-selected', 'true');
    expect(overviewTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(keysTab);
    expect(keysTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(historyTab);
    expect(historyTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders institutional US branding when account has research affiliation', async () => {
    auth.user = {
      ...user,
      plan: 'RESEARCH',
      institutional_branding: true,
    };

    render(<MemoryRouter><Account /></MemoryRouter>);

    expect(await screen.findByText('Campus US')).toBeInTheDocument();
    expect(screen.getAllByText('Universidad de Sevilla').length).toBeGreaterThanOrEqual(1);
  });

  it('supports deep linking to tabs via URL search parameters', async () => {
    render(
      <MemoryRouter initialEntries={['/app/account?tab=keys']}>
        <Account />
      </MemoryRouter>,
    );

    const keysTab = await screen.findByRole('tab', { name: /API Keys/i });
    expect(keysTab).toHaveAttribute('aria-selected', 'true');
    const overviewTab = screen.getByRole('tab', { name: /Overview & Quotas/i });
    expect(overviewTab).toHaveAttribute('aria-selected', 'false');
  });

  it('switches to corresponding tabs when metric cards are clicked', async () => {
    render(<MemoryRouter><Account /></MemoryRouter>);

    expect(await screen.findByText('Account & Security Hub')).toBeInTheDocument();
    const keysMetricCard = screen.getByRole('button', { name: /Active API Keys/i });
    fireEvent.click(keysMetricCard);

    const keysTab = screen.getByRole('tab', { name: /API Keys/i });
    expect(keysTab).toHaveAttribute('aria-selected', 'true');
  });

  it('updates email and password with current password verification', async () => {
    api.updateOwnProfile.mockResolvedValue({
      ...user,
      email: 'newalice@example.test',
    });
    const { container } = render(<MemoryRouter><Account /></MemoryRouter>);

    expect(await screen.findByText('Security & Credentials')).toBeInTheDocument();

    const currentPwdInput = container.querySelector('#sec-current-pwd')!;
    const emailInput = container.querySelector('#sec-email')!;
    const newPwdInput = container.querySelector('#sec-new-pwd')!;
    const confirmPwdInput = container.querySelector('#sec-confirm-pwd')!;

    fireEvent.change(currentPwdInput, {
      target: { value: 'old-password-123' },
    });
    fireEvent.change(emailInput, {
      target: { value: 'newalice@example.test' },
    });
    fireEvent.change(newPwdInput, {
      target: { value: 'new-secure-password' },
    });
    fireEvent.change(confirmPwdInput, {
      target: { value: 'new-secure-password' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update Credentials' }));

    await waitFor(() => {
      expect(api.updateOwnProfile).toHaveBeenCalledWith({
        email: 'newalice@example.test',
        current_password: 'old-password-123',
        new_password: 'new-secure-password',
      });
    });
  });

  it('validates password mismatch before calling API', async () => {
    const { container } = render(<MemoryRouter><Account /></MemoryRouter>);

    expect(await screen.findByText('Security & Credentials')).toBeInTheDocument();

    const currentPwdInput = container.querySelector('#sec-current-pwd')!;
    const newPwdInput = container.querySelector('#sec-new-pwd')!;
    const confirmPwdInput = container.querySelector('#sec-confirm-pwd')!;

    fireEvent.change(currentPwdInput, {
      target: { value: 'old-password-123' },
    });
    fireEvent.change(newPwdInput, {
      target: { value: 'new-password-one' },
    });
    fireEvent.change(confirmPwdInput, {
      target: { value: 'different-password' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update Credentials' }));

    expect(await screen.findByText('New password and confirm password do not match.')).toBeInTheDocument();
    expect(api.updateOwnProfile).not.toHaveBeenCalled();
  });
});
