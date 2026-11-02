export interface CitationInput {
  title: string;
  kindLabel: string;
  /** The permanent link, by name (slug or permanent id): a link that embeds a digest would show the digest outside its one field. */
  url: string;
  year?: number | null;
  author?: string | null;
  version?: string | null;
  /** `dataset` (the default) or `document`. */
  cslType?: 'dataset' | 'document';
}

export interface BuiltCitation {
  /** The sentence to cite: names, version and year; never a digest. */
  text: string;
  bibtex: string;
  /** CSL-JSON, serialised. */
  cslJson: string;
}

const BIBTEX_SPECIALS = /[\\{}&%$#_^~]/g;

/** Escape what BibTeX would read as markup. */
export function escapeBibtex(value: string): string {
  return value.replace(BIBTEX_SPECIALS, (character) => {
    if (character === '\\') return '\\textbackslash{}';
    if (character === '^') return '\\textasciicircum{}';
    if (character === '~') return '\\textasciitilde{}';
    return `\\${character}`;
  });
}

function citeKey(source: CitationInput): string {
  const author = (source.author ?? 'openbinding').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'openbinding';
  const word = source.title.toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(/\s+/).find(Boolean) ?? 'record';
  return `${author}${source.year ?? ''}${word}`;
}

// [impl->req~citation-panel~1]
export function buildPanelCitation(source: CitationInput): BuiltCitation {
  const author = source.author?.trim() || 'OpenBinding';
  const year = source.year == null ? null : source.year;
  const version = source.version?.trim() || null;
  const text = `${author} (${year ?? 'n.d.'}). ${source.title}${version ? ` (version ${version})` : ''}. OpenBinding ${source.kindLabel}.`;

  const fields = [
    `  title        = {${escapeBibtex(source.title)}}`,
    `  author       = {${escapeBibtex(author)}}`,
    ...(year === null ? [] : [`  year         = {${year}}`]),
    ...(version ? [`  version      = {${escapeBibtex(version)}}`] : []),
    `  howpublished = {OpenBinding ${escapeBibtex(source.kindLabel)}}`,
    `  url          = {${source.url}}`,
  ];
  const bibtex = `@misc{${citeKey(source)},\n${fields.join(',\n')}\n}`;

  const csl: Record<string, unknown> = {
    id: citeKey(source),
    type: source.cslType ?? 'dataset',
    title: source.title,
    author: [{ literal: author }],
    publisher: 'OpenBinding',
    genre: source.kindLabel,
    URL: source.url,
  };
  if (year !== null) csl.issued = { 'date-parts': [[year]] };
  if (version) csl.version = version;
  return { text, bibtex, cslJson: JSON.stringify([csl], null, 2) };
}
