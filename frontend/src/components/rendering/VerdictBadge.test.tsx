import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerdictBadge } from './VerdictBadge';

const CASES = [
  ['OPTIMAL', 'success', 'proven best combination'],
  ['FEASIBLE', 'info', 'a valid combination, not proven best'],
  ['UNSAT', 'error', 'no combination satisfies the rules'],
  ['TIMEOUT', 'warning', 'stopped at the time budget'],
  ['INCOMPATIBLE', 'default', 'the engine cannot solve this problem'],
] as const;

describe('VerdictBadge', () => {
  // [utest->req~frontend-rendering-verdict-badge~1]
  it.each(CASES)('shows %s as text in the %s badge variant', (verdict, variant) => {
    render(<VerdictBadge verdict={verdict} />);

    expect(screen.getByText(verdict)).toHaveClass('badge', `badge-${variant}`);
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it.each(CASES)('describes %s in plain language through aria-describedby', (verdict, _variant, description) => {
    render(<VerdictBadge verdict={verdict} />);

    const wrapper = screen.getByText(verdict).parentElement as HTMLElement;
    const id = wrapper.getAttribute('aria-describedby') as string;
    expect(id).toBeTruthy();
    const target = document.getElementById(id) as HTMLElement;
    expect(target).toHaveTextContent(description);
    expect(target).toHaveClass('sr-only');
    expect(wrapper).toHaveAccessibleDescription(description);
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('gives every instance its own description id', () => {
    render(<><VerdictBadge verdict="OPTIMAL" /><VerdictBadge verdict="OPTIMAL" /></>);

    const [a, b] = screen.getAllByText('OPTIMAL');
    expect(a.parentElement?.getAttribute('aria-describedby')).not.toBe(b.parentElement?.getAttribute('aria-describedby'));
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('renders an unknown verdict neutral, with its own text and no description', () => {
    render(<VerdictBadge verdict="WEIRD" />);

    const badge = screen.getByText('WEIRD');
    expect(badge).toHaveClass('badge-default');
    expect(badge.closest('[aria-describedby]')).toBeNull();
    expect(document.querySelector('.sr-only')).toBeNull();
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('uses the small size by default and the medium size on request', () => {
    const { unmount } = render(<VerdictBadge verdict="OPTIMAL" />);
    expect(screen.getByText('OPTIMAL')).toHaveClass('badge-sm');
    unmount();

    render(<VerdictBadge verdict="OPTIMAL" size="md" />);
    expect(screen.getByText('OPTIMAL')).toHaveClass('badge-md');
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('renders no reasons list when reasons are absent or empty', () => {
    const { unmount } = render(<VerdictBadge verdict="UNSAT" />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    unmount();

    render(<VerdictBadge verdict="UNSAT" reasons={[]} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('lists the reasons in a list named Reasons after the badge', () => {
    const { container } = render(<VerdictBadge verdict="UNSAT" reasons={['Budget too low', 'No engine']} />);

    const list = screen.getByRole('list', { name: 'Reasons' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Budget too low', 'No engine']);
    const badge = screen.getByText('UNSAT');
    expect(badge.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('carries the verdict in text, not only in colour', () => {
    render(<VerdictBadge verdict="TIMEOUT" />);

    expect(screen.getByText('TIMEOUT').textContent).toBe('TIMEOUT');
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/VerdictBadge.css'), 'utf8');

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
