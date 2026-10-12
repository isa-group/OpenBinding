import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminErrors } from './AdminErrors';
import { ERRORS, ERROR_OVERVIEW, MARIA, SAM } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminErrorOverview: vi.fn(),
  adminListErrors: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

const none = { items: [], total: 0, limit: 50, offset: 0 };

describe('admin-errors · what is failing on the platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminErrorOverview.mockResolvedValue(ERROR_OVERVIEW);
    api.adminListErrors.mockResolvedValue(ERRORS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('summarises the last 24 hours by category, by status and by hour', async () => {
    renderAdmin(<AdminErrors />);
    expect(screen.getByRole('heading', { level: 1, name: 'Errors' })).toBeInTheDocument();
    expect(await screen.findByText('9 error events')).toBeInTheDocument();
    // The same labels are the options of the category filter.
    expect(screen.getAllByText('Quota (402)').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Platform faults').length).toBeGreaterThan(1);
    expect(screen.getByRole('img', { name: 'Errors by status: 402: 5, 422: 1, 429: 2, 503: 1' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Error events per hour over the last 24 hours, at most 4 in one hour/ })).toBeInTheDocument();
    expect(screen.getByText(/402 means a quota ran out \(expected\); 503 means a dependency was down/)).toBeInTheDocument();
  });

  it('names the accounts that keep hitting limits and the endpoints whose solvers fail', async () => {
    renderAdmin(<AdminErrors />);
    const accounts = await screen.findAllByRole('link', { name: SAM.email });
    expect(accounts[0]).toHaveAttribute('href', `/app/admin/users/${SAM.id}`);
    expect(await screen.findByText('7 refusals')).toBeInTheDocument();
    expect(screen.getByText('/v1/engines/minizinc/solve')).toBeInTheDocument();
    expect(screen.getByText('2 failures')).toBeInTheDocument();
  });

  it('groups the events of a page by status and code, busiest first', async () => {
    renderAdmin(<AdminErrors />);
    const groups = await screen.findByRole('list', { name: 'Errors grouped by code' });
    const items = within(groups).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('quota_exceeded')).toBeInTheDocument();
    expect(within(items[0]).getByText('×2')).toBeInTheDocument();
    expect(within(items[1]).getByText('concurrency_limit_exceeded')).toBeInTheDocument();
    expect(within(items[2]).getByText('pricing_unavailable')).toBeInTheDocument();
  });

  it('explains the group you pick: what it means, where, who, and the quota at the time', async () => {
    renderAdmin(<AdminErrors />);
    const aside = await screen.findByRole('complementary', { name: 'Error detail' });
    expect(within(aside).getByText('402 · quota_exceeded')).toBeInTheDocument();
    expect(within(aside).getByText(/A monthly or capacity allowance ran out/)).toBeInTheDocument();
    expect(within(aside).getByText('POST /v1/jobs')).toBeInTheDocument();
    expect(within(aside).getByRole('link', { name: SAM.email })).toHaveAttribute('href', `/app/admin/users/${SAM.id}`);
    const quota = within(aside).getByLabelText('Quota at the time');
    expect(within(quota).getByText('10 of 10 run/month')).toBeInTheDocument();
    expect(within(aside).getByText('View source')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pricing_unavailable/ }));
    expect(within(aside).getByText('503 · pricing_unavailable')).toBeInTheDocument();
    expect(within(aside).getByText('Not signed in')).toBeInTheDocument();
    expect(within(aside).queryByLabelText('Quota at the time')).not.toBeInTheDocument();
  });

  it('asks the gateway for the filters you choose', async () => {
    renderAdmin(<AdminErrors />);
    await screen.findByRole('list', { name: 'Errors grouped by code' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '402' } });
    await waitFor(() => expect(api.adminListErrors).toHaveBeenLastCalledWith(expect.objectContaining({ status_code: 402, limit: 50, offset: 0 })));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'pricing_quota' } });
    await waitFor(() => expect(api.adminListErrors).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'pricing_quota', status_code: 402 })));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-09' } });
    await waitFor(() => expect(api.adminListErrors).toHaveBeenLastCalledWith(expect.objectContaining({ from_date: '2026-10-01T00:00:00Z', to_date: '2026-10-09T23:59:59Z' })));
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'quota' } });
    await waitFor(() => expect(api.adminListErrors).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'quota' })));
  });

  it('filters by account only once the id is a UUID', async () => {
    renderAdmin(<AdminErrors />);
    await screen.findByRole('list', { name: 'Errors grouped by code' });
    fireEvent.change(screen.getByLabelText('Account id'), { target: { value: 'sam' } });
    expect(screen.getByText(/An account id is a UUID; the filter waits until it is one/)).toBeInTheDocument();
    expect(api.adminListErrors).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Account id'), { target: { value: SAM.id } });
    await waitFor(() => expect(api.adminListErrors).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: SAM.id })));
  });

  it('says there is nothing to diagnose when the gateway has recorded no errors', async () => {
    api.adminErrorOverview.mockResolvedValue({ ...ERROR_OVERVIEW, total_errors_24h: 0, by_category_24h: {}, by_status_code_24h: {}, top_users_quota: [], top_solvers_failed: [], timeline: [] });
    api.adminListErrors.mockResolvedValue(none);
    renderAdmin(<AdminErrors />);
    expect(await screen.findByText('No errors in the retention window')).toBeInTheDocument();
    expect(screen.getAllByText('No errors recorded.').length).toBeGreaterThan(0);
  });

  it('says when filters match nothing, and clears them', async () => {
    renderAdmin(<AdminErrors />);
    await screen.findByRole('list', { name: 'Errors grouped by code' });
    api.adminListErrors.mockResolvedValue(none);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '404' } });
    expect(await screen.findByText('No events match these filters')).toBeInTheDocument();
    api.adminListErrors.mockResolvedValue(ERRORS);
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findByRole('list', { name: 'Errors grouped by code' })).toBeInTheDocument();
  });

  it('pages through the events', async () => {
    api.adminListErrors.mockResolvedValue({ ...ERRORS, total: 120 });
    renderAdmin(<AdminErrors />);
    expect(await screen.findByText('Showing 1–4 of 120 events')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.adminListErrors).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
  });

  it('says in plain words that the gateway keeps no resolved state for events', async () => {
    renderAdmin(<AdminErrors />);
    expect(await screen.findByText(/The gateway keeps no “resolved” state for them/)).toBeInTheDocument();
  });

  it('keeps one failing part from hiding the rest, and retries it', async () => {
    api.adminErrorOverview.mockRejectedValueOnce(refusal(503, 'pricing_unavailable'));
    renderAdmin(<AdminErrors />);
    expect(await screen.findByText('A service isn’t available right now (503 · pricing_unavailable)')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Errors grouped by code' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('9 error events')).toBeInTheDocument();
  });

  it('reports events that cannot be read (503) and a key that cannot read them (403)', async () => {
    api.adminListErrors.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderAdmin(<AdminErrors />);
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('No errors in the retention window')).not.toBeInTheDocument();
  });

  it('says when the API key cannot use administration (403)', async () => {
    api.adminErrorOverview.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    api.adminListErrors.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminErrors />);
    expect((await screen.findAllByText('This key can’t use administration (403)')).length).toBeGreaterThan(0);
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminErrors />, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(api.adminErrorOverview).not.toHaveBeenCalled();
    expect(api.adminListErrors).not.toHaveBeenCalled();
  });
});
