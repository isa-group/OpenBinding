import type { Publication, Report, StudyRun } from '../../api/platform';
import type { StudyContent } from '../Project/projectModel';
import { shortDigest } from '../../utils/digest';

export type BlockKind = 'heading' | 'text' | 'evidence' | 'citation';

/** One block of a report as the editor draws it. Stored in `document.blocks`; older documents are read into the same shape. */
export interface Block {
  kind: BlockKind;
  text: string;
  /** The study run an evidence block cites. */
  runId?: string;
}

export const BLOCK_LABELS: Record<BlockKind, string> = { heading: 'Heading', text: 'Text', evidence: 'Evidence', citation: 'Citation' };

export type Doc = Record<string, unknown>;

const isRecord = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `findings` and `sections` are what older reports (and the reports started from a run) hold instead of `blocks`. */
const LEGACY_KEYS = ['sections', 'findings'] as const;

export interface ReadDocument {
  /** `blocks`: the editor's own format. `legacy`: summary, sections or findings read into blocks. `decision`: a saved binding decision. `opaque`: anything else. */
  shape: 'blocks' | 'legacy' | 'decision' | 'opaque';
  blocks: Block[];
  /** Whether the block editor can write this document back without losing anything. */
  editable: boolean;
  /** The numbers of an object-valued `summary`, drawn as facts (never edited as blocks). */
  facts: Array<[string, string]>;
}

function blockOf(value: unknown): Block | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const kind = value.type;
  if (kind !== 'heading' && kind !== 'text' && kind !== 'evidence' && kind !== 'citation') return null;
  return { kind, text: value.text, ...(typeof value.runId === 'string' ? { runId: value.runId } : {}) };
}

export function readDocument(document: Doc): ReadDocument {
  const summary = document.summary;
  const facts: Array<[string, string]> = isRecord(summary)
    ? Object.entries(summary).filter(([key]) => key !== 'conclusion').map(([key, value]): [string, string] => [key.replace(/_/g, ' '), typeof value === 'string' ? value : JSON.stringify(value)])
    : [];

  if (document.kind === 'binding-decision' && Array.isArray(document.selected)) return { shape: 'decision', blocks: [], editable: false, facts };

  if (Array.isArray(document.blocks)) {
    const blocks = document.blocks.map(blockOf);
    const ok = blocks.every((block): block is Block => block !== null);
    return { shape: ok ? 'blocks' : 'opaque', blocks: blocks.filter((block): block is Block => block !== null), editable: ok, facts };
  }

  const blocks: Block[] = [];
  let editable = true;
  if (typeof summary === 'string' && summary.trim()) blocks.push({ kind: 'text', text: summary });
  if (isRecord(summary) && typeof summary.conclusion === 'string') blocks.push({ kind: 'text', text: summary.conclusion });
  if (Array.isArray(document.sections)) {
    document.sections.forEach((section: unknown, index) => {
      if (!isRecord(section) || (section.content !== undefined && typeof section.content !== 'string') || (section.heading !== undefined && typeof section.heading !== 'string')) { editable = false; return; }
      blocks.push({ kind: 'heading', text: (section.heading as string | undefined) || `Section ${index + 1}` });
      if (section.content) blocks.push({ kind: 'text', text: section.content as string });
    });
  }
  if (Array.isArray(document.findings)) {
    for (const finding of document.findings) {
      if (typeof finding === 'string') blocks.push({ kind: 'text', text: finding });
      else editable = false;
    }
  }
  // A summary that is an object stays in the document, and its conclusion is read as text: writing blocks back would say it twice.
  if (isRecord(summary) && typeof summary.conclusion === 'string') editable = false;
  const legacy = blocks.length > 0 || LEGACY_KEYS.some((key) => key in document) || typeof summary === 'string';
  return { shape: legacy ? 'legacy' : 'blocks', blocks, editable, facts };
}

/** The document with its blocks replaced. Whatever the blocks were read from (summary text, sections, findings) goes, since it is in them now. */
export function withBlocks(document: Doc, blocks: readonly Block[]): Doc {
  const next: Doc = { ...document };
  if (typeof next.summary === 'string') delete next.summary;
  for (const key of LEGACY_KEYS) delete next[key];
  next.blocks = blocks.map((block) => ({ type: block.kind, text: block.text, ...(block.runId ? { runId: block.runId } : {}) }));
  return next;
}

export const sameDocument = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface Evidence {
  label: string;
  /** A fingerprint of the evidence, when the document names one. */
  fingerprint?: string;
  /** The study run's screen. */
  href?: string;
  /** The run's comparison charts (`study-analytics`). */
  analytics?: string;
}

/** A study run in the words of its study (`Engines × semillas · run #1`) and the screens that show it; just its short id when the run is not known. */
export function describeRun(runId: string, studies: readonly StudyContent[] | undefined, root: string): { label: string; href?: string; analytics?: string } {
  for (const { study, runs } of studies ?? []) {
    const run = runs.find((item: StudyRun) => item.id === runId);
    if (run) {
      const base = `${root}/studies/${encodeURIComponent(study.slug)}/runs/${run.id}`;
      return { label: `${study.name} · run #${run.run_number}`, href: base, analytics: `${base}/analytics` };
    }
  }
  return { label: `Study run ${runId.slice(0, 8)}…` };
}

/** What a report stands on: its pinned run, the runs its blocks cite, the datasets, software and jobs its provenance and decision name. */
export function evidenceOf(report: Pick<Report, 'study_run_id'>, document: Doc, studies: readonly StudyContent[] | undefined, root: string, blocks: readonly Block[]): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const addRun = (runId: string, fingerprint?: string) => {
    if (seen.has(runId)) return;
    seen.add(runId);
    const run = describeRun(runId, studies, root);
    out.push({ label: run.label, fingerprint, href: run.href, analytics: run.analytics });
  };
  const provenance = isRecord(document.provenance) ? document.provenance : {};
  const study = isRecord(provenance.study) ? provenance.study : {};
  if (report.study_run_id) addRun(report.study_run_id, typeof study.matrixDigest === 'string' ? `matrix ${shortDigest(study.matrixDigest)}` : undefined);
  else if (typeof study.runId === 'string') addRun(study.runId, typeof study.matrixDigest === 'string' ? `matrix ${shortDigest(study.matrixDigest)}` : undefined);
  for (const block of blocks) if (block.kind === 'evidence' && block.runId) addRun(block.runId);
  if (typeof study.reference === 'string') out.push({ label: study.reference, fingerprint: typeof study.digest === 'string' ? shortDigest(study.digest) : undefined });
  if (Array.isArray(provenance.datasets)) {
    for (const dataset of provenance.datasets) {
      if (isRecord(dataset) && typeof dataset.reference === 'string') out.push({ label: dataset.reference, fingerprint: typeof dataset.digest === 'string' ? shortDigest(dataset.digest) : undefined });
    }
  }
  if (Array.isArray(provenance.software)) {
    for (const item of provenance.software) {
      if (isRecord(item) && typeof item.name === 'string') out.push({ label: `${item.name} ${typeof item.version === 'string' ? item.version : ''}`.trim(), fingerprint: typeof item.digest === 'string' ? shortDigest(item.digest) : undefined });
    }
  }
  if (Array.isArray(document.sources)) {
    for (const source of document.sources) {
      if (isRecord(source) && typeof source.id === 'string') out.push({ label: `${typeof source.engine === 'string' ? source.engine : 'Job'} · job ${source.id.slice(0, 8)}…`, fingerprint: typeof source.resultDigest === 'string' ? shortDigest(source.resultDigest) : undefined });
    }
  }
  return out;
}

/** The publication of a report that is live (not withdrawn), if any. */
export function livePublication(report: Pick<Report, 'id'>, publications: readonly Publication[]): Publication | undefined {
  return publications.find((publication) => publication.report_id === report.id && !publication.withdrawn);
}

export function publicationsOf(report: Pick<Report, 'id'>, publications: readonly Publication[]): Publication[] {
  return publications.filter((publication) => publication.report_id === report.id);
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An address made from a title: lower case, hyphens, at most 60 characters; empty when the title has no letters or digits. */
export function slugOf(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}

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
