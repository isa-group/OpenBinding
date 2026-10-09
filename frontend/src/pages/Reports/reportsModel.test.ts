import { describe, expect, it } from 'vitest';
import { RUN_ID, runFixture, studyFixture } from '../Studies/fixtures';
import { DRAFT, FROZEN, LEGACY, publicationOf } from './fixtures';
import {
  citationBibtex, citationFields, citationText, describeRun, evidenceOf, livePublication, publicationsOf, readDocument, sameDocument, slugOf, withBlocks,
} from './reportsModel';

const ROOT = '/app/isa-demo/qos-benchmarks';
const studies = [{ study: studyFixture(), runs: [runFixture()] }];

describe('reading a report’s document as blocks', () => {
  it('reads the editor’s own format', () => {
    const read = readDocument(FROZEN.document);
    expect(read.shape).toBe('blocks');
    expect(read.editable).toBe(true);
    expect(read.blocks.map((block) => block.kind)).toEqual(['heading', 'text', 'evidence']);
    expect(read.blocks[2].runId).toBe(RUN_ID);
  });

  it('reads the summary, sections and findings older reports hold', () => {
    const read = readDocument({ summary: 'A conclusion.', sections: [{ heading: 'Setup', content: 'Two engines.' }, { content: 'No heading' }], findings: ['Cheaper', 'Slower'] });
    expect(read.shape).toBe('legacy');
    expect(read.blocks).toEqual([
      { kind: 'text', text: 'A conclusion.' },
      { kind: 'heading', text: 'Setup' }, { kind: 'text', text: 'Two engines.' },
      { kind: 'heading', text: 'Section 2' }, { kind: 'text', text: 'No heading' },
      { kind: 'text', text: 'Cheaper' }, { kind: 'text', text: 'Slower' },
    ]);
    expect(read.editable).toBe(true);
  });

  it('shows the numbers of an object summary as facts, and does not offer to rewrite a conclusion that lives in it', () => {
    const read = readDocument({ summary: { conclusion: 'MiniZinc wins.', total_cells: 4 } });
    expect(read.facts).toEqual([['total cells', '4']]);
    expect(read.blocks).toEqual([{ kind: 'text', text: 'MiniZinc wins.' }]);
    expect(read.editable).toBe(false);
  });

  it('refuses to edit blocks it cannot read back, and a decision snapshot', () => {
    expect(readDocument({ blocks: [{ type: 'hologram', text: 'x' }] })).toMatchObject({ shape: 'opaque', editable: false });
    expect(readDocument({ kind: 'binding-decision', selected: [] })).toMatchObject({ shape: 'decision', editable: false });
    expect(readDocument({ findings: [{ claim: 'object findings' }] }).editable).toBe(false);
  });

  it('treats an empty document as an empty report that can be written', () => {
    expect(readDocument({})).toMatchObject({ shape: 'blocks', blocks: [], editable: true });
  });

  it('writes blocks back without losing what is not text', () => {
    const next = withBlocks(LEGACY.document, [{ kind: 'text', text: 'Rewritten' }]);
    expect(next).toEqual({ provenance: {}, blocks: [{ type: 'text', text: 'Rewritten' }] });
    expect(sameDocument(next, LEGACY.document)).toBe(false);
    expect(sameDocument(readDocument(next).blocks, [{ kind: 'text', text: 'Rewritten' }])).toBe(true);
    expect(withBlocks({ summary: { total_cells: 4 } }, []).summary).toEqual({ total_cells: 4 });
  });
});

describe('the evidence a report stands on', () => {
  it('names the pinned run in the words of its study and links the screens that show it', () => {
    const run = describeRun(RUN_ID, studies, ROOT);
    expect(run.label).toBe('Engines × semillas · run #1');
    expect(run.href).toBe(`${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}`);
    expect(run.analytics).toBe(`${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}/analytics`);
    expect(describeRun('ffffffff-0000', studies, ROOT)).toEqual({ label: 'Study run ffffffff…' });
  });

  it('lists the run once, then datasets and software from the provenance', () => {
    const read = readDocument(FROZEN.document);
    const evidence = evidenceOf(FROZEN, FROZEN.document, studies, ROOT, read.blocks);
    expect(evidence.map((item) => item.label)).toEqual(['Engines × semillas · run #1', 'checkout-flow@2', 'bim-reference-evaluator 1.0.0']);
    expect(evidence[0].fingerprint).toBe('matrix sha256-dddd…dddd');
    expect(evidence[1].fingerprint).toBe('sha256-aaaa…aaaa');
  });

  it('lists the jobs a decision snapshot records', () => {
    const evidence = evidenceOf(DRAFT, { kind: 'binding-decision', sources: [{ id: 'f1a1b2c3-0000', engine: 'random-search', resultDigest: `sha256-${'f'.repeat(64)}` }] }, undefined, ROOT, []);
    expect(evidence).toEqual([{ label: 'random-search · job f1a1b2c3…', fingerprint: 'sha256-ffff…ffff' }]);
  });
});

describe('publications and citations', () => {
  it('finds the live publication of a report, and its history', () => {
    const live = publicationOf(FROZEN);
    const withdrawn = publicationOf(FROZEN, { id: 'pub-old', slug: 'old', withdrawn: true });
    expect(livePublication(FROZEN, [withdrawn, live])).toBe(live);
    expect(livePublication(FROZEN, [withdrawn])).toBeUndefined();
    expect(publicationsOf(FROZEN, [withdrawn, live, publicationOf(DRAFT)])).toHaveLength(2);
  });

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

describe('an address from a title', () => {
  it('lower-cases, drops accents and hyphenates', () => {
    expect(slugOf('Comparativa de engines — checkout (v2)')).toBe('comparativa-de-engines-checkout-v2');
    expect(slugOf('Análisis ñandú')).toBe('analisis-nandu');
    expect(slugOf('!!!')).toBe('');
    expect(slugOf('a'.repeat(80))).toHaveLength(60);
  });
});
