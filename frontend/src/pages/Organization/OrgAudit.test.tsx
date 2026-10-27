import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { OrganizationAuditEvent } from '../../api/platform';
import { auditFixture } from './auditFixture';
import { member, org, renderScreen } from './testKit';
import { OrgAudit } from './OrgAudit';

const platform = vi.hoisted(() => ({ organizationAudit: vi.fn(), members: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });

function renderAudit(organizations = [group], slug = 'isa-demo') {
  return renderScreen(<OrgAudit />, { path: '/app/:org/settings/audit', url: `/app/${slug}/settings/audit`, organizations });
}

const page = (events: OrganizationAuditEvent[], over: Record<string, unknown> = {}) => ({ events, total: events.length, offset: 0, limit: 50, ...over });
const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });
const card = (name: RegExp | string) => screen.getByRole('button', { name });

describe('Audit log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.members.mockResolvedValue([member('lucia', 'OWNER'), member('marco', 'MEMBER'), member('sofia', 'VIEWER')]);
    platform.organizationAudit.mockImplementation(async (_org: string, params: { action?: string }) => (
      page(params.action ? auditFixture.filter((event) => event.action === params.action) : auditFixture)
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the events as a timeline, newest first, each with its kind, sentence and time', async () => {
    renderAudit();

    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    expect(screen.getByText('Who did what in ISA Demo Group.')).toBeInTheDocument();
    const timeline = await screen.findByRole('list', { name: 'Audit events, newest first' });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('MembersInvitation createdOct 8, 2026, 09:15 UTC');
    expect(items[1]).toHaveTextContent('Members2 member changes applied together');
    expect(items[2]).toHaveTextContent('OrganizationOrganization created');
    expect(screen.getByText('Showing 1–3 of 3 · newest first')).toBeInTheDocument();
    expect(platform.organizationAudit).toHaveBeenCalledWith('isa-demo', { action: undefined, offset: 0, limit: 50 });
  });

  it('opens an event to who did it, what it touched and the changes it carried', async () => {
    renderAudit();
    fireEvent.click(await screen.findByRole('button', { name: /2 member changes applied together/ }));

    const open = card(/2 member changes applied together/);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    const details = document.getElementById(open.getAttribute('aria-controls')!)!;
    expect(within(details).getByText('lucia.vega')).toBeInTheDocument();
    expect(within(details).getByText('organization.members.batch_updated')).toBeInTheDocument();
    expect(details).toHaveTextContent('TargetOrganization · org-isa-demo');
    // The people in the batch are named from the member list; nobody is shown as a bare id.
    expect(within(details).getByText('marco → ADMIN')).toBeInTheDocument();
    expect(within(details).getByText('sofia → removed')).toBeInTheDocument();

    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'false');
    // An event with no recorded actor says so.
    fireEvent.click(card(/Invitation created/));
    expect(screen.getByText('Not recorded', { selector: 'dd' })).toBeInTheDocument();
  });

  // [utest->req~frontend-audit-detail-rendered~1]
  it('shows nested object and array details as readable text, never as JSON', async () => {
    const rich: OrganizationAuditEvent = {
      ...auditFixture[2],
      id: 'ev-rich',
      action: 'organization.updated',
      detail: { limits: { max_projects: 1500, is_public: true }, tags: ['alpha', 'beta'], note: null, retry_count: 3 },
    };
    platform.organizationAudit.mockResolvedValue(page([rich]));
    renderAudit();

    fireEvent.click(await screen.findByRole('button', { name: /Organization updated/ }));
    const open = card(/Organization updated/);
    const details = document.getElementById(open.getAttribute('aria-controls')!)!;
    expect(within(details).getByText('Limits')).toBeInTheDocument();
    expect(within(details).getByText('Max projects')).toBeInTheDocument();
    expect(within(details).getByText('1,500')).toBeInTheDocument();
    expect(within(details).getByText('Is public')).toBeInTheDocument();
    expect(within(details).getByText('Yes')).toBeInTheDocument();
    expect(within(details).getByText('Retry count')).toBeInTheDocument();
    expect(within(details).getByText('none')).toBeInTheDocument();
    const tags = within(details).getAllByRole('listitem').map((item) => item.textContent);
    expect(tags).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(details.textContent).not.toContain('{"');
    expect(details.textContent).not.toContain('["');
  });

  it('copies the reference of an event', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAudit();

    fireEvent.click(await screen.findByRole('button', { name: /Organization created/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy event reference' }));

    expect(writeText).toHaveBeenCalledWith('ev-1');
    expect(await screen.findByRole('button', { name: 'Event reference copied' })).toBeInTheDocument();
  });

  it('filters the action on the server and the actor in the view', async () => {
    renderAudit();
    await screen.findByRole('list', { name: 'Audit events, newest first' });
    expect(screen.getByText('Action is filtered by the server; actor and period are filtered in this view.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'organization.created' } });
    await waitFor(() => expect(platform.organizationAudit).toHaveBeenCalledWith('isa-demo', { action: 'organization.created', offset: 0, limit: 50 }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Audit events, newest first' })).getAllByRole('listitem')).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: '' } });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Audit events, newest first' })).getAllByRole('listitem')).toHaveLength(3));
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: '__none' } });
    const items = within(screen.getByRole('list', { name: 'Audit events, newest first' })).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Invitation created');
    expect(screen.getByText(/1 match the actor and period filters/)).toBeInTheDocument();
  });

  it('keeps only the events of the last 30 days when asked', async () => {
    const day = 86_400_000;
    const recent = { ...auditFixture[0], id: 'recent', createdAt: new Date(Date.now() - 2 * day).toISOString() };
    const old = { ...auditFixture[2], id: 'old', createdAt: new Date(Date.now() - 200 * day).toISOString() };
    platform.organizationAudit.mockResolvedValue(page([recent, old]));
    renderAudit();
    await screen.findByRole('list', { name: 'Audit events, newest first' });

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30' } });

    const items = within(screen.getByRole('list', { name: 'Audit events, newest first' })).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Invitation created');
  });

  it('says when nothing matches the filters and clears them', async () => {
    platform.organizationAudit.mockImplementation(async (_org: string, params: { action?: string }) => page(params.action ? [] : auditFixture));
    renderAudit();
    await screen.findByRole('list', { name: 'Audit events, newest first' });

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'project.deleted' } });
    expect(await screen.findByText(/No events match these filters\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(await screen.findByRole('list', { name: 'Audit events, newest first' })).toBeInTheDocument();
    expect(screen.getByLabelText('Action')).toHaveValue('');
  });

  it('says there is nothing yet when no event was ever recorded', async () => {
    platform.organizationAudit.mockResolvedValue(page([]));
    renderAudit();

    expect(await screen.findByText('No events have been recorded for this organization yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('pages through the log with the offset the server understands', async () => {
    platform.organizationAudit.mockImplementation(async (_org: string, params: { offset?: number }) => page(auditFixture, { total: 120, offset: params.offset ?? 0 }));
    renderAudit();

    expect(await screen.findByText('Showing 1–3 of 120 · newest first')).toBeInTheDocument();
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(platform.organizationAudit).toHaveBeenCalledWith('isa-demo', { action: undefined, offset: 50, limit: 50 }));
    expect(await screen.findByText('Showing 51–53 of 120 · newest first')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('exports the events in view as CSV', async () => {
    const createObjectURL = vi.fn(() => 'blob:audit');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAudit();

    const exportButton = await screen.findByRole('button', { name: 'Export this view' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(await screen.findByText('Exported 3 events as CSV: this page, with the filters you set.')).toBeInTheDocument();
  });

  it('needs ADMIN: below it nothing is requested and the 403 is explained', async () => {
    renderAudit([{ ...group, effective_role: 'MEMBER' }]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The audit log needs ADMIN (403)');
    expect(alert).toHaveTextContent('Your role in ISA Demo Group is MEMBER.');
    expect(within(alert).getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
    expect(platform.organizationAudit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Export this view' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Action')).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Organization settings' })).getByText('ADMIN')).toBeInTheDocument();
  });

  it('shows the same explanation when the server refuses a role that looked sufficient', async () => {
    platform.organizationAudit.mockRejectedValue(refusal(403, 'organization_forbidden'));
    renderAudit();

    expect(await screen.findByText('The audit log needs ADMIN (403)')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Audit events, newest first' })).not.toBeInTheDocument();
  });

  it('reports a failed load with a retry', async () => {
    platform.organizationAudit.mockRejectedValueOnce(new HttpError(503, 'down'));
    renderAudit();

    expect(await screen.findByRole('alert')).toHaveTextContent('The audit log couldn’t be loaded (503).');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('list', { name: 'Audit events, newest first' })).toBeInTheDocument();
    expect(platform.organizationAudit).toHaveBeenCalledTimes(2);
  });

  it('answers the neutral message for an organization the account cannot see', async () => {
    renderAudit([group], 'ghost');

    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(platform.organizationAudit).not.toHaveBeenCalled();
  });
});
