import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { NoProject } from './PlatformPages';

// The screens of a project are tested with their own pages; what stays here is the message of a project page that has no project to open.
const outlet = vi.hoisted(() => ({ value: null as PlatformOutletContext | null }));

vi.mock('react-router-dom', async () => ({
  ...await vi.importActual<typeof import('react-router-dom')>('react-router-dom'),
  useOutletContext: () => outlet.value,
}));

const organization: Organization = {
  id: 'organization-id', slug: 'openbinding', name: 'OpenBinding', parent_id: null,
  billing_sponsor_user_id: 'sponsor-id', effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z',
};
const project: Project = {
  id: 'project-id', organization_id: organization.id, slug: 'research', name: 'Binding research',
  description: 'Reproducible binding evidence.', visibility: 'private', created_by_id: 'user-id',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};
const reload = vi.fn();

describe('a project page without a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outlet.value = { organizations: [organization], projects: [project], organization, project: undefined, loading: false, reload };
  });

  it('sends the person to the new-project screen of the organization', () => {
    render(<MemoryRouter><NoProject /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Create a first project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/app/openbinding/new-project');
  });

  it('says so while the workspace is still loading', () => {
    outlet.value = { organizations: [], projects: [], organization: undefined, project: undefined, loading: true, reload };

    render(<MemoryRouter><NoProject /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Loading workspace…');
  });

  it('asks for an organization first when the account has none', () => {
    outlet.value = { organizations: [], projects: [], organization: undefined, project: undefined, loading: false, reload };

    render(<MemoryRouter><NoProject /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'No organization yet' })).toBeInTheDocument();
  });
});
