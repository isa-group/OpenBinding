import { describe, expect, it } from 'vitest';
import { citationBibtex, citationFields, citationText } from './reportsModel';

describe('publications and citations', () => {
  it('writes the citation from what the publisher recorded and invents nothing', () => {
    const fields = citationFields({ title: 'A study', authors: ['Vega, L.', 'Díaz, M.'], year: 2026, doi: '10.1000/xyz' }, 'fallback');
    expect(citationText(fields)).toBe('Vega, L., Díaz, M. (2026). A study. OpenBinding. https://doi.org/10.1000/xyz');
    expect(citationText(citationFields(null, 'Fallback title'))).toBe('OpenBinding (n.d.). Fallback title. OpenBinding.');
    expect(citationFields({ authors: 'A, B' }, 't').authors).toEqual(['A', 'B']);
  });

  it('escapes what BibTeX reads as markup and keeps the DOI bare', () => {
    const bibtex = citationBibtex(citationFields({ title: 'R&D_100', authors: ['Vega'], year: 2026, doi: 'https://doi.org/10.1000/xyz' }, 't'), 'rd', 'https://x.test/resolve/report/sha256-e');
    expect(bibtex).toMatch(/title\s+= \{R\\&D\\_100\}/);
    expect(bibtex).toMatch(/doi\s+= \{10\.1000\/xyz\}/);
    expect(bibtex).toMatch(/url\s+= \{https:\/\/x\.test\/resolve\/report\/sha256-e\}/);
    expect(bibtex.startsWith('@misc{vega2026rd,')).toBe(true);
  });
});
