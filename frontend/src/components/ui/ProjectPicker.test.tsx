import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPicker } from './ProjectPicker';

const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

function renderPicker() {
  return render(
    <MemoryRouter>
      <ProjectPicker label="Run with this engine" destination={(org, project) => `/app/${org}/${project}/jobs/new`} />
    </MemoryRouter>,
  );
}

describe('project picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.organizations.mockResolvedValue([{ slug: 'a', name: 'Org A' }, { slug: 'b', name: 'Org B' }]);
    platform.projects.mockImplementation(async (org: string) => (org === 'a' ? [{ slug: 'one', name: 'Project One' }, { slug: 'two', name: 'Project Two' }] : []));
  });

  it('loads nothing until it is opened, then links every project of every organization', async () => {
    renderPicker();
    expect(platform.organizations).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Run with this engine' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('link', { name: 'Org A / Project One' })).toHaveAttribute('href', '/app/a/one/jobs/new');
    expect(screen.getByRole('link', { name: 'Org A / Project Two' })).toHaveAttribute('href', '/app/a/two/jobs/new');
    expect(platform.projects).toHaveBeenCalledTimes(2);

    fireEvent.click(button);
    expect(screen.queryByRole('link', { name: 'Org A / Project One' })).not.toBeInTheDocument();
  });

  it('points to the workspace when the account has no project', async () => {
    platform.organizations.mockResolvedValue([]);
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Run with this engine' }));
    expect(await screen.findByText(/You have no projects yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open your workspace' })).toHaveAttribute('href', '/app');
  });

  it('reports a failure and retries', async () => {
    platform.organizations.mockRejectedValueOnce(new Error('down'));
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Run with this engine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your projects couldn’t be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Org A / Project One' })).toBeInTheDocument();
  });
});
