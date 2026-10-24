import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogPanel } from './LogPanel';

const LOG = 'start job\nsolver Alpha ready\nERROR boom\nsolver beta done';
const writeText = vi.fn();
const createObjectURL = vi.fn(() => 'blob:log');
const revokeObjectURL = vi.fn();
let anchorClick: ReturnType<typeof vi.spyOn>;
let originalClipboard: PropertyDescriptor | undefined;
let originalCreate: PropertyDescriptor | undefined;
let originalRevoke: PropertyDescriptor | undefined;

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined) => {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
};

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  anchorClick.mockRestore();
  vi.useRealTimers();
  restore(navigator, 'clipboard', originalClipboard);
  restore(URL, 'createObjectURL', originalCreate);
  restore(URL, 'revokeObjectURL', originalRevoke);
});

const details = () => document.querySelector('details') as HTMLDetailsElement;

describe('LogPanel', () => {
  // [utest->req~frontend-rendering-log-panel~1]
  it('is collapsed by default and open with defaultOpen', () => {
    const { unmount } = render(<LogPanel log={LOG} />);
    expect(details().open).toBe(false);
    unmount();

    render(<LogPanel log={LOG} defaultOpen />);
    expect(details().open).toBe(true);
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('summarises the title and the line count, singular for one line', () => {
    const { unmount } = render(<LogPanel log={LOG} />);
    expect(screen.getByText('Log (4 lines)')).toBeInTheDocument();
    unmount();

    const one = render(<LogPanel log="only" title="Solver output" />);
    expect(screen.getByText('Solver output (1 line)')).toBeInTheDocument();
    one.unmount();

    render(<LogPanel log="" />);
    expect(screen.getByText('Log (0 lines)')).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('shows No log for an empty log', () => {
    render(<LogPanel log="" defaultOpen />);

    expect(screen.getByText('No log')).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('shows every line with its number in a pre named by the title', () => {
    render(<LogPanel log={LOG} title="Run log" defaultOpen />);

    const pre = screen.getByLabelText('Run log');
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveTextContent('solver Alpha ready');
    expect([...pre.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'))).toEqual(['1', '2', '3', '4']);
    expect(screen.getByRole('status')).toHaveTextContent('4 of 4 lines');
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('filters case-insensitively, keeps the original line numbers and updates the status', () => {
    render(<LogPanel log={LOG} defaultOpen />);
    const input = screen.getByLabelText('Search the log');

    fireEvent.change(input, { target: { value: 'SOLVER' } });

    const pre = screen.getByLabelText('Log');
    expect(pre).toHaveTextContent('solver Alpha ready');
    expect(pre).toHaveTextContent('solver beta done');
    expect(pre).not.toHaveTextContent('ERROR boom');
    expect(pre.querySelector('[data-line="4"]')).not.toBeNull();
    expect(pre.querySelector('[data-line="3"]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 4 lines');

    fireEvent.change(input, { target: { value: 'error' } });
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4 lines');
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('says No lines match when nothing matches', () => {
    render(<LogPanel log={LOG} defaultOpen />);

    fireEvent.change(screen.getByLabelText('Search the log'), { target: { value: 'zzz' } });

    expect(screen.getByText('No lines match')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 of 4 lines');
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('copies the whole log, not the filtered view, and announces it', async () => {
    render(<LogPanel log={LOG} defaultOpen />);
    fireEvent.change(screen.getByLabelText('Search the log'), { target: { value: 'error' } });

    fireEvent.click(screen.getByRole('button', { name: /^Copy/ }));

    expect(writeText).toHaveBeenCalledWith(LOG);
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => /copied/i.test(s.textContent ?? ''))).toBe(true));
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('shows Download only with a filename and downloads the whole log as text, revoking the URL later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { unmount } = render(<LogPanel log={LOG} defaultOpen />);
    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
    unmount();

    render(<LogPanel log={LOG} defaultOpen filename="run.log" />);
    fireEvent.change(screen.getByLabelText('Search the log'), { target: { value: 'error' } });
    fireEvent.click(screen.getByRole('button', { name: /^Download/ }));

    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('text/plain');
    expect(await readBlob(blob)).toBe(LOG);
    expect((anchorClick.mock.contexts[0] as HTMLAnchorElement).download).toBe('run.log');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:log');
    expect(anchorClick.mock.invocationCallOrder[0]).toBeLessThan(revokeObjectURL.mock.invocationCallOrder[0]);
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('keeps the log pre in the tab order', () => {
    render(<LogPanel log={LOG} defaultOpen filename="run.log" />);

    expect(screen.getByLabelText('Log')).toHaveAttribute('tabindex', '0');
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('says "1 of 1 line" for a single line', () => {
    render(<LogPanel log="only" defaultOpen />);

    expect(screen.getByRole('status')).toHaveTextContent(/^1 of 1 line$/);
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('shows the line numbers as text, original ones after filtering', () => {
    render(<LogPanel log={LOG} defaultOpen />);
    const nums = () => [...document.querySelectorAll('.rendering-log__num')].map((n) => n.textContent);

    expect(nums()).toEqual(['1', '2', '3', '4']);
    fireEvent.change(screen.getByLabelText('Search the log'), { target: { value: 'solver' } });
    expect(nums()).toEqual(['2', '4']);
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('lets long lines scroll instead of breaking the layout', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/LogPanel.css'), 'utf8');

    expect(css).toMatch(/overflow:\s*auto/);
  });

  // [utest->req~frontend-rendering-log-panel~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/LogPanel.css'), 'utf8');

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
