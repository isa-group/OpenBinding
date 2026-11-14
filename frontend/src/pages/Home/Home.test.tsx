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
const auth = vi.hoisted(() => ({ user: null as UserProfile | null }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

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
  });

  describe('hero and runtime catalogue', () => {
    it('invites a visitor to create an account and reads the public catalogue only', async () => {
      renderHome();

      expect(screen.getByRole('heading', { level: 1, name: 'Describe. Bind. Reproduce.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Create an account/ })).toHaveAttribute('href', '/register');
      expect(screen.getByRole('link', { name: /Validate a package/ })).toHaveAttribute('href', '/workbench');
      expect(screen.getByRole('link', { name: /Browse the engines/ })).toHaveAttribute('href', '/engines');
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

      expect(screen.getByRole('link', { name: /Learn with an example/ })).toHaveAttribute('href', '/workbench');
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
      expect(screen.getByRole('link', { name: 'Try an example package' })).toHaveAttribute('href', '/workbench');
      fireEvent.click(screen.getByRole('tab', { name: /Engine/ }));
      expect(screen.getByRole('tab', { name: /Engine/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('link', { name: 'Browse engines' })).toHaveAttribute('href', '/engines');
      fireEvent.keyDown(screen.getByRole('tab', { name: /Engine/ }), { key: 'End' });
      expect(screen.getByRole('link', { name: 'About OpenBinding' })).toHaveAttribute('href', '/about');
    });
  });

  describe('public engines', () => {
    it('shows a loading placeholder first', () => {
      api.getPublicEngines.mockReturnValue(new Promise(() => undefined));
      renderHome();

      expect(screen.getByText('Loading the public engines')).toBeInTheDocument();
    });

    it('lists the public engines with the page they open', async () => {
      renderHome();

      const engines = await screen.findByRole('link', { name: /2 public engine revisions/ });
      expect(engines).toHaveAttribute('href', '/engines');
      expect(engines).toHaveTextContent('random-search · evolutionary');
      expect(screen.getByRole('link', { name: 'All engines' })).toHaveAttribute('href', '/engines');
      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '').filter((href) => href.startsWith('/explore'))).toEqual([]);
    });

    it('explains an empty catalogue instead of leaving a gap', async () => {
      api.getPublicEngines.mockResolvedValue([]);
      renderHome();

      expect(await screen.findByText('No public engines yet')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Read the language guide' })).toHaveAttribute('href', '/language');
    });

    it('reports a failure with its status, keeps the page and retries on request', async () => {
      api.getPublicEngines.mockRejectedValue(new HttpError(503, 'down'));
      renderHome();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The public engines couldn’t be loaded (HTTP 503)');
      expect(screen.getByRole('heading', { name: 'Free to start, institutional when you scale' })).toBeInTheDocument();

      api.getPublicEngines.mockResolvedValue([engine('random-search')]);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('link', { name: /1 public engine revision/ })).toBeInTheDocument();
    });
  });

  describe('plans and links', () => {
    it('summarises the four plans and points to the live pricing', () => {
      renderHome();

      for (const name of ['Basic', 'Research', 'Advanced', 'Pro']) expect(screen.getByText(name, { selector: '.home-kicker' })).toBeInTheDocument();
      expect(screen.getByText('1 concurrent run')).toBeInTheDocument();
      expect(screen.getByText('Unlimited API keys')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      expect(screen.getByText(/Headline limits from pricing 0\.1\.0/)).toBeInTheDocument();
    });

    it('links only to routes that exist', async () => {
      renderHome();
      await screen.findByRole('link', { name: /2 public engine revisions/ });

      const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
      expect(hrefs.filter((href) => /^\/(playground|profiles|schemas|team|research|funding|contributions|changelog|engines\/new|analytics|artifacts)(\/|\?|$)/.test(href))).toEqual([]);
    });
  });
});
