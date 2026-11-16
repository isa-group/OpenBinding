import { refusalMarker, refusalText, type Refusal } from '../../shared/api/refusals';
import { isRecord, parseJson, type BimDocument, type ResourceEntry, type WorkspaceFiles } from '../../features/bim-editor/documents';

/** Everything the workbench says about a package or a refusal, as plain functions. */

/** Opening a problem version from the address (`?problem=&revision=`) failed. */
export function loadRefusalText(refusal: Refusal): string {
  if (refusal.status === 404) return `That problem version doesn’t exist any more, or you’re not in the organization it belongs to${refusalMarker(refusal)}. The package was not loaded.`;
  return refusalText(refusal, 'the package was not loaded');
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
    case 'Application': return `${plural(count(spec?.tasks), 'task')} and ${plural(count(spec?.features), 'quality metric')}`;
    case 'CandidateCatalog': return `${plural(count(spec?.candidates), 'candidate')} with ${plural(count(spec?.featureBindings), 'quality column')}`;
    case 'ConstraintSet': return plural(count(spec?.constraints), 'rule');
    case 'Optimization': return `Goal · ${plural(count(spec?.criteria), 'criterion', 'criteria')}`;
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

/** How many criteria the goal of the package has, summed over its optimization documents. */
export function goalTerms(files: WorkspaceFiles, resources: ResourceEntry[]): number {
  return resources
    .filter((resource) => resource.kind === 'Optimization' && resource.path)
    .reduce((total, resource) => total + count(parseJson(files[resource.path!])?.spec?.criteria), 0);
}
