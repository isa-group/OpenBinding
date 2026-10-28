import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewSource } from './EngineParts';

const { saveText } = vi.hoisted(() => ({ saveText: vi.fn() }));
vi.mock('../../components/rendering/download', () => ({ saveText }));

const writeText = vi.fn();
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  saveText.mockClear();
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

/** Renders the helper and presses its summary; returns the opened `<details>`. */
function open(element: ReactElement, summary = 'View source'): HTMLDetailsElement {
  render(element);
  const disclosure = screen.getByText(summary).closest('details') as HTMLDetailsElement;
  fireEvent.click(screen.getByText(summary));
  return disclosure;
}

describe('ViewSource', () => {
  // [utest->req~frontend-engines-source-view~1]
  it('is a closed disclosure with the summary View source, and its source is not visible', () => {
    render(<ViewSource value={{ kind: 'Engine' }} />);

    const disclosure = screen.getByText('View source').closest('details') as HTMLDetailsElement;
    expect(disclosure.tagName).toBe('DETAILS');
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.getByText('View source').tagName).toBe('SUMMARY');
    const source = screen.getByRole('region', { name: 'Source document', hidden: true });
    expect(disclosure).toContainElement(source);
    expect(source).not.toBeVisible();
  });

  // [utest->req~frontend-engines-source-view~1]
  it('opens on its summary into the catalogue viewer: indented JSON, Copy, no Download without a filename', () => {
    const value = { kind: 'Engine', modes: [{ id: 'tabu' }] };
    const disclosure = open(<ViewSource value={value} />);

    expect(disclosure).toHaveAttribute('open');
    const source = screen.getByRole('region', { name: 'Source document' });
    expect(source).toBeVisible();
    expect(source).toHaveAttribute('data-language', 'json');
    expect(source.querySelector('pre code')?.textContent).toBe(JSON.stringify(value, null, 2));
    expect(within(source).getByRole('button', { name: 'Copy Source document' })).toBeInTheDocument();
    expect(within(source).queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
  });

  // [utest->req~frontend-engines-source-view~1]
  it('names the summary and the viewer after a custom label', () => {
    const disclosure = open(<ViewSource value={{ openapi: '3.1.0' }} label="Submitted OpenAPI" />, 'Submitted OpenAPI');

    expect(within(disclosure).getByRole('region', { name: 'Submitted OpenAPI' })).toBeVisible();
    expect(within(disclosure).getByRole('button', { name: 'Copy Submitted OpenAPI' })).toBeInTheDocument();
  });

  // [utest->req~frontend-engines-source-view~1]
  it('names the viewer after sourceLabel and keeps the summary', () => {
    const disclosure = open(<ViewSource value={{ a: 1 }} sourceLabel="Engine manifest source" />);

    expect(within(disclosure).getByRole('region', { name: 'Engine manifest source' })).toBeVisible();
    expect(within(disclosure).getByText('View source').tagName).toBe('SUMMARY');
  });

  // [utest->req~frontend-engines-source-view~1]
  it.each([
    ['a string', 'kind: Engine', 'kind: Engine'],
    ['a number', 3, '3'],
    ['a boolean', true, 'true'],
    ['null', null, 'null'],
  ])('shows %s as text, not as a quoted JSON document', (_name, value, text) => {
    open(<ViewSource value={value} />);

    expect(screen.getByRole('region', { name: 'Source document' }).querySelector('pre code')?.textContent).toBe(text);
  });

  // [utest->req~frontend-engines-source-view~1]
  it('says Empty for an undefined value', () => {
    open(<ViewSource value={undefined} />);

    const source = screen.getByRole('region', { name: 'Source document' });
    expect(within(source).getByText('Empty')).toBeInTheDocument();
    expect(source.querySelector('pre code')).toBeNull();
  });

  // [utest->req~frontend-engines-source-view~1]
  it('copies the text it shows', async () => {
    open(<ViewSource value={{ k: 'v' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Source document' }));

    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ k: 'v' }, null, 2));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Source document copied'));
  });

  // [utest->req~frontend-engines-source-view~1]
  it('offers a Download under the given filename: an object as application/json, a string as text/plain', () => {
    open(<ViewSource value={{ kind: 'Engine' }} filename="engine.json" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Source document' }));
    expect(saveText).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'Engine' }, null, 2), 'engine.json', 'application/json');
  });

  // [utest->req~frontend-engines-source-view~1]
  it('downloads a string value as written, as text/plain', () => {
    open(<ViewSource value={'kind: Engine'} label="Dialect" filename="dialect.yaml" />, 'Dialect');
    fireEvent.click(screen.getByRole('button', { name: 'Download Dialect' }));
    expect(saveText).toHaveBeenLastCalledWith('kind: Engine', 'dialect.yaml', 'text/plain');
  });
});
