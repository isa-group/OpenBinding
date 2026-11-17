import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeGateway, renderModule } from '../../../../test/moduleKit';
import CompositionsTab from '.';

const composition = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `c-${slug}`,
  slug,
  name: slug.toUpperCase(),
  description: '',
  kind: 'application',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-acme', slug: 'acme', name: 'Acme' },
  latest_version: null,
  version_count: 0,
  created_by_id: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const ORG = { slug: 'acme', name: 'Acme' };

describe("the organization's Compositions tab", () => {
  it('pages the compositions on the server and lets a member create and archive', async () => {
    const gateway = fakeGateway({
      'GET /v1/organizations/acme/compositions': {
        body: {
          compositions: [composition('desk', { visibility: 'public' })],
          total: 12,
        },
      },
    });
    renderModule(<CompositionsTab org={ORG} myRole="MEMBER" isPublicView={false} />, {
      gateway,
      entry: '/orgs/acme/compositions',
    });
    const card = await screen.findByRole('article', { name: 'DESK' });
    expect(within(card).getByText('Public')).toBeInTheDocument();
    expect(gateway.mock.calls[0][0]).toContain('limit=10');
    expect(gateway.mock.calls[0][0]).toContain('archived=false');
    fireEvent.click(within(card).getByRole('button', { name: 'Actions for DESK' }));
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(gateway.mock.calls.at(-1)?.[0]).toContain('offset=10'));
    expect(screen.getByRole('link', { name: 'New composition' })).toHaveAttribute(
      'href',
      '/compositions/new?org=acme'
    );
  });

  it('filters by kind and archived state through the address', async () => {
    const gateway = fakeGateway({
      'GET /v1/organizations/acme/compositions': { body: { compositions: [], total: 0 } },
    });
    renderModule(<CompositionsTab org={ORG} myRole="ADMIN" isPublicView={false} />, { gateway });
    expect(await screen.findByText('No compositions found.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'System' }));
    await waitFor(() => expect(gateway.mock.calls.at(-1)?.[0]).toContain('kinds=system'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only archived compositions' }));
    await waitFor(() => expect(gateway.mock.calls.at(-1)?.[0]).toContain('archived=true'));
    expect(await screen.findByText('No compositions match.')).toBeInTheDocument();
  });

  it('shows a visitor the public compositions, with no action', async () => {
    const gateway = fakeGateway({
      'GET /v1/organizations/acme/compositions': {
        body: { compositions: [composition('desk')], total: 1 },
      },
    });
    renderModule(<CompositionsTab org={ORG} myRole={null} isPublicView />, {
      gateway,
      user: null,
    });
    const card = await screen.findByRole('article', { name: 'DESK' });
    expect(screen.getByRole('heading', { name: 'Public compositions' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'DESK' })).toHaveAttribute(
      'href',
      '/compositions/acme/desk'
    );
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: 'New composition' })).toBeNull();
    expect(gateway.mock.calls[0][0]).not.toContain('archived');
  });
});
