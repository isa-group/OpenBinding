import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SavedDecision } from './SavedDecision';

const snapshot = (binding: unknown) => ({
  kind: 'binding-decision',
  revision: 'revision-1',
  scope: 'stored only',
  query: { sources: ['job-a'] },
  selected: [{
    row: { id: 'sha256-1234567890abcdef', score: [0.5] },
    explanation: { formula: 'sum of priorities', components: [{ key: 'cost', value: 2, weight: 1, normalized: 0.5 }] },
    binding,
  }],
});

describe('SavedDecision', () => {
  it('shows the id of a well-formed reference', () => {
    render(<SavedDecision document={snapshot({ T1: { resource: 'service', id: 'svc-7' } })} />);

    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('svc-7')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Binding 1234567890' })).toBeInTheDocument();
  });

  it('says a malformed reference is unrecognised, never printing it as JSON', () => {
    const { container } = render(<SavedDecision document={snapshot({ T1: { resource: 'service' }, T2: 42 })} />);

    expect(screen.getAllByText('unrecognised reference')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/[{}"]/);
  });

  it('says so when the snapshot is invalid', () => {
    render(<SavedDecision document={{ kind: 'binding-decision' }} />);

    expect(screen.getByText(/invalid decision snapshot/)).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
