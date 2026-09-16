import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Explore, Research, WorkbenchPage } from './PublicPages';

const api = vi.hoisted(() => ({
  publicProjects: vi.fn(),
  publicPublications: vi.fn(),
}));

vi.mock('../../api/platform', () => ({ platformApi: api }));

describe('public platform surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.publicProjects.mockResolvedValue([]);
    api.publicPublications.mockResolvedValue([]);
  });

  it('renders projects and frozen publications from the public API', async () => {
    api.publicProjects.mockResolvedValue([{
      organization: { slug: 'research-lab', name: 'Research Lab' },
      project: { slug: 'binding-study', name: 'Binding study', description: 'A reproducible comparison.' },
    }]);
    api.publicPublications.mockResolvedValue([{
      id: 'publication-1', title: 'Frozen report', abstract: 'Exact cases and engines.', published_at: '2026-09-01',
    }]);

    render(<MemoryRouter><Explore /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Binding study' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Frozen report' })).toBeInTheDocument();
    expect(api.publicProjects).toHaveBeenCalledOnce();
    expect(api.publicPublications).toHaveBeenCalledOnce();
  });

  // it('does not invent an OpenBinding-specific grant', () => {
  //   render(<MemoryRouter><Funding /></MemoryRouter>);

  //   expect(screen.getByText('No OpenBinding-specific award is published')).toBeInTheDocument();
  //   expect(screen.getByText(/do not, by themselves, claim a specific grant/i)).toBeInTheDocument();
  // });

  it('labels related papers as sources for the executable corpus', () => {
    render(<MemoryRouter><Research /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Sources represented in the executable corpus.' })).toBeInTheDocument();
    expect(screen.getByText(/Authors retain authorship of the original work/i)).toBeInTheDocument();
  });

  it('explains the workbench loop and links to the editor and related resources', () => {
    render(<MemoryRouter><WorkbenchPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'From package to evidence.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'One package, four useful views.' })).toBeInTheDocument();
    for (const label of ['Author', 'Inspect', 'Validate', 'Solve']) {
      expect(screen.getByText(label, { selector: '.workbench-step-label' })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: /Open the Workbench/i })).toHaveAttribute('href', '/playground');
    expect(screen.getByRole('link', { name: /Browse examples/i })).toHaveAttribute('href', '/examples');
    expect(screen.getByRole('link', { name: /Profiles & dialects/i })).toHaveAttribute('href', '/profiles');
    expect(screen.getByRole('link', { name: /Specification/i })).toHaveAttribute('href', '/schemas');
  });
});
