import type {
  CapabilitySelector,
  EngineCatalogEntry,
  EngineMode,
  EngineRegistrationRevision,
} from '../../api/client';
import type { EngineRevision } from '../../api/platform';
import { shortDigest } from '../../utils/digest';

export const BUILTIN_NAMESPACE = 'bim.builtin';

export type Visibility = 'public' | 'private';
export type Publication = 'published' | 'in review' | 'rejected' | 'not requested';

export interface EngineRow {
  key: string;
  engine: EngineCatalogEntry;
  /** What the family filter groups by: the engine's name for built-ins, `federated` for everything else. */
  family: string;
  familyLabel: string;
  visibility: Visibility;
  publication: Publication;
  /** True for a private engine that belongs to the signed-in account. */
  yours: boolean;
  chips: string[];
  href: string;
}

export interface ModeRow {
  /** Unique across the catalog: engine reference plus mode id. */
  id: string;
  engineKey: string;
  label: string;
  placement: string;
  irExtensions: string;
  options: string;
}

export function engineKey(engine: EngineCatalogEntry): string {
  return `${engine.namespace}/${engine.name}@${engine.version}`;
}

export function engineHref(ref: { namespace: string; name: string; version: string }): string {
  return `/engines/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}/${encodeURIComponent(ref.version)}`;
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** `Not declared` when the engine's contract does not list the dimension; the others as the selector spells them. */
export function selectorText(selector: CapabilitySelector | undefined): string {
  if (!selector) return 'Not declared';
  if (selector.selector === 'none') return 'none';
  if (selector.selector === 'all') return 'all';
  return selector.values?.join(', ') || 'none listed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OptionFact {
  name: string;
  unit: string | null;
  default: number | string | boolean | null;
  required: boolean;
  type: string | null;
}

/** The caller options a mode declares, with the unit and default its schema gives them. */
export function optionFacts(mode: EngineMode): OptionFact[] {
  const properties = mode.optionsSchema?.properties ?? {};
  return Object.entries(properties).map(([name, schema]) => {
    const entry: Record<string, unknown> = isRecord(schema) ? schema : {};
    const unit = typeof entry.unit === 'string' ? entry.unit : typeof entry['x-unit'] === 'string' ? entry['x-unit'] : null;
    const fallback = entry.default;
    return {
      name,
      unit,
      default: typeof fallback === 'number' || typeof fallback === 'string' || typeof fallback === 'boolean' ? fallback : null,
      required: Boolean(mode.optionsSchema?.required?.includes(name)),
      type: typeof entry.type === 'string' ? entry.type : null,
    };
  });
}

export function formatDefault(value: OptionFact['default']): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
}

/** `time_budget_ms (ms, 30,000)`: the one-line form used in tables. */
export function optionLine(fact: OptionFact): string {
  const parts = [fact.unit, fact.default !== null ? formatDefault(fact.default) : null].filter((part): part is string => part !== null);
  return parts.length ? `${fact.name} (${parts.join(', ')})` : fact.name;
}

export function modeRows(engine: EngineCatalogEntry): ModeRow[] {
  return engine.modes.map((mode) => {
    const options = optionFacts(mode).map(optionLine);
    return {
      id: `${engineKey(engine)}::${mode.id}`,
      engineKey: engineKey(engine),
      label: `${engine.name} · ${mode.id}`,
      placement: selectorText(mode.capabilities?.placement),
      irExtensions: selectorText(mode.capabilities?.irExtensions),
      options: options.length ? options.join(' · ') : 'No caller options',
    };
  });
}

const PUBLICATION: Record<EngineRegistrationRevision['status'], Publication> = {
  private: 'not requested',
  pending_review: 'in review',
  published: 'published',
  rejected: 'rejected',
};

interface RowContext {
  /** The signed-in account's username, which is also the namespace of the engines it owns. */
  username: string | null;
  revisions: EngineRevision[];
  registrations: EngineRegistrationRevision[];
}

/** One row per revision, with the visibility and publication the gateway reports (or the best honest reading of it). */
export function engineRows(engines: EngineCatalogEntry[], context: RowContext): EngineRow[] {
  return engines.map((engine) => {
    const key = engineKey(engine);
    const revision = context.revisions.find((item) => item.namespace === engine.namespace && item.name === engine.name && item.version === engine.version);
    const registration = context.registrations.find((item) => item.namespace === engine.namespace && item.name === engine.name && item.version === engine.version);
    const builtin = engine.namespace === BUILTIN_NAMESPACE;
    const owned = context.username !== null && engine.namespace === context.username;
    const visibility: Visibility = revision ? (revision.state === 'private' ? 'private' : 'public') : owned && !builtin ? 'private' : 'public';
    const publication: Publication = registration ? PUBLICATION[registration.status] : visibility === 'public' ? 'published' : 'not requested';
    const yours = visibility === 'private' && owned;
    const chips: string[] = [];
    if (visibility === 'public') chips.push('Public');
    else chips.push(yours ? 'Private · yours' : 'Private');
    if (registration) chips.push(registration.active ? 'Registration active' : 'Registration inactive');
    if (revision?.registration?.verificationReport?.status === 'verified') chips.push('Conformance passed');
    else if (revision?.registration?.verificationReport?.status === 'failed') chips.push('Conformance failed');
    if (visibility === 'private') chips.push(`Publication ${publication}`);
    return {
      key,
      engine,
      family: builtin ? engine.name : 'federated',
      familyLabel: builtin ? titleCase(engine.name) : 'Federated',
      visibility,
      publication,
      yours,
      chips,
      href: engineHref(engine),
    };
  });
}

export function familyOptions(rows: EngineRow[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) if (!seen.has(row.family)) seen.set(row.family, row.familyLabel);
  const builtin = [...seen].filter(([id]) => id !== 'federated');
  const federated = seen.has('federated') ? [['federated', 'Federated'] as const] : [];
  return [{ id: 'all', label: 'All' }, ...[...builtin, ...federated].map(([id, label]) => ({ id, label }))];
}

export function glyphOf(name: string): string {
  const words = name.split(/[\s._/-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

export { shortDigest };
