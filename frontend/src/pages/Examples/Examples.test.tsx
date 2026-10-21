import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { Examples } from './Examples';

const api = vi.hoisted(() => ({ getBimExamples: vi.fn(), getBimExamplePackage: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

const lucia: UserProfile = { id: 'u', username: 'lucia', email: 'l@example.test', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-01-01T00:00:00Z' };
const PATHS = ['demo/01_simple_seq', 'demo/02_parallel', 'placement/01_small_placement', 'literature/zhang', 'bpmn/order_flow', 'demo/05_single_obj_various'];

function renderPage(user: UserProfile | null = null) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Examples />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const card = (path: string) => screen.getByText(path).closest('article') as HTMLElement;

describe('example packages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getBimExamples.mockResolvedValue(PATHS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('groups the packages by family with their lessons, and hides the retired example', async () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Example packages' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Demo · 2 packages' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Placement · 1 package' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'BPMN · 1 package' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Literature · 1 package' })).toBeInTheDocument();
    expect(screen.queryByText('demo/05_single_obj_various')).not.toBeInTheDocument();

    const first = card('demo/01_simple_seq');
    expect(first).toHaveTextContent('A first binding · Basic sequence');
    expect(first).toHaveTextContent('Level 1');
    expect(first).toHaveTextContent('Connect one Application, one CandidateCatalog and one Optimization');
    expect(within(first).getByRole('img', { name: 'sequence workflow glyph' })).toBeInTheDocument();
    expect(card('placement/01_small_placement')).toHaveTextContent('Requires placement=placement and irExtensions=qos-binding-placement/v1.');
    // A package the gateway lists but this page has no lesson for still gets a card.
    expect(card('bpmn/order_flow')).toHaveTextContent('Order Flow · BIM package');
  });

  it('opens a package in the workbench', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Demo · 2 packages' });
    expect(within(card('demo/01_simple_seq')).getByRole('link', { name: 'Open in workbench' })).toHaveAttribute('href', '/workbench?example=demo%2F01_simple_seq');
  });

  it('narrows by search and by family', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Demo · 2 packages' });

    fireEvent.click(screen.getByRole('button', { name: 'Placement' }));
    expect(screen.getByRole('heading', { name: 'Placement · 1 package' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Demo/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search examples' }), { target: { value: 'parallel' } });
    expect(screen.getByText('demo/02_parallel')).toBeInTheDocument();
    expect(screen.queryByText('demo/01_simple_seq')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search examples' }), { target: { value: 'zzz' } });
    expect(await screen.findByText('No example matches this view.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('demo/01_simple_seq')).toBeInTheDocument();
  });

  it('asks a visitor to log in to import, and lets a signed-in account choose the project', async () => {
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: 'Demo · 2 packages' });
    const login = within(card('demo/01_simple_seq')).getByRole('link', { name: 'Log in to import' });
    expect(login).toHaveAttribute('href', '/login');
    expect(login).toHaveAttribute('title', 'Log in to import into a project');
    unmount();

    platform.organizations.mockResolvedValue([{ id: 'o', slug: 'isa-demo', name: 'ISA Demo Group' }]);
    platform.projects.mockResolvedValue([{ id: 'p', slug: 'qos', name: 'QoS Benchmarks' }]);
    renderPage(lucia);
    await screen.findByRole('heading', { name: 'Demo · 2 packages' });
    expect(screen.queryByRole('link', { name: 'Log in to import' })).not.toBeInTheDocument();
    fireEvent.click(within(card('demo/01_simple_seq')).getByRole('button', { name: 'Import as case' }));
    const project = await screen.findByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' });
    expect(project).toHaveAttribute('href', '/app/isa-demo/qos/workbench?example=demo%2F01_simple_seq');
    expect(platform.projects).toHaveBeenCalledWith('isa-demo');
  });

  it('downloads the .bim.zip and shows its digest', async () => {
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xab).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:zip'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const downloaded: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      downloaded.push(this.download);
    });
    api.getBimExamplePackage.mockResolvedValue(new Uint8Array([80, 75, 3, 4]).buffer);
    renderPage();
    await screen.findByRole('heading', { name: 'Demo · 2 packages' });

    fireEvent.click(within(card('demo/01_simple_seq')).getByRole('button', { name: 'Download .bim.zip' }));
    const status = await within(card('demo/01_simple_seq')).findByRole('status');
    expect(status).toHaveTextContent(`sha256-${'ab'.repeat(32)}`);
    expect(api.getBimExamplePackage).toHaveBeenCalledWith('demo/01_simple_seq');
    expect(downloaded).toEqual(['01_simple_seq.bim.zip']);

    fireEvent.click(within(status).getByRole('button', { name: 'Copy digest' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`sha256-${'ab'.repeat(32)}`));
  });

  it('says an example is corrupt when the gateway answers 422, without touching the others', async () => {
    api.getBimExamplePackage.mockRejectedValueOnce(new HttpError(422, 'invalid_example'));
    renderPage();
    await screen.findByRole('heading', { name: 'Demo · 2 packages' });

    fireEvent.click(within(card('demo/02_parallel')).getByRole('button', { name: 'Download .bim.zip' }));
    expect(await within(card('demo/02_parallel')).findByRole('alert')).toHaveTextContent('This example package is corrupt (422 · invalid_example). The download stopped; other examples are unaffected.');
    expect(within(card('demo/01_simple_seq')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when no example is installed', async () => {
    api.getBimExamples.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No examples installed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the workbench' })).toHaveAttribute('href', '/workbench');
  });

  it('falls back to the bundled lesson index when the live list cannot be read', async () => {
    api.getBimExamples.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderPage();
    expect(await screen.findByText(/Live catalogue unavailable/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^Demo · \d+ packages$/ })).toBeInTheDocument();
    expect(screen.getByText('demo/01_simple_seq')).toBeInTheDocument();

    api.getBimExamples.mockResolvedValueOnce(['demo/01_simple_seq']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Demo · 1 package' })).toBeInTheDocument();
  });
});
