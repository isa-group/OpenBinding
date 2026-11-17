import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, renderModule } from '../../../../test/moduleKit';
import CompositionListPage from '.';

const row = (org: string, slug: string, name: string, figures = {}) => ({
  organization: { slug: org, name: org.toUpperCase() },
  slug,
  name,
  description: '',
  kind: 'workflow',
  latest_version: {
    label: '1.2.0',
    ordinal: 3,
    values_status: 'verified',
    verified: true,
    created_at: '2026-10-01T00:00:00Z',
    figures: { tasks: 4, providers: 3, cost: 3060, cost_unit: 'USD/month', ...figures },
  },
  version_count: 3,
  updated_at: '2026-10-01T00:00:00Z',
});

const FACETS = {
  owners: [
    { slug: 'acme', name: 'Acme', count: 2 },
    { slug: 'beta', name: 'Beta Lab', count: 1 },
  ],
  ranges: {
    tasks: { min: 1, max: 8, data: [{ value: '0-1', count: 1 }] },
    providers: { min: null, max: null, data: [] },
    cost: { min: 10, max: 3060, data: [{ value: '10-20', count: 1 }] },
  },
};

describe('/compositions', () => {
  it('lists the public compositions as SPHERE cards, with their kind, tasks, cost and version', async () => {
    const gateway = fakeGateway({
      'GET /v1/compositions': {
        body: { compositions: [row('acme', 'order-desk', 'Order desk')], total: 1, facets: FACETS },
      },
    });
    renderModule(<CompositionListPage />, { user: null, gateway, entry: '/compositions' });
    const card = await screen.findByRole('article', { name: 'Order desk' });
    expect(within(card).getByRole('link', { name: 'Order desk' })).toHaveAttribute(
      'href',
      '/c/acme/order-desk'
    );
    expect(card).toHaveTextContent('Workflow');
    expect(card).toHaveTextContent('4 tasks');
    expect(card).toHaveTextContent('3,060 USD/month');
    expect(within(card).getByText('Verified')).toBeInTheDocument();
    expect(card).toHaveTextContent('v1.2.0');
    expect(screen.getByText('1 composition found')).toBeInTheDocument();
    expect(gateway.mock.calls[0][0]).toContain('limit=12');
  });

  it('keeps the search and the filters in the address and sends them as the gateway names them', async () => {
    const gateway = fakeGateway({
      'GET /v1/compositions': { body: { compositions: [], total: 0, facets: FACETS } },
    });
    renderModule(<CompositionListPage />, { user: null, gateway, entry: '/compositions?q=desk' });
    expect(await screen.findByText('No compositions found')).toBeInTheDocument();
    expect(gateway.mock.calls[0][0]).toContain('q=desk');

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const panel = screen.getByRole('group', { name: 'Filters' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Beta Lab/ }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Pipeline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(addressNow()).toContain('owners=beta'));
    expect(addressNow()).toContain('kinds=pipeline');
    await waitFor(() => expect(gateway.mock.calls.at(-1)?.[0]).toContain('owners=beta'));
    // A range without data offers no slider.
    expect(within(panel).queryByRole('slider', { name: /Providers/ })).toBeNull();
    expect(within(panel).getAllByRole('slider', { name: /Tasks/ })).toHaveLength(2);
  });

  it('says so when the list fails, and tries again', async () => {
    let calls = 0;
    const gateway = fakeGateway({
      'GET /v1/compositions': () =>
        ++calls === 1
          ? { status: 503, body: { detail: 'down' } }
          : { body: { compositions: [row('acme', 'a', 'Alpha')], total: 1 } },
    });
    renderModule(<CompositionListPage />, { user: null, gateway });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Alpha' })).toBeInTheDocument();
  });
});
