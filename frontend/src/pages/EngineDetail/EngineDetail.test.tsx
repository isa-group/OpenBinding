import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, type EngineCatalogEntry, type EngineMode } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { catalogFixture } from '../Pricing/pricingFixture';
import { EngineDetail } from './EngineDetail';

const api = vi.hoisted(() => ({
  getPublicEngines: vi.fn(),
  getCatalogEngines: vi.fn(),
  listEngineRegistrations: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  getPricingCatalog: vi.fn(),
}));
const platform = vi.hoisted(() => ({ engineRevision: vi.fn(), organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

const DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;
// What GET /v1/pricing/catalog serves: the active document as JSON (a synthetic one, see pricingFixture).
const catalog = JSON.parse(JSON.stringify(catalogFixture)) as Record<string, unknown>;

const lucia: UserProfile = {
  id: 'u1', username: 'lucia', email: 'lucia@example.test', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-01-01T00:00:00Z',
};

function mode(id: string, extra: Partial<EngineMode> = {}): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id,
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm: 'random sampling',
    capabilities: {
      workflowNodes: all, metricScopes: { selector: 'none' }, aggregations: all, constraints: all, optimization: { selector: 'only', values: ['satisfy', 'weighted'] },
      objectiveTypes: all, expressions: all, placement: all, irExtensions: { selector: 'only', values: ['qos-binding-placement/v1'] },
    },
    optionsSchema: {
      type: 'object',
      properties: {
        time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' },
        iterations: { type: 'integer', default: 100000 },
        population: { type: 'integer', default: 64 },
      },
      required: ['iterations'],
      additionalProperties: false,
    },
    limits: { maxTasks: 500 },
    guarantees: { termination: ['FEASIBLE', 'UNKNOWN'], exact: false },
    ...extra,
  };
}

function engine(namespace: string, name: string, version: string, modes: EngineMode[] = [mode('sampling')]): EngineCatalogEntry {
  const ref = { namespace, name, version, digest: DIGEST };
  return { ...ref, id: `${namespace}/${name}`, ref, modes };
}

function renderAt(path: string, user: UserProfile | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Routes><Route path="/engines/:namespace/:name/:version" element={<EngineDetail />} /></Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const PATH = '/engines/bim.builtin/random-search/1.0.0';

describe('engine revision detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPublicEngines.mockResolvedValue([engine('bim.builtin', 'random-search', '1.0.0'), engine('bim.builtin', 'evolutionary', '1.0.0', [mode('genetic')])]);
    api.getCatalogEngines.mockResolvedValue({ engines: [engine('bim.builtin', 'random-search', '1.0.0'), engine('lucia', 'edge-solver', '0.3.1')], fellBackToPublic: false });
    api.listEngineRegistrations.mockResolvedValue([]);
    api.getPricingCatalog.mockResolvedValue(catalog);
    platform.engineRevision.mockResolvedValue({
      id: 'r1', namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: DIGEST, state: 'published', createdAt: null, document: {}, registration: null,
    });
  });

  it('shows the exact reference, the modes with their options and a plan preview for a visitor', async () => {
    renderAt(PATH);

    expect(await screen.findByRole('heading', { level: 1, name: 'bim.builtin/random-search@1.0.0' })).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in to run' })).toHaveAttribute('href', '/login');
    expect(api.listEngineRegistrations).not.toHaveBeenCalled();
    expect(platform.engineRevision).not.toHaveBeenCalled();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Engines/bim.builtin/random-search');

    const options = await screen.findByRole('region', { name: 'Options of mode sampling' });
    // A visitor previews the smallest plan.
    expect(await screen.findByLabelText('Plan to preview')).toHaveValue('BASIC');
    const iterations = within(options).getByRole('row', { name: /iterations/ });
    expect(within(iterations).getByText('OPTION_CLAMPED → 10,000')).toBeInTheDocument();
    expect(within(iterations).getByText('10,000 iterations')).toBeInTheDocument();
    const time = within(options).getByRole('row', { name: /time_budget_ms/ });
    expect(within(time).getByText('60,000 ms (60 s)')).toBeInTheDocument();
    expect(within(time).getByText('Within the ceiling')).toBeInTheDocument();
    const population = within(options).getByRole('row', { name: /population/ });
    expect(within(population).getByText('Not reduced by plan')).toBeInTheDocument();
    expect(within(population).getByText('Applies as requested')).toBeInTheDocument();
    expect(screen.getByText(/Ceilings depend on your plan\. BASIC allows 60 s and 10,000 iterations per request\./)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Plan to preview'), { target: { value: 'RESEARCH' } });
    expect(within(options).queryByText(/OPTION_CLAMPED/)).not.toBeInTheDocument();
    expect(within(iterations).getByText('1,000,000 iterations')).toBeInTheDocument();
  });

  it('describes the mode contract and which endings it declares', async () => {
    renderAt(PATH);
    const contract = await screen.findByRole('region', { name: 'Mode contract' });
    expect(within(contract).getByText('qos-binding/v1')).toBeInTheDocument();
    expect(within(contract).getByText('bim/v1 · BindingProblem')).toBeInTheDocument();
    expect(within(contract).getByText('Heuristic mode')).toBeInTheDocument();
    expect(within(contract).getByText('maxTasks: 500')).toBeInTheDocument();
    const ends = screen.getByRole('region', { name: 'How a run can end' });
    expect(within(ends).getAllByText('Declared by this mode')).toHaveLength(2);
  });

  it('lists every capability dimension per mode on the Capabilities tab', async () => {
    renderAt(`${PATH}?tab=caps`);
    const table = await screen.findByRole('region', { name: 'Capabilities by dimension' });
    expect(screen.getByRole('tab', { name: /Capabilities/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(table).getByRole('row', { name: /Metric scopes/ })).toHaveTextContent('none');
    expect(within(table).getByRole('row', { name: /IR extensions/ })).toHaveTextContent('qos-binding-placement/v1');
    expect(within(table).getByRole('row', { name: /Optimization/ })).toHaveTextContent('satisfy, weighted');
    expect(within(table).getByRole('row', { name: /Feature values/ })).toBeInTheDocument();
    expect(screen.getByText(/Feature values:/)).toHaveTextContent('includes open ranges (an end null, such as ≤ 200 or ≥ 100)');
    expect(screen.getByText(/Validate a package in the Workbench, then log in/)).toBeInTheDocument();
  });

  it('keeps the URL in step with the selected tab', async () => {
    renderAt(PATH);
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Registrations/ }));
    expect(screen.getByRole('tab', { name: /Registrations/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/No deployment registrations are listed for this revision/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Modes/ }));
    expect(await screen.findByRole('region', { name: 'Options of mode sampling' })).toBeInTheDocument();
  });

  it('offers a mode choice when the revision has several modes', async () => {
    api.getPublicEngines.mockResolvedValue([engine('bim.builtin', 'random-search', '1.0.0', [mode('sampling'), mode('exhaustive', { algorithm: 'enumeration', guarantees: { termination: ['OPTIMAL'], exact: true } })])]);
    renderAt(PATH);
    await screen.findByRole('region', { name: 'Options of mode sampling' });
    fireEvent.click(screen.getByRole('button', { name: 'Mode · exhaustive' }));
    expect(await screen.findByRole('region', { name: 'Options of mode exhaustive' })).toBeInTheDocument();
    expect(screen.getByText('Exact mode')).toBeInTheDocument();
  });

  it('answers a neutral 404 for a revision the caller cannot see', async () => {
    renderAt('/engines/bim.builtin/random-search/9.9.9');
    expect(await screen.findByRole('heading', { name: 'Engine revision not found' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('There’s no engine revision you can see at this address.');
    expect(screen.getByRole('link', { name: 'Back to the catalog' })).toHaveAttribute('href', '/engines');
  });

  it('treats a 403 from the revision endpoint like a missing revision', async () => {
    api.getCatalogEngines.mockResolvedValue({ engines: [], fellBackToPublic: false });
    platform.engineRevision.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderAt('/engines/other/private-engine/1.0.0', lucia);
    expect(await screen.findByRole('heading', { name: 'Engine revision not found' })).toBeInTheDocument();
  });

  it('refuses to call a revision verified when the link names another digest (409)', async () => {
    renderAt(`${PATH}?digest=sha256-${'0'.repeat(64)}`);
    expect(await screen.findByText('This reference points to a different digest (409).')).toBeInTheDocument();
    expect(screen.getByText('Digest mismatch', { selector: '.ui-chip' })).toBeInTheDocument();
  });

  it('reports a gateway failure with Retry and loads the contract when it comes back', async () => {
    api.getPublicEngines.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderAt(PATH);
    expect(await screen.findByText(/The engine contract couldn’t be loaded \(HTTP 503\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'bim.builtin/random-search@1.0.0' })).toBeInTheDocument();
  });

  it('switches revisions with the selector', async () => {
    renderAt(PATH);
    const select = await screen.findByLabelText('Revision');
    expect(select).toHaveValue('bim.builtin/random-search@1.0.0');
    expect(within(select).getAllByRole('option')).toHaveLength(2);
  });

  it('uses the account plan, offers project actions and shows the registration report to a signed-in owner', async () => {
    const registration = { namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: DIGEST, status: 'private' as const, active: true };
    api.listEngineRegistrations.mockResolvedValue([registration]);
    api.getEngineRegistrationReport.mockResolvedValue({
      ...registration,
      openapiDigest: `sha256-${'ab12'.repeat(16)}`,
      openapi: null,
      engine: null,
      report: {
        protocol: 'bim-engine/v1',
        protocolDigest: `sha256-${'cd34'.repeat(16)}`,
        status: 'verified',
        durationMs: 120,
        checks: [{ id: 'health', status: 'passed', message: 'GET /health answered 200' }, { id: 'schema', status: 'failed', message: 'Missing field' }],
      },
    });
    platform.engineRevision.mockResolvedValue({
      id: 'r2', namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: DIGEST, state: 'private', createdAt: null, document: {}, registration: null,
    });
    renderAt('/engines/lucia/edge-solver/0.3.1', lucia);

    expect(await screen.findByRole('heading', { level: 1, name: 'lucia/edge-solver@0.3.1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run with this engine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to a study' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in to run' })).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Plan to preview')).toHaveValue('RESEARCH');
    expect(screen.getByText(/RESEARCH: max timeout 900 s, max 1,000,000 iterations per request\./)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Your plan’s ceiling' })).toBeInTheDocument();
    // The header and the exact-reference panel both say so.
    expect(screen.getAllByText('Private', { selector: '.ui-chip' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('tab', { name: /Registrations/ }));
    const item = await screen.findByRole('region', { name: 'Registration edge-solver' });
    expect(within(item).getByText('active for you')).toBeInTheDocument();
    expect(screen.queryByText(/No active registration/)).not.toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Show conformance report' }));
    expect(await within(item).findByText('Conformance passed')).toBeInTheDocument();
    expect(within(item).getByRole('row', { name: /health.*passed/ })).toBeInTheDocument();
    expect(within(item).getByRole('row', { name: /schema.*failed.*Missing field/ })).toBeInTheDocument();
    expect(within(item).getByText('2 checks · 120 ms')).toBeInTheDocument();
    expect(api.getEngineRegistrationReport).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver', digest: DIGEST }));
  });

  it('warns that a private revision cannot run until a registration is active', async () => {
    api.getCatalogEngines.mockResolvedValue({ engines: [engine('lucia', 'edge-solver', '0.3.1')], fellBackToPublic: false });
    platform.engineRevision.mockResolvedValue({
      id: 'r2', namespace: 'lucia', name: 'edge-solver', version: '0.3.1', digest: DIGEST, state: 'private', createdAt: null, document: {}, registration: null,
    });
    renderAt('/engines/lucia/edge-solver/0.3.1?tab=regs', lucia);
    expect(await screen.findByText(/No active registration\. This revision can’t be executed/)).toBeInTheDocument();
    await waitFor(() => expect(api.listEngineRegistrations).toHaveBeenCalled());
  });
});
