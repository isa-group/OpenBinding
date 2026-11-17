import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../../core/api/account';
import { HttpError } from '../../../core/api/http';
import { renderModule } from '../../../../test/moduleKit';
import type {
  EngineCatalogEntry,
  EngineMode,
  EngineRegistrationRevision,
} from '../../api/enginesApi';
import EngineListPage from '.';

const api = vi.hoisted(() => ({
  getPublicEngines: vi.fn(),
  getCatalogEngines: vi.fn(),
  engineRevisions: vi.fn(),
  listEngineRegistrations: vi.fn(),
}));

vi.mock('../../api/enginesApi', async () => ({
  ...(await vi.importActual<typeof import('../../api/enginesApi')>('../../api/enginesApi')),
  useEnginesApi: () => api,
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

function registration(
  name: string,
  status: EngineRegistrationRevision['status'],
  active = false,
  namespace = 'admin'
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

function mode(id: string, options: Record<string, Record<string, unknown>> = {}): EngineMode {
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
      irExtensions: { selector: 'only', values: ['qos-binding-placement/v1'] },
    },
    optionsSchema: { type: 'object', properties: options, additionalProperties: false },
    limits: { tasks: 100 },
    guarantees: { termination: ['FEASIBLE'], exact: false },
  };
}

function engine(
  namespace: string,
  name: string,
  version: string,
  modes: EngineMode[],
  seed = 'b'
): EngineCatalogEntry {
  const ref = { namespace, name, version, digest: `sha256-${seed.repeat(64)}` };
  return { ...ref, id: `${namespace}/${name}`, ref, modes };
}

const randomSearch = engine(
  'bim.builtin',
  'random-search',
  '1.0.0',
  [
    mode('sampling', {
      time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' },
      iterations: { type: 'integer', default: 100000 },
    }),
  ],
  'b'
);
const evolutionary = engine(
  'bim.builtin',
  'evolutionary',
  '1.0.0',
  [mode('genetic', { population: { type: 'integer', default: 64 } })],
  'c'
);
const edge = engine('admin', 'edge-solver', '0.3.1', [mode('sampling')], 'e');

function renderPage(user: UserProfile | null, entry = '/engines') {
  return renderModule(<EngineListPage />, { user, entry, path: '/engines' });
}

/** The cards of the list, by their accessible names. */
const cards = () => screen.getAllByRole('article').map(card => card.getAttribute('aria-label'));

describe('/engines for a visitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPublicEngines.mockResolvedValue([randomSearch, evolutionary]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the public revisions as SPHERE cards with their version, modes and a Published pill', async () => {
    renderPage(null);

    expect(screen.getByRole('heading', { level: 1, name: 'Engines' })).toBeInTheDocument();
    expect(await screen.findByText('2 engine revisions found')).toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'bim.builtin/random-search 1.0.0' });
    expect(within(card).getByRole('link', { name: 'bim.builtin/random-search' })).toHaveAttribute(
      'href',
      '/engines/bim.builtin/random-search/1.0.0'
    );
    expect(card).toHaveTextContent('v1.0.0');
    expect(card).toHaveTextContent('mode · sampling');
    expect(within(card).getByText('Published')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|\b[0-9a-f]{12}/);
    expect(screen.getByText(/Showing public engines\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/authentication');
    expect(api.getCatalogEngines).not.toHaveBeenCalled();
    expect(api.listEngineRegistrations).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Register engine' })).not.toBeInTheDocument();
    expect(document.title).toBe('OpenBinding - Engines');
  });

  it('filters by family in the Filters panel, and keeps the filter and the search in the address', async () => {
    renderPage(null);
    await screen.findByText('2 engine revisions found');

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = screen.getByRole('group', { name: 'Filters' });
    for (const legend of ['Family', 'Mode', 'Capability', 'Visibility'])
      expect(within(panel).getByText(legend)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Evolutionary' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('1 engine revision found')).toBeInTheDocument();
    expect(cards()).toEqual(['bim.builtin/evolutionary 1.0.0']);
  });

  it('reads a mode filter from the address', async () => {
    renderPage(null, '/engines?mode=sampling');
    expect(await screen.findByText('1 engine revision found')).toBeInTheDocument();
    expect(cards()).toEqual(['bim.builtin/random-search 1.0.0']);
  });

  it('finds nothing for a search that matches no revision', async () => {
    renderPage(null, '/engines?q=no-match');
    expect(await screen.findByText('No engine revisions found')).toBeInTheDocument();
  });

  it('says so when no engine is visible', async () => {
    api.getPublicEngines.mockResolvedValue([]);
    renderPage(null);
    expect(await screen.findByText('No engine revisions found')).toBeInTheDocument();
  });

  it('reports a failed load and recovers on Retry', async () => {
    api.getPublicEngines.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderPage(null);
    expect(
      await screen.findByText('The engine revisions could not be loaded.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2 engine revisions found')).toBeInTheDocument();
    expect(api.getPublicEngines).toHaveBeenCalledTimes(2);
  });
});

describe('/engines for a signed-in account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCatalogEngines.mockResolvedValue({
      engines: [randomSearch, edge],
      fellBackToPublic: false,
    });
    api.listEngineRegistrations.mockResolvedValue([]);
    api.engineRevisions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the account view with ownership, registration and conformance of a private engine', async () => {
    api.listEngineRegistrations.mockResolvedValue(
      [registration('edge-solver', 'private', true)].map(item => ({ ...item, version: '0.3.1' }))
    );
    api.engineRevisions.mockResolvedValue([
      {
        id: '1',
        namespace: 'bim.builtin',
        name: 'random-search',
        version: '1.0.0',
        digest: randomSearch.digest,
        state: 'published',
        createdAt: null,
        document: {},
        registration: null,
      },
      {
        id: '2',
        namespace: 'admin',
        name: 'edge-solver',
        version: '0.3.1',
        digest: edge.digest,
        state: 'private',
        createdAt: null,
        document: {},
        registration: { id: 'r', verificationReport: { status: 'verified' } },
      },
    ]);
    renderPage(admin);

    const card = await screen.findByRole('article', { name: 'admin/edge-solver 0.3.1' });
    expect(
      screen.getByText(
        /Showing engines visible to your account: public revisions plus private ones you own\./
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    for (const chip of [
      'Private · yours',
      'Registration active',
      'Conformance passed',
      'Listing not requested',
    ]) {
      expect(within(card).getByText(chip)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'My engines' })).toHaveAttribute('href', '/me/engines');
    expect(screen.getByRole('link', { name: 'Register engine' })).toHaveAttribute(
      'href',
      '/me/engines/new'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = screen.getByRole('group', { name: 'Filters' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Private' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(cards()).toEqual(['admin/edge-solver 0.3.1']));
  });

  it('says the session expired when the gateway falls back to the public list', async () => {
    api.getCatalogEngines.mockResolvedValue({ engines: [randomSearch], fellBackToPublic: true });
    renderPage(admin);
    expect(
      await screen.findByText(
        /Your session expired \(401\), so the catalog fell back to the public view/
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'log in' })).toHaveAttribute('href', '/authentication');
    expect(api.listEngineRegistrations).not.toHaveBeenCalled();
  });

  it('explains a 403 and names the missing permission', async () => {
    api.getCatalogEngines.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderPage(admin);
    expect(
      await screen.findByText(
        /This API key can’t list engines \(403 · insufficient_api_key_permission\)/
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/engines:read/)).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toEqual([]);
  });

  it('keeps the list when the visibility extras fail', async () => {
    api.engineRevisions.mockRejectedValue(new HttpError(503, 'unavailable'));
    api.listEngineRegistrations.mockRejectedValue(new HttpError(503, 'unavailable'));
    renderPage(admin);
    expect(await screen.findByText('2 engine revisions found')).toBeInTheDocument();
  });
});
