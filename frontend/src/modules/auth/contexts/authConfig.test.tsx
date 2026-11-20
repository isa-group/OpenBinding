import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthConfigProvider } from './authConfig';
import { useAuthConfig } from './authConfigContext';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Mode() {
  return <output>{`provider ${useAuthConfig().provider}`}</output>;
}

describe('AuthConfigProvider', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('shows the loading view, then the application once the gateway says how it signs people in', async () => {
    let answer: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise(resolve => (answer = resolve)));
    render(
      <AuthConfigProvider>
        <Mode />
      </AuthConfigProvider>
    );
    expect(screen.queryByText(/provider/)).not.toBeInTheDocument();
    answer(json(200, { provider: 'local', login_url: null, account_url: null }));
    expect(await screen.findByText('provider local')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/auth\/config$/);
    expect(init).toMatchObject({ cache: 'no-store' });
  });

  it('reads the SCORETech configuration', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        provider: 'scoretech',
        login_url: 'https://openbinding.example/api/v1/auth/identity/login',
        account_url: 'https://identity.example/account/#public-profile',
      })
    );
    render(
      <AuthConfigProvider>
        <Mode />
      </AuthConfigProvider>
    );
    expect(await screen.findByText('provider scoretech')).toBeInTheDocument();
  });

  it.each([
    ['a failure', () => json(503, { code: 'unavailable' })],
    ['a 404 (no fallback to an older API)', () => json(404, { code: 'not_found' })],
    ['an unknown provider', () => json(200, { provider: 'cas' })],
    [
      'a SCORETech configuration without its sign-in URL',
      () => json(200, { provider: 'scoretech' }),
    ],
  ])('draws nothing of the application on %s, and Try again asks again', async (_name, failing) => {
    fetchMock.mockResolvedValueOnce(failing());
    fetchMock.mockResolvedValueOnce(json(200, { provider: 'local' }));
    render(
      <AuthConfigProvider>
        <Mode />
      </AuthConfigProvider>
    );
    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load the sign-in settings' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/provider/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('provider local')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('refuses to be read outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Mode />)).toThrow('useAuthConfig must be used inside AuthConfigProvider');
  });
});
