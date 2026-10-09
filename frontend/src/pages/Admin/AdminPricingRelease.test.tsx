import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPricingRelease } from './AdminPricingRelease';
import { IKER, LUCIA } from './adminFixtures';
import { refusal, renderAdmin } from './adminTestUtils';
import { DRAFT_RELEASE, DRAINING_RELEASE, LIVE_RELEASE, PRICING_ROOM, previewOf } from './pricingFixtures';

const platform = vi.hoisted(() => ({
  pricingControlRoom: vi.fn(),
  previewPricing: vi.fn(),
  pricingAction: vi.fn(),
  archivePricing: vi.fn(),
  publishPricing: vi.fn(),
  forkPricing: vi.fn(),
  deletePricingDraft: vi.fn(),
}));
const client = vi.hoisted(() => ({ adminAudit: vi.fn() }));

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: platform,
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: client,
}));

vi.mock('pricing-renderer/react', () => ({ PricingRenderer: () => <div data-testid="renderer">Customer pricing</div> }));

configure({ asyncUtilTimeout: 5000 });

const AUDIT = {
  events: [
    { id: 'e1', organizationId: null, actorId: IKER.id, action: 'pricing.live.activated', targetType: 'PricingRelease', targetId: null, detail: { version: '0.1.0' }, createdAt: '2026-09-02T09:00:00Z' },
    { id: 'e2', organizationId: null, actorId: IKER.id, action: 'pricing.draft.created', targetType: 'PricingRelease', targetId: '0.2.0-draft.1', detail: {}, createdAt: '2026-10-01T09:00:00Z' },
    { id: 'e3', organizationId: null, actorId: IKER.id, action: 'pricing.deployment.drained', targetType: 'PricingRelease', targetId: null, detail: { version: '0.0.9' }, createdAt: '2026-09-02T09:05:00Z' },
    { id: 'e4', organizationId: null, actorId: IKER.id, action: 'contract.subscription.changed', targetType: 'User', targetId: LIVE_RELEASE.version, detail: {}, createdAt: '2026-09-03T09:00:00Z' },
  ],
  total: 4,
  offset: 0,
  limit: 200,
};

const open = (version: string) => renderAdmin(<AdminPricingRelease />, { entry: `/app/admin/pricing/${version}`, path: '/app/admin/pricing/:version' });
const action = (name: string) => screen.getByRole('group', { name });
/** The page of a version that exists: its facts only appear once the control room has answered. */
const ready = async (version: string) => {
  await screen.findByRole('list', { name: 'About this version' });
  return screen.getByRole('heading', { level: 1, name: `Pricing ${version}` });
};

describe('admin-pricing-release · one pricing version', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.pricingControlRoom.mockResolvedValue(PRICING_ROOM);
    platform.previewPricing.mockImplementation(async (version: string) => previewOf(version));
    platform.pricingAction.mockResolvedValue({ release: LIVE_RELEASE, message: 'The version was updated.' });
    platform.archivePricing.mockResolvedValue({ release: DRAINING_RELEASE, message: 'The version was archived.' });
    platform.publishPricing.mockResolvedValue({ release: { ...DRAFT_RELEASE, version: '0.2.0', sphere_state: 'PUBLIC_RELEASE' }, message: 'Release published.' });
    platform.forkPricing.mockResolvedValue({ release: { ...DRAFT_RELEASE, version: '0.2.0-draft.2' }, message: 'Draft forked.' });
    platform.deletePricingDraft.mockResolvedValue(undefined);
    client.adminAudit.mockResolvedValue(AUDIT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the LIVE release: its states, its stage, and what it holds as plans', async () => {
    open('0.1.0');
    await ready('0.1.0');
    expect(screen.getByRole('navigation', { name: 'Administration' }).querySelector('[aria-current="page"]')).toHaveTextContent('Pricing');
    expect(screen.getByText(/A public, immutable release/)).toBeInTheDocument();
    const facts = screen.getByRole('list', { name: 'About this version' });
    expect(within(facts).getByText('sha256-bbbb…bbbb')).toBeInTheDocument();
    expect(within(facts).getByText('First release.')).toBeInTheDocument();

    const where = screen.getByRole('region', { name: 'Where this version is' });
    expect(within(where).getByRole('listitem', { name: /^LIVE/ })).toHaveClass('is-live');
    expect(within(where).getByRole('listitem', { name: /^Draining/ })).not.toHaveClass('is-on');

    const plans = await screen.findByRole('list', { name: 'Plans' });
    expect(within(within(plans).getByRole('listitem', { name: 'BASIC' })).getByText('Free')).toBeInTheDocument();
    const pro = within(within(plans).getByRole('listitem', { name: 'PRO' }));
    expect(pro.getByText('Unlimited')).toBeInTheDocument();
    expect(pro.getByText('8')).toBeInTheDocument();
    expect(pro.getByText('Advanced analytics')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Add-ons' })).getByText('Compute pack')).toBeInTheDocument();
    expect(screen.getByText('Every plan includes solve.')).toBeInTheDocument();
    expect(screen.queryByText(/certified/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/app/admin/pricing');
  });

  it('keeps the document itself behind “View source”, and the customer preview behind a button', async () => {
    open('0.1.0');
    await screen.findByRole('list', { name: 'Plans' });
    expect(screen.getByLabelText('View source (YAML)')).toHaveTextContent('syntaxVersion');
    expect(screen.queryByTestId('renderer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the customer preview' }));
    expect(screen.getByTestId('renderer')).toBeInTheDocument();
  });

  it('has nothing to compare the LIVE release with, and says so', async () => {
    open('0.1.0');
    await ready('0.1.0');
    expect(screen.getByText('This is the LIVE version, so there is nothing to compare it with.')).toBeInTheDocument();
  });

  it('compares a draft with LIVE, figure by figure', async () => {
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    expect(screen.getByRole('heading', { name: 'Compared with LIVE 0.1.0' })).toBeInTheDocument();
    const changes = await screen.findByRole('group', { name: 'Changes of 0.2.0-draft.1 against LIVE' });
    expect(within(changes).getByText('Concurrent jobs')).toBeInTheDocument();
    expect(within(changes).getByText('8')).toBeInTheDocument();
    expect(within(changes).getByText('10 ▲')).toBeInTheDocument();
    expect(screen.getByText(/It isn’t certified, and it can’t be LIVE until it is published as a release/)).toBeInTheDocument();
  });

  it('gives a version’s history: when it changed, its manifest, the events that name it and every version', async () => {
    open('0.1.0');
    await ready('0.1.0');
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('Migration · Reason').nextSibling).toHaveTextContent('first release');
    const events = await within(history).findByRole('list', { name: 'Events of this version' });
    expect(within(events).getAllByRole('listitem')).toHaveLength(1);
    expect(within(events).getByText('Pricing live activated: 0.1.0.')).toBeInTheDocument();
    expect(within(events).queryByText(/drained/)).not.toBeInTheDocument();
    expect(within(events).queryByText(/Contract subscription/)).not.toBeInTheDocument();
    const versions = within(history).getByRole('list', { name: 'All versions' });
    expect(within(versions).getAllByRole('link').map((link) => link.textContent)).toEqual(['0.2.0-draft.1', '0.1.0', '0.0.9']);
    expect(within(versions).getByRole('link', { name: '0.0.9' })).toHaveAttribute('href', '/app/admin/pricing/0.0.9');
    expect(within(versions).getByRole('link', { name: '0.1.0' })).toHaveAttribute('aria-current', 'page');
  });

  it('says the audit log could not be read without losing the rest', async () => {
    client.adminAudit.mockRejectedValue(refusal(503, 'accounts_unavailable'));
    open('0.1.0');
    await ready('0.1.0');
    expect(await screen.findByText(/The audit log couldn’t be read, so no events are shown/)).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Plans' })).toBeInTheDocument();
  });

  it('says what the API does not report: the contracts pinned to a version', async () => {
    open('0.0.9');
    await ready('0.0.9');
    expect(screen.getByRole('heading', { name: 'Contracts on 0.0.9' })).toBeInTheDocument();
    expect(screen.getByText(/doesn’t report how many contracts are pinned to a version/)).toBeInTheDocument();
  });

  it('lists each action with what it needs, and allows none on the LIVE release', async () => {
    open('0.1.0');
    await ready('0.1.0');
    const deploy = within(action('Deploy to SPACE'));
    expect(deploy.getByText('Not now')).toBeInTheDocument();
    expect(deploy.getByText(/Not deployed yet, or archived/)).toHaveTextContent('(not met)');
    expect(deploy.getByText(/The gateway would answer 409 · the version is already deployed/)).toBeInTheDocument();
    for (const name of ['Deploy to SPACE', 'Make LIVE', 'Drain', 'Archive']) {
      expect(within(action(name)).getByRole('button', { name })).toBeDisabled();
    }
    expect(within(action('Archive')).getByText(/No contract is still on it/)).toHaveTextContent('(checked by the gateway)');
    expect(screen.queryByRole('group', { name: 'Delete draft' })?.querySelector('button')).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Publish as a release' })).not.toBeInTheDocument();
    expect(screen.getByText(/this screen doesn’t send one/)).toBeInTheDocument();
  });

  it('deploys a draft as a preview only after a confirmation, then reads the versions again', async () => {
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    expect(within(action('Deploy to SPACE')).getByText('Available')).toBeInTheDocument();
    expect(within(action('Make LIVE')).getByText('Not now')).toBeInTheDocument();
    fireEvent.click(within(action('Deploy to SPACE')).getByRole('button', { name: 'Deploy to SPACE' }));
    const dialog = screen.getByRole('dialog', { name: 'Deploy to SPACE 0.2.0-draft.1?' });
    expect(platform.pricingAction).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Deploys this draft to SPACE as a preview/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deploy to SPACE' }));
    await waitFor(() => expect(platform.pricingAction).toHaveBeenCalledWith('0.2.0-draft.1', 'deploy'));
    expect(await screen.findByText('The version was updated.')).toBeInTheDocument();
    await waitFor(() => expect(platform.pricingControlRoom).toHaveBeenCalledTimes(2));
  });

  it('makes a draining release LIVE again after a confirmation', async () => {
    open('0.0.9');
    await ready('0.0.9');
    fireEvent.click(within(action('Make LIVE')).getByRole('button', { name: 'Make LIVE' }));
    const dialog = screen.getByRole('dialog', { name: 'Make LIVE 0.0.9?' });
    expect(within(dialog).getByText(/The current LIVE version starts draining/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make LIVE' }));
    await waitFor(() => expect(platform.pricingAction).toHaveBeenCalledWith('0.0.9', 'activate'));
  });

  it('archives a draining release, and says when the gateway refuses (409)', async () => {
    platform.archivePricing.mockRejectedValueOnce(refusal(409, 'pricing_has_contracts', 'Two contracts are still pinned to 0.0.9.'));
    open('0.0.9');
    await ready('0.0.9');
    fireEvent.click(within(action('Archive')).getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Archive 0.0.9?' })).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('The gateway refused the change (409 · pricing_has_contracts)')).toBeInTheDocument();
    expect(screen.getByText('Two contracts are still pinned to 0.0.9.')).toBeInTheDocument();
    expect(platform.archivePricing).toHaveBeenCalledWith('0.0.9');

    fireEvent.click(within(action('Archive')).getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Archive 0.0.9?' })).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('The version was archived.')).toBeInTheDocument();
    expect(screen.queryByText('The gateway refused the change (409 · pricing_has_contracts)')).not.toBeInTheDocument();
  });

  it('says a key without the pricing permission cannot act (403)', async () => {
    platform.pricingAction.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    fireEvent.click(within(action('Deploy to SPACE')).getByRole('button', { name: 'Deploy to SPACE' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deploy to SPACE' }));
    expect(await screen.findByText('This key can’t administer pricing (403)')).toBeInTheDocument();
  });

  it('publishes a draft as an immutable release, asking for its version and changelog', async () => {
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    fireEvent.click(within(action('Publish as a release')).getByRole('button', { name: 'Publish…' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish 0.2.0-draft.1 as a release?' });
    expect(within(dialog).getByText(/publishing doesn’t certify its content/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Publish release' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Release version (X.Y.Z)'), { target: { value: '0.2.0' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Changelog (required)'), { target: { value: 'More jobs on PRO' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(platform.publishPricing).toHaveBeenCalledWith('0.2.0-draft.1', '0.2.0', 'More jobs on PRO', { reason: 'new functionality' }));
    expect(await screen.findByText('Release published.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing 0.2.0' })).toBeInTheDocument();
  });

  it('says why a draft cannot be published (422)', async () => {
    platform.publishPricing.mockRejectedValue(refusal(422, 'invalid_release_version', 'The first stable release must be 0.1.0.'));
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    fireEvent.click(within(action('Publish as a release')).getByRole('button', { name: 'Publish…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Release version (X.Y.Z)'), { target: { value: '0.2.0' } });
    fireEvent.change(within(dialog).getByLabelText('Changelog (required)'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish release' }));
    expect(await screen.findByText('That isn’t valid (422 · invalid_release_version)')).toBeInTheDocument();
    expect(screen.getByText('The first stable release must be 0.1.0.')).toBeInTheDocument();
  });

  it('forks any version into a new private draft', async () => {
    open('0.1.0');
    await ready('0.1.0');
    fireEvent.click(within(action('Fork into a new draft')).getByRole('button', { name: 'Fork…' }));
    const dialog = screen.getByRole('dialog', { name: 'Fork 0.1.0 into a new draft' });
    const submit = within(dialog).getByRole('button', { name: 'Fork draft' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('New draft version (X.Y.Z-draft.N)'), { target: { value: '0.2.0-draft.2' } });
    fireEvent.click(submit);
    await waitFor(() => expect(platform.forkPricing).toHaveBeenCalledWith('0.1.0', '0.2.0-draft.2', ''));
    expect(await screen.findByText('Draft forked.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing 0.2.0-draft.2' })).toBeInTheDocument();
  });

  it('deletes a private draft only when its exact version is typed', async () => {
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    fireEvent.click(within(action('Delete draft')).getByRole('button', { name: 'Delete draft…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete draft 0.2.0-draft.1?' });
    const submit = within(dialog).getByRole('button', { name: 'Delete draft' });
    const typed = within(dialog).getByLabelText(/Type the version 0\.2\.0-draft\.1 to confirm/);
    fireEvent.change(typed, { target: { value: '0.2.0-draft' } });
    expect(submit).toBeDisabled();
    fireEvent.change(typed, { target: { value: '0.2.0-draft.1' } });
    expect(submit).toBeEnabled();
    expect(platform.deletePricingDraft).not.toHaveBeenCalled();
    fireEvent.click(submit);
    await waitFor(() => expect(platform.deletePricingDraft).toHaveBeenCalledWith('0.2.0-draft.1'));
    expect(await screen.findByText('Draft 0.2.0-draft.1 deleted')).toBeInTheDocument();
  });

  it('offers no deletion of a public release', async () => {
    open('0.0.9');
    await ready('0.0.9');
    expect(within(action('Delete draft')).getByRole('button', { name: 'Delete draft…' })).toBeDisabled();
    expect(within(action('Delete draft')).getByText(/a public release is immutable/)).toBeInTheDocument();
  });

  it('moves between versions with the selector', async () => {
    open('0.1.0');
    await ready('0.1.0');
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '0.2.0-draft.1' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing 0.2.0-draft.1' })).toBeInTheDocument();
    await waitFor(() => expect(platform.previewPricing).toHaveBeenCalledWith('0.2.0-draft.1'));
  });

  it('says when no such version is recorded', async () => {
    open('0.9.9');
    expect(await screen.findByText('No version 0.9.9')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the control room' })).toHaveAttribute('href', '/app/admin/pricing');
    expect(screen.queryByRole('group', { name: 'Deploy to SPACE' })).not.toBeInTheDocument();
  });

  it('refuses to show content whose fingerprint does not match, and pauses the actions', async () => {
    platform.previewPricing.mockRejectedValue(refusal(502, 'pricing_digest_mismatch', 'The digest differs.'));
    open('0.2.0-draft.1');
    await ready('0.2.0-draft.1');
    expect((await screen.findAllByText('The content doesn’t match its fingerprint (502 · pricing_digest_mismatch)')).length).toBeGreaterThan(0);
    expect(screen.getByText('Actions are paused until the fingerprint mismatch is resolved.')).toBeInTheDocument();
    expect(within(action('Deploy to SPACE')).getByRole('button', { name: 'Deploy to SPACE' })).toBeDisabled();
    expect(screen.queryByRole('list', { name: 'Plans' })).not.toBeInTheDocument();
  });

  it('words a preview that fails, and one that is not readable as plans', async () => {
    platform.previewPricing.mockRejectedValueOnce(refusal(503, 'sphere_disabled', 'SPHERE is disabled.'));
    open('0.1.0');
    await ready('0.1.0');
    expect(await screen.findByText('SPHERE or SPACE isn’t available (503 · sphere_disabled)')).toBeInTheDocument();
    platform.previewPricing.mockResolvedValue('- just a list');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The content couldn’t be shown as plans')).toBeInTheDocument();
    expect(screen.getByLabelText('View source (YAML)')).toHaveTextContent('just a list');
  });

  it('tells a key without the pricing permission so, with no retry', async () => {
    platform.pricingControlRoom.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    open('0.1.0');
    expect(await screen.findByText('This key can’t administer pricing (403)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminPricingRelease />, { user: LUCIA, entry: '/app/admin/pricing/0.1.0', path: '/app/admin/pricing/:version' });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(platform.pricingControlRoom).not.toHaveBeenCalled();
    expect(platform.previewPricing).not.toHaveBeenCalled();
    expect(client.adminAudit).not.toHaveBeenCalled();
  });
});
