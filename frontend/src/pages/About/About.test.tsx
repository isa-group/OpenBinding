import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGateway, type GatewayStatus, type ProbeName, type ProbeResult } from '../../api/health';
import { About } from './About';
import { aboutData, type AboutData } from './aboutModel';

vi.mock('../../api/health', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/health')>()), checkGateway: vi.fn() }));

const probe = (name: ProbeName, state: 'ok' | 'failed' | 'unreached', status = 200): ProbeResult => ({
  name,
  request: `GET /${name}`,
  reached: state !== 'unreached',
  status: state === 'unreached' ? null : status,
  ok: state === 'ok',
  ms: state === 'unreached' ? null : 3,
  body: null,
});

function gatewayStatus(probes: Record<ProbeName, ProbeResult>, dependencies: GatewayStatus['dependencies'] = []): GatewayStatus {
  return { checkedAt: new Date('2026-11-01T10:00:00Z'), probes, dependencies };
}

const OPERATIONAL = gatewayStatus({ health: probe('health', 'ok'), live: probe('live', 'ok'), ready: probe('ready', 'ok') }, [
  { name: 'database', value: 'ok', state: 'ok' },
]);

beforeEach(() => {
  vi.mocked(checkGateway).mockReset();
  vi.mocked(checkGateway).mockResolvedValue(OPERATIONAL);
});

function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderAbout(path = '/about', data?: AboutData) {
  return render(<MemoryRouter initialEntries={[path]}><About data={data} /><Search /></MemoryRouter>);
}

const EMPTY: AboutData = {
  team: [], research: [], researchFacts: [], funding: [], relatedProjects: [], contributions: [],
  changelog: { platform: [], bim: [], documentation: [] },
};

describe('About', () => {
  it('opens on the team with the real roster and profile links', () => {
    renderAbout();

    expect(screen.getByRole('heading', { level: 1, name: 'People, research and changes behind OpenBinding' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Team', 'Research', 'Funding', 'Contributions', 'Changelog']);

    const person = screen.getByRole('article', { name: 'Francisco Javier Cavero López' });
    expect(within(person).getByText('Maintainer · repository contributor')).toBeInTheDocument();
    expect(within(person).getByText('Universidad de Sevilla')).toBeInTheDocument();
    const profiles = within(within(person).getByRole('navigation', { name: 'Francisco Javier Cavero López profiles' }));
    expect(profiles.getByRole('link', { name: /ORCID/ })).toHaveAttribute('href', 'https://orcid.org/0009-0004-2453-8814');
    expect(profiles.getByRole('link', { name: /GitHub/ })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('article', { name: 'José Antonio Parejo Maestre' })).toBeInTheDocument();
    expect(screen.getByText('Contribution is the source of truth.')).toBeInTheDocument();
    expect(screen.queryByText(/\[/)).not.toBeInTheDocument();
  });

  it('follows ?tab= and writes it back when a tab is chosen', () => {
    renderAbout('/about?tab=research');
    expect(screen.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Funding' }));

    expect(screen.getByRole('tab', { name: 'Funding' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=funding');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'about-tab-funding');
  });

  it('falls back to the team for an unknown tab and reads contributions as contrib', () => {
    const { unmount } = renderAbout('/about?tab=nonsense');
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
    unmount();

    renderAbout('/about?tab=contributions');
    expect(screen.getByRole('tab', { name: 'Contributions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves between tabs with the arrow keys', () => {
    renderAbout();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Team' }), { key: 'ArrowLeft' });

    expect(screen.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=changelog');
  });

  describe('research', () => {
    it('keeps the real sources, the numbers and the provenance caveat', () => {
      renderAbout('/about?tab=research');

      expect(screen.getByRole('heading', { name: 'Sources represented in the executable corpus.' })).toBeInTheDocument();
      expect(screen.getByText(/Authors retain authorship of the original work/)).toBeInTheDocument();
      const facts = within(screen.getByRole('list', { name: 'The executable corpus in numbers' }));
      expect(facts.getByText('6')).toBeInTheDocument();
      expect(facts.getByText('68+')).toBeInTheDocument();
      expect(screen.getAllByRole('link', { name: /^DOI / })).toHaveLength(aboutData.research.length);
      expect(screen.getByRole('link', { name: /DOI 10\.1109\/ICDE\.2002\.994738/ })).toHaveAttribute('href', 'https://doi.org/10.1109/ICDE.2002.994738');
      expect(screen.getByText('Declarative Composition and Peer-to-Peer Provisioning of Dynamic Web Services')).toBeInTheDocument();
    });
  });

  describe('funding', () => {
    it('shows each funder, with a logo only where one exists, and what each project contributes', () => {
      renderAbout('/about?tab=funding');

      const sevilla = screen.getByRole('link', { name: /Universidad de Sevilla/ });
      expect(sevilla).toHaveAttribute('href', 'https://www.us.es');
      expect(within(sevilla).getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
      expect(within(screen.getByRole('link', { name: /SCORE Lab/ })).queryByRole('img')).not.toBeInTheDocument();
      expect(screen.getByText(/it does not imply that every entity funds every OpenBinding release/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'What each project contributes' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /SPACE/ })).toHaveAttribute('href', 'https://github.com/isa-group/SPACE');
    });
  });

  describe('contributions', () => {
    it('opens a track in a dialog that traps focus, closes on Escape and returns focus', () => {
      renderAbout('/about?tab=contrib');
      const track = screen.getByRole('button', { name: /Engine reproducibility benchmark/ });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      track.focus();
      fireEvent.click(track);

      const dialog = screen.getByRole('dialog', { name: 'Engine reproducibility benchmark' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(within(dialog).getByText(/Build comparative studies that measure Pareto quality/)).toBeInTheDocument();
      expect(within(dialog).getByText('TFG · Research')).toBeInTheDocument();
      expect(within(dialog).getByText('Engines')).toBeInTheDocument();
      expect(dialog).toHaveFocus();
      expect(within(dialog).queryByText('Supervisor:')).not.toBeInTheDocument();

      fireEvent.keyDown(dialog, { key: 'Tab' });
      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(track).toHaveFocus();
    });

    it('closes from the backdrop and names the supervisor when the repository does', () => {
      renderAbout('/about?tab=contrib', {
        ...aboutData,
        contributions: [{ title: 'A thesis', level: 'TFM', tags: ['BIM'], description: 'Do it.', supervisor: 'Dr. Example' }],
      });

      fireEvent.click(screen.getByRole('button', { name: /A thesis/ }));
      expect(screen.getByText('Supervisor:')).toBeInTheDocument();
      expect(screen.getByText('Dr. Example')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('invites a proposal through the issue tracker', () => {
      renderAbout('/about?tab=contrib');

      expect(screen.getByRole('link', { name: /Discuss an idea/ })).toHaveAttribute('href', 'https://github.com/isa-group/OpenBinding/issues');
    });
  });

  describe('changelog', () => {
    it('lists every stream newest first and filters by stream', () => {
      renderAbout('/about?tab=changelog', {
        ...EMPTY,
        changelog: {
          platform: [{ version: '1.2.0', date: '2026-09-06', title: 'Add collaborative binding analysis platform', changes: ['Share analyses'] }],
          bim: [
            { version: 'next', date: 'Unreleased', title: 'Upcoming engine work', changes: [] },
            { version: '0.5.0', date: '2026-09-20', title: 'Binding language and engines', changes: ['New engine'] },
          ],
          documentation: [{ version: '0.3.0', date: '2026-08-01', title: 'OpenBinding documentation', changes: ['Guides'] }],
        },
      });
      const entries = () => within(screen.getByRole('tabpanel')).getAllByRole('article');

      expect(entries().map((entry) => within(entry).getByRole('heading').textContent)).toEqual([
        'Upcoming engine work', 'Binding language and engines', 'Add collaborative binding analysis platform', 'OpenBinding documentation',
      ]);
      expect(screen.getByText('Unreleased')).toBeInTheDocument();
      expect(screen.getByText('No changes recorded yet.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Platform' }));

      expect(screen.getByRole('button', { name: 'Platform' })).toHaveAttribute('aria-pressed', 'true');
      expect(entries()).toHaveLength(1);
      expect(within(entries()[0]).getByText('Add collaborative binding analysis platform')).toBeInTheDocument();
      expect(within(entries()[0]).getByText('2026-09-06')).toBeInTheDocument();
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(expect.arrayContaining(['All', 'Platform', 'BIM-Engines', 'Documentation']));
    });
  });

  describe('without reviewed data', () => {
    it.each([
      ['team', 'team'],
      ['research', 'research'],
      ['funding', 'funding'],
      ['contrib', 'contributions'],
      ['changelog', 'changelog'],
    ])('shows "Pending editorial review" on the %s tab', (tab, noun) => {
      renderAbout(`/about?tab=${tab}`, EMPTY);

      expect(screen.getByText('Pending editorial review')).toBeInTheDocument();
      expect(screen.getByText(`Entries for ${noun} appear once they’re reviewed.`)).toBeInTheDocument();
    });
  });

  describe('service status note', () => {
    it('says that every system is operational when the check reports every dependency up', async () => {
      renderAbout();

      expect(await screen.findByText('Service status: All systems operational')).toBeInTheDocument();
    });

    it('is checking while the gateway has not answered', () => {
      vi.mocked(checkGateway).mockReturnValue(new Promise(() => {}));
      renderAbout();

      expect(screen.getByText('Service status: checking…')).toBeInTheDocument();
    });

    it('says Degraded when readiness fails', async () => {
      vi.mocked(checkGateway).mockResolvedValue(gatewayStatus({ health: probe('health', 'ok'), live: probe('live', 'ok'), ready: probe('ready', 'failed', 503) }));
      renderAbout();

      expect(await screen.findByText('Service status: Degraded')).toBeInTheDocument();
    });

    it('says Degraded when a dependency is down although every probe answered', async () => {
      vi.mocked(checkGateway).mockResolvedValue(gatewayStatus(
        { health: probe('health', 'ok'), live: probe('live', 'ok'), ready: probe('ready', 'ok') },
        [{ name: 'space', value: 'unavailable', state: 'down' }],
      ));
      renderAbout();

      expect(await screen.findByText('Service status: Degraded')).toBeInTheDocument();
    });

    it('says the gateway reports errors when the health or live probe fails', async () => {
      vi.mocked(checkGateway).mockResolvedValue(gatewayStatus({ health: probe('health', 'failed', 500), live: probe('live', 'ok'), ready: probe('ready', 'ok') }));
      renderAbout();

      expect(await screen.findByText('Service status: Gateway reporting errors')).toBeInTheDocument();
    });

    it('says it is not available when no probe answers, and still renders the page', async () => {
      vi.mocked(checkGateway).mockResolvedValue(gatewayStatus({ health: probe('health', 'unreached'), live: probe('live', 'unreached'), ready: probe('ready', 'unreached') }));
      renderAbout();

      expect(await screen.findByText('Service status: not available right now')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'People, research and changes behind OpenBinding' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Team' })).toBeInTheDocument();
    });

    it('says it is not available when the check throws, and still renders the page', async () => {
      vi.mocked(checkGateway).mockRejectedValue(new Error('boom'));
      renderAbout();

      expect(await screen.findByText('Service status: not available right now')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Team' })).toBeInTheDocument();
    });
  });

  it('links to no address that has been removed', () => {
    renderAbout('/about?tab=funding');

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => /^\/(team|research|funding|contributions|changelog)(\/|$)/.test(href))).toEqual([]);
  });
});
