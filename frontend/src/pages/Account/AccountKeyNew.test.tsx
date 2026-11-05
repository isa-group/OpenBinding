import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError, type CreatedApiKey, type UserProfile } from '../../api/auth';
import { HttpError, type EngineCatalogEntry } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { AccountKeyNew } from './AccountKeyNew';

const api = vi.hoisted(() => ({ getEngines: vi.fn(), createApiKey: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;
const ref = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: DIGEST };
const engine: EngineCatalogEntry = { ...ref, id: 'bim.builtin/random-search', ref, modes: [] };

const person = (role: 'user' | 'admin' = 'user'): UserProfile => ({
  id: 'user-id', username: 'iker', email: 'iker@example.test', role, is_active: true, plan: 'PRO', created_at: '2026-01-10T00:00:00Z',
});

const created: CreatedApiKey = {
  id: 'k3', name: 'ci-nightly', prefix: 'obk_demo0003', created_at: '2026-10-09T10:00:00Z', permissions: ['jobs:read'],
  engine_access: { all: true, engines: [] }, secret: 'obk_demo0003_ONLY-SHOWN-ONCE',
};

function renderWizard(user: UserProfile = person()) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter initialEntries={['/app/account/keys?create=key']}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        <AccountKeyNew onClose={onClose} onCreated={onCreated} />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

const permission = (id: string) => screen.getByRole('checkbox', { name: new RegExp(`^${id}`) });
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
const heading = (name: string | RegExp) => screen.findByRole('heading', { level: 2, name });

/** Name the key and move to the permissions step. */
async function nameIt(name = 'ci-nightly') {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  next();
  await heading('Permissions');
}

describe('New API key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getEngines.mockResolvedValue([engine]);
    api.createApiKey.mockResolvedValue(created);
    platform.organizations.mockResolvedValue([{ id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group' }]);
    platform.projects.mockResolvedValue([{ id: 'p1', organization_id: 'org-1', slug: 'qos-benchmarks', name: 'QoS Benchmarks' }]);
  });

  it('starts with the name and expiry, in a five-step wizard inside the dialog New API key', async () => {
    renderWizard();

    const dialog = within(await screen.findByRole('dialog', { name: 'New API key' }));
    const steps = within(dialog.getByRole('list', { name: 'Steps' }));
    expect(steps.getAllByRole('button')).toHaveLength(5);
    expect(steps.getByRole('button', { name: 'Name' })).toHaveAttribute('aria-current', 'step');
    expect(steps.getByRole('button', { name: 'Review' })).toBeDisabled();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    expect(dialog.getByLabelText('Expires')).toHaveValue('90');
    expect(dialog.getByLabelText('Name')).toHaveFocus();
  });

  it('asks to be closed from Cancel, × and Escape, and creates nothing', async () => {
    const { onClose, onCreated } = renderWizard();
    const dialog = await screen.findByRole('dialog', { name: 'New API key' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it('will not go on without a name', async () => {
    renderWizard();
    next();

    expect(await screen.findByText('Give the key a name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('heading', { name: 'Permissions' })).not.toBeInTheDocument();
  });

  describe('permissions', () => {
    it('offers every permission of the closed set, with the admin-only ones locked and explained', async () => {
      renderWizard();
      await nameIt();

      expect(screen.getAllByRole('checkbox')).toHaveLength(30);
      for (const id of ['engines:moderate', 'extensions:moderate', 'pricing:admin', 'admin:accounts:read', 'admin:accounts:write']) {
        expect(permission(id)).toBeDisabled();
      }
      expect(permission('jobs:read')).toBeEnabled();
      expect(screen.getAllByText('ADMIN')).toHaveLength(5);
      expect(screen.getAllByText('Only global administrators can grant this.')).toHaveLength(5);
      expect(screen.getByText(/Permissions marked ADMIN are only granted to global administrators/)).toBeInTheDocument();
      expect(permission('pricing:admin')).toHaveAccessibleDescription('Only global administrators can grant this.');
    });

    it('unlocks them for a global administrator', async () => {
      renderWizard(person('admin'));
      await nameIt();

      expect(permission('pricing:admin')).toBeEnabled();
      expect(screen.queryByText(/Permissions marked ADMIN are only granted/)).not.toBeInTheDocument();
    });

    it('fills in a preset and clears it', async () => {
      renderWizard();
      await nameIt();

      fireEvent.click(screen.getByRole('button', { name: 'Preset: read results' }));
      for (const id of ['jobs:read', 'studies:read', 'reports:read', 'projects:read']) expect(permission(id)).toBeChecked();
      expect(permission('engines:execute')).not.toBeChecked();

      fireEvent.click(screen.getByRole('button', { name: 'Preset: run an engine' }));
      expect(permission('engines:execute')).toBeChecked();
      expect(permission('projects:read')).not.toBeChecked();

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.getAllByRole('checkbox').some((box) => (box as HTMLInputElement).checked)).toBe(false);
    });

    it('needs at least one', async () => {
      renderWizard();
      await nameIt();
      next();

      expect(await screen.findByRole('alert')).toHaveTextContent('Choose at least one permission.');
      expect(screen.getByRole('heading', { name: 'Permissions' })).toBeInTheDocument();
    });
  });

  describe('engines', () => {
    async function toEngines(id: string) {
      renderWizard();
      await nameIt();
      fireEvent.click(permission(id));
      next();
      await heading('Engine access');
    }

    it('grants all engines by default, including future ones', async () => {
      await toEngines('jobs:read');
      expect(screen.getByRole('radio', { name: /All engines/ })).toBeChecked();
      expect(screen.getByText(/Includes engines added later/)).toBeInTheDocument();
    });

    it('refuses engine-bound permissions without an exact engine (422), then accepts one', async () => {
      await toEngines('engines:execute');
      fireEvent.click(screen.getByRole('radio', { name: /Only these engines/ }));
      next();

      expect(await screen.findByRole('alert')).toHaveTextContent('422 · The permissions you chose need all engines or at least one exact engine.');
      expect(screen.getByRole('heading', { name: 'Engine access' })).toBeInTheDocument();

      const pick = await screen.findByRole('checkbox', { name: /bim\.builtin\/random-search@1\.0\.0/ });
      expect(document.body.textContent).not.toMatch(/sha256-|\b[0-9a-f]{12}/);
      fireEvent.click(pick);
      next();
      expect(await heading(/^Limits/)).toBeInTheDocument();
    });

    it('does not ask for an engine when no permission needs one', async () => {
      await toEngines('account:read');
      fireEvent.click(screen.getByRole('radio', { name: /Only these engines/ }));
      next();
      expect(await heading(/^Limits/)).toBeInTheDocument();
    });

    it('says when there are no engines to pick from', async () => {
      api.getEngines.mockResolvedValue([]);
      await toEngines('account:read');
      fireEvent.click(screen.getByRole('radio', { name: /Only these engines/ }));
      expect(await screen.findByText('No visible engines are available to select.')).toBeInTheDocument();
    });
  });

  describe('limits', () => {
    async function toLimits() {
      renderWizard();
      await nameIt();
      fireEvent.click(permission('account:read'));
      next();
      await heading('Engine access');
      next();
      await heading(/^Limits/);
    }

    it('offers the methods, the organizations and projects of the account, and kinds', async () => {
      await toLimits();

      const methods = within(screen.getByRole('group', { name: 'HTTP methods' }));
      expect(methods.getAllByRole('button')).toHaveLength(5);
      expect(await within(screen.getByRole('group', { name: 'Organizations' })).findByRole('button', { name: 'isa-demo' })).toBeInTheDocument();
      expect(await within(screen.getByRole('group', { name: 'Projects' })).findByRole('button', { name: 'qos-benchmarks' })).toBeInTheDocument();
      expect(within(screen.getByRole('group', { name: 'Resource kinds' })).getByRole('button', { name: 'studies' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('lets an exact identifier that is not listed be added, with Enter or the button', async () => {
      await toLimits();
      const slugs = within(screen.getByRole('group', { name: 'Slugs' }));

      const field = slugs.getByLabelText('Add slugs');
      fireEvent.change(field, { target: { value: 'latency-study, other-case' } });
      fireEvent.keyDown(field, { key: 'Enter' });

      expect(slugs.getByRole('button', { name: 'latency-study' })).toHaveAttribute('aria-pressed', 'true');
      expect(slugs.getByRole('button', { name: 'other-case' })).toHaveAttribute('aria-pressed', 'true');
      // Pressing an identifier that was typed in takes it out again: there is nothing else to pick it back from.
      fireEvent.click(slugs.getByRole('button', { name: 'other-case' }));
      expect(slugs.queryByRole('button', { name: 'other-case' })).not.toBeInTheDocument();
      expect(slugs.getByRole('button', { name: 'latency-study' })).toBeInTheDocument();
    });
  });

  describe('creating', () => {
    async function toReview(options: { expiry?: string } = {}) {
      const wizard = renderWizard();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ci-nightly' } });
      if (options.expiry) fireEvent.change(screen.getByLabelText('Expires'), { target: { value: options.expiry } });
      next();
      await heading('Permissions');
      fireEvent.click(permission('jobs:read'));
      next();
      await heading('Engine access');
      fireEvent.click(screen.getByRole('radio', { name: /Only these engines/ }));
      fireEvent.click(await screen.findByRole('checkbox', { name: /bim\.builtin\/random-search@1\.0\.0/ }));
      next();
      await heading(/^Limits/);
      fireEvent.click(within(screen.getByRole('group', { name: 'HTTP methods' })).getByRole('button', { name: 'GET' }));
      fireEvent.click(await within(screen.getByRole('group', { name: 'Organizations' })).findByRole('button', { name: 'isa-demo' }));
      const field = within(screen.getByRole('group', { name: 'Slugs' })).getByLabelText('Add slugs');
      fireEvent.change(field, { target: { value: 'my-slug' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      next();
      await heading('Review');
      return wizard;
    }

    it('reviews everything that was chosen before it creates anything', async () => {
      await toReview();
      const review = within(screen.getByText('Name', { selector: 'dt' }).closest('dl') as HTMLElement);

      expect(review.getByText('ci-nightly')).toBeInTheDocument();
      expect(review.getByText('In 90 days')).toBeInTheDocument();
      expect(review.getByText('jobs:read').closest('li')).toHaveTextContent('Read runs and results (jobs:read)');
      expect(review.getByText('bim.builtin/random-search@1.0.0')).toBeInTheDocument();
      expect(review.getByText('my-slug').closest('dd')).toHaveTextContent('GET · isa-demo · my-slug');
      expect(screen.getByText(/After creation the key’s authority can’t be edited/)).toBeInTheDocument();
      expect(api.createApiKey).not.toHaveBeenCalled();
    });

    it('sends the choices exactly, with the expiry counted from now', async () => {
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

      await waitFor(() => expect(api.createApiKey).toHaveBeenCalledTimes(1));
      const sent = api.createApiKey.mock.calls[0][0];
      expect(sent).toEqual({
        name: 'ci-nightly',
        permissions: ['jobs:read'],
        engine_access: { all: false, engines: [ref] },
        boundary: { methods: ['GET'], organizations: ['isa-demo'], slugs: ['my-slug'] },
        expires_at: expect.any(String),
      });
      const days = (Date.parse(sent.expires_at) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
    });

    it('leaves the expiry out when the key never expires', async () => {
      await toReview({ expiry: 'never' });
      fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

      await waitFor(() => expect(api.createApiKey).toHaveBeenCalled());
      expect(api.createApiKey.mock.calls[0][0]).not.toHaveProperty('expires_at');
    });

    it('shows the secret once in place of the wizard, and only goes on after it is confirmed as stored', async () => {
      const { onClose, onCreated } = await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

      const dialog = within(await screen.findByRole('dialog', { name: '“ci-nightly” is ready. Copy its secret now' }));
      expect(screen.queryByRole('dialog', { name: 'New API key' })).not.toBeInTheDocument();
      expect(dialog.getByText('obk_demo0003_ONLY-SHOWN-ONCE')).toBeInTheDocument();
      expect(dialog.getByText('X-API-Key')).toBeInTheDocument();
      const go = dialog.getByRole('button', { name: 'Go to my keys' });
      expect(go).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // The list is stale as soon as the key exists, whichever way the secret dialog is left.
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(dialog.getByLabelText('I’ve stored the secret somewhere safe'));
      fireEvent.click(go);

      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('goes back a step and keeps what was chosen', async () => {
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await heading(/^Limits/);
      expect(within(screen.getByRole('group', { name: 'HTTP methods' })).getByRole('button', { name: 'GET' })).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(within(screen.getByRole('list', { name: 'Steps' })).getByRole('button', { name: /^Name/ }));
      expect(await heading('Name and expiry')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveValue('ci-nightly');
    });

    describe('when the gateway refuses', () => {
      const refusal = (status: number, code: string, message: string) => {
        const error = new HttpError(status, message);
        error.code = code;
        return error;
      };

      async function createAndRefuse(error: Error) {
        api.createApiKey.mockRejectedValue(error);
        await toReview();
        fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
        return screen.findByRole('alert');
      }

      it('402: the plan’s key limit', async () => {
        const alert = await createAndRefuse(new QuotaError('quota_exceeded', 'Your plan allows 1 API key', { limit_id: 'apiKeys', limit: 1, used: 1 }));
        expect(alert).toHaveTextContent('402 · You’ve reached your plan’s API key limit.');
        expect(screen.queryByRole('dialog', { name: /is ready/ })).not.toBeInTheDocument();
      });

      it('403: a key cannot grant more than it has (escalation)', async () => {
        const alert = await createAndRefuse(refusal(403, 'api_key_escalation', 'A key may create only keys whose permissions are a subset of its own.'));
        expect(alert).toHaveTextContent('403 · api_key_escalation: A key may create only keys whose permissions are a subset of its own.');
      });

      it('403: an admin permission only an administrator can grant', async () => {
        const alert = await createAndRefuse(refusal(403, 'permission_not_grantable', 'Only an administrator account may grant this.'));
        expect(alert).toHaveTextContent('403 · permission_not_grantable');
      });

      it('422: engines missing, taking the person back to the engines step', async () => {
        const alert = await createAndRefuse(refusal(422, 'validation_error', 'Engine discovery, analysis, execution and job access require all Engines or at least one exact Engine revision'));
        expect(alert).toHaveTextContent('422 · The permissions you chose need all engines or at least one exact engine.');
        expect(await heading('Engine access')).toBeInTheDocument();
      });

      it('503: the service is down, nothing is created and the person can try again', async () => {
        const alert = await createAndRefuse(refusal(503, 'unavailable', 'down'));
        expect(alert).toHaveTextContent('Nothing was created');
        expect(screen.getByRole('button', { name: 'Create key' })).toBeEnabled();
      });
    });
  });
});
