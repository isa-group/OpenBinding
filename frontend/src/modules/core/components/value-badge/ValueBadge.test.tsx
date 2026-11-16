import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { originText } from './originText';
import { ValueBadge } from './ValueBadge';

const ORIGIN = {
  kind: 'package' as const,
  resource: 'catalog',
  path: 'candidates.json',
  pointer: '/spec/candidates/x/features/cost',
};

describe('ValueBadge', () => {
  it.each([
    ['verified', 'Verified'],
    ['declared', 'Declared'],
    ['unverified', 'Unverified'],
  ] as const)(
    'prints the %s status in words, with an icon that only repeats them',
    (status, words) => {
      const { container } = render(<ValueBadge status={status} />);
      expect(screen.getByText(words)).toHaveClass(`vb-status is-${status}`);
      expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  );

  it('says where a value is written', () => {
    render(<ValueBadge status="declared" origin={ORIGIN} />);
    expect(
      screen.getByText('written in candidates.json at /spec/candidates/x/features/cost')
    ).toBeInTheDocument();
    expect(originText(ORIGIN)).toBe(
      'written in candidates.json at /spec/candidates/x/features/cost'
    );
  });

  it('keeps the words of a compact origin for assistive technology and as a tooltip', () => {
    const { container } = render(<ValueBadge origin={ORIGIN} compact />);
    const words = screen.getByText(originText(ORIGIN));
    expect(words).toHaveClass('sr-only');
    expect(container.querySelector('.vb-origin')).toHaveAttribute('title', originText(ORIGIN));
  });

  it('shows nothing it was not given', () => {
    const { container } = render(<ValueBadge origin={null} />);
    expect(container.textContent).toBe('');
  });
});
