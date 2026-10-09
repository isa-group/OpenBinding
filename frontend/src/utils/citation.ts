import { shortDigest } from './digest';

export interface CitationSource {
  title: string;
  /** Who made it; `null` when the record does not say. */
  author: string | null;
  year: number | null;
  /** What it is, in the reader's words: `report`, `engine`… */
  kindLabel: string;
  digest: string;
  /** Absolute address that resolves the digest. */
  url: string;
}

export interface Citation {
  text: string;
  bibtex: string;
}

const BIBTEX_SPECIALS = /[\\{}&%$#_^~]/g;

/** Escape what BibTeX would read as markup. */
function escapeBibtex(value: string): string {
  return value.replace(BIBTEX_SPECIALS, (character) => {
    if (character === '\\') return '\\textbackslash{}';
    if (character === '^') return '\\textasciicircum{}';
    if (character === '~') return '\\textasciitilde{}';
    return `\\${character}`;
  });
}

function citeKey(source: CitationSource): string {
  const author = (source.author ?? 'openbinding').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const word = source.title.toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(/\s+/).find(Boolean) ?? 'record';
  const suffix = source.digest.replace(/^sha256-/, '').slice(0, 8);
  return `${author || 'openbinding'}${source.year ?? ''}${word}${suffix}`;
}

/**
 * A reference for an element that has been resolved, written from what the resolver
 * returned. It carries no DOI or venue: those would be inventions.
 */
export function buildCitation(source: CitationSource): Citation {
  const author = source.author ?? 'OpenBinding';
  const year = source.year === null ? 'n.d.' : String(source.year);
  const text = `${author} (${year}). ${source.title}. OpenBinding ${source.kindLabel}, digest ${shortDigest(source.digest)}.`;
  const fields = [
    `  title        = {${escapeBibtex(source.title)}}`,
    `  author       = {${escapeBibtex(author)}}`,
    ...(source.year === null ? [] : [`  year         = {${source.year}}`]),
    `  howpublished = {OpenBinding ${escapeBibtex(source.kindLabel)}}`,
    `  url          = {${source.url}}`,
    `  note         = {SHA-256 digest ${source.digest}}`,
  ];
  return { text, bibtex: `@misc{${citeKey(source)},\n${fields.join(',\n')}\n}` };
}
