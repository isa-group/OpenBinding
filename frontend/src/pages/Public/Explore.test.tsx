import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { ExplorePage } from './Explore';

const api = vi.hoisted(() => ({ getPublicEngines: vi.fn() }));
const platform = vi.hoisted(() => ({ publicProjects: vi.fn(), publicPublications: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

const DIGEST = `sha256-${'e5f6'.repeat(16)}`;

const projects = [
  { organization: { slug: 'isa-demo', name: 'ISA Demo Group' }, project: { slug: 'qos', name: 'QoS Benchmarks', description: 'Reference binding cases.' } },
  { organization: { slug: 'other-lab', name: 'Other Lab' }, project: { slug: 'notes', name: 'Field notes', description: '' } },
];
const publications = [{
  slug: 'checkout',
  citation: { title: 'Engines at checkout', authors: ['Lucía Vega'], year: 2026 },
  report: { title: 'Engines at checkout', digest: DIGEST, version_id: 'v1' },
  project: 'qos',
  organization: 'isa-demo',
  publishedAt: '2026-09-25T10:00:00Z',
}];
const engines = [{
  id: 'random-search', namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: `sha256-${'b2c3'.repeat(16)}`, ref: {},
  modes: [{ id: 'sampling', optionsSchema: { type: 'object', properties: { time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' }, iterations: { type: 'integer' } }, required: ['iterations'] } }],
}];

function renderExplore(path = '/explore') {
  return render(<MemoryRouter initialEntries={[path]}><ExplorePage /></MemoryRouter>);
}

describe('Explore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    platform.publicProjects.mockResolvedValue(projects);
    platform.publicPublications.mockResolvedValue(publications);
    api.getPublicEngines.mockResolvedValue(engines);
  });

  it('opens on publications, counts every tab and details the first item', async () => {
    renderExplore();

    expect(screen.getByRole('heading', { level: 1, name: 'Public work on OpenBinding' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Engines at checkout/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: /Publications/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Projects/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /Engines/ })).toHaveTextContent('1');

    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByRole('heading', { name: 'Engines at checkout' })).toBeInTheDocument();
    expect(within(details).getByText('Lucía Vega')).toBeInTheDocument();
    expect(within(details).getByText('ISA Demo Group / QoS Benchmarks')).toBeInTheDocument();
    expect(within(details).getByText(DIGEST)).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: 'Open verification' })).toHaveAttribute('href', `/resolve/report/${DIGEST}`);
  });

  it('copies the citation as listed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderExplore();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy citation' }));

    expect(writeText).toHaveBeenCalledWith('Lucía Vega (2026). Engines at checkout. ISA Demo Group / QoS Benchmarks.');
    expect(await screen.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument();
  });

  it('follows ?tab= and lets a visitor see a project but not open it', async () => {
    renderExplore('/explore?tab=projects');

    const card = await screen.findByRole('button', { name: /QoS Benchmarks/ });
    await waitFor(() => expect(card).toHaveTextContent('1 publication'));
    const details = screen.getByRole('complementary', { name: 'Details' });
    expect(within(details).getByRole('link', { name: 'Log in to open as a member' })).toHaveAttribute('href', '/login');
    expect(within(details).queryByRole('link', { name: 'Open project' })).not.toBeInTheDocument();
  });

  it('lets a signed-in member open the project and jump to its publications', async () => {
    auth.user = { id: 'u1', username: 'lucia', email: 'lucia@example.test', role: 'user', plan: 'FREE', is_active: true, created_at: '2026-01-01T00:00:00Z' };
    renderExplore('/explore?tab=projects');

    const details = await screen.findByRole('complementary', { name: 'Details' });
    expect(within(details).getByRole('link', { name: 'Open project' })).toHaveAttribute('href', '/app/isa-demo/qos');

    fireEvent.click(within(details).getByRole('button', { name: 'See its publications' }));

    expect(await screen.findByRole('tab', { name: /Publications/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search this tab' })).toHaveValue('QoS Benchmarks');
    expect(screen.getByRole('button', { name: /Engines at checkout/ })).toBeInTheDocument();
  });

  it('filters by search text and organization, and says when nothing matches', async () => {
    renderExplore('/explore?tab=projects');
    await screen.findByRole('button', { name: /QoS Benchmarks/ });

    fireEvent.click(screen.getByRole('button', { name: 'Other Lab' }));
    expect(screen.queryByRole('button', { name: /QoS Benchmarks/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Field notes/ })).toHaveTextContent('A public OpenBinding project.');
    expect(screen.getByText('1 public project')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All organizations' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this tab' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No public projects match “zzz”.')).toBeInTheDocument();
    expect(screen.getByText('Select an item to see its citation, digest and where to verify it.')).toBeInTheDocument();
  });

  it('shows the engine revision with its modes and option defaults', async () => {
    renderExplore('/explore?tab=engines');

    const details = await screen.findByRole('complementary', { name: 'Details' });
    expect(within(details).getByRole('heading', { name: 'bim.builtin/random-search@1.0.0' })).toBeInTheDocument();
    expect(within(details).getByText('sampling')).toBeInTheDocument();
    expect(within(details).getByText('time_budget_ms (ms, default 30,000); iterations (required)')).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: 'Open engine' })).toHaveAttribute('href', '/engines/bim.builtin/random-search/1.0.0');
    expect(screen.getByRole('group', { name: 'Namespace filter' })).toBeInTheDocument();
  });

  it('shows a loading placeholder, then the empty state of each tab', async () => {
    platform.publicProjects.mockResolvedValue([]);
    platform.publicPublications.mockResolvedValue([]);
    api.getPublicEngines.mockResolvedValue([]);
    renderExplore();

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(await screen.findByText('No public publications yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Engines/ }));
    expect(await screen.findByText('No public engines')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open your projects' })).not.toBeInTheDocument();
  });

  it('offers a signed-in account its own projects when the catalog is empty', async () => {
    auth.user = { id: 'u1', username: 'lucia', email: 'lucia@example.test', role: 'user', plan: 'FREE', is_active: true, created_at: '2026-01-01T00:00:00Z' };
    platform.publicPublications.mockResolvedValue([]);
    renderExplore();

    expect(await screen.findByRole('link', { name: 'Open your projects' })).toHaveAttribute('href', '/app');
  });

  it('reports one tab failing without touching the others, and retries only that tab', async () => {
    platform.publicPublications.mockRejectedValue(new HttpError(503, 'down'));
    renderExplore('/explore?tab=publications');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Publications couldn’t be loaded (HTTP 503). Your search and filters are kept.');
    expect(screen.getByRole('tab', { name: /Projects/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /Publications/ })).toHaveTextContent('–');

    platform.publicPublications.mockResolvedValue(publications);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: /Engines at checkout/ })).toBeInTheDocument();
    expect(platform.publicProjects).toHaveBeenCalledOnce();
    expect(platform.publicPublications).toHaveBeenCalledTimes(2);
  });

  it('switches tabs with the arrow keys', async () => {
    renderExplore();
    await screen.findByRole('button', { name: /Engines at checkout/ });

    fireEvent.keyDown(screen.getByRole('tab', { name: /Publications/ }), { key: 'ArrowRight' });

    expect(await screen.findByRole('tab', { name: /Engines/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'explore-tab-engines');
  });
});
