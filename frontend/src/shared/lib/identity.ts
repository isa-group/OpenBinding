// [impl->req~identity-labels~1]
// Identity labels (docs/ARCHITECTURE.md §5.4, openspec change m27-names-not-digests design §2): a thing is named by its name, version,
// count, engine mode and date, never by an id, a digest or a fingerprint. Every function is pure, reads no clock, locale or time zone,
// and returns a non-empty string. A text field that looks like an identifier counts as missing, as a whole.

type Maybe<T> = T | null | undefined;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const SEPARATOR = ' · ';

// A digest prefix, a run of 40 or more hexadecimal characters (git SHA, SHA-256) or a UUID. No lookarounds: `build<hex>` is caught too.
const DIGEST_PREFIX = /sha256[-]/i;
const HEX_RUN = /[0-9a-f]{40,}/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function containsIdentifier(text: string): boolean {
  return DIGEST_PREFIX.test(text) || HEX_RUN.test(text) || UUID.test(text);
}

function text(value: Maybe<string>): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || containsIdentifier(trimmed) ? null : trimmed;
}

function positiveInteger(value: Maybe<number | string>): number | null {
  const n = typeof value === 'string' ? (/^v?\d+$/i.test(value.trim()) ? Number(value.trim().replace(/^v/i, '')) : NaN) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function version(value: Maybe<number | string>): string | null {
  const n = positiveInteger(value);
  return n === null ? null : `v${n}`;
}

function count(value: Maybe<number>): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function utcText(value: string): string {
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) return `${value}Z`;
  const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(value);
  return spaced ? `${spaced[1]}T${spaced[2]}Z` : value;
}

function date(value: Maybe<string | number | Date>): string | null {
  if (value === null || value === undefined || value === '') return null;
  // A date-time without an offset would be read in local time; read it as UTC. `YYYY-MM-DD HH:MM` is the same value with a space.
  const parsed = new Date(typeof value === 'string' ? utcText(value.trim()) : value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

const words = (...parts: Array<string | null>): string | null => {
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? null : kept.join(' ');
};

const join = (segments: Array<string | null>): string => segments.filter((segment): segment is string => segment !== null).join(SEPARATOR);

export interface ProblemVersionInput {
  name?: Maybe<string>;
  version?: Maybe<number | string>;
  sealedAt?: Maybe<string | number | Date>;
}

function problemVersionParts(input: Pick<ProblemVersionInput, 'name' | 'version'>): { name: string | null; version: string | null } {
  return { name: text(input.name), version: version(input.version) };
}

function problemHead({ name, version: v }: { name: string | null; version: string | null }, fallback: string): string | null {
  if (name === null && v === null) return null;
  return words(name ?? fallback, v);
}

/** `checkout-flow v3 · sealed 20 Aug 2026` */
export function problemVersionLabel(input: ProblemVersionInput): string {
  const sealed = date(input.sealedAt);
  return join([problemHead(problemVersionParts(input), 'problem') ?? 'problem version', sealed === null ? null : `sealed ${sealed}`]);
}

export interface CollectionVersionInput {
  name?: Maybe<string>;
  version?: Maybe<number | string>;
  problemCount?: Maybe<number>;
}

/** `QACOBench icws v2 · 12 problems` */
export function collectionVersionLabel(input: CollectionVersionInput): string {
  const n = count(input.problemCount);
  return join([
    problemHead({ name: text(input.name), version: version(input.version) }, 'collection') ?? 'collection version',
    n === null ? null : `${n.toLocaleString('en-US')} ${n === 1 ? 'problem' : 'problems'}`,
  ]);
}

export interface EngineInput {
  name?: Maybe<string>;
  version?: Maybe<string>;
  mode?: Maybe<string>;
}

/** `minizinc-csp 1.1.1 · mode exact` */
export function engineLabel(input: EngineInput): string {
  const name = text(input.name);
  const v = text(input.version);
  const mode = text(input.mode);
  const head = name === null && v === null ? null : words(name ?? 'engine', v);
  return join([head ?? 'engine', mode === null ? null : `mode ${mode}`]);
}

export interface RunInput {
  number?: Maybe<number | string>;
  problem?: Maybe<{ name?: Maybe<string>; version?: Maybe<number | string> }>;
  engine?: Maybe<EngineInput>;
  createdAt?: Maybe<string | number | Date>;
}

/** `run 14 of checkout-flow v3 · minizinc-csp 1.1.1 exact · 21 Oct 2026` */
export function runLabel(input: RunInput): string {
  const number = positiveInteger(input.number);
  const problem = input.problem ? problemHead(problemVersionParts(input.problem), 'problem') : null;
  const head = words('run', number === null ? null : String(number), problem === null ? null : 'of', problem);
  const name = text(input.engine?.name);
  const v = text(input.engine?.version);
  const mode = text(input.engine?.mode);
  const engine = v === null && mode === null && name === null ? null : words(name ?? 'engine', v, mode);
  return join([head, engine, date(input.createdAt)]);
}

export interface StudyRunInput {
  study?: Maybe<string>;
  number?: Maybe<number | string>;
  createdAt?: Maybe<string | number | Date>;
}

/** `engines-vs-suite run 3 · 21 Oct 2026` */
export function studyRunLabel(input: StudyRunInput): string {
  const number = positiveInteger(input.number);
  return join([words(text(input.study) ?? 'study', 'run', number === null ? null : String(number)), date(input.createdAt)]);
}

export interface PublishedResultInput {
  title?: Maybe<string>;
  publishedAt?: Maybe<string | number | Date>;
}

/** `Engines versus the ICWS suite · published 22 Oct 2026` */
export function publishedResultLabel(input: PublishedResultInput): string {
  const published = date(input.publishedAt);
  return join([text(input.title) ?? 'published result', published === null ? null : `published ${published}`]);
}
