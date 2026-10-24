import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiagnosticsList, type Diagnostic } from './DiagnosticsList';

const DIAGS: Diagnostic[] = [
  { severity: 'info', code: 'I1', message: 'Just so you know', resource: 'b.yaml' },
  { severity: 'error', code: 'E1', message: 'Broken thing', resource: 'b.yaml', pointer: '/a/0', hint: 'Fix it' },
  { severity: 'warning', code: 'W1', message: 'Careful', resource: 'a.yaml' },
  { severity: 'error', code: 'E2', message: 'No resource here' },
  { severity: 'error', code: 'E3', message: 'Second error', resource: 'a.yaml' },
];

const headings = () => screen.getAllByRole('heading').map((h) => h.textContent);
const codes = () => screen.getAllByRole('listitem').map((li) => li.querySelector('code')?.textContent);

describe('DiagnosticsList', () => {
  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('summarises the counts in a status region, singular and plural', () => {
    const { unmount } = render(<DiagnosticsList diagnostics={DIAGS} />);
    expect(screen.getByRole('status')).toHaveTextContent('3 errors, 1 warning, 1 info');
    unmount();

    render(<DiagnosticsList diagnostics={[DIAGS[1], DIAGS[2]]} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 error, 1 warning');
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('omits kinds with a zero count', () => {
    render(<DiagnosticsList diagnostics={[DIAGS[2], DIAGS[2]]} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('2 warnings');
    expect(status).not.toHaveTextContent(/error|info/);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('groups by resource under headings and puts those without resource under General', () => {
    render(<DiagnosticsList diagnostics={DIAGS} />);

    expect(headings()).toHaveLength(3);
    expect(headings()).toContain('a.yaml');
    const general = screen.getByRole('heading', { name: 'General' }).closest('section') as HTMLElement;
    expect(within(general).getByText('No resource here')).toBeInTheDocument();
    expect(within(general).getAllByRole('listitem')).toHaveLength(1);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('sorts error, warning, info (stable) and orders groups by first appearance after the sort', () => {
    render(<DiagnosticsList diagnostics={DIAGS} />);

    // sorted: E1(b) E2(General) E3(a) W1(a) I1(b); groups by first appearance: b, General, a
    expect(codes()).toEqual(['E1', 'I1', 'E2', 'E3', 'W1']);
    expect(headings()).toEqual(['b.yaml', 'General', 'a.yaml']);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('keeps items with the same pointer together inside a resource', () => {
    render(
      <DiagnosticsList
        diagnostics={[
          { severity: 'warning', code: 'P1a', message: 'm', resource: 'r', pointer: '/p1' },
          { severity: 'error', code: 'P2', message: 'm', resource: 'r', pointer: '/p2' },
          { severity: 'info', code: 'P1b', message: 'm', resource: 'r', pointer: '/p1' },
        ]}
      />,
    );

    // severity sort: P2, P1a, P1b -> pointer groups by first appearance: /p2, /p1
    expect(codes()).toEqual(['P2', 'P1a', 'P1b']);
    expect(screen.getAllByRole('list')).toHaveLength(1);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('orders pointer groups by worst severity and puts items without pointer in their own group', () => {
    render(
      <DiagnosticsList
        diagnostics={[
          { severity: 'info', code: 'N1', message: 'm', resource: 'r' },
          { severity: 'warning', code: 'A1', message: 'm', resource: 'r', pointer: '/a' },
          { severity: 'error', code: 'B1', message: 'm', resource: 'r', pointer: '/b' },
          { severity: 'error', code: 'N2', message: 'm', resource: 'r' },
          { severity: 'info', code: 'B2', message: 'm', resource: 'r', pointer: '/b' },
          { severity: 'warning', code: 'A2', message: 'm', resource: 'r', pointer: '/a' },
        ]}
      />,
    );

    // sorted: B1 N2 A1 A2 N1 B2 -> groups /b, none, /a
    expect(codes()).toEqual(['B1', 'B2', 'N2', 'N1', 'A1', 'A2']);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('counts several info diagnostics as "2 info"', () => {
    render(<DiagnosticsList diagnostics={[DIAGS[0], DIAGS[0]]} />);

    expect(screen.getByRole('status')).toHaveTextContent('2 info');
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('shows severity as text in a badge, the code, the message, the labelled pointer and the hint', () => {
    render(<DiagnosticsList diagnostics={[DIAGS[1], DIAGS[2]]} />);

    const [error, warning] = screen.getAllByRole('listitem');
    const badge = within(error).getByText('error');
    expect(badge).toHaveClass('badge', 'badge-error');
    expect(within(warning).getByText('warning')).toHaveClass('badge-warning');
    expect(within(error).getByText('E1').tagName).toBe('CODE');
    expect(within(error).getByText('Broken thing')).toBeInTheDocument();
    const pointer = within(error).getByText('/a/0');
    expect(pointer.tagName).toBe('CODE');
    expect(error).toHaveTextContent('Pointer');
    expect(error).toHaveTextContent('Hint: Fix it');
    expect(warning).not.toHaveTextContent(/Pointer|Hint/);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('uses the info badge variant for info', () => {
    render(<DiagnosticsList diagnostics={[DIAGS[0]]} />);

    expect(screen.getByText('info')).toHaveClass('badge-info');
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('says No diagnostics for an empty list', () => {
    render(<DiagnosticsList diagnostics={[]} />);

    expect(screen.getByText('No diagnostics')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('uses h3 headings by default and the level given by headingLevel', () => {
    const { unmount } = render(<DiagnosticsList diagnostics={DIAGS} />);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
    unmount();

    for (const level of [2, 4, 5] as const) {
      const r = render(<DiagnosticsList diagnostics={DIAGS} headingLevel={level} />);
      expect(screen.getAllByRole('heading', { level })).toHaveLength(3);
      r.unmount();
    }
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('names each group section by its heading and never renders a pre', () => {
    const { container } = render(<DiagnosticsList diagnostics={DIAGS} />);

    expect(screen.getByRole('region', { name: 'a.yaml' })).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('names sections whose resource has spaces and keeps a literal General apart', () => {
    render(
      <DiagnosticsList
        diagnostics={[
          { severity: 'error', code: 'A', message: 'm', resource: 'my file.yaml' },
          { severity: 'error', code: 'B', message: 'm', resource: 'General' },
          { severity: 'error', code: 'C', message: 'm' },
        ]}
      />,
    );

    expect(screen.getByRole('region', { name: 'my file.yaml' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'General' })).toHaveLength(2);
  });

  // [utest->req~frontend-rendering-diagnostics-list~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/DiagnosticsList.css'), 'utf8');

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
