import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AccountPage } from './AccountPage';

// The bodies of the sections have their own tests: here only the choice of the section is looked at.
vi.mock('./Account', () => ({ Account: () => <h1>Profile body</h1> }));
vi.mock('./AccountUsage', () => ({ AccountUsage: () => <h1>Plan body</h1> }));
vi.mock('./AccountKeys', () => ({ AccountKeys: () => <h1>API keys body</h1> }));
vi.mock('./AccountIdentities', () => ({ AccountIdentities: () => <h1>Identities body</h1> }));
vi.mock('./AccountNotifications', () => ({ AccountNotifications: () => <h1>Notifications body</h1> }));

function renderAt(address: string) {
  render(
    <MemoryRouter initialEntries={[address]}>
      <Routes>
        <Route path="/app/account/:section?" element={<AccountPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AccountPage', () => {
  // [utest->req~frontend-nav-account-sections~1]
  it.each([
    ['/app/account', 'Profile body'],
    ['/app/account/usage', 'Plan body'],
    ['/app/account/keys', 'API keys body'],
    ['/app/account/identities', 'Identities body'],
    ['/app/account/notifications', 'Notifications body'],
  ])('%s opens %s', (address, heading) => {
    renderAt(address);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  // [utest->req~frontend-nav-account-sections~1]
  it.each(['/app/account/billing', '/app/account/Keys', '/app/account/usage-2'])('%s shows Page not found', (address) => {
    renderAt(address);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText(/ body$/)).not.toBeInTheDocument();
  });
});
