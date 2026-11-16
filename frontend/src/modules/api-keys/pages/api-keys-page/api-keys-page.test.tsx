import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, orgNode, renderModule } from '../../../../test/moduleKit';
import type { ApiKeySummary } from '../../api/apiKeysApi';
import ApiKeysPage from '.';

const reader: ApiKeySummary = {
  id: 'k1',
  name: 'ci-results',
  prefix: 'obk_demo0001',
  created_at: '2026-09-01T00:00:00Z',
  last_used_at: '2026-10-08T00:00:00Z',
  expires_at: '2099-12-31T00:00:00Z',
  permissions: ['jobs:read', 'problems:read'],
  engine_access: { all: true, engines: [] },
  boundary: { methods: ['GET'], organizations: ['isa-demo'], resource_kinds: null, slugs: null },
};

const USAGE = {
  plan: 'FREE',
  contract_pending: false,
  features: {},
  capabilities: { maxApiKeys: 2 },
};

function gatewayWith(keys: ApiKeySummary[]) {
  let list = [...keys];
  return fakeGateway({
    'GET /v1/users/me/api-keys': () => ({ body: { api_keys: list } }),
    'GET /v1/users/me/usage': { body: USAGE },
    'GET /v1/engines': { body: { engines: [] } },
    'GET /v1/organizations': { body: [orgNode('isa-demo')] },
    'POST /v1/users/me/api-keys': ({ body }) => {
      const created = {
        ...(body as object),
        id: 'k2',
        prefix: 'obk_demo0002',
        created_at: '2026-11-16T00:00:00Z',
        last_used_at: null,
        boundary: (body as { boundary?: object }).boundary ?? {},
      } as ApiKeySummary;
      list = [...list, created];
      return { status: 201, body: { ...created, secret: 'obk_demo0002_SECRET' } };
    },
    'DELETE /v1/users/me/api-keys/k1': () => {
      list = list.filter(key => key.id !== 'k1');
      return { status: 204 };
    },
  });
}

const renderKeys = (gateway: ReturnType<typeof fakeGateway>, entry = '/me/api-keys') =>
  renderModule(<ApiKeysPage />, { entry, path: '/me/api-keys', gateway });

describe('/me/api-keys', () => {
  it('lists the keys with their permissions, limits, engines and the plan’s key limit', async () => {
    renderKeys(gatewayWith([reader]));
    const card = await screen.findByRole('article', { name: 'ci-results' });
    expect(within(card).getByText('obk_demo0001…')).toBeInTheDocument();
    expect(within(card).getByText('jobs:read')).toBeInTheDocument();
    expect(within(card).getByText('GET only')).toBeInTheDocument();
    expect(within(card).getByText('org isa-demo')).toBeInTheDocument();
    expect(within(card).getByText('All engines, including future ones')).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 keys')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create new API key' })).toHaveAttribute(
      'href',
      '/me/api-keys?create=key'
    );
  });

  it('creates a key in the dialog and shows its secret once', async () => {
    const gateway = gatewayWith([]);
    renderKeys(gateway, '/me/api-keys?create=key');
    const dialog = await screen.findByRole('dialog', { name: 'Create new API key' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Give the key a name.')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'nightly' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Choose at least one permission.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /problems:read/ }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /View only/ }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search organizations' }), {
      target: { value: 'isa' },
    });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Isa Demo/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('obk_demo0002_SECRET')).toBeInTheDocument();
    expect(screen.getByText(/You won’t be able to see it again/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(addressNow()).toBe('/me/api-keys');
    expect(await screen.findByRole('article', { name: 'nightly' })).toBeInTheDocument();
    // The list never carries the secret: only the panel above it does.
    expect(
      within(screen.getByRole('article', { name: 'nightly' })).queryByText(/SECRET/)
    ).toBeNull();

    const post = gateway.mock.calls.find(([, init]) => init?.method === 'POST');
    const sent = JSON.parse(post?.[1]?.body as string);
    expect(sent).toMatchObject({
      name: 'nightly',
      permissions: ['problems:read'],
      engine_access: { all: true, engines: [] },
      boundary: { methods: ['GET'], organizations: ['isa-demo'] },
    });
    expect(typeof sent.expires_at).toBe('string');
  });

  it('revokes a key after confirming', async () => {
    const gateway = gatewayWith([reader]);
    renderKeys(gateway);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke ci-results' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Revoke “ci-results”?');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('“ci-results” was revoked.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'ci-results' })).not.toBeInTheDocument()
    );
    expect(screen.getByText('No API keys')).toBeInTheDocument();
    expect(gateway).toHaveBeenCalledWith(
      '/v1/users/me/api-keys/k1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('says why the list could not be read', async () => {
    renderKeys(
      fakeGateway({
        'GET /v1/users/me/api-keys': { status: 403, body: { code: 'forbidden', detail: 'no' } },
      })
    );
    expect(
      await screen.findByText(/To manage keys, a request needs keys:read/)
    ).toBeInTheDocument();
  });
});
