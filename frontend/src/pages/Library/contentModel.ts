// Kept only for frontend/e2e/helpers/mockApi.ts; delete with the mock fixtures (M2.4 slice 3 follow-up).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Content = JsonObject | string;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const RESOURCE_API_VERSION = 'qos-binding/v1';
const PLACEMENT_API_VERSION = 'qos-binding-placement/v1';
const BPMN_MEDIA_TYPE = 'application/vnd.omg.bpmn+xml';

const BPMN_SKELETON = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://openbinding/bpmn">
  <bpmn:process id="Process_1" isExecutable="false" />
</bpmn:definitions>
`;

const RESOURCE_KINDS = new Set(['Application', 'CandidateCatalog', 'ConstraintSet', 'Optimization', 'Placement', 'RoutingOverlay']);

/** The empty document a new draft starts from, shaped as its kind expects. */
export function templateFor(kind: string, name: string): { content: Content; mediaType: string } {
  const resource = (spec: JsonObject): JsonObject => ({ apiVersion: kind === 'Placement' ? PLACEMENT_API_VERSION : RESOURCE_API_VERSION, kind, metadata: { name }, spec });
  switch (kind) {
    case 'Application': return { content: resource({ tasks: {}, features: {}, workflow: {} }), mediaType: 'application/json' };
    case 'CandidateCatalog': return { content: resource({ featureBindings: {}, candidates: {} }), mediaType: 'application/json' };
    case 'ConstraintSet': return { content: resource({ constraints: {} }), mediaType: 'application/json' };
    case 'Optimization': return { content: resource({ criteria: [], penalties: [] }), mediaType: 'application/json' };
    case 'RoutingOverlay': return { content: resource({ uniform: true }), mediaType: 'application/json' };
    case 'Placement': return { content: resource({ pools: {} }), mediaType: 'application/json' };
    case 'BPMN': return { content: BPMN_SKELETON, mediaType: BPMN_MEDIA_TYPE };
    default: return { content: RESOURCE_KINDS.has(kind) ? resource({}) : {}, mediaType: 'application/json' };
  }
}

function setIn(root: Json, path: readonly (string | number)[], value: Json | undefined): Json {
  if (path.length === 0) return value ?? null;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    const index = Number(head);
    if (value === undefined && rest.length === 0) copy.splice(index, 1);
    else copy[index] = setIn(copy[index] ?? null, rest, value);
    return copy;
  }
  const base: JsonObject = isObject(root) ? root : {};
  if (value === undefined && rest.length === 0) {
    const { [String(head)]: removed, ...others } = base;
    void removed;
    return others;
  }
  return { ...base, [String(head)]: setIn(base[String(head)] ?? null, rest, value) };
}

/** `document` with the value at `path` replaced (or removed, when `value` is `undefined`). */
export function updateAt(document: JsonObject, path: readonly (string | number)[], value: Json | undefined): JsonObject {
  const next = setIn(document, path, value);
  return isObject(next) ? next : document;
}
