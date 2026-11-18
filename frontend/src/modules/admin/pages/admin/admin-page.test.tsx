import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARIA, MODERATION, queuesAt } from '../../../../test/fixtures/admin';
import { ADMIN_SECTION_IDS, adminPath } from '../../../../routes/paths/admin';
import { renderSection } from '../../utils/adminTestUtils';
import { ADMIN_SECTIONS } from './sections';

// `/admin/:section?`: SPHERE's settings shell around the sections of administration. What each section shows is tested beside
// it (components/*-section); this is the shell: the nav, the address, and who gets a page at all.

const api = vi.hoisted(() => ({
  adminOverview: vi.fn(),
  adminQueues: vi.fn(),
  adminModeration: vi.fn(),
  adminErrorOverview: vi.fn(),
  getPlansPricing: vi.fn(),
  adminListEngineRegistrations: vi.fn(),
}));

vi.mock('../../api/adminApi', () => ({ useAdminApi: () => api }));

configure({ asyncUtilTimeout: 5000 });

describe('admin · the settings shell of administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminOverview.mockResolvedValue({ counts: {}, jobs: {}, contracts: {}, recentAudit: [] });
    api.adminQueues.mockImplementation(async () => queuesAt(Date.now()));
    api.adminModeration.mockResolvedValue(MODERATION);
    api.adminErrorOverview.mockResolvedValue({
      total_errors_24h: 0,
      by_category_24h: {},
      by_status_code_24h: {},
      top_users_quota: [],
      top_solvers_failed: [],
      timeline: [],
    });
    api.getPlansPricing.mockResolvedValue({ version: '1.0.0' });
    api.adminListEngineRegistrations.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every section in its nav, each a link to its address, the current one marked', async () => {
    renderSection('/admin/queues');
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Queues' })).toBeInTheDocument();
    const nav = within(screen.getByRole('navigation', { name: 'Administration' }));
    const links = nav.getAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual(ADMIN_SECTIONS.map(item => item.label));
    expect(links.map(link => link.getAttribute('href'))).toEqual(
      ADMIN_SECTION_IDS.map(id => adminPath(id))
    );
    expect(nav.getByRole('link', { name: 'Queues' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    await waitFor(() => expect(document.title).toBe('OpenBinding - Administration'));
  });

  it('opens on the overview, which has no segment of its own', async () => {
    renderSection('/admin');
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Administration' })).getByRole('link', {
        name: 'Overview',
      })
    ).toHaveAttribute('aria-current', 'page');
  });

  it('follows the nav from one section to another', async () => {
    renderSection('/admin/queues');
    await screen.findByRole('heading', { level: 2, name: 'Queues' });
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Administration' })).getByRole('link', {
        name: 'Moderation',
      })
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Moderation' })
    ).toBeInTheDocument();
    expect(api.adminModeration).toHaveBeenCalled();
  });

  it('picks the section from a labelled menu on a phone, which closes on Escape', async () => {
    renderSection('/admin/queues');
    const toggle = screen.getByRole('button', { name: 'Administration section: Queues' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const menu = screen.getByRole('navigation', { name: 'Administration sections' });
    expect(within(menu).getAllByRole('link')).toHaveLength(ADMIN_SECTIONS.length);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('reads a section that does not exist as a page that does not exist', async () => {
    renderSection('/admin/pricing');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Administration' })).not.toBeInTheDocument();
  });

  it.each(ADMIN_SECTION_IDS)(
    'shows a person who is not an administrator the in-place 404 at /admin/%s, and asks the gateway nothing',
    async section => {
      renderSection(adminPath(section), { user: MARIA });
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Page not found' })
      ).toBeInTheDocument();
      expect(screen.queryByText('Administration')).not.toBeInTheDocument();
      for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
    }
  );
});
