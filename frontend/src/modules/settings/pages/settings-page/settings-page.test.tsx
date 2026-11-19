import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { addressNow, fakeGateway, ME, renderModule } from '../../../../test/moduleKit';
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

  it('unlinks the CAS identity of a RESEARCH account only with the typed phrase', async () => {
    const gateway = fakeGateway({
      'GET /v1/users/me/identities': {
        body: [
          { id: 'i1', provider: 'us-cas', subject: 'arivera1', verifiedAt: '2026-09-01T00:00:00Z' },
        ],
      },
      'DELETE /v1/users/me/identities/i1': { status: 204 },
    });
    renderSettings('/me/settings?section=integrations', gateway);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Unlink Universidad de Sevilla · CAS' })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Unlink your Universidad de Sevilla identity?',
    });
    const unlink = within(dialog).getByRole('button', { name: 'Unlink' });
    expect(unlink).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type DOWNGRADE RESEARCH to confirm'), {
      target: { value: 'DOWNGRADE RESEARCH' },
    });
    fireEvent.click(unlink);
    expect(await screen.findByText(/Identity unlinked\. Your plan is now/)).toBeInTheDocument();
    expect(gateway).toHaveBeenCalledWith(
      '/v1/users/me/identities/i1?confirmation=DOWNGRADE%20RESEARCH',
      expect.objectContaining({ method: 'DELETE' })
    );
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
});
