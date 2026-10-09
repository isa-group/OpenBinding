import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WorkbenchPage } from './PublicPages';

describe('public platform surfaces', () => {
  it('explains the workbench loop and links to the workspace, examples and related resources', () => {
    render(<MemoryRouter><WorkbenchPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'From package to evidence.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'One package, four useful views.' })).toBeInTheDocument();
    for (const label of ['Author', 'Inspect', 'Validate', 'Solve']) {
      expect(screen.getByText(label, { selector: '.workbench-step-label' })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: /Open your workspace/i })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('link', { name: /Browse examples/i })).toHaveAttribute('href', '/examples');
    expect(screen.getByRole('link', { name: /Profiles & dialects/i })).toHaveAttribute('href', '/language');
    expect(screen.getByRole('link', { name: /Specification/i })).toHaveAttribute('href', '/language/schemas/application');
  });
});
