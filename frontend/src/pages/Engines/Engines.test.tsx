import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { EngineCatalogEntry, EngineMode, EngineRegistrationRevision } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { Engines } from './Engines';

const api = vi.hoisted(() => ({
  getEngines: vi.fn(),
  listEngineRegistrations: vi.fn(),
  activateEngineRegistration: vi.fn(),
  deactivateEngineRegistration: vi.fn(),
  requestEngineRegistrationPublication: vi.fn(),
  setEngineRegistrationCredential: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const admin: UserProfile = {
  id: 'admin-id',
  username: 'admin',
  email: 'admin@example.test',
  role: 'admin',
  is_active: true,
  plan: 'PRO',
  created_at: '2026-01-01T00:00:00Z',
};

function registration(name: string, status: EngineRegistrationRevision['status'], active = false, namespace = 'admin'): EngineRegistrationRevision {
  return { namespace, name, version: '1.0.0', digest: `sha256-${name.padEnd(64, 'a').slice(0, 64)}`, status, active };
}

function mode(id: string): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id,
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm: `${id}-algorithm`,
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

function engine(name: string, modes: EngineMode[]): EngineCatalogEntry {
  const ref = {
    namespace: 'bim.builtin',
    name,
    version: '1.0.0',
    digest: `sha256-${name.padEnd(64, 'b').slice(0, 64)}`,
  };
  return { ...ref, id: `${ref.namespace}/${name}`, ref, modes };
}

function renderPage(user: UserProfile | null) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{
        user,
        loading: false,
        signIn: vi.fn(),
        register: vi.fn(),
        signOut: vi.fn(),
        refresh: vi.fn(),
        isAdmin: user?.role === 'admin',
      }}>
        <Engines />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('federated deployment management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.getEngines.mockResolvedValue([]);
    api.activateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: true }));
    api.deactivateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: false }));
    api.requestEngineRegistrationPublication.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'pending_review' }));
    api.setEngineRegistrationCredential.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'private', active: false }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps deployment management out of the anonymous catalogue', async () => {
    renderPage(null);

    expect(await screen.findByText('No Engine revisions advertised')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My deployments' })).not.toBeInTheDocument();
    expect(api.listEngineRegistrations).not.toHaveBeenCalled();
  });

  it('shows only the signed-in namespace and applies owner lifecycle actions', async () => {
    api.listEngineRegistrations.mockResolvedValue([
      registration('pending-deployment', 'pending_review', true),
      registration('private-deployment', 'private', true),
      registration('published-deployment', 'published', true),
      registration('inactive-deployment', 'private', false),
      registration('rejected-deployment', 'rejected', false),
      registration('someone-elses-deployment', 'published', true, 'alice'),
    ]);
    renderPage(admin);

    expect(await screen.findByRole('heading', { name: 'My deployments' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'someone-elses-deployment' })).not.toBeInTheDocument();

    const expectedStates = [
      ['pending-deployment', 'In review'],
      ['private-deployment', 'Private'],
      ['published-deployment', 'Published'],
      ['inactive-deployment', 'Private'],
      ['rejected-deployment', 'Rejected'],
    ];
    for (const [name, state] of expectedStates) {
      const row = screen.getByRole('heading', { name }).closest('li');
      expect(row).not.toBeNull();
      expect(within(row!).getByText(state)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Activate inactive-deployment' }));
    await waitFor(() => expect(api.activateEngineRegistration).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(screen.getByRole('heading', { name: 'inactive-deployment' }).closest('li')!).getByText('active for you')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Request publication for private-deployment' }));
    expect(window.confirm).toHaveBeenCalledWith('Submit private-deployment for publication? Administrators will then be able to discover and review this exact revision.');
    await waitFor(() => expect(api.requestEngineRegistrationPublication).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(screen.getByRole('heading', { name: 'private-deployment' }).closest('li')!).getByText('In review')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate published-deployment' }));
    await waitFor(() => expect(api.deactivateEngineRegistration).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(screen.getByRole('heading', { name: 'published-deployment' }).closest('li')!).getByText('inactive for you')).toBeInTheDocument());

    expect(within(screen.getByRole('heading', { name: 'published-deployment' }).closest('li')!).queryByRole('button', { name: 'Replace credential for published-deployment' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace credential for pending-deployment' }));
    fireEvent.change(screen.getByLabelText('New deployment credential'), { target: { value: 'rotated-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Store encrypted credential' }));
    await waitFor(() => expect(api.setEngineRegistrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pending-deployment' }),
      'rotated-secret',
    ));
    const rotated = screen.getByRole('heading', { name: 'pending-deployment' }).closest('li')!;
    await waitFor(() => expect(within(rotated).getByText('Private')).toBeInTheDocument());
    expect(within(rotated).getByText('inactive for you')).toBeInTheDocument();
  });

  it('does not expose a private registration to administrators when publication is cancelled', async () => {
    api.listEngineRegistrations.mockResolvedValue([registration('private-deployment', 'private', true)]);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    renderPage(admin);

    fireEvent.click(await screen.findByRole('button', { name: 'Request publication for private-deployment' }));

    expect(api.requestEngineRegistrationPublication).not.toHaveBeenCalled();
    expect(within(screen.getByRole('heading', { name: 'private-deployment' }).closest('li')!).getByText('Private')).toBeInTheDocument();
  });

  it('shows the concrete conformance diagnostic behind a deployment 409', async () => {
    api.listEngineRegistrations.mockResolvedValue([registration('legacy-deployment', 'private')]);
    const failure = new HttpError(409, 'Engine registration failed its OpenAPI and response-contract checks.');
    failure.diagnostics = [{
      id: 'conformance',
      status: 'failed',
      message: 'registration must include the deployment OpenAPI document',
    }];
    api.activateEngineRegistration.mockRejectedValueOnce(failure);
    renderPage(admin);

    fireEvent.click(await screen.findByRole('button', { name: 'Activate legacy-deployment' }));

    expect(await screen.findByText(/registration must include the deployment OpenAPI document/)).toBeInTheDocument();
  });

  it('keeps filtered details in the result set and exposes keyboard-operable mode tabs', async () => {
    api.getEngines.mockResolvedValue([
      engine('alpha-engine', [mode('first'), mode('second')]),
      engine('beta-engine', [mode('only')]),
    ]);
    renderPage(null);

    const firstTab = await screen.findByRole('tab', { name: /first/i });
    const secondTab = screen.getByRole('tab', { name: /second/i });
    const panel = screen.getByRole('tabpanel');
    expect(firstTab).toHaveAttribute('tabindex', '0');
    expect(secondTab).toHaveAttribute('tabindex', '-1');
    expect(firstTab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', firstTab.id);

    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
    expect(secondTab).toHaveFocus();
    expect(secondTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', secondTab.id);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search engine revisions' }), { target: { value: 'beta' } });
    expect(screen.getByRole('heading', { name: 'beta-engine' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'alpha-engine' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search engine revisions' }), { target: { value: 'no-match' } });
    expect(screen.getByText('No revision matches “no-match”.')).toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });
});
