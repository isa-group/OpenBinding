import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import type { EngineCatalogEntry, EngineMode, EngineRegistrationRevision } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { AppEngines } from './AppEngines';

const api = vi.hoisted(() => ({
  getEngines: vi.fn(),
  listEngineRegistrations: vi.fn(),
  activateEngineRegistration: vi.fn(),
  deactivateEngineRegistration: vi.fn(),
  requestEngineRegistrationPublication: vi.fn(),
  deleteEngineRegistration: vi.fn(),
  setEngineRegistrationCredential: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

// Mock recharts to render simple placeholder
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="recharts-container">{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div data-testid="barchart">{children}</div>,
  Bar: () => <div data-testid="bar" />,
  XAxis: () => <div data-testid="xaxis" />,
  YAxis: () => <div data-testid="yaxis" />,
  Tooltip: () => <div data-testid="tooltip" />,
}));

const user: UserProfile = {
  id: 'user-id',
  username: 'researcher',
  email: 'researcher@example.test',
  role: 'user',
  is_active: true,
  plan: 'PRO',
  created_at: '2026-01-01T00:00:00Z',
};

function registration(
  name: string,
  status: EngineRegistrationRevision['status'],
  active = false,
  namespace = 'researcher',
): EngineRegistrationRevision {
  return {
    namespace,
    name,
    version: '1.0.0',
    digest: `sha256-${name.padEnd(64, 'a').slice(0, 64)}`,
    status,
    active,
  };
}

function mode(id: string): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id,
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm: `${id}-algo`,
    capabilities: {
      workflowNodes: all,
      metricScopes: all,
      aggregations: all,
      constraints: all,
      optimization: all,
      objectiveTypes: all,
      expressions: all,
      placement: all,
      irExtensions: all,
    },
    optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
    limits: { tasks: 100 },
    guarantees: { termination: ['FEASIBLE'], exact: false },
  };
}

function engine(name: string, namespace = 'bim.builtin'): EngineCatalogEntry {
  const ref = {
    namespace,
    name,
    version: '1.0.0',
    digest: `sha256-${name.padEnd(64, 'b').slice(0, 64)}`,
  };
  return {
    ...ref,
    id: `${namespace}/${name}`,
    ref,
    modes: [mode('default')],
  };
}

function renderAppEngines() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          isAdmin: false,
        }}
      >
        <AppEngines />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('AppEngines (/app/engines authenticated dashboard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockImplementation(() => 'private-solver');
    api.getEngines.mockResolvedValue([
      engine('builtin-opt', 'bim.builtin'),
      engine('custom-solver', 'researcher'),
    ]);
    api.listEngineRegistrations.mockResolvedValue([
      registration('private-solver', 'private', true, 'researcher'),
      registration('pending-solver', 'pending_review', false, 'researcher'),
    ]);
    api.activateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: true }));
    api.deactivateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: false }));
    api.requestEngineRegistrationPublication.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'pending_review' }));
    api.deleteEngineRegistration.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders telemetry and catalog entries', async () => {
    renderAppEngines();

    expect(await screen.findByRole('heading', { name: 'Engine Management' })).toBeInTheDocument();
    expect(screen.getByText('Real-time Telemetry & Solves')).toBeInTheDocument();
    expect(screen.getByText('builtin-opt')).toBeInTheDocument();
    expect(screen.getByText('custom-solver')).toBeInTheDocument();
  });

  it('changes telemetry horizon when horizon buttons are clicked', async () => {
    renderAppEngines();

    await screen.findByRole('heading', { name: 'Engine Management' });

    const btn7d = screen.getByRole('button', { name: '7d' });
    fireEvent.click(btn7d);
    expect(btn7d).toHaveClass('is-active');

    const btn1h = screen.getByRole('button', { name: '1h' });
    fireEvent.click(btn1h);
    expect(btn1h).toHaveClass('is-active');
  });

  it('filters engines by tab', async () => {
    renderAppEngines();

    await screen.findByText('builtin-opt');

    // Switch to My Deployments tab
    const deploymentsTab = screen.getByRole('button', { name: /My Deployments/i });
    fireEvent.click(deploymentsTab);

    expect(await screen.findByRole('heading', { name: 'private-solver' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'pending-solver' })).toBeInTheDocument();
  });

  it('pauses an active deployment and activates an inactive one', async () => {
    renderAppEngines();

    const deploymentsTab = screen.getByRole('button', { name: /My Deployments/i });
    fireEvent.click(deploymentsTab);

    const pauseBtn = await screen.findByRole('button', { name: /Pause/i });
    fireEvent.click(pauseBtn);

    await waitFor(() => expect(api.deactivateEngineRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'private-solver' }),
    ));

    const activateBtn = screen.getByRole('button', { name: /Activate/i });
    fireEvent.click(activateBtn);

    await waitFor(() => expect(api.activateEngineRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pending-solver' }),
    ));
  });

  it('deletes an engine registration when confirmation matches', async () => {
    renderAppEngines();

    const deploymentsTab = screen.getByRole('button', { name: /My Deployments/i });
    fireEvent.click(deploymentsTab);

    const deregisterBtns = await screen.findAllByRole('button', { name: /Deregister/i });
    fireEvent.click(deregisterBtns[0]);

    expect(window.confirm).toHaveBeenCalled();
    expect(window.prompt).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteEngineRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'private-solver' }),
    ));
  });
});
