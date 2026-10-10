import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { RANGE_CODE, RANGE_REFUSAL } from '../../utils/featureRange';
import type { WorkspaceFiles } from '../../utils/workspaceDraft';
import { isRecord, parseJson, type BimDocument, type CompatibleMode, type Diagnostic, type ResourceEntry } from './bimDocuments';

/** Everything the workbench says about a package or a refusal, as plain functions. */

// --- what the gateway can refuse

export type RefusalKind = 'invalid' | 'too-big' | 'too-large' | 'session' | 'key' | 'unsupported' | 'busy' | 'unavailable' | 'other';

export interface Refusal {
  kind: RefusalKind;
  status?: number;
  /** The machine code the gateway sent, for people who need to quote it. */
  code?: string;
  /** The gateway's own sentence. */
  message: string;
  /** The problems a 422 lists, one per place in the package. */
  diagnostics: Diagnostic[];
  /** What a 402 names: the allowance and its ceiling. */
  limitId?: string;
  limit?: number;
}

/** `(422)` or `(403 · api_key_boundary)`: the status and code of a refusal. */
export function refusalMarker(refusal: Pick<Refusal, 'status' | 'code'>): string {
  const parts = [refusal.status, refusal.code].filter((part) => part !== undefined && part !== '');
  return parts.length ? ` (${parts.join(' · ')})` : '';
}

/** Sort a failed call into the cases the workbench has words for. */
export function refusalOf(caught: unknown): Refusal {
  if (caught instanceof QuotaError) {
    return { kind: 'too-big', status: 402, code: caught.code, message: caught.message, diagnostics: [], limitId: caught.quota?.limit_id, limit: caught.quota?.limit };
  }
  if (caught instanceof HttpError) {
    const base = {
      status: caught.status,
      code: caught.code,
      message: caught.message.replace(/^HTTP \d+: /, ''),
      diagnostics: (caught.diagnostics ?? []).filter(isRecord) as Diagnostic[],
    };
    switch (caught.status) {
      case 401: return { kind: 'session', ...base };
      case 403: return { kind: 'key', ...base };
      case 413: return { kind: 'too-large', ...base };
      case 415: return { kind: 'unsupported', ...base };
      case 422: return { kind: 'invalid', ...base };
      case 429: return { kind: 'busy', ...base };
      default: return { kind: caught.status >= 500 ? 'unavailable' : 'other', ...base };
    }
  }
  if (caught instanceof TypeError) return { kind: 'unavailable', message: 'OpenBinding could not be reached.', diagnostics: [] };
  return { kind: 'other', message: caught instanceof Error ? caught.message : String(caught), diagnostics: [] };
}

/** The sentence for a refusal that isn't one of the screen's own states. */
export function refusalText(refusal: Refusal, doing: string): string {
  const marker = refusalMarker(refusal);
  switch (refusal.kind) {
    case 'unsupported': return `The gateway doesn’t take this kind of file${marker}. Use a .bim.zip package.`;
    case 'busy': return `Too many requests${marker}. Wait a moment and try again.`;
    case 'unavailable': return `A service OpenBinding depends on isn’t answering${marker}, so ${doing}. This says nothing about your package; try again in a moment.`;
    case 'too-big': return `This package is bigger than your plan can compile${marker}, so ${doing}.`;
    case 'too-large': return `This package is larger than your plan allows per request${marker}, so ${doing}.`;
    case 'session': return `Your session has ended${marker}. Log in again; your package is kept in this browser.`;
    default: return refusal.status === undefined ? refusal.message : `${refusal.message || 'That couldn’t be done'}${marker}, so ${doing}.`;
  }
}

/** Opening a case revision from the address (`?case=&revision=`) failed. */
export function loadRefusalText(refusal: Refusal): string {
  if (refusal.status === 404) return `That case revision doesn’t exist any more, or you’re not in the organization it belongs to${refusalMarker(refusal)}. The package was not loaded.`;
  return refusalText(refusal, 'the package was not loaded');
}

/** Saving a revision: what each refusal of `POST …/cases/{case}/revisions` means. */
export function saveRefusalText(refusal: Refusal): string {
  const marker = refusalMarker(refusal);
  switch (refusal.kind) {
    case 'key': return `You need MEMBER in the organization to save a revision, and an API key needs projects:write${marker}. Nothing was saved.`;
    case 'session': return `Your session has ended${marker}. Log in again; the package is kept in this browser. Nothing was saved.`;
    case 'invalid': return `The gateway refused to seal a revision from this package${marker}. ${refusal.message ? `${refusal.message} ` : ''}Nothing was saved.`;
    case 'too-big': return `This package is bigger than your plan can compile${marker}. Nothing was saved.`;
    case 'too-large': return `This package is larger than your plan allows per request${marker}. Nothing was saved.`;
    case 'other': return refusal.status === 404
      ? `That case no longer exists, or you’re not in its organization${marker}. Nothing was saved.`
      : `${refusal.message || 'The revision could not be saved'}${marker}. Nothing was saved.`;
    default: return refusalText(refusal, 'nothing was saved');
  }
}

// --- the plan's ceilings

/** The plan's ceiling for the size of a compiled problem, as a power of ten; `null` when unlimited or unknown. */
export function complexityCeiling(capability: unknown, planValue: number | null): number | null {
  if (typeof capability === 'number' && Number.isFinite(capability)) return capability;
  return planValue;
}

// --- the package as the person sees it

export interface PackageFile {
  path: string;
  /** Two letters for the tile. */
  tile: string;
  kind: string;
  what: string;
}

const TILES: Record<string, string> = {
  Instance: 'IN', Application: 'AP', CandidateCatalog: 'CA', ConstraintSet: 'CS', Optimization: 'OP', RoutingOverlay: 'RO', Placement: 'PL', BPMN: 'WF',
};

const plural = (count: number, noun: string, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`;
const count = (value: unknown): number => (isRecord(value) ? Object.keys(value).length : Array.isArray(value) ? value.length : 0);

function describeDocument(document: BimDocument | null): string {
  const spec = document?.spec;
  switch (document?.kind) {
    case 'Instance': return `Root of the package · ${plural(Object.values(spec?.resources ?? {}).reduce((total, group) => total + count(group), 0), 'resource')}`;
    case 'Application': return `${plural(count(spec?.tasks), 'task')} and ${plural(count(spec?.metrics), 'quality metric')}`;
    case 'CandidateCatalog': return `${plural(count(spec?.candidates), 'candidate')} with ${plural(count(spec?.metricBindings), 'quality column')}`;
    case 'ConstraintSet': return plural(count(spec?.constraints), 'rule');
    case 'Optimization': return `${spec?.mode ?? 'goal'} goal · ${plural(count(spec?.terms), 'term')}`;
    case 'RoutingOverlay': return spec?.entries ? plural(count(spec.entries), 'routed branch', 'routed branches') : 'Even branch weights';
    case 'Placement': return `${plural(count(spec?.pools), 'pool')} and ${plural(count(spec?.network), 'network link')}`;
    default: return document?.kind ? String(document.kind) : 'Not a JSON document';
  }
}

/** Each file of the package, with what it holds in plain words. */
export function packageFileList(files: WorkspaceFiles, resources: ResourceEntry[]): PackageFile[] {
  return Object.keys(files).sort((a, b) => (a === 'instance.json' ? -1 : b === 'instance.json' ? 1 : a.localeCompare(b))).map((path) => {
    const lower = path.toLowerCase();
    if (lower.endsWith('.bpmn') || lower.endsWith('.xml')) {
      const tasks = (files[path].match(/<bpmn:(?:service|user|script|manual|business|send|receive)?[Tt]ask\b/g) ?? []).length;
      return { path, tile: TILES.BPMN, kind: 'BPMN', what: `Workflow diagram${tasks ? ` · ${plural(tasks, 'task')}` : ''}` };
    }
    const document = parseJson(files[path]);
    const kind = path === 'instance.json' ? 'Instance' : resources.find((resource) => resource.path === path)?.kind ?? document?.kind ?? 'File';
    return { path, tile: TILES[kind] ?? kind.slice(0, 2).toUpperCase(), kind, what: describeDocument(document) };
  });
}

/** How many terms the goal of the package has, summed over its optimization documents. */
export function goalTerms(files: WorkspaceFiles, resources: ResourceEntry[]): number {
  return resources
    .filter((resource) => resource.kind === 'Optimization' && resource.path)
    .reduce((total, resource) => total + count(parseJson(files[resource.path!])?.spec?.terms), 0);
}

// --- engines

export interface EngineRow {
  key: string;
  name: string;
  mode: string;
  runnable: boolean;
  registered: boolean;
  why: string;
}

/** What the run says when an engine refuses a package for its ranges, plus the diagnostics' pointers when the gateway sent them. */
export const RANGE_RUN_ERROR = 'This engine only accepts single values, and this package has range features (a min and a max, open or not). Pick a mode that declares interval values, or edit those candidates to use single values.';

/** Did the run end because the engine mode doesn't take ranges (`unsupported_capability_value`)? */
export function isRangeRefusal(caught: unknown): boolean {
  if (caught instanceof HttpError) {
    if (caught.code === RANGE_CODE) return true;
    if ((caught.diagnostics ?? []).some((row) => isRecord(row) && row.code === RANGE_CODE)) return true;
  }
  return caught instanceof Error && caught.message.includes(RANGE_CODE);
}

/** The pointers of the diagnostics of such a refusal, as ` Candidates: /spec/candidates/a/features/latency, …` (empty when it sent none). */
export function rangePointers(caught: unknown): string {
  const rows = caught instanceof HttpError ? caught.diagnostics ?? [] : [];
  const pointers = rows.flatMap((row) => (isRecord(row) && typeof row.pointer === 'string' ? [row.pointer] : [])).slice(0, 5);
  return pointers.length ? ` The gateway pointed at ${pointers.join(', ')}.` : '';
}

/** Did the gateway turn the mode down because of ranges (`unsupported_capability_value`, or an interval it can't take)? */
export function refusesRanges(mode: CompatibleMode): boolean {
  return mode.compatible !== true && (mode.diagnostics ?? []).some((diagnostic) => (
    diagnostic.code === RANGE_CODE || /\binterval\b/i.test(`${diagnostic.message ?? ''} ${diagnostic.detail ?? ''}`)
  ));
}

/** The reason a mode that can't run the package gives, in words. A refusal for ranges says so in the one sentence everywhere. */
export function whyNot(mode: CompatibleMode): string {
  if (refusesRanges(mode)) return RANGE_REFUSAL;
  return mode.diagnostics?.map((diagnostic) => diagnostic.message ?? diagnostic.detail).filter(Boolean).join(' ') || 'Its declared capabilities don’t cover this package.';
}

/** A row for each engine mode the analysis listed, with the reason it can or can't run the package. */
export function engineRows(modes: CompatibleMode[]): EngineRow[] {
  return modes.map((item) => ({
    key: `${item.engine.namespace}/${item.engine.name}@${item.engine.version}#${item.registration.name}@${item.registration.version}/${item.mode}`,
    name: `${item.engine.name} ${item.engine.version}`,
    mode: item.mode,
    runnable: item.compatible === true,
    registered: item.engine.namespace !== 'bim.builtin',
    why: item.compatible
      ? `Runs through ${item.registration.namespace}/${item.registration.name}@${item.registration.version}.`
      : whyNot(item),
  }));
}

/** Does any candidate of any catalog of the package hold a range (an object under `features`, or `metrics` in the older layout)? */
export function filesHaveRanges(files: WorkspaceFiles): boolean {
  return Object.entries(files).some(([path, source]) => {
    if (!path.toLowerCase().endsWith('.json')) return false;
    const document = parseJson(source);
    const candidates = document?.kind === 'CandidateCatalog' && isRecord(document.spec) ? document.spec.candidates : undefined;
    const entries = isRecord(candidates) ? Object.values(candidates) : Array.isArray(candidates) ? candidates : [];
    return entries.some((entry) => isRecord(entry) && ['features', 'metrics'].some((key) => isRecord(entry[key]) && Object.values(entry[key] as Record<string, unknown>).some(isRecord)));
  });
}

// --- the draft of the workspace

/** Where a workspace's unsaved edits are kept: per person, per address and per case revision. */
export function workbenchDraftScope(userId: string | undefined, pathname: string, caseRef: string | null, revisionRef: string | null): string {
  return `${userId || 'anonymous'}:${pathname}:${caseRef || ''}:${revisionRef || ''}`;
}
