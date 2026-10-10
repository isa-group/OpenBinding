import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAudit } from './AdminAudit';
import { ALEX, AUDIT, MARIA } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({ adminAudit: vi.fn() }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

describe('admin-audit · the platform audit log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminAudit.mockResolvedValue(AUDIT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the events newest first, each in a sentence', async () => {
    renderAdmin(<AdminAudit />);
    expect(screen.getByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    expect(await screen.findByText('2 abandoned jobs were reconciled.')).toBeInTheDocument();
    expect(screen.getByText('Pricing live activated: 0.1.0.')).toBeInTheDocument();
    expect(screen.getByText('Agreement changed from BASIC to RESEARCH (no add-ons).')).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: 'Events, newest first' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(3);
    expect(api.adminAudit).toHaveBeenCalledWith({ action: undefined, offset: 0, limit: 100 });
    expect(screen.getByText(/Changes made inside an organization, such as a sponsorship transfer, are in that organization’s own audit log/)).toBeInTheDocument();
  });

  it('shows the detail of the event you pick, with what it changed from and to', async () => {
    renderAdmin(<AdminAudit />);
    await screen.findByText('2 abandoned jobs were reconciled.');
    const aside = screen.getByRole('complementary', { name: 'Event detail' });
    expect(within(aside).getByText('maintenance.jobs.reconciled')).toBeInTheDocument();
    expect(within(aside).queryByLabelText('Before and after')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /contract\.subscription\.changed/ }));
    expect(within(aside).getByText('contract.subscription.changed')).toBeInTheDocument();
    const change = within(aside).getByLabelText('Before and after');
    expect(within(change).getByText('BASIC · no add-ons')).toBeInTheDocument();
    expect(within(change).getByText('RESEARCH · no add-ons')).toBeInTheDocument();
    expect(within(aside).getByText('Institutional agreement')).toBeInTheDocument();
    expect(within(aside).getByText('Agreement 2026-14')).toBeInTheDocument();
    expect(within(aside).getByRole('link', { name: '00000000…' })).toHaveAttribute('href', `/app/admin/users/${ALEX.id}`);
    expect(within(aside).getByText('00000000-0000-4000-8000-000000000401')).toBeInTheDocument();
    expect(within(aside).getByText('View source')).toBeInTheDocument();
  });

  it('narrows the page by kind of event', async () => {
    renderAdmin(<AdminAudit />);
    await screen.findByText('2 abandoned jobs were reconciled.');
    const kinds = screen.getByRole('group', { name: 'Kind of event' });
    fireEvent.click(within(kinds).getByRole('button', { name: 'Pricing' }));
    expect(screen.getByText('Pricing live activated: 0.1.0.')).toBeInTheDocument();
    expect(screen.queryByText('2 abandoned jobs were reconciled.')).not.toBeInTheDocument();
    fireEvent.click(within(kinds).getByRole('button', { name: 'Other' }));
    expect(screen.getByText('No events for this filter')).toBeInTheDocument();
    fireEvent.click(within(kinds).getByRole('button', { name: 'All' }));
    expect(screen.getByText('2 abandoned jobs were reconciled.')).toBeInTheDocument();
  });

  it('asks the gateway for an exact action, and can drop the filter again', async () => {
    renderAdmin(<AdminAudit />);
    await screen.findByText('2 abandoned jobs were reconciled.');
    fireEvent.change(screen.getByLabelText('Exact action'), { target: { value: 'contract.subscription.changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: 'contract.subscription.changed', offset: 0, limit: 100 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear “contract.subscription.changed”' }));
    await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, offset: 0, limit: 100 }));
  });

  it('says so when there are no events', async () => {
    api.adminAudit.mockResolvedValue({ events: [], total: 0, offset: 0, limit: 100 });
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('No events for this filter')).toBeInTheDocument();
    expect(screen.getByText('Nothing has been recorded at platform level yet.')).toBeInTheDocument();
  });

  it('pages through the log', async () => {
    api.adminAudit.mockResolvedValue({ ...AUDIT, total: 250 });
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('Showing 1–3 of 250 events')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.adminAudit).toHaveBeenLastCalledWith({ action: undefined, offset: 100, limit: 100 }));
  });

  it('keeps a failure apart from an empty log and tries again', async () => {
    api.adminAudit.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('No events for this filter')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 abandoned jobs were reconciled.')).toBeInTheDocument();
  });

  it('says when the API key cannot read the log (403)', async () => {
    api.adminAudit.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText('This key can’t use administration (403)')).toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminAudit />, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Events, newest first' })).not.toBeInTheDocument();
    expect(api.adminAudit).not.toHaveBeenCalled();
  });
});
