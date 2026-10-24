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
  it.each(CASES)('reads %s followed by its plain-language description, visually hidden', (verdict, _variant, description) => {
    const { container } = render(<VerdictBadge verdict={verdict} />);

    const wrapper = screen.getByText(verdict).parentElement as HTMLElement;
    expect(wrapper).not.toHaveAttribute('aria-describedby');
    expect(wrapper.textContent).toBe(`${verdict}, ${description}`);
    const hidden = container.querySelector('.sr-only') as HTMLElement;
    expect(hidden.textContent).toBe(`, ${description}`);
    expect(wrapper).toContainElement(hidden);
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('uses a div as outer element so the reasons list is not inside a span', () => {
    const { container } = render(<VerdictBadge verdict="UNSAT" reasons={['x']} />);

    expect((container.firstElementChild as HTMLElement).tagName).toBe('DIV');
  });

  // [utest->req~frontend-rendering-verdict-badge~1]
  it('renders an unknown verdict neutral, with its own text and no description', () => {
    const { container } = render(<VerdictBadge verdict="WEIRD" />);

    const badge = screen.getByText('WEIRD');
    expect(badge).toHaveClass('badge-default');
    expect(badge.parentElement?.textContent).toBe('WEIRD');
    expect(container.querySelector('.sr-only')).toBeNull();
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
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/VerdictBadge.css'), 'utf8');

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
