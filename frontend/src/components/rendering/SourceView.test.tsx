import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceView } from './SourceView';

const writeText = vi.fn();
const createObjectURL = vi.fn(() => 'blob:test');
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

describe('SourceView', () => {
  // [utest->req~frontend-rendering-source-view~1]
  it('shows a string source as is, keeping its line breaks, in a region named by the label', () => {
    render(<SourceView source={'line one\nline two'} label="BIM source" />);

    const region = screen.getByRole('region', { name: 'BIM source' });
    const pre = region.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('line one\nline two');
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('pretty-prints an object source as JSON with two spaces', () => {
    const source = { a: 1, nested: { b: [true] } };
    render(<SourceView source={source} label="Problem" />);

    expect(document.querySelector('pre code')?.textContent).toBe(JSON.stringify(source, null, 2));
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('says Empty for an empty source and offers nothing to show', () => {
    render(<SourceView source="" label="Problem" />);

    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(document.querySelector('pre code')).toBeNull();
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('exposes the language as a data attribute', () => {
    render(<SourceView source="x" label="Problem" language="json" />);

    expect(screen.getByRole('region', { name: 'Problem' })).toHaveAttribute('data-language', 'json');
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('copies the full text and announces it in a status region', async () => {
    render(<SourceView source={{ k: 'v' }} label="Problem" />);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Problem' }));

    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ k: 'v' }, null, 2));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Problem copied'));
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<SourceView source="x" label="Problem" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Problem' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not copy the Problem'));
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('offers no download without a filename', () => {
    render(<SourceView source="x" label="Problem" />);

    expect(screen.queryByRole('button', { name: 'Download Problem' })).not.toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('downloads a text source as text/plain through a temporary anchor and revokes the URL later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    render(<SourceView source="plain" label="Problem" filename="problem.txt" />);

    fireEvent.click(screen.getByRole('button', { name: 'Download Problem' }));

    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('text/plain');
    expect(await readBlob(blob)).toBe('plain');
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(anchorClick.mock.invocationCallOrder[0]).toBeLessThan(revokeObjectURL.mock.invocationCallOrder[0]);
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('downloads an object source as pretty-printed application/json', async () => {
    render(<SourceView source={{ a: 1 }} label="Problem" filename="problem.json" />);

    fireEvent.click(screen.getByRole('button', { name: 'Download Problem' }));

    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('application/json');
    expect(await readBlob(blob)).toBe(JSON.stringify({ a: 1 }, null, 2));
    const anchor = anchorClick.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('problem.json');
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('is reachable by keyboard: a focusable pre and buttons that are not removed from the tab order', () => {
    render(<SourceView source="x" label="Problem" filename="p.txt" />);

    const pre = document.querySelector('pre') as HTMLElement;
    expect(pre).toHaveAttribute('tabindex', '0');
    for (const name of ['Copy Problem', 'Download Problem']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('tabindex', '-1');
    }
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('does not rely on colour alone: the copy outcome is also text', async () => {
    render(<SourceView source="x" label="Problem" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Problem' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Problem' })).toHaveTextContent('Copied'));
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('applies maxHeight to the scrolling area', () => {
    render(<SourceView source="x" label="Problem" maxHeight="10rem" />);

    expect(document.querySelector('pre')?.getAttribute('style')).toContain('max-height: 10rem');
  });

  // [utest->req~frontend-rendering-source-view~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/SourceView.css'), 'utf8');

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
