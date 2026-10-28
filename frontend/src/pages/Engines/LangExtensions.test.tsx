import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { COMMUNITY_DIALECT, PLACEMENT_DIALECT, QOS_PROFILE, REGISTERED_RESOURCES } from '../../test/fixtures/engines';
import { LangExtensions } from './LangExtensions';

const api = vi.hoisted(() => ({
  getDialects: vi.fn(),
  getProfiles: vi.fn(),
  getRegisteredResources: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const lucia: UserProfile = {
  id: 'lucia-id', username: 'alex.rivera', email: 'lucia@example.test', role: 'user', plan: 'RESEARCH', is_active: true, created_at: '2026-01-01T00:00:00Z',
};
const iker: UserProfile = { ...lucia, id: 'iker-id', username: 'iker.mora', role: 'admin' };

// The first render of a file is slow on a busy machine.
configure({ asyncUtilTimeout: 5000 });

function refusal(status: number, code: string): HttpError {
  const error = new HttpError(status, code);
  error.code = code;
  return error;
}

function renderPage(options: { user?: UserProfile; entry?: string } = {}) {
  const user = options.user ?? lucia;
  return render(
    <MemoryRouter initialEntries={[options.entry ?? '/app/language/extensions']}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        <LangExtensions />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('lang-extensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDialects.mockResolvedValue([PLACEMENT_DIALECT, COMMUNITY_DIALECT]);
    api.getProfiles.mockResolvedValue([QOS_PROFILE]);
    api.getRegisteredResources.mockResolvedValue(REGISTERED_RESOURCES);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts what is installed: dialects, the adapters behind them and the profiles, resource types and resources', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Language extensions' })).toBeInTheDocument();
    const kpis = screen.getByRole('region', { name: 'What is installed' });
    await waitFor(() => expect(kpis).toHaveTextContent('2Dialects installed'));
    await waitFor(() => expect(kpis).toHaveTextContent('3Adapters'));
    expect(kpis).toHaveTextContent('2Resource types');
    await waitFor(() => expect(kpis).toHaveTextContent('2Registered resources'));
    expect(screen.getByRole('link', { name: 'Profiles and installed dialects' })).toHaveAttribute('href', '/language');
  });

  it('shows each dialect with its status, version and where it comes from', async () => {
    renderPage();
    const placement = await screen.findByRole('article', { name: 'Dialect placement 1.0.0' });
    expect(within(placement).getByText('Installed')).toBeInTheDocument();
    expect(within(placement).getByText('Built in')).toBeInTheDocument();
    expect(within(placement).getByText('Installed with the gateway.')).toBeInTheDocument();
    expect(within(placement).getByText('qos-binding/v1')).toBeInTheDocument();
    expect(placement).toHaveTextContent('1 resource type · 0 extension points');

    const community = screen.getByRole('article', { name: 'Dialect edge-annotations 1.0.0' });
    expect(within(community).getByText('Approved')).toBeInTheDocument();
    expect(within(community).getByText('Submitted by alex.rivera and approved by an administrator.')).toBeInTheDocument();
    expect(community).toHaveTextContent('1 resource type · 1 extension point');
  });

  it('opens a dialect to its resource types, extension points and adapter, with the source folded away', async () => {
    renderPage();
    await screen.findByRole('article', { name: 'Dialect edge-annotations 1.0.0' });
    const button = screen.getByRole('button', { name: 'Details of edge-annotations' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    const community = screen.getByRole('article', { name: 'Dialect edge-annotations 1.0.0' });
    expect(within(community).getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    const types = within(community).getByRole('region', { name: 'Resource types of edge-annotations' });
    expect(types).toHaveTextContent('LatencyTable');
    expect(types).toHaveTextContent('latency-table');
    expect(types).toHaveTextContent('BPMN (XML) · root definitions');
    expect(within(community).getByText('/spec/annotations')).toBeInTheDocument();
    expect(within(community).getByText('Application')).toBeInTheDocument();
    expect(within(community).getByRole('button', { name: 'Copy edge-annotations-adapter binary fingerprint' })).toBeInTheDocument();
    // [utest->req~frontend-engines-source-view~1]
    const summary = within(community).getByText('View source');
    const disclosure = summary.closest('details') as HTMLDetailsElement;
    expect(disclosure).not.toHaveAttribute('open');
    const source = within(community).getByRole('region', { name: 'edge-annotations dialect source', hidden: true });
    expect(disclosure).toContainElement(source);
    expect(source).not.toBeVisible();
    expect(source).toHaveTextContent('"kind"');
    expect(within(source).getByRole('button', { name: 'Copy edge-annotations dialect source', hidden: true })).toBeInTheDocument();
  });

  it('narrows the dialects by where they come from and by what is typed', async () => {
    renderPage();
    await screen.findByRole('article', { name: 'Dialect placement 1.0.0' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Provenance' })).getByRole('button', { name: 'Built in' }));
    expect(screen.queryByRole('article', { name: 'Dialect edge-annotations 1.0.0' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Dialect placement 1.0.0' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Provenance' })).getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search extensions' }), { target: { value: 'latencytable' } });
    expect(screen.getByRole('article', { name: 'Dialect edge-annotations 1.0.0' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Dialect placement 1.0.0' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search extensions' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No dialect matches')).toBeInTheDocument();
  });

  it('lists the adapters with their version, fingerprint and everything that relies on them', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /^Adapters/ }));
    const table = await screen.findByRole('region', { name: 'Installed adapters' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const profile = within(table).getByRole('row', { name: /qos-binding-profile/ });
    expect(profile).toHaveTextContent('Profile · qos-binding/v1');
    expect(profile).toHaveTextContent('sha256-ad01…ad01');
    expect(within(table).getByRole('row', { name: /edge-annotations-adapter/ })).toHaveTextContent('Dialect · edge-annotations 1.0.0');
    expect(screen.getByText(/Approving a dialect never installs code/)).toBeInTheDocument();
  });

  it('lists the registered resources, which are published and written in an installed dialect', async () => {
    renderPage({ entry: '/app/language/extensions?tab=resources' });
    const table = await screen.findByRole('region', { name: 'Registered resources' });
    expect(screen.getByRole('tab', { name: /Registered resources/ })).toHaveAttribute('aria-selected', 'true');
    const mine = within(table).getByRole('row', { name: /eu-edge-placement/ });
    expect(mine).toHaveTextContent('1.0.0');
    expect(mine).toHaveTextContent('Placement');
    expect(mine).toHaveTextContent('placement/v1 · JSON');
    expect(within(mine).getByText('Approved')).toBeInTheDocument();
    expect(within(mine).getByText('Published')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /default-optimization/ })).getByText('Built in')).toBeInTheDocument();
  });

  it('says plainly that nothing is installed or registered yet', async () => {
    api.getDialects.mockResolvedValue([]);
    api.getRegisteredResources.mockResolvedValue([]);
    api.getProfiles.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No dialects installed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^Adapters/ }));
    expect(await screen.findByText('No adapters installed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Registered resources/ }));
    expect(await screen.findByText('No resources registered yet')).toBeInTheDocument();
  });

  it('asks to log in again when the session ended (401)', async () => {
    api.getDialects.mockRejectedValue(refusal(401, 'unauthorized'));
    renderPage();
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('says what a key without the permission cannot read (403)', async () => {
    api.getRegisteredResources.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderPage({ entry: '/app/language/extensions?tab=resources' });
    expect(await screen.findByText('This API key can’t read the language catalog (403)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage API keys' })).toHaveAttribute('href', '/app/account/keys');
    expect(screen.queryByRole('region', { name: 'Registered resources' })).not.toBeInTheDocument();
  });

  it('offers a retry when the catalog cannot be reached', async () => {
    api.getDialects.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderPage();
    expect(await screen.findByText(/The language extensions couldn’t be loaded \(HTTP 503\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Dialect placement 1.0.0' })).toBeInTheDocument();
  });

  it('mentions moderation only to administrators', async () => {
    const first = renderPage();
    await screen.findByRole('article', { name: 'Dialect placement 1.0.0' });
    expect(screen.queryByRole('link', { name: 'Moderation' })).not.toBeInTheDocument();
    expect(screen.getByText(/are made through the API/)).toBeInTheDocument();
    first.unmount();
    renderPage({ user: iker });
    await screen.findByRole('article', { name: 'Dialect placement 1.0.0' });
    expect(screen.getByRole('link', { name: 'Moderation' })).toHaveAttribute('href', '/app/admin/moderation');
  });
});
