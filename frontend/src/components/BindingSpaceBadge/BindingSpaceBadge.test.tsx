import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BindingSpaceBadge } from './BindingSpaceBadge';
import { parseBindingSpace } from './bindingSpace';

describe('parseBindingSpace', () => {
  it('handles micro / trivial space sizes', () => {
    const res = parseBindingSpace('42');
    expect(res.tier).toBe('micro');
    expect(res.tierLabel).toBe('Trivial');
    expect(res.formatted).toBe('42');
    expect(res.exact).toBe('42');
    expect(res.dots).toBe(1);
  });

  it('handles small / exhaustive space sizes', () => {
    const res = parseBindingSpace('1024');
    expect(res.tier).toBe('small');
    expect(res.tierLabel).toBe('Exhaustive');
    expect(res.formatted).toBe('1,024');
    expect(res.exact).toBe('1,024');
    expect(res.dots).toBe(2);
  });

  it('handles medium / moderate space sizes with k and M', () => {
    const resK = parseBindingSpace('25000');
    expect(resK.formatted).toBe('25.0k');
    expect(resK.exact).toBe('25,000');

    const resM = parseBindingSpace('8640000');
    expect(resM.tier).toBe('medium');
    expect(resM.tierLabel).toBe('Moderate');
    expect(resM.formatted).toBe('8.64M');
    expect(resM.exact).toBe('8,640,000');
    expect(resM.dots).toBe(3);
  });

  it('handles large / complex space sizes in billions', () => {
    const resB = parseBindingSpace('12500000000');
    expect(resB.tier).toBe('large');
    expect(resB.tierLabel).toBe('Complex');
    expect(resB.formatted).toBe('12.50B');
    expect(resB.dots).toBe(4);
  });

  it('handles massive space sizes beyond trillions with scientific notation', () => {
    const resMassive = parseBindingSpace('100000000000000000000'); // 10^20
    expect(resMassive.tier).toBe('massive');
    expect(resMassive.tierLabel).toBe('Massive');
    expect(resMassive.formatted).toContain('× 10²⁰');
    expect(resMassive.dots).toBe(4);
  });

  it('handles invalid or empty strings gracefully without crashing', () => {
    const res = parseBindingSpace('');
    expect(res.tier).toBe('micro');
    expect(res.exact).toBe('1');
  });
});

describe('BindingSpaceBadge Component', () => {
  it('renders badge variant with label, value, and meter dots', () => {
    render(<BindingSpaceBadge cardinality="8640000" />);
    const badge = screen.getByRole('status', { name: /Binding space size: 8\.64M combinations/i });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('tier-medium');
    expect(screen.getByText('8.64M')).toBeInTheDocument();
    expect(screen.getByText('8,640,000 combinations')).toBeInTheDocument();
  });

  it('renders card variant with structured details', () => {
    render(<BindingSpaceBadge cardinality="100000000000000000000" variant="card" />);
    const card = screen.getByRole('article');
    expect(card).toBeInTheDocument();
    expect(card).toHaveClass('tier-massive');
    expect(screen.getAllByText('Binding Space').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Massive')).toBeInTheDocument();
  });
});
