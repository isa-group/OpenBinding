import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addressNow,
  fakeGateway,
  ME,
  renderModule,
  SCORETECH_CONFIG,
} from '../../../../test/moduleKit';
import { BRAND_STORAGE_KEY } from '../../../core/theme/brand';
import SettingsPage from '.';
import { sectionOf, settingsPath } from './sections';

const PREFERENCES = {
  inbox: true,
  email_contract_changes: true,
  email_invitations: true,
  email_job_failures: false,
  kinds: {
    OrganizationInvitation: { inbox: true, email: true },
    System: { inbox: true, email: true },
    CompositionUpdated: { inbox: true, email: true },
    RunFinished: { inbox: true, email: false },
    RunFailed: { inbox: true, email: true },
    CompositionAdopted: { inbox: true, email: false },
  },
};

const renderSettings = (entry = '/me/settings', gateway = fakeGateway({})) =>
  renderModule(<SettingsPage />, { entry, path: '/me/settings', gateway });

/** Settings in SCORETech Identity mode, for an account that signs in with Identity only. */
const renderIdentitySettings = (entry = '/me/settings', gateway = fakeGateway({})) =>
  renderModule(<SettingsPage />, {
    entry,
    path: '/me/settings',
    gateway,
    authConfig: SCORETECH_CONFIG,
    user: { ...ME, password_enabled: false, email_verified: true },
  });

const settingsNav = () => screen.getByRole('navigation', { name: 'Settings' });

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.brand;
});

describe('the settings sections', () => {
  it('reads the section from the address, and an unknown one as Account', () => {
    expect(sectionOf(null)).toBe('account');
    expect(sectionOf('billing')).toBe('account');
    expect(sectionOf('plan')).toBe('plan');
    expect(settingsPath('account')).toBe('/me/settings');
    expect(settingsPath('appearance')).toBe('/me/settings?section=appearance');
  });
});

describe('/me/settings', () => {
  it('opens the section the address names and marks it in the navigation', async () => {
    renderSettings(
      '/me/settings?section=plan',
      fakeGateway({
        'GET /v1/users/me/usage': {
          body: { plan: 'RESEARCH', contract_pending: false, features: {}, capabilities: {} },
        },
      })
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Plan & permissions' })
    ).toBeInTheDocument();
    expect(within(settingsNav()).getByRole('link', { name: 'Plan' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      await screen.findByRole('link', { name: 'Your organizations and roles' })
    ).toHaveAttribute('href', '/me/orgs');
    expect(screen.getByRole('link', { name: /Open SPACE console/ })).toHaveAttribute(
      'target',
      '_blank'
    );
  });

  it('opens Account for an unknown section', async () => {
    renderSettings('/me/settings?section=billing');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Account Details' })
    ).toBeInTheDocument();
    expect(within(settingsNav()).getByRole('link', { name: 'Account' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('changes the email with the current password, and says when the password is wrong', async () => {
    let attempts = 0;
    const gateway = fakeGateway({
      'PATCH /v1/users/me': ({ body }) => {
        attempts += 1;
        return attempts === 1
          ? { status: 401, body: { code: 'invalid_credentials', detail: 'Wrong password' } }
          : { body: { ...ME, email: (body as { email: string }).email } };
      },
    });
    renderSettings('/me/settings', gateway);
    const email = await screen.findByLabelText('Email address');
    fireEvent.change(email, { target: { value: 'alex@example.org' } });
    const save = screen.getByRole('button', { name: 'Save email' });
    fireEvent.click(save);
    expect(
      await screen.findByText('Enter your current password to change your email.')
    ).toBeInTheDocument();
    expect(gateway).not.toHaveBeenCalledWith('/v1/users/me', expect.anything());

    const passwords = screen.getAllByLabelText('Current password');
    fireEvent.change(passwords[0], { target: { value: 'not-it' } });
    fireEvent.click(save);
    expect(await screen.findByText(/That isn’t your current password/)).toBeInTheDocument();

    fireEvent.change(passwords[0], { target: { value: 'correct horse' } });
    fireEvent.click(save);
    expect(await screen.findByText('Email updated to alex@example.org.')).toBeInTheDocument();
    const patch = gateway.mock.calls.filter(
      ([path, init]) => path === '/v1/users/me' && init?.method === 'PATCH'
    );
    expect(JSON.parse(patch.at(-1)?.[1]?.body as string)).toEqual({
      email: 'alex@example.org',
      current_password: 'correct horse',
    });
  });

  it('checks a new password before sending it', async () => {
    const gateway = fakeGateway({ 'PATCH /v1/users/me': { body: ME } });
    renderSettings('/me/settings', gateway);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getAllByLabelText('Current password')[1], {
      target: { value: 'old-password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    expect(screen.getByText('Strength: Too short')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Password must be at least 10 characters long.')
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'A-much-longer-one-42' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'A-much-longer-one-42' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Password changed.')).toBeInTheDocument();
  });

  it('holds back a section change while Account has unsaved changes', async () => {
    renderSettings(
      '/me/settings',
      fakeGateway({ 'GET /v1/notifications/preferences': { body: PREFERENCES } })
    );
    fireEvent.change(await screen.findByLabelText('Email address'), {
      target: { value: 'changed@example.org' },
    });
    fireEvent.click(within(settingsNav()).getByRole('link', { name: 'Notifications' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(addressNow()).toBe('/me/settings');

    fireEvent.click(within(settingsNav()).getByRole('link', { name: 'Notifications' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', {
        name: 'Discard changes',
      })
    );
    await waitFor(() => expect(addressNow()).toBe('/me/settings?section=notifications'));
    expect(await screen.findByRole('switch', { name: 'Runs finished: Email' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('saves the notification channels per kind', async () => {
    const gateway = fakeGateway({
      'GET /v1/notifications/preferences': { body: PREFERENCES, headers: { ETag: '"r1"' } },
      'PUT /v1/notifications/preferences': ({ body }) => ({ body, headers: { ETag: '"r2"' } }),
    });
    renderSettings('/me/settings?section=notifications', gateway);
    const toggle = await screen.findByRole('switch', { name: 'Runs finished: Email' });
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(await screen.findByText('Preferences updated')).toBeInTheDocument();
    const put = gateway.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(new Headers(put?.[1]?.headers).get('If-Match')).toBe('"r1"');
    expect(JSON.parse(put?.[1]?.body as string).kinds.RunFinished).toEqual({
      inbox: true,
      email: true,
    });
  });

  it('switches the palette at once, keeps it in this browser, and goes back to the default', async () => {
    renderSettings('/me/settings?section=appearance');
    const blue = await screen.findByRole('radio', { name: /OpenBinding blue/ });
    const orange = screen.getByRole('radio', { name: /SPHERE orange/ });
    expect(orange).toBeChecked();
    expect(screen.getByRole('button', { name: 'Use the default' })).toBeDisabled();

    fireEvent.click(blue);
    expect(blue).toBeChecked();
    expect(document.documentElement.dataset.brand).toBe('openbinding');
    expect(window.localStorage.getItem(BRAND_STORAGE_KEY)).toBe('openbinding');

    fireEvent.click(screen.getByRole('button', { name: 'Use the default' }));
    expect(orange).toBeChecked();
    expect(document.documentElement.dataset.brand).toBe('sphere');
    expect(window.localStorage.getItem(BRAND_STORAGE_KEY)).toBeNull();
  });

  it('turns beta features on', async () => {
    const gateway = fakeGateway({
      'GET /v1/users/me/settings/beta-features': { body: { enabled: false } },
      'PUT /v1/users/me/settings/beta-features': ({ body }) => ({ body }),
    });
    renderSettings('/me/settings?section=beta', gateway);
    const toggle = await screen.findByRole('switch', { name: 'Enable beta features' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('deletes the account only once the username is typed, and says what to do when it owns an organization', async () => {
    const gateway = fakeGateway({
      'DELETE /v1/users/me': {
        status: 409,
        body: { code: 'last_owner', detail: { code: 'last_owner', error: 'Owner of isa-demo' } },
      },
    });
    renderSettings('/me/settings?section=danger', gateway);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete account' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(`Type ${ME.username} to confirm`), {
      target: { value: 'alex' },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(`Type ${ME.username} to confirm`), {
      target: { value: ME.username },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Hand the organization over/
    );
    expect(within(dialog).getByRole('link', { name: 'Your organizations' })).toHaveAttribute(
      'href',
      '/me/orgs'
    );
    const call = gateway.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      confirmation: ME.username,
      current_password: null,
    });
  });

  it('asks the current password at deletion only of an account that has one', async () => {
    const gateway = fakeGateway({ 'DELETE /v1/users/me': { status: 204 } });
    renderModule(<SettingsPage />, {
      entry: '/me/settings?section=danger',
      path: '/me/settings',
      gateway,
      user: { ...ME, password_enabled: false },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    expect(within(dialog).queryByLabelText('Current password')).not.toBeInTheDocument();
  });
});

describe('/me/settings in SCORETech Identity mode', () => {
  it('shows the SCORETech account instead of the local email and password', async () => {
    renderIdentitySettings();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Your SCORETech account' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open my SCORETech profile/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('(opens in a new tab)');
    const href = new URL(link.getAttribute('href') ?? '');
    expect(`${href.origin}${href.pathname}`).toBe('https://identity.example/account/');
    expect(href.hash).toBe('#public-profile');
    expect(href.searchParams.get('return_to')).toBe(
      `${window.location.origin}/me/settings?section=account`
    );
  });

  it('keeps the other sections', async () => {
    renderIdentitySettings();
    await screen.findByRole('heading', { level: 2, name: 'Your SCORETech account' });
    const nav = settingsNav();
    for (const name of [
      'Account',
      'Public profile',
      'Notifications',
      'Plan',
      'Appearance',
      'Beta features',
    ])
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
  });

  it('says the SCORETech account stays, and asks no password at deletion', async () => {
    const gateway = fakeGateway({ 'DELETE /v1/users/me': { status: 204 } });
    renderIdentitySettings('/me/settings?section=danger', gateway);
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Delete OpenBinding account' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Your SCORETech Identity account and your access/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    expect(within(dialog).queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});

describe('/me/settings › Public profile', () => {
  it('saves the display name in local mode, without a password', async () => {
    const gateway = fakeGateway({
      'PATCH /v1/users/me': ({ body }) => ({ body: { ...ME, ...(body as object) } }),
    });
    renderSettings('/me/settings?section=profile', gateway);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Public profile' })
    ).toBeInTheDocument();
    const field = screen.getByLabelText('Display name');
    const save = screen.getByRole('button', { name: 'Save display name' });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: '  Alex Rivera ' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        gateway.mock.calls.some(
          ([path, init]) => path === '/v1/users/me' && init?.method === 'PATCH'
        )
      ).toBe(true)
    );
    const patch = gateway.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ display_name: 'Alex Rivera' });
  });

  it('edits the avatar in a dialog that takes the focus, in Identity shapes', async () => {
    const gateway = fakeGateway({ 'PATCH /v1/users/me': { body: ME } });
    const { auth } = renderSettings('/me/settings?section=profile', gateway);
    fireEvent.click(await screen.findByRole('button', { name: 'Change avatar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit avatar' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Icons' }));
    const leaf = within(dialog).getByRole('button', { name: 'Leaf' });
    fireEvent.click(leaf);
    expect(leaf).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Background colour #212529' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save avatar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patches = () =>
      gateway.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(init?.body as string));
    expect(patches()).toEqual([
      {
        avatar: {
          kind: 'icon',
          assetId: 'leaf',
          backgroundColor: '#212529',
          foregroundColor: '#ffffff',
        },
      },
    ]);
    expect(auth.refresh).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Change avatar' }));
    const again = await screen.findByRole('dialog', { name: 'Edit avatar' });
    fireEvent.click(within(again).getByRole('button', { name: 'Presets' }));
    expect(within(again).queryByRole('button', { name: /colour #/ })).not.toBeInTheDocument();
    fireEvent.click(within(again).getByRole('button', { name: 'Fox' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Save avatar' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toEqual({ avatar: { kind: 'preset', assetId: 'fox' } });
  });

  it('removes an avatar, and says when saving fails', async () => {
    let calls = 0;
    const gateway = fakeGateway({
      'PATCH /v1/users/me': () => {
        calls += 1;
        return calls === 1 ? { status: 503, body: { code: 'unavailable' } } : { body: ME };
      },
    });
    renderModule(<SettingsPage />, {
      entry: '/me/settings?section=profile',
      path: '/me/settings',
      gateway,
      user: { ...ME, avatar: { kind: 'preset', assetId: 'owl' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Change avatar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit avatar' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove avatar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Nothing was saved/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove avatar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const last = gateway.mock.calls.filter(([, init]) => init?.method === 'PATCH').at(-1);
    expect(JSON.parse(last?.[1]?.body as string)).toEqual({ avatar: null });
  });

  it('shows Identity display name and avatar read-only in SCORETech Identity mode', async () => {
    renderModule(<SettingsPage />, {
      entry: '/me/settings?section=profile',
      path: '/me/settings',
      authConfig: SCORETECH_CONFIG,
      user: {
        ...ME,
        password_enabled: false,
        display_name: 'Alex Rivera',
        avatar: {
          kind: 'icon',
          assetId: 'leaf',
          backgroundColor: '#212529',
          foregroundColor: '#ffffff',
        },
      },
    });
    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change avatar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
    const edit = screen.getByRole('link', { name: /Edit in SCORETech Identity/ });
    expect(edit).toHaveAttribute('target', '_blank');
    expect(edit).toHaveAttribute('rel', 'noopener noreferrer');
    const href = new URL(edit.getAttribute('href') ?? '');
    expect(href.hash).toBe('#public-profile');
    expect(href.searchParams.get('return_to')).toBe(
      `${window.location.origin}/me/settings?section=account`
    );
    expect(document.querySelector('[data-avatar-kind="icon"]')).not.toBeNull();
  });
});
