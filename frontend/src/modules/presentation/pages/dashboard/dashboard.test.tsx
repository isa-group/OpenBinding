import { act, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGateway, orgNode, renderModule } from '../../../../test/moduleKit';
import myEvents from '../../../../test/fixtures/core/upstream.me.events.json';
import myProposals from '../../../../test/fixtures/core/zproposals.me.json';
import DashboardPage from '.';

const runs = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../../run/api/runsClient', async actual => ({
  ...(await actual<typeof import('../../../run/api/runsClient')>()),
  runsApi: runs,
}));

// An upstream event arriving, as useUpstreamRefresh tells the page (the hook itself is tested on its own).
const upstreamArrivals = vi.hoisted(() => ({
  count: 0,
  listeners: new Set<(count: number) => void>(),
}));
vi.mock('../../../notification/hooks/useUpstreamRefresh', () => ({
  useUpstreamRefresh: () => {
    const [count, setCount] = useState(upstreamArrivals.count);
    useEffect(() => {
      upstreamArrivals.listeners.add(setCount);
      return () => {
        upstreamArrivals.listeners.delete(setCount);
      };
    }, []);
    return count;
  },
}));
const arrive = () =>
  act(() => {
    upstreamArrivals.count += 1;
    upstreamArrivals.listeners.forEach(listener => listener(upstreamArrivals.count));
  });

const group = orgNode('isa-demo', { name: 'ISA Demo Group' });
const composition = {
  id: 'c1',
  slug: 'fleet-routing',
  name: 'Fleet routing',
  kind: 'workflow',
  organization: { id: group.id, slug: 'isa-demo', name: 'ISA Demo Group' },
};

describe('the dashboard', () => {
  beforeEach(() => {
    localStorage.clear();
    runs.list.mockResolvedValue({
      runs: [
        {
          id: 'r1',
          engine_id: 'random-search',
          status: 'running',
          created_at: '2026-11-15T10:00:00Z',
          problem: { id: 'p1', slug: 'checkout', name: 'Checkout flow' },
        },
      ],
      total: 1,
    });
  });

  it('greets the account and counts its organizations, compositions and running runs', async () => {
    renderModule(<DashboardPage />, {
      tree: [group],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [composition], total: 7 } },
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, alex.rivera' })
    ).toBeInTheDocument();
    const stats = screen.getByRole('list', { name: 'Your workspace in numbers' });
    expect(within(stats).getByText('7')).toBeInTheDocument();
    expect(within(stats).getByText('Runs running').previousSibling).toHaveTextContent('1');
    expect(screen.getByRole('link', { name: /Fleet routing/ })).toHaveAttribute(
      'href',
      '/compositions/isa-demo/fleet-routing'
    );
    expect(screen.getByRole('link', { name: /Checkout flow/ })).toHaveAttribute(
      'href',
      '/runs/isa-demo/r1'
    );
    expect(
      within(screen.getByRole('region', { name: 'Recent organizations' })).getByRole('link', {
        name: /ISA Demo Group/,
      })
    ).toHaveAttribute('href', '/orgs/isa-demo');
    expect(screen.getByRole('link', { name: /Start a run/ })).toBeInTheDocument();
  });

  it('marks a personal organization Personal and a team Team, as SPHERE’s cards do', async () => {
    const mine = orgNode('alex-rivera', { name: 'alex.rivera PERSONAL', is_personal: true });
    runs.list.mockResolvedValue({ runs: [], total: 0 });
    renderModule(<DashboardPage />, {
      tree: [group, mine],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [], total: 0 } },
      }),
    });
    const recent = await screen.findByRole('region', { name: 'Recent organizations' });
    const card = (name: RegExp) => within(recent).getByRole('link', { name });
    expect(within(card(/alex\.rivera PERSONAL/)).getByText('Personal')).toBeInTheDocument();
    expect(within(card(/ISA Demo Group/)).getByText('Team')).toBeInTheDocument();
  });

  it('shows the first steps to an account without organizations', async () => {
    renderModule(<DashboardPage />, {
      tree: [],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [], total: 0 } },
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No organizations yet' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create organization' })).toHaveAttribute(
      'href',
      '/orgs/new'
    );
    expect(screen.getByText(/I have an invitation link/)).toBeInTheDocument();
  });

  it('shows the open upstream changes and the account’s pending proposals after the recent compositions', async () => {
    renderModule(<DashboardPage />, {
      tree: [group],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [composition], total: 1 } },
        'GET /v1/users/me/upstream-events': { body: myEvents },
        'GET /v1/users/me/proposals': { body: myProposals },
      }),
    });
    const changes = await screen.findByRole('region', { name: 'Upstream changes' });
    const [event] = myEvents.events;
    expect(within(changes).getByRole('link', { name: /brevo 2026-10 → 2026-11/ })).toHaveAttribute(
      'href',
      `/compositions/${event.organization.slug}/${event.composition.slug}/operation?event=${event.id}`
    );
    expect(changes).toHaveTextContent('Values changed');
    const pending = screen.getByRole('region', { name: 'Your pending proposals' });
    expect(pending).toHaveTextContent(myProposals.proposals[0].summary);
    expect(pending).toHaveTextContent('waiting for your confirmation');
    const order = screen
      .getAllByRole('region')
      .map(region => region.getAttribute('aria-label'))
      .filter(Boolean);
    expect(order.indexOf('Upstream changes')).toBe(order.indexOf('Recent compositions') + 1);
  });

  it('says which upstream changes were already reviewed but not resolved', async () => {
    const [open] = myEvents.events;
    renderModule(<DashboardPage />, {
      tree: [group],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [composition], total: 1 } },
        'GET /v1/users/me/upstream-events': {
          body: { ...myEvents, events: [{ ...open, state: 'reviewed' }] },
        },
        'GET /v1/users/me/proposals': { body: { proposals: [] } },
      }),
    });
    const changes = await screen.findByRole('region', { name: 'Upstream changes' });
    expect(within(changes).getByRole('listitem')).toHaveTextContent('Reviewed');
  });

  it('keeps what it shows when a re-read after an upstream arrival fails', async () => {
    let failing = false;
    const answer = (body: unknown) => () =>
      failing ? { status: 503, body: { title: 'Unavailable' } } : { body };
    renderModule(<DashboardPage />, {
      tree: [group],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': answer({ compositions: [composition], total: 1 }),
        'GET /v1/users/me/upstream-events': answer(myEvents),
        'GET /v1/users/me/proposals': answer(myProposals),
      }),
    });
    await screen.findByRole('region', { name: 'Upstream changes' });
    expect(screen.getByRole('link', { name: /Fleet routing/ })).toBeInTheDocument();
    failing = true;
    const asked = runs.list.mock.calls.length;
    runs.list.mockRejectedValue(new Error('unavailable'));
    arrive();
    await waitFor(() => expect(runs.list.mock.calls.length).toBeGreaterThan(asked));
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Upstream changes' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your pending proposals' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fleet routing/ })).toBeInTheDocument();
    expect(screen.getAllByText(/random-search/).length).toBeGreaterThan(0);
  });

  it('hides both panels when there is nothing to show', async () => {
    renderModule(<DashboardPage />, {
      tree: [group],
      gateway: fakeGateway({
        'GET /v1/users/me/compositions': { body: { compositions: [composition], total: 1 } },
        'GET /v1/users/me/upstream-events': { body: { events: [] } },
        'GET /v1/users/me/proposals': { body: { proposals: [] } },
      }),
    });
    await screen.findByRole('region', { name: 'Recent compositions' });
    expect(screen.queryByRole('region', { name: 'Upstream changes' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your pending proposals' })).toBeNull();
  });
});
