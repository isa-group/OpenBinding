import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { EngineCatalogEntry, EngineMode, EngineRegistrationRevision } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { Engines } from './Engines';

const api = vi.hoisted(() => ({
  getPublicEngines: vi.fn(),
  getCatalogEngines: vi.fn(),
  listEngineRegistrations: vi.fn(),
  activateEngineRegistration: vi.fn(),
  deactivateEngineRegistration: vi.fn(),
  requestEngineRegistrationPublication: vi.fn(),
  setEngineRegistrationCredential: vi.fn(),
}));
const platform = vi.hoisted(() => ({ engineRevisions: vi.fn() }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

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

function mode(id: string, options: Record<string, Record<string, unknown>> = {}): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id,
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm: `${id}-algorithm`,
    capabilities: {
      workflowNodes: all, metricScopes: all, aggregations: all, constraints: all, optimization: all, objectiveTypes: all, expressions: all,
      placement: all, irExtensions: { selector: 'only', values: ['qos-binding-placement/v1'] },
    },
    optionsSchema: { type: 'object', properties: options, additionalProperties: false },
    limits: { tasks: 100 },
    guarantees: { termination: ['FEASIBLE'], exact: false },
  };
}

function engine(namespace: string, name: string, version: string, modes: EngineMode[], seed = 'b'): EngineCatalogEntry {
  const ref = { namespace, name, version, digest: `sha256-${seed.repeat(64)}` };
  return { ...ref, id: `${namespace}/${name}`, ref, modes };
}

const randomSearch = engine('bim.builtin', 'random-search', '1.0.0', [mode('sampling', { time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' }, iterations: { type: 'integer', default: 100000 } })], 'b');
const evolutionary = engine('bim.builtin', 'evolutionary', '1.0.0', [mode('genetic', { population: { type: 'integer', default: 64 } })], 'c');
const edge = engine('admin', 'edge-solver', '0.3.1', [mode('sampling')], 'e');

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

describe('engine catalog for a visitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPublicEngines.mockResolvedValue([randomSearch, evolutionary]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the public revisions as cards with their modes and exact identity', async () => {
    renderPage(null);

    expect(screen.getByRole('heading', { level: 1, name: 'Engine catalog' })).toBeInTheDocument();
    const list = await screen.findByRole('region', { name: 'Engines' });
    expect(within(list).getByText('2 engine revisions')).toBeInTheDocument();
    const [first] = within(list).getAllByRole('link');
    expect(first).toHaveAttribute('href', '/engines/bim.builtin/random-search/1.0.0');
    expect(first).toHaveTextContent('mode · sampling');
    expect(first).toHaveTextContent('sha256-bbbb…bbbb');
    expect(first).toHaveTextContent('Public');
    expect(screen.getByText('Showing public engines. Log in to also see private engines you own.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(api.getCatalogEngines).not.toHaveBeenCalled();
    expect(api.listEngineRegistrations).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'My deployments' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Register engine' })).not.toBeInTheDocument();
  });

  it('searches and filters by family', async () => {
    renderPage(null);
    const list = await screen.findByRole('region', { name: 'Engines' });

    fireEvent.click(screen.getByRole('button', { name: 'Evolutionary' }));
    expect(within(list).getByText('1 engine revision')).toBeInTheDocument();
    expect(within(list).queryByText(/random-search/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search engines' }), { target: { value: 'no-match' } });
    expect(await screen.findByText('No revision matches “no-match”.')).toBeInTheDocument();
  });

  it('compares two modes side by side, never more than two', async () => {
    renderPage(null);
    await screen.findByRole('region', { name: 'Engines' });
    const table = screen.getByRole('region', { name: 'Capabilities by mode' });
    expect(within(table).getByRole('row', { name: /random-search · sampling/ })).toHaveTextContent('time_budget_ms (ms, 30,000) · iterations (100,000)');
    expect(within(table).getByRole('row', { name: /evolutionary · genetic/ })).toHaveTextContent('qos-binding-placement/v1');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Compare random-search · sampling' }));
    expect(screen.queryByLabelText('Comparison')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compare evolutionary · genetic' }));
    const comparison = screen.getByLabelText('Comparison');
    expect(within(comparison).getByText('random-search · sampling')).toBeInTheDocument();
    expect(within(comparison).getByText('evolutionary · genetic')).toBeInTheDocument();
  });

  it('lists the revisions with visibility and publication, linking each to its detail', async () => {
    renderPage(null);
    const table = await screen.findByRole('region', { name: 'Engine revisions' });
    const row = within(table).getByRole('row', { name: /random-search/ });
    expect(row).toHaveTextContent('bim.builtin');
    expect(row).toHaveTextContent('Public');
    expect(row).toHaveTextContent('Published');
    expect(within(row).getByRole('link', { name: 'Open random-search 1.0.0' })).toHaveAttribute('href', '/engines/bim.builtin/random-search/1.0.0');
  });

  it('says so when no engine is visible', async () => {
    api.getPublicEngines.mockResolvedValue([]);
    renderPage(null);
    expect(await screen.findByText('No engines visible to you')).toBeInTheDocument();
    expect(screen.getByText(/BASIC: 1 engine/)).toBeInTheDocument();
  });

  it('reports a failed load and recovers on Retry', async () => {
    api.getPublicEngines.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderPage(null);
    expect(await screen.findByText('The catalog couldn’t be loaded (HTTP 503).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Engines' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('engine catalog for a signed-in account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.getCatalogEngines.mockResolvedValue({ engines: [randomSearch, edge], fellBackToPublic: false });
    api.listEngineRegistrations.mockResolvedValue([]);
    platform.engineRevisions.mockResolvedValue({ revisions: [] });
    api.activateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: true }));
    api.deactivateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: false }));
    api.requestEngineRegistrationPublication.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'pending_review' }));
    api.setEngineRegistrationCredential.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'private', active: false }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the account view with ownership, registration and conformance of a private engine', async () => {
    api.listEngineRegistrations.mockResolvedValue([registration('edge-solver', 'private', true)].map((item) => ({ ...item, version: '0.3.1' })));
    platform.engineRevisions.mockResolvedValue({
      revisions: [
        { id: '1', namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: randomSearch.digest, state: 'published', createdAt: null, document: {}, registration: null },
        { id: '2', namespace: 'admin', name: 'edge-solver', version: '0.3.1', digest: edge.digest, state: 'private', createdAt: null, document: {}, registration: { id: 'r', verificationReport: { status: 'verified' } } },
      ],
    });
    renderPage(admin);

    const list = await screen.findByRole('region', { name: 'Engines' });
    expect(screen.getByText(/Showing engines visible to your account: public revisions plus private ones you own\./)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    const card = within(list).getByRole('link', { name: /edge-solver/ });
    for (const chip of ['Private · yours', 'Registration active', 'Conformance passed', 'Publication not requested']) {
      expect(within(card).getByText(chip)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'My registrations' })).toHaveAttribute('href', '/app/engines/registrations');
    expect(screen.getByRole('link', { name: 'Register engine' })).toHaveAttribute('href', '/app/engines/new');
    const table = screen.getByRole('region', { name: 'Engine revisions' });
    expect(within(table).getByRole('row', { name: /edge-solver/ })).toHaveTextContent('Private');
    expect(within(table).getByRole('row', { name: /edge-solver/ })).toHaveTextContent('Not requested');
  });

  it('says the session expired when the gateway falls back to the public list', async () => {
    api.getCatalogEngines.mockResolvedValue({ engines: [randomSearch], fellBackToPublic: true });
    renderPage(admin);
    expect(await screen.findByText(/Your session expired \(401\), so the catalog fell back to the public view/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Log in' }).length).toBeGreaterThan(0);
  });

  it('explains a 403 and offers the keys page', async () => {
    api.getCatalogEngines.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderPage(admin);
    expect(await screen.findByText('This API key can’t list engines (403 · insufficient_api_key_permission)')).toBeInTheDocument();
    expect(screen.getByText('engines:read')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage API keys' })).toHaveAttribute('href', '/app/account/keys');
    expect(screen.queryByRole('region', { name: 'Engines' })).not.toBeInTheDocument();
  });

  it('keeps the last list when a refresh fails with 503', async () => {
    api.listEngineRegistrations.mockResolvedValue([registration('inactive-deployment', 'private', false)]);
    renderPage(admin);
    await screen.findByRole('region', { name: 'Engines' });

    api.getCatalogEngines.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: 'Activate inactive-deployment' }));

    expect(await screen.findByText('The catalog couldn’t refresh (503). You’re seeing the last list loaded.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Engines' })).toHaveTextContent('edge-solver');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/The catalog couldn’t refresh/)).not.toBeInTheDocument());
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
    expect(await screen.findByRole('heading', { name: 'pending-deployment' })).toBeInTheDocument();
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
});
