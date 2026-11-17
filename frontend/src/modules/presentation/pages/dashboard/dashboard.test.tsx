import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGateway, orgNode, renderModule } from '../../../../test/moduleKit';
import DashboardPage from '.';

const runs = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../../../api/runs', async actual => ({
  ...(await actual<typeof import('../../../../api/runs')>()),
  runsApi: runs,
}));

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
});
