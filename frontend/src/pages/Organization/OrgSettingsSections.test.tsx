import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditFixture } from './auditFixture';
import { member, org, project, renderScreen } from './testKit';
import { OrgSettings } from './OrgSettings';

const api = vi.hoisted(() => ({ adminListUsers: vi.fn() }));
const platform = vi.hoisted(() => ({
  members: vi.fn(), projects: vi.fn(), organizationAudit: vi.fn(), invitations: vi.fn(), organizationInvitations: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const readOnly = org('read-only', { name: 'Read Only Lab', effective_role: 'MEMBER' });

function renderSection(section?: string, organizations = [group, readOnly], slug = 'isa-demo') {
  return renderScreen(<OrgSettings />, {
    path: '/app/:org/settings/:section?',
    url: `/app/${slug}/settings${section ? `/${section}` : ''}`,
    organizations,
  });
}

const navOf = () => screen.getByRole('navigation', { name: 'Organization settings' });

describe('org-settings sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.members.mockResolvedValue([member('lucia', 'OWNER'), member('marco', 'MEMBER')]);
    platform.projects.mockResolvedValue([project('qos-benchmarks')]);
    platform.invitations.mockResolvedValue([]);
    platform.organizationInvitations.mockResolvedValue([]);
    platform.organizationAudit.mockResolvedValue({ events: auditFixture, total: auditFixture.length, offset: 0, limit: 50 });
    api.adminListUsers.mockResolvedValue({ users: [] });
  });

  it('renders General at /settings with General as the current link', async () => {
    renderSection();

    expect(await screen.findByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument();
    expect(within(navOf()).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    expect(navOf().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('renders Members at /settings/members with Members as the current link', async () => {
    renderSection('members');

    expect(await screen.findByRole('heading', { level: 1, name: /Members/ })).toBeInTheDocument();
    expect(within(navOf()).getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
    expect(navOf().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('renders Audit at /settings/audit with Audit as the current link', async () => {
    renderSection('audit');

    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    expect(within(navOf()).getByRole('link', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
    expect(navOf().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('shows Page not found for any other section', () => {
    renderSection('billing');

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Organization settings' })).not.toBeInTheDocument();
  });

  it('keeps the ADMIN gate of the audit section for a member', async () => {
    renderSection('audit', [readOnly], 'read-only');

    expect(await within(await screen.findByRole('navigation', { name: 'Organization settings' })).findByText('ADMIN')).toBeInTheDocument();
    expect(platform.organizationAudit).not.toHaveBeenCalled();
  });
});
