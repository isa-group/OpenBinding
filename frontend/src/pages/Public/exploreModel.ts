import type { EngineCatalogEntry } from '../../api/client';
import type { PublicPublication } from '../../api/platform';
import { formatDate, yearOf } from '../../utils/format';
import { isDigest, shortDigest } from '../../utils/digest';

export type ExploreTab = 'projects' | 'publications' | 'engines';

export const EXPLORE_TABS: ReadonlyArray<{ id: ExploreTab; label: string; noun: string; singular: string }> = [
  { id: 'projects', label: 'Projects', noun: 'projects', singular: 'project' },
  { id: 'publications', label: 'Publications', noun: 'publications', singular: 'publication' },
  { id: 'engines', label: 'Engines', noun: 'engines', singular: 'engine' },
];

export interface PublicProject {
  organization: { slug: string; name: string };
  project: { slug: string; name: string; description: string };
}

interface ItemBase {
  /** Unique within its tab. */
  id: string;
  /** What the organization filter groups by: the organization slug, or the engine namespace. */
  group: string;
  groupLabel: string;
  glyph: string;
  /** The small line above the title. */
  meta: string;
  title: string;
  sub: string;
  chips: string[];
}

export interface ProjectItem extends ItemBase {
  tab: 'projects';
  organization: PublicProject['organization'];
  project: PublicProject['project'];
  publications: number;
}

export interface PublicationItem extends ItemBase {
  tab: 'publications';
  authors: string | null;
  year: number | null;
  published: string | null;
  where: string;
  digest: string | null;
  citation: string;
}

export interface EngineItem extends ItemBase {
  tab: 'engines';
  ref: string;
  namespace: string;
  name: string;
  version: string;
  digest: string;
  modes: string;
  options: string;
}

export type ExploreItem = ProjectItem | PublicationItem | EngineItem;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function initialsOf(label: string): string {
  const words = label.split(/[\s._/-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : label.slice(0, 2)).toUpperCase();
}

function authorsOf(citation: Record<string, unknown>): string | null {
  const raw = citation.authors ?? citation.author;
  if (typeof raw === 'string') return text(raw);
  if (!Array.isArray(raw)) return null;
  const names = raw.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (isRecord(entry)) {
      const name = text(entry.name) ?? [text(entry.family), text(entry.given)].filter(Boolean).join(', ');
      return name ? [name] : [];
    }
    return [];
  });
  return names.length ? names.join(', ') : null;
}

/** `publications` is `null` while they are unknown (still loading, or failed): the count is left out rather than shown as 0. */
export function projectItems(projects: PublicProject[], publications: PublicPublication[] | null): ProjectItem[] {
  return projects.map(({ organization, project }) => {
    const count = publications?.filter((item) => item.organization === organization.slug && item.project === project.slug).length ?? 0;
    return {
      tab: 'projects',
      id: `${organization.slug}/${project.slug}`,
      group: organization.slug,
      groupLabel: organization.name,
      glyph: initialsOf(organization.name),
      meta: organization.name,
      title: project.name,
      sub: project.description || 'A public OpenBinding project.',
      chips: ['Public project', ...(publications ? [`${count} publication${count === 1 ? '' : 's'}`] : [])],
      organization,
      project,
      publications: count,
    };
  });
}

export function publicationItems(publications: PublicPublication[], projects: PublicProject[]): PublicationItem[] {
  return publications.map((publication, index) => {
    const citation = isRecord(publication.citation) ? publication.citation : {};
    const organizationSlug = text(publication.organization) ?? 'openbinding';
    const projectSlug = text(publication.project) ?? 'public';
    const known = projects.find((item) => item.organization.slug === organizationSlug && item.project.slug === projectSlug);
    const organizationName = known?.organization.name ?? organizationSlug;
    const where = `${organizationName} / ${known?.project.name ?? projectSlug}`;
    const title = text(publication.report?.title) ?? text(citation.title) ?? text(publication.slug) ?? `Publication ${index + 1}`;
    const authors = authorsOf(citation);
    const published = text(publication.publishedAt);
    const rawYear = Number(citation.year);
    const year = Number.isInteger(rawYear) && rawYear > 0 ? rawYear : yearOf(published);
    const digest = text(publication.report?.digest);
    const validDigest = digest && isDigest(digest) ? digest : null;
    const byline = [authors, year].filter((part) => part !== null).join(' · ');
    const publishedLabel = formatDate(published);
    return {
      tab: 'publications',
      id: text(publication.slug) ? `${organizationSlug}/${projectSlug}/${publication.slug}` : `${organizationSlug}/${projectSlug}#${index}`,
      group: organizationSlug,
      groupLabel: organizationName,
      glyph: initialsOf(organizationName),
      meta: where,
      title,
      sub: byline || text(citation.abstract) || 'Immutable report with pinned binding and engine provenance.',
      chips: ['Report edition', ...(validDigest ? [shortDigest(validDigest)] : []), ...(publishedLabel ? [publishedLabel] : [])],
      authors,
      year,
      published: publishedLabel,
      where,
      digest: validDigest,
      citation: `${authors ? `${authors} ` : ''}(${year ?? 'n.d.'}). ${title}. ${where}.`,
    };
  });
}

function optionLine(name: string, schema: unknown, required: boolean): string {
  const details: string[] = [];
  if (isRecord(schema)) {
    const unit = text(schema.unit) ?? text(schema['x-unit']);
    if (unit) details.push(unit);
    if (schema.default !== undefined && schema.default !== null) details.push(`default ${typeof schema.default === 'number' ? schema.default.toLocaleString('en-US') : String(schema.default)}`);
  }
  if (required) details.push('required');
  return details.length ? `${name} (${details.join(', ')})` : name;
}

export function engineItems(engines: EngineCatalogEntry[]): EngineItem[] {
  return engines.map((engine) => {
    const modes = engine.modes ?? [];
    const options = [...new Set(modes.flatMap((mode) => {
      const properties = mode.optionsSchema?.properties ?? {};
      return Object.entries(properties).map(([name, schema]) => optionLine(name, schema, Boolean(mode.optionsSchema?.required?.includes(name))));
    }))];
    const modeIds = modes.map((mode) => mode.id);
    return {
      tab: 'engines',
      id: `${engine.namespace}/${engine.name}@${engine.version}`,
      group: engine.namespace,
      groupLabel: engine.namespace,
      glyph: initialsOf(engine.name),
      meta: engine.namespace,
      title: `${engine.name} ${engine.version}`,
      sub: modeIds.length ? `Mode${modeIds.length === 1 ? '' : 's'}: ${modeIds.join(', ')}` : 'No modes advertised',
      chips: ['Public', shortDigest(engine.digest)],
      ref: `${engine.namespace}/${engine.name}@${engine.version}`,
      namespace: engine.namespace,
      name: engine.name,
      version: engine.version,
      digest: engine.digest,
      modes: modeIds.join(', ') || 'None advertised',
      options: options.length ? options.join('; ') : 'No caller options',
    };
  });
}

export function searchText(item: ExploreItem): string {
  return `${item.title} ${item.sub} ${item.meta} ${item.groupLabel}`.toLowerCase();
}
