import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, renderModule } from '../../../../test/moduleKit';
import PermanentLinkPage from '.';

describe('/p/:id', () => {
  it('opens the composition the gateway names, at the version asked for', async () => {
    const gateway = fakeGateway({
      'GET /v1/permalinks/compositions/c-1?version=1.2.0': {
        body: { location: '/compositions/acme/order-desk?version=1.2.0' },
      },
    });
    renderModule(<PermanentLinkPage />, {
      gateway,
      user: null,
      path: '/p/:id',
      entry: '/p/c-1?version=1.2.0',
      routes: { '/compositions/:org/:composition': <p>composition</p> },
    });
    await waitFor(() => expect(addressNow()).toBe('/compositions/acme/order-desk?version=1.2.0'));
  });

  it('says the same thing for a missing and an unreadable composition, and for a foreign destination', async () => {
    const gateway = fakeGateway({
      'GET /v1/permalinks/compositions/elsewhere': { body: { location: 'https://evil.example/x' } },
    });
    const { unmount } = renderModule(<PermanentLinkPage />, {
      gateway,
      path: '/p/:id',
      entry: '/p/missing',
    });
    expect(
      await screen.findByText(
        'This resource is unavailable. Sign in if you have access to a private resource.'
      )
    ).toBeInTheDocument();
    unmount();
    renderModule(<PermanentLinkPage />, { gateway, path: '/p/:id', entry: '/p/elsewhere' });
    expect(await screen.findByText(/This resource is unavailable/)).toBeInTheDocument();
    expect(addressNow()).toBe('/p/elsewhere');
  });
});
