import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { BindingAnalysis } from './BindingAnalysis';

// [utest->req~frontend-retire-no-link-to-retired~1]
it('links nowhere for the persisted source', () => {
  render(<MemoryRouter><BindingAnalysis result={{ solutions: [{}, {}] }} jobId="job-a" /></MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Open analysis' })).not.toBeInTheDocument();
  expect(screen.getByText(/2 stored results/)).toBeInTheDocument();
});
it('keeps unpersisted results inspectable without inventing a source', () => {
  render(<MemoryRouter><BindingAnalysis result={{ solutions: [] }} /></MemoryRouter>);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText(/Persist a solver job/)).toBeInTheDocument();
});
