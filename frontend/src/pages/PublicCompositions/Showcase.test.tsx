import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { Organization } from '../../api/platform';
import { AuthContext } from '../../contexts/auth';
import type { CompositionVersionView, CompositionView } from '../../shared/api/types';
import fmsVersion from '../../test/fixtures/core/fms.version.json';
import { Showcase } from './Showcase';

const api = vi.hoisted(() => ({ get: vi.fn(), allVersions: vi.fn(), version: vi.fn(), fork: vi.fn() }));
vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

const platform = vi.hoisted(() => ({ organizations: vi.fn() }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

const person: UserProfile = {
  id: 'user-1', username: 'alice', email: 'alice@example.com', role: 'user', is_active: true, plan: 'FREE', created_at: '2026-01-01T00:00:00Z',
};

const organization = (slug: string, name: string, role: Organization['effective_role']): Organization => ({
  id: `org-${slug}`, slug, name, parent_id: null, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});
const OWN = [organization('isa-demo', 'ISA Demo Group', 'OWNER'), organization('qos-lab', 'QoS Lab', 'MEMBER')];

function compositionOf(over: Partial<CompositionView> = {}): CompositionView {
  return {
    id: 'composition-fleet', slug: 'fleet-routing', name: 'Fleet routing', description: 'Plans the delivery routes of a fleet.', kind: 'workflow',
    archived: false, visibility: 'public', organization: { id: 'org-lab-other', slug: 'lab-other', name: 'Other Lab' }, created_by_id: null,
    created_at: '2026-08-20T09:00:00Z', updated_at: '2026-09-30T14:00:00Z', version_count: 2,
    latest_version: { id: 'v2', ordinal: 2, label: '1.1.0', values_status: 'verified', verified: true, created_at: '2026-09-30T14:00:00Z' },
    ...over,
  };
}

/** A version of the gateway's fixture, as a public reader gets it: no problem id, the current evaluation without its findings. */
function linkedVersion(id: string, label: string, ordinal: number, createdAt: string): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  return {
    ...version, id, label, ordinal, created_at: createdAt, created_by_id: null,
    document: { ...version.document, version: label },
    problem: version.problem && { ...version.problem, problem: { ...version.problem.problem, id: null } },
    evaluations: version.evaluations.filter((item) => item.current).map((item) => ({ ...item, diagnostics: [], violations: [], binding: null })),
  };
}

const v1 = linkedVersion('v1', '1.0.0', 1, '2026-08-20T09:00:00Z');
const v2 = linkedVersion('v2', '1.1.0', 2, '2026-09-30T14:00:00Z');

const declared: CompositionVersionView = {
  ...v2, id: 'd1', label: '1.0.0', ordinal: 1, problem: null, values_status: 'declared', verified: false, offering: { url: 'https://pricings.example.org/desk.yml' },
  current_evaluation: v2.current_evaluation && { ...v2.current_evaluation, outcome: 'declared', basis: 'declared', compilation: null },
  evaluations: [], document: { ...v2.document, problem: undefined, evidence: { evaluatedBy: 'declared' } },
};

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}{where.state ? ` ${JSON.stringify(where.state)}` : ''}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderShowcase(url = '/c/lab-other/fleet-routing', user: UserProfile | null = null) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Routes>
          <Route path="/c/:org/:composition" element={<><Showcase /><Where /></>} />
          <Route path="/login" element={<Where />} />
          <Route path="/app/:org/compositions/:composition" element={<Where />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const region = (name: string) => screen.getByRole('region', { name });

describe('Showcase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ value: compositionOf(), etag: 'W/"3"' });
    api.allVersions.mockResolvedValue([v2, v1]);
    api.version.mockImplementation(async (_org: string, _slug: string, id: string) => [v1, v2, declared].find((version) => version.id === id));
    platform.organizations.mockResolvedValue(OWN);
  });

  it('shows a visitor a linked public composition as its documents say it, and nothing of its problem but the reference', async () => {
    renderShowcase();

    expect(await screen.findByRole('heading', { level: 1, name: 'Fleet routing' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('lab-other', 'fleet-routing');
    expect(api.allVersions).toHaveBeenCalledWith('lab-other', 'fleet-routing', { order: 'newest' });
    await waitFor(() => expect(api.version).toHaveBeenCalledWith('lab-other', 'fleet-routing', 'v2', { document: true }));
    expect(screen.getByText('Workflow · Other Lab')).toBeInTheDocument();
    expect(region('What it does')).toHaveTextContent('Plans the delivery routes of a fleet.');
    expect(await screen.findByRole('region', { name: 'Value status' })).toHaveTextContent('Verified');
    expect(region('Values')).toHaveTextContent('3,060 USD/month');
    expect(within(region('Workflow')).getByRole('group', { name: 'The workflow of Fleet routing' })).toBeInTheDocument();
    expect(region('Providers')).toBeInTheDocument();
    expect(region('Problem')).toHaveTextContent('fixtures/problems/fms@1');
    // A reader who is not a member only reads: no candidates of the problem, no findings, no analysis, no app.
    for (const name of ['Problem candidates', 'Evaluation findings', 'Moves', 'This binding']) expect(screen.queryByRole('region', { name })).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open in the app' })).toBeNull();
    expect(screen.queryByText('Only members see this page')).toBeNull();
    expect(platform.organizations).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Public compositions' })).toHaveAttribute('href', '/compositions');
  });

  it('shows a declared composition with its own pricing as a reference, and no problem', async () => {
    api.get.mockResolvedValue({ value: compositionOf({ slug: 'order-desk', name: 'Order desk', kind: 'application', version_count: 1 }), etag: null });
    api.allVersions.mockResolvedValue([declared]);
    renderShowcase('/c/isa-demo/order-desk');

    expect(await screen.findByRole('region', { name: 'Value status' })).toHaveTextContent('Declared');
    expect(screen.queryByRole('region', { name: 'Problem' })).toBeNull();
    const offering = region('Offering');
    expect(within(offering).getByRole('link', { name: /pricings\.example\.org\/desk\.yml/ })).toHaveAttribute('href', 'https://pricings.example.org/desk.yml');
    expect(offering).toHaveTextContent('Plans and prices arrive when OpenBinding reads the offering.');
  });

  it('opens the version the address names, and lists every version as a link to its own page', async () => {
    renderShowcase('/c/lab-other/fleet-routing?version=1.0.0');

    await waitFor(() => expect(api.version).toHaveBeenCalledWith('lab-other', 'fleet-routing', 'v1', { document: true }));
    expect(await screen.findByText(/Version/, { selector: 'p' })).toHaveTextContent('Version 1.0.0, sealed Aug 20, 2026 · Updated Sep 30, 2026');
    const versions = screen.getByRole('list', { name: 'Versions' });
    expect(within(versions).getByRole('link', { name: '1.0.0' })).toHaveAttribute('aria-current', 'page');
    expect(within(versions).getByRole('link', { name: '1.1.0' })).toHaveAttribute('href', '/c/lab-other/fleet-routing?version=1.1.0');
    expect(within(versions).getByRole('link', { name: '1.1.0' })).not.toHaveAttribute('aria-current');
  });

  it('sends a visitor who asks to fork to sign in, to come back to this version with the fork asked for', async () => {
    renderShowcase('/c/lab-other/fleet-routing?version=1.0.0');

    fireEvent.click(await screen.findByRole('button', { name: 'Fork' }));
    expect(where()).toBe('/login {"from":"/c/lab-other/fleet-routing?version=1.0.0&fork=1"}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the fork dialog once for a signed-in reader who comes back with ?fork=1, and drops the parameter', async () => {
    renderShowcase('/c/lab-other/fleet-routing?version=1.1.0&fork=1', person);

    const dialog = await screen.findByRole('dialog', { name: 'Fork this composition' });
    await waitFor(() => expect(where()).toBe('/c/lab-other/fleet-routing?version=1.1.0'));
    expect(await within(dialog).findByRole('radio', { name: 'QoS Lab' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Fork is the reader's to ask for again, from the page.
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(screen.getByRole('dialog', { name: 'Fork this composition' })).toBeInTheDocument();
  });

  it('tells a member that only members see a private composition here, and offers it in the app', async () => {
    api.get.mockResolvedValue({ value: compositionOf({ visibility: 'private', organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' } }), etag: null });
    renderShowcase('/c/isa-demo/fleet-routing', person);

    expect(await screen.findByText('Only members see this page')).toBeInTheDocument();
    expect(screen.getByText(/anybody outside ISA Demo Group who opens this address is told there is no composition here/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open in the app' })).toHaveAttribute('href', '/app/isa-demo/compositions/fleet-routing?version=1.1.0');
    expect(platform.organizations).toHaveBeenCalled();
  });

  it('answers a missing composition and one the reader may not see in the same words', async () => {
    api.get.mockRejectedValue(Object.assign(new HttpError(404, 'Composition not found.'), { code: 'not_found' }));
    renderShowcase('/c/isa-demo/legacy-intake');

    expect(await screen.findByRole('heading', { name: 'No composition here, or you cannot see it' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // The way back, above the page and in the answer itself.
    for (const link of screen.getAllByRole('link', { name: 'Public compositions' })) expect(link).toHaveAttribute('href', '/compositions');
  });

  it('says when the gateway did not answer, and reads the composition again', async () => {
    api.get.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderShowcase();

    expect(await screen.findByRole('heading', { name: /The composition couldn’t be loaded/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Fleet routing' })).toBeInTheDocument();
  });
});
