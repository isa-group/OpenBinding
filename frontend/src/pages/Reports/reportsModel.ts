export interface CitationFields {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
}

/** What a publication's citation says, read defensively: the publisher recorded it, so every field may be missing. */
export function citationFields(citation: Record<string, unknown> | null | undefined, fallbackTitle: string): CitationFields {
  const record = citation ?? {};
  const authors = Array.isArray(record.authors) ? record.authors.filter((author): author is string => typeof author === 'string' && author.trim() !== '') : typeof record.authors === 'string' ? record.authors.split(',').map((author) => author.trim()).filter(Boolean) : [];
  return {
    title: typeof record.title === 'string' && record.title ? record.title : fallbackTitle,
    authors,
    year: typeof record.year === 'number' ? record.year : null,
    venue: typeof record.venue === 'string' && record.venue ? record.venue : null,
    doi: typeof record.doi === 'string' && record.doi ? record.doi : null,
  };
}

/** `Vega, L. (2026). Title. Venue. https://doi.org/…`, from what the publisher recorded and nothing else. */
export function citationText(fields: CitationFields): string {
  const who = fields.authors.length ? fields.authors.join(', ') : 'OpenBinding';
  const doi = fields.doi ? (/^https?:/.test(fields.doi) ? fields.doi : `https://doi.org/${fields.doi}`) : '';
  return `${who} (${fields.year ?? 'n.d.'}). ${fields.title}.${fields.venue ? ` ${fields.venue}.` : ' OpenBinding.'}${doi ? ` ${doi}` : ''}`;
}

const BIBTEX_SPECIALS = /[\\{}&%$#_^~]/g;
const escapeBibtex = (value: string) => value.replace(BIBTEX_SPECIALS, (character) => `\\${character}`);

export function citationBibtex(fields: CitationFields, slug: string, url?: string): string {
  const key = `${(fields.authors[0] ?? 'openbinding').toLowerCase().replace(/[^a-z0-9]+/g, '')}${fields.year ?? ''}${slug.replace(/[^a-z0-9]+/g, '')}`;
  const lines = [
    `  title        = {${escapeBibtex(fields.title)}}`,
    `  author       = {${escapeBibtex(fields.authors.length ? fields.authors.join(' and ') : 'OpenBinding')}}`,
    ...(fields.year === null ? [] : [`  year         = {${fields.year}}`]),
    `  howpublished = {${escapeBibtex(fields.venue ?? 'OpenBinding')}}`,
    ...(fields.doi ? [`  doi          = {${escapeBibtex(fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, ''))}}`] : []),
    ...(url ? [`  url          = {${url}}`] : []),
  ];
  return `@misc{${key},\n${lines.join(',\n')}\n}`;
}
