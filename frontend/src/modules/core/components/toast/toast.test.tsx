import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ToastItem from '.';

describe('a toast', () => {
  it('leads where its notification does when it is given a page', () => {
    render(
      <MemoryRouter>
        <ToastItem
          toast={{
            id: 't1',
            notification: {
              kind: 'UpstreamEvent',
              title: 'brevo 2026-11: TomatoMeter values changed',
              message: 'brevo 2026-11 changes tomatometer 1.0.0 (in effect in production)',
              to: '/compositions/fixtures/tomatometer/operation?event=e1',
            },
          }}
          onRemove={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(
      screen.getByRole('link', { name: 'brevo 2026-11: TomatoMeter values changed' })
    ).toHaveAttribute('href', '/compositions/fixtures/tomatometer/operation?event=e1');
  });

  it('is plain text without one', () => {
    render(
      <ToastItem
        toast={{ id: 't2', notification: { kind: 'System', title: 'Saved.' } }}
        onRemove={vi.fn()}
      />
    );
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
