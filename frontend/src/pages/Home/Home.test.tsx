import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, SESSION_ENDED_EVENT } from '../../api/client';
import { Home } from './Home';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  getDialects: vi.fn(),
  getEngines: vi.fn(),
  getPublicEngines: vi.fn(),
}));
const platform = vi.hoisted(() => ({ publicProjects: vi.fn(), publicPublications: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

const DIGEST = `sha256-${'ab'.repeat(32)}`;

const publication = {
  slug: 'checkout-engines',
  citation: { title: 'Engines at checkout', authors: ['Lucía Vega'], year: 2026 },
  report: { title: 'Engines at checkout', digest: DIGEST, version_id: 'v1' },
  project: 'qos',
  organization: 'isa-demo',
  publishedAt: '2026-09-25T10:00:00Z',
};
const project = {
  organization: { slug: 'isa-demo', name: 'ISA Demo Group' },
  project: { slug: 'qos', name: 'QoS Benchmarks', description: 'Reference binding cases.' },
};
const engine = (name: string) => ({ id: name, namespace: 'bim.builtin', name, version: '1.0.0', digest: `sha256-${'cd'.repeat(32)}`, ref: {}, modes: [] });

function renderHome() {
  return render(<MemoryRouter><Home /></MemoryRouter>);
}

describe('Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    api.getProfiles.mockResolvedValue([{ id: 'qos-binding/v1' }]);
    api.getDialects.mockResolvedValue([{ id: 'json' }, { id: 'bpmn' }]);
    api.getEngines.mockResolvedValue([engine('private-solver'), engine('random-search')]);
    api.getPublicEngines.mockResolvedValue([engine('random-search'), engine('evolutionary')]);
    platform.publicProjects.mockResolvedValue([project]);
    platform.publicPublications.mockResolvedValue([publication]);
  });

  describe('hero and runtime catalogue', () => {
    it('invites a visitor to create an account and reads the public catalogue only', async () => {
      renderHome();

      expect(screen.getByRole('heading', { level: 1, name: 'Describe. Bind. Reproduce.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Create an account/ })).toHaveAttribute('href', '/register');
      expect(screen.getByRole('link', { name: /Validate a package/ })).toHaveAttribute('href', '/workbench');
      expect(screen.getByRole('link', { name: /Explore published results/ })).toHaveAttribute('href', '/explore');
      const runtime = screen.getByRole('status', { name: 'Runtime catalogue status' });
      expect(await within(runtime).findByText('2 public engine revisions')).toBeInTheDocument();
      expect(within(runtime).getByText('1 executable profile')).toBeInTheDocument();
      expect(within(runtime).getByText('2 installed dialects')).toBeInTheDocument();
      expect(api.getEngines).not.toHaveBeenCalled();
    });

    it('sends a signed-in account to its workspace and counts the engines it can see', async () => {
      auth.user = { id: 'u1', username: 'alice', email: 'alice@example.test', role: 'user', plan: 'RESEARCH', is_active: true, created_at: '2026-01-01T00:00:00Z' };
      renderHome();

      const card = screen.getByRole('link', { name: /Go to your workspace/ });
      expect(card).toHaveAttribute('href', '/app');
      expect(card).toHaveTextContent('Signed in as alice · RESEARCH plan');
      expect(screen.queryByRole('link', { name: /Create an account/ })).not.toBeInTheDocument();
      const runtime = screen.getByRole('status', { name: 'Runtime catalogue status' });
      expect(await within(runtime).findByText('2 engine revisions')).toBeInTheDocument();
      expect(api.getEngines).toHaveBeenCalledOnce();
    });

    it('says so when the runtime catalogue cannot be read', async () => {
      api.getProfiles.mockRejectedValue(new Error('offline'));
      renderHome();

      expect(await screen.findByText('Runtime catalogue unavailable')).toBeInTheDocument();
    });

    it('keeps the shortcuts the previous home offered', () => {
      renderHome();

      expect(screen.getByRole('link', { name: /Learn with an example/ })).toHaveAttribute('href', '/examples');
      expect(screen.getByRole('link', { name: /Explore extensibility/ })).toHaveAttribute('href', '/language');
      expect(screen.getByRole('heading', { name: 'A stable core, plural problem families.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Inspect engine modes/ })).toHaveAttribute('href', '/engines');
    });

    it('tells a visitor whose session just ended that nothing private is shown', () => {
      renderHome();
      expect(screen.queryByText(/Your session expired/)).not.toBeInTheDocument();

      act(() => { window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT)); });

      expect(screen.getByText(/Your session expired, so you’re browsing as a visitor/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Log in again' })).toHaveAttribute('href', '/login');
    });
  });

  describe('how it works', () => {
    it('walks the six stages and links each to where it is explained', () => {
      renderHome();
      const tabs = within(screen.getByRole('tablist', { name: 'Pipeline stages' })).getAllByRole('tab');

      expect(tabs).toHaveLength(6);
      expect(screen.getByRole('link', { name: 'Browse example packages' })).toHaveAttribute('href', '/examples');
      fireEvent.click(screen.getByRole('tab', { name: /Engine/ }));
      expect(screen.getByRole('tab', { name: /Engine/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('link', { name: 'Browse engines' })).toHaveAttribute('href', '/engines');
      fireEvent.keyDown(screen.getByRole('tab', { name: /Engine/ }), { key: 'End' });
      expect(screen.getByRole('link', { name: 'See published results' })).toHaveAttribute('href', '/explore');
    });
  });

  describe('recently public', () => {
    it('shows a loading placeholder first', () => {
      platform.publicPublications.mockReturnValue(new Promise(() => undefined));
      renderHome();

      expect(screen.getByText('Loading recent publications')).toBeInTheDocument();
    });

    it('lists publications, projects and engines with the places they open', async () => {
      renderHome();

      const publicationLink = await screen.findByRole('link', { name: /Engines at checkout/ });
      expect(publicationLink).toHaveAttribute('href', `/resolve/report/${DIGEST}`);
      expect(publicationLink).toHaveTextContent('ISA Demo Group / QoS Benchmarks');
      expect(publicationLink).toHaveTextContent('Lucía Vega · 2026');
      expect(screen.getByRole('link', { name: /Reference binding cases/ })).toHaveAttribute('href', '/explore?tab=projects');
      const engines = screen.getByRole('link', { name: /2 public engine revisions/ });
      expect(engines).toHaveAttribute('href', '/engines');
      expect(engines).toHaveTextContent('random-search · evolutionary');
      expect(screen.getByRole('link', { name: 'View all in Explore' })).toHaveAttribute('href', '/explore');
    });

    it('explains an empty catalogue instead of leaving a gap', async () => {
      platform.publicProjects.mockResolvedValue([]);
      platform.publicPublications.mockResolvedValue([]);
      api.getPublicEngines.mockResolvedValue([]);
      renderHome();

      expect(await screen.findByText('Nothing has been published yet')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Read the language guide' })).toHaveAttribute('href', '/language');
    });

    it('reports a failure with its status, keeps the page and retries on request', async () => {
      platform.publicProjects.mockRejectedValue(new HttpError(503, 'down'));
      platform.publicPublications.mockRejectedValue(new HttpError(503, 'down'));
      renderHome();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Recent publications couldn’t be loaded (HTTP 503)');
      expect(screen.getByRole('heading', { name: 'Free to start, institutional when you scale' })).toBeInTheDocument();

      platform.publicProjects.mockResolvedValue([project]);
      platform.publicPublications.mockResolvedValue([publication]);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('link', { name: /Engines at checkout/ })).toBeInTheDocument();
      expect(platform.publicPublications).toHaveBeenCalledTimes(2);
    });
  });

  describe('plans and links', () => {
    it('summarises the four plans and points to the live pricing', () => {
      renderHome();

      for (const name of ['Basic', 'Research', 'Advanced', 'Pro']) expect(screen.getByText(name, { selector: '.home-kicker' })).toBeInTheDocument();
      expect(screen.getByText('10 solves / month')).toBeInTheDocument();
      expect(screen.getByText('Unlimited solves')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      expect(screen.getByText(/Headline limits from pricing 0\.1\.0/)).toBeInTheDocument();
    });

    it('links only to routes that exist', async () => {
      renderHome();
      await screen.findByRole('link', { name: /Engines at checkout/ });

      const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
      expect(hrefs.filter((href) => /^\/(playground|profiles|schemas|team|research|funding|contributions|changelog|engines\/new|analytics|artifacts)(\/|\?|$)/.test(href))).toEqual([]);
    });
  });
});
