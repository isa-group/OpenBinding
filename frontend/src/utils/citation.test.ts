import { describe, expect, it } from 'vitest';
import { buildCitation } from './citation';
import { formatBytes, formatDate, formatDateTime, yearOf } from './format';

const DIGEST = `sha256-${'e5f60718'.repeat(8)}`;
const base = {
  title: 'Engines at checkout', author: 'lucia.vega', year: 2026, kindLabel: 'report edition', digest: DIGEST, url: `https://openbinding.test/resolve/report/${DIGEST}`,
};

describe('buildCitation', () => {
  it('writes a reference from the resolved facts alone', () => {
    const { text, bibtex } = buildCitation(base);

    expect(text).toBe(`lucia.vega (2026). Engines at checkout. OpenBinding report edition, digest sha256-e5f6…0718.`);
    expect(bibtex).toBe([
      '@misc{luciavega2026enginese5f60718,',
      '  title        = {Engines at checkout},',
      '  author       = {lucia.vega},',
      '  year         = {2026},',
      '  howpublished = {OpenBinding report edition},',
      `  url          = {${base.url}},`,
      `  note         = {SHA-256 digest ${DIGEST}}`,
      '}',
    ].join('\n'));
    expect(`${text}${bibtex}`).not.toMatch(/doi|venue/i);
  });

  it('falls back to OpenBinding and "n.d." when the record names no author or date', () => {
    const { text, bibtex } = buildCitation({ ...base, author: null, year: null });

    expect(text).toContain('OpenBinding (n.d.). Engines at checkout.');
    expect(bibtex).not.toContain('year');
    expect(bibtex).toContain('author       = {OpenBinding}');
  });

  it('escapes what BibTeX would read as markup', () => {
    const { bibtex } = buildCitation({ ...base, title: 'Cost & latency: 50% of {all} $ runs_#1' });

    expect(bibtex).toContain('title        = {Cost \\& latency: 50\\% of \\{all\\} \\$ runs\\_\\#1}');
  });
});

describe('format', () => {
  it('writes dates in UTC and refuses what is not a date', () => {
    expect(formatDate('2026-09-25T23:59:00Z')).toBe('Sep 25, 2026');
    expect(formatDateTime('2026-09-25T11:55:00Z')).toBe('Sep 25, 2026, 11:55 UTC');
    expect(yearOf('2026-09-25T11:55:00Z')).toBe(2026);
    for (const value of [null, undefined, '', 'yesterday']) {
      expect(formatDate(value)).toBeNull();
      expect(formatDateTime(value)).toBeNull();
      expect(yearOf(value)).toBeNull();
    }
  });

  it('writes sizes with their exact bytes', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(20480)).toBe('20 KiB (20,480 bytes)');
    expect(formatBytes(1536)).toBe('1.5 KiB (1,536 bytes)');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MiB (5,242,880 bytes)');
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
  });
});
