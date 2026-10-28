import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CitationPanel } from './CitationPanel';
import { buildPanelCitation } from './citationModel';

const DIGEST = `sha256-${'ab12'.repeat(16)}`;
const BASE = { title: 'Travel booking', kindLabel: 'problem', url: 'https://openbinding.example/p/travel', year: 2026, author: 'ISA Group', version: '1.2.0' };

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe('CitationPanel', () => {
  // [utest->req~citation-panel~1]
  it('shows the digest in the DOM exactly once, and not in the citation sentence', () => {
    const { container } = render(<CitationPanel {...BASE} digest={DIGEST} />);

    expect(container.textContent?.split(DIGEST).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Copy digest' })).toHaveLength(1);
    expect(screen.getByText(/ISA Group \(2026\)\. Travel booking \(version 1\.2\.0\)\./)).toBeInTheDocument();
  });

  // [utest->req~citation-panel~1]
  it('copies the permanent link, the digest, BibTeX and CSL-JSON', async () => {
    render(<CitationPanel {...BASE} digest={DIGEST} />);
    const expected = buildPanelCitation(BASE);

    fireEvent.click(screen.getByRole('button', { name: 'Copy permanent link' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(BASE.url));
    fireEvent.click(screen.getByRole('button', { name: 'Copy digest' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(DIGEST));
    fireEvent.click(screen.getByRole('button', { name: 'Copy BibTeX' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected.bibtex));
    fireEvent.click(screen.getByRole('button', { name: 'Copy CSL-JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected.cslJson));
    fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected.text));
  });

  // [utest->req~citation-panel~1]
  it('renders with no digest when none is given', () => {
    render(<CitationPanel {...BASE} />);

    expect(screen.queryByRole('button', { name: 'Copy digest' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cite and link' })).toBeInTheDocument();
  });

  // [utest->req~citation-panel~1]
  it('announces a copy to assistive technology', async () => {
    render(<CitationPanel {...BASE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy BibTeX' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((node) => node.textContent === 'BibTeX copied')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Copy CSL-JSON' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((node) => node.textContent === 'CSL-JSON copied')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((node) => node.textContent === 'Citation text copied')).toBe(true));
  });

  // [utest->req~citation-panel~1]
  it('announces only the latest outcome, a failure replacing an earlier success', async () => {
    render(<CitationPanel {...BASE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy BibTeX' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((node) => node.textContent === 'BibTeX copied')).toBe(true));
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(screen.getAllByRole('status').some((node) => node.textContent === 'Could not copy the citation text')).toBe(true));
    expect(screen.queryByText(/BibTeX copied/)).not.toBeInTheDocument();
  });

  // [utest->req~citation-panel~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(import.meta.dirname, 'CitationPanel.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('buildPanelCitation', () => {
  // [utest->req~citation-panel~1]
  it('carries no digest in text, BibTeX or CSL-JSON', () => {
    const built = buildPanelCitation({ ...BASE });
    for (const output of [built.text, built.bibtex, built.cslJson]) expect(output).not.toMatch(/sha256|digest/i);
  });

  // [utest->req~citation-panel~1]
  it('escapes BibTeX specials in title, author, version and kind', () => {
    const { bibtex } = buildPanelCitation({ ...BASE, title: 'A_B & 50% {x} #1 $ ^ ~ \\', author: 'R&D', version: 'v_1', kindLabel: 'a_b' });

    expect(bibtex).toContain('title        = {A\\_B \\& 50\\% \\{x\\} \\#1 \\$ \\textasciicircum{} \\textasciitilde{} \\textbackslash{}}');
    expect(bibtex).toContain('author       = {R\\&D}');
    expect(bibtex).toContain('version      = {v\\_1}');
    expect(bibtex).toContain('howpublished = {OpenBinding a\\_b}');
  });

  // [utest->req~citation-panel~1]
  it('writes valid CSL-JSON of type dataset by default and document on request', () => {
    const dataset = JSON.parse(buildPanelCitation(BASE).cslJson);
    expect(dataset).toHaveLength(1);
    expect(dataset[0]).toMatchObject({ type: 'dataset', title: 'Travel booking', URL: BASE.url, version: '1.2.0', issued: { 'date-parts': [[2026]] }, author: [{ literal: 'ISA Group' }] });
    expect(JSON.parse(buildPanelCitation({ ...BASE, cslType: 'document' }).cslJson)[0].type).toBe('document');
  });

  // [utest->req~citation-panel~1]
  it('falls back to OpenBinding and n.d. and leaves out missing fields', () => {
    const built = buildPanelCitation({ title: 'T', kindLabel: 'collection', url: 'https://x.example/c' });

    expect(built.text).toBe('OpenBinding (n.d.). T. OpenBinding collection.');
    expect(built.bibtex).not.toMatch(/year|version/);
    const csl = JSON.parse(built.cslJson)[0];
    expect(csl).not.toHaveProperty('issued');
    expect(csl).not.toHaveProperty('version');
  });
});
