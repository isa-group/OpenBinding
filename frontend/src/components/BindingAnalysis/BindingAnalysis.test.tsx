import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { BindingAnalysis } from './BindingAnalysis';

it('opens the authoritative workspace for the persisted source', () => {
  render(<MemoryRouter><BindingAnalysis result={{ solutions: [{}, {}] }} jobId="job-a" /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Open analysis' })).toHaveAttribute('href', '/app/analysis?job=job-a');
  expect(screen.getByText(/2 stored results/)).toBeInTheDocument();
});
it('keeps unpersisted results inspectable without inventing a source', () => {
  render(<MemoryRouter><BindingAnalysis result={{ solutions: [] }} /></MemoryRouter>);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText(/Persist a solver job/)).toBeInTheDocument();
});
