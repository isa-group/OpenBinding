import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { Home } from './Home';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  getDialects: vi.fn(),
  getEngines: vi.fn(),
}));

const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../api/client', () => ({ apiClient: api }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

describe('Home runtime catalogue visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    api.getProfiles.mockResolvedValue([{ id: 'qos-binding/v1' }]);
    api.getDialects.mockResolvedValue([{ id: 'json' }]);
    api.getEngines.mockResolvedValue([{ id: 'bim.builtin/test' }]);
  });

  it('does not request the protected Engine catalogue anonymously', async () => {
    render(<MemoryRouter><Home /></MemoryRouter>);

    expect(await screen.findByText('Sign in to inspect engine revisions')).toBeInTheDocument();
    expect(api.getProfiles).toHaveBeenCalledOnce();
    expect(api.getDialects).toHaveBeenCalledOnce();
    expect(api.getEngines).not.toHaveBeenCalled();
  });

  it('includes Engine revisions for a signed-in account', async () => {
    auth.user = {
      id: 'alice-id',
      username: 'alice',
      email: 'alice@example.test',
      role: 'user',
      plan: 'FREE',
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    render(<MemoryRouter><Home /></MemoryRouter>);

    expect(await screen.findByText('1 engine revision')).toBeInTheDocument();
    expect(api.getEngines).toHaveBeenCalledOnce();
  });
});
