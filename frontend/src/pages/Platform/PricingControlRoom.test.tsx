import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingControlRoomPage } from './PricingControlRoom';
import { MARIA } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from '../Admin/adminTestUtils';
import { PRICING_ROOM } from '../Admin/pricingFixtures';
import { config } from '../../config';

const platform = vi.hoisted(() => ({ pricingControlRoom: vi.fn(), syncPricing: vi.fn() }));
const client = vi.hoisted(() => ({ adminReconcileContracts: vi.fn() }));

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: platform,
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: client,
}));

configure({ asyncUtilTimeout: 5000 });

describe('admin-pricing · the pricing control room', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.pricingControlRoom.mockResolvedValue(PRICING_ROOM);
    platform.syncPricing.mockResolvedValue({ created: 2 });
    client.adminReconcileContracts.mockResolvedValue({ renewed: 3 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Open SPACE Console header button with an external link opening in a new tab', async () => {
    renderAdmin(<PricingControlRoomPage />);
    const consoleButton = await screen.findByRole('link', { name: /Open SPACE Console/i });
    expect(consoleButton).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(consoleButton).toHaveAttribute('target', '_blank');
    expect(consoleButton).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders Manage in SPACE within the SPACE 1.5 health card', async () => {
    renderAdmin(<PricingControlRoomPage />);
    const cardLink = await screen.findByRole('link', { name: /Manage in SPACE/i });
    expect(within(screen.getByRole('region', { name: 'SPACE 1.5' })).getByRole('link', { name: /Manage in SPACE/i })).toBe(cardLink);
    expect(cardLink).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(cardLink).toHaveAttribute('target', '_blank');
    expect(cardLink).toHaveAttribute('rel', 'noreferrer');
  });

  it('shows whether SPHERE and SPACE answer, and the LIVE version with its fingerprint', async () => {
    renderAdmin(<PricingControlRoomPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Pricing control room' })).toBeInTheDocument();
    const sphere = await screen.findByRole('region', { name: 'SPHERE' });
    expect(within(sphere).getByText('Connected')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'SPACE 1.5' })).getByText('Connected')).toBeInTheDocument();
    const live = screen.getByRole('region', { name: 'LIVE' });
    expect(within(live).getByText('0.1.0', { selector: 'strong' })).toBeInTheDocument();
    expect(within(live).getByText(/sha256-bbbb…bbbb/)).toBeInTheDocument();
    expect(within(live).getByRole('link', { name: 'Open 0.1.0' })).toHaveAttribute('href', '/app/admin/pricing/0.1.0');
    expect(screen.getByRole('navigation', { name: 'Administration' }).querySelector('[aria-current="page"]')).toHaveTextContent('Pricing');
  });

  it('says a service is unavailable or not configured instead of leaving a blank', async () => {
    platform.pricingControlRoom.mockResolvedValue({ ...PRICING_ROOM, sphere: { enabled: false, reachable: false }, space: { enabled: true, reachable: false } });
    renderAdmin(<PricingControlRoomPage />);
    expect(within(await screen.findByRole('region', { name: 'SPHERE' })).getByText('Not configured')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'SPACE 1.5' })).getByText('Unavailable')).toBeInTheDocument();
  });

  it('does not claim that LIVE, or any draft, is certified', async () => {
    renderAdmin(<PricingControlRoomPage />);
    expect(await screen.findByText('LIVE is not a certification')).toBeInTheDocument();
    expect(screen.queryByText(/certified/i)).not.toBeInTheDocument();
  });

  it('places each version in the stages of its life', async () => {
    renderAdmin(<PricingControlRoomPage />);
    await screen.findByRole('region', { name: 'LIVE' });
    const stage = (name: string) => within(screen.getByRole('listitem', { name }));
    expect(stage('Private draft').getByRole('link', { name: '0.2.0-draft.1' })).toHaveAttribute('href', '/app/admin/pricing/0.2.0-draft.1');
    expect(stage('Immutable release').getByRole('link', { name: '0.1.0' })).toBeInTheDocument();
    expect(stage('Immutable release').getByRole('link', { name: '0.0.9' })).toBeInTheDocument();
    expect(stage('Deployed').getByRole('link', { name: '0.1.0' })).toBeInTheDocument();
    expect(stage('LIVE').getByRole('link', { name: '0.1.0' })).toBeInTheDocument();
    expect(stage('Draining').getByRole('link', { name: '0.0.9' })).toBeInTheDocument();
    expect(stage('Archived').getByText('None')).toBeInTheDocument();
  });

  it('lists the versions with their states, and a way into each', async () => {
    renderAdmin(<PricingControlRoomPage />);
    const live = await screen.findByRole('row', { name: 'Version 0.1.0' });
    expect(within(live).getByText('Public release')).toBeInTheDocument();
    expect(within(live).getByText('Active')).toBeInTheDocument();
    expect(within(live).getByText('LIVE')).toBeInTheDocument();
    expect(within(live).getByRole('link', { name: 'Open 0.1.0' })).toHaveAttribute('href', '/app/admin/pricing/0.1.0');
    const draft = screen.getByRole('row', { name: 'Version 0.2.0-draft.1' });
    expect(within(draft).getByText('Private draft')).toBeInTheDocument();
    expect(within(draft).getByText('Not deployed')).toBeInTheDocument();
    expect(within(draft).queryByText('LIVE')).not.toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: 'Version 0.0.9' })).getByText('Draining')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New draft' })).toHaveAttribute('href', '/app/admin/pricing/drafts/new');
  });

  it('names the versions SPHERE and this database disagree about', async () => {
    platform.pricingControlRoom.mockResolvedValue({ ...PRICING_ROOM, divergence: { onlyInSphere: ['0.3.0'], onlyLocal: ['0.0.1'] } });
    renderAdmin(<PricingControlRoomPage />);
    const section = (await screen.findByRole('heading', { name: 'SPHERE vs. this database' })).closest('section')!;
    expect(within(section).getByText('0.3.0')).toBeInTheDocument();
    expect(within(section).getByText('0.0.1')).toBeInTheDocument();
    expect(within(section).queryByText(/No differences/)).not.toBeInTheDocument();
  });

  it('syncs the metadata and reads the control room again', async () => {
    renderAdmin(<PricingControlRoomPage />);
    await screen.findByRole('region', { name: 'LIVE' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync metadata' }));
    expect(await screen.findByText(/Metadata synced: 2 new versions recorded/)).toBeInTheDocument();
    expect(platform.syncPricing).toHaveBeenCalledOnce();
    await waitFor(() => expect(platform.pricingControlRoom).toHaveBeenCalledTimes(2));
  });

  it('says what a failed sync is, in pricing’s own words', async () => {
    platform.syncPricing.mockRejectedValue(refusal(502, 'pricing_digest_mismatch', 'SPHERE content differs.'));
    renderAdmin(<PricingControlRoomPage />);
    await screen.findByRole('region', { name: 'LIVE' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync metadata' }));
    expect(await screen.findByText('The content doesn’t match its fingerprint (502 · pricing_digest_mismatch)')).toBeInTheDocument();
  });

  it('moves expired contracts to LIVE only after a confirmation', async () => {
    renderAdmin(<PricingControlRoomPage />);
    await screen.findByRole('region', { name: 'LIVE' });
    fireEvent.click(screen.getByRole('button', { name: 'Move expired contracts to LIVE' }));
    const dialog = screen.getByRole('dialog', { name: 'Move expired contracts to LIVE?' });
    expect(client.adminReconcileContracts).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reconcile contracts' }));
    await waitFor(() => expect(client.adminReconcileContracts).toHaveBeenCalledOnce());
    expect(await screen.findByText('Expired contracts were renewed onto the LIVE pricing. Recorded in the audit log.')).toBeInTheDocument();
    expect(within(screen.getByLabelText('What was moved')).getByText('Renewed')).toBeInTheDocument();
  });

  it('invites a sync when no release is recorded', async () => {
    platform.pricingControlRoom.mockResolvedValue({ ...PRICING_ROOM, live: null, releases: [], remoteVersions: [] });
    renderAdmin(<PricingControlRoomPage />);
    expect(await screen.findByText('No releases recorded here yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sync metadata' }).length).toBeGreaterThan(0);
  });

  it('words a control room that fails to load, apart from an empty one, and tries again', async () => {
    platform.pricingControlRoom.mockRejectedValueOnce(refusal(503, 'sphere_disabled', 'SPHERE is disabled.'));
    renderAdmin(<PricingControlRoomPage />);
    expect(await screen.findByText('SPHERE or SPACE isn’t available (503 · sphere_disabled)')).toBeInTheDocument();
    expect(screen.queryByText('No releases recorded here yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'LIVE' })).toBeInTheDocument();
  });

  it('tells a key without the pricing permission so, with no retry', async () => {
    platform.pricingControlRoom.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<PricingControlRoomPage />);
    expect(await screen.findByText('This key can’t administer pricing (403)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<PricingControlRoomPage />, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open SPACE Console/i })).not.toBeInTheDocument();
    expect(platform.pricingControlRoom).not.toHaveBeenCalled();
  });
});
