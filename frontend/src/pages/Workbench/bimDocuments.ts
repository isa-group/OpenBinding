import type { BimResourceRef } from '../../api/client';
import type { FeatureSlot } from '../../utils/featureRange';
import type { WorkspaceFiles } from '../../utils/workspaceDraft';

/** The documents of a BIM package as the workbench reads them: tolerant types over JSON, and the small readers the editor and the summaries share. */

export const DEFAULT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="https://bim.dev/examples">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:serviceTask id="hello" name="Hello"><bpmn:incoming>Flow_1</bpmn:incoming><bpmn:outgoing>Flow_2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:endEvent id="EndEvent_1"><bpmn:incoming>Flow_2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="hello" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="hello" targetRef="EndEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="120" y="102" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="hello_di" bpmnElement="hello"><dc:Bounds x="220" y="80" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1"><dc:Bounds x="384" y="102" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="156" y="120" /><di:waypoint x="220" y="120" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2"><di:waypoint x="320" y="120" /><di:waypoint x="384" y="120" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

export function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The small package the workbench starts from when nothing else was asked for. */
export const DEFAULT_FILES: WorkspaceFiles = {
  'instance.json': pretty({
    apiVersion: 'bim/v1',
    kind: 'Instance',
    metadata: { name: 'hello-bim' },
    spec: {
      profile: 'qos-binding/v1',
      resources: {
        application: { application: 'application.json', workflow: 'workflow.bpmn' },
        candidateCatalog: { catalog: 'candidates.json' },
        optimization: { optimization: 'optimization.json' },
      },
    },
  }),
  'application.json': pretty({
    apiVersion: 'qos-binding/v1',
    kind: 'Application',
    metadata: { name: 'hello-app' },
    spec: {
      tasks: { hello: 'http' },
      metrics: {
        latency: { unit: 'ms', domain: 'real', direction: 'minimize', scope: 'invocation', aggregation: 'sum' },
      },
      workflow: { bpmn: { resource: 'workflow', id: 'Process_1' } },
    },
  }),
  'candidates.json': pretty({
    apiVersion: 'qos-binding/v1',
    kind: 'CandidateCatalog',
    metadata: { name: 'hello-catalog' },
    spec: {
      metricBindings: { latency: { resource: 'application', id: 'latency' } },
      candidates: { 'service-a': { provides: 'http', features: { latency: 10 } } },
    },
  }),
  'optimization.json': pretty({
    apiVersion: 'qos-binding/v1',
    kind: 'Optimization',
    metadata: { name: 'hello-optimization' },
    spec: { type: 'MONO', mode: 'weighted', terms: [{ metric: { resource: 'application', id: 'latency' }, weight: 1 }] },
  }),
  'workflow.bpmn': DEFAULT_BPMN,
};

export type WorkspaceStatus = 'idle' | 'validating' | 'valid' | 'queued' | 'running' | 'completed' | 'failed';

export interface CompiledIr {
  snapshot: string;
  digest: string;
  document: Record<string, unknown>;
}

export type ResourceRole = string;

export interface RegisteredResourceRef {
  namespace: string;
  name: string;
  version: string;
  digest?: string;
  versionDigest?: string;
}

export interface ResourceEntry {
  id: string;
  role: ResourceRole;
  kind: string;
  path?: string;
  registered?: RegisteredResourceRef;
}

export const RESOURCE_ROLE_LABELS: Record<string, string> = {
  application: 'Application',
  candidateCatalog: 'Candidate catalogs',
  constraintSet: 'Constraint sets',
  optimization: 'Optimization',
};

export interface Diagnostic {
  code?: string;
  message?: string;
  detail?: string;
  resource?: string;
  resourcePath?: string;
  path?: string;
  pointer?: string;
  jsonPointer?: string;
  bpmnElement?: string;
  element?: string;
  related?: unknown[];
  span?: { start?: number; end?: number };
  start?: number;
  end?: number;
}

export interface CompatibleMode {
  engine: BimResourceRef;
  registration: BimResourceRef;
  mode: string;
  compatible: boolean;
  diagnostics?: Diagnostic[];
}

export interface BimMetadataDocument extends Record<string, unknown> {
  name?: string;
  version?: string;
  description?: string;
}

export interface InternalReference extends Record<string, unknown> {
  resource?: string;
  id?: string;
}

export type TaskDocument = string | {
  kind?: 'service' | 'local';
  requires?: string | { type?: string; predicate?: unknown };
  [key: string]: unknown;
};

export interface MetricDocument extends Record<string, unknown> {
  type?: 'number';
  unit?: string;
  domain?: string | { kind?: string; minimum?: number; maximum?: number };
  direction?: 'minimize' | 'maximize';
  scope?: 'invocation' | 'selectedCandidate';
  aggregation?: unknown;
  neutral?: number;
}

export type ScalarValue = string | number | boolean | null;
export type ScalarMap = Record<string, ScalarValue>;
export type CapabilityDocument = string | { type?: string; properties?: ScalarMap };

export interface CandidateDocument extends Record<string, unknown> {
  provides?: CapabilityDocument | CapabilityDocument[];
  provider?: InternalReference;
  properties?: ScalarMap;
  /** A number, or a range `{ min, max }` (an end `null` for no limit) while it is being typed. This is the key of the schema. */
  features?: Record<string, FeatureSlot>;
  /** The key older drafts used for the same table; read when a document is opened, never written. */
  metrics?: Record<string, FeatureSlot>;
}

/** The qualities of a candidate, from `features` (or from `metrics`, in a draft written before the key was fixed). */
export function candidateFeatures(candidate: CandidateDocument): Record<string, FeatureSlot> {
  return { ...(candidate.metrics || {}), ...(candidate.features || {}) };
}

/** The candidate with these qualities under `features`, the key of the schema, and without the older `metrics`. */
export function withCandidateFeatures(candidate: CandidateDocument, features: Record<string, FeatureSlot>): CandidateDocument {
  const next: CandidateDocument = { ...candidate, features };
  delete next.metrics;
  return next;
}

export interface ConstraintDocument extends Record<string, unknown> {
  assert: unknown;
  enforcement: 'hard' | 'soft';
  penalty?: unknown;
}

export interface NormalizeDocument extends Record<string, unknown> {
  min: number;
  max: number;
  clamp?: boolean;
}

export interface OptimizationTermDocument extends Record<string, unknown> {
  metric?: InternalReference;
  direction?: 'minimize' | 'maximize';
  weight?: number;
  normalize?: NormalizeDocument;
}

export interface OptimizationPenaltyDocument extends Record<string, unknown> {
  constraint?: InternalReference;
  weight?: number;
}

export type NumberMap = Record<string, number>;

export interface RoutingEntryDocument extends Record<string, unknown> {
  target?: InternalReference;
  probability?: number;
}

export interface PlacementPoolDocument extends Record<string, unknown> {
  name?: string;
  kind?: string;
  capacity?: NumberMap;
  properties?: Record<string, unknown>;
}

export interface PlacementGroupDocument extends Record<string, unknown> {
  pool?: InternalReference;
  capability?: string;
  candidates?: InternalReference[];
  resources?: NumberMap;
}

export interface PlacementDemandDocument extends Record<string, unknown> {
  candidate?: InternalReference;
  pool?: InternalReference;
  resources?: NumberMap;
}

export interface PlacementNetworkDocument extends Record<string, unknown> {
  from?: InternalReference;
  to?: InternalReference;
  latency?: number;
}

export interface PlacementEventLatencyDocument extends Record<string, unknown> {
  pool?: InternalReference;
  latency?: number;
}

export interface PlacementEventDocument extends Record<string, unknown> {
  pool?: InternalReference;
  latency?: PlacementEventLatencyDocument[];
}

export interface PlacementTransitionDocument extends Record<string, unknown> {
  from?: InternalReference;
  to?: InternalReference;
  metric?: InternalReference;
  maximum?: number;
  enforcement?: 'hard' | 'soft';
  penalty?: number;
}

export interface PlacementCapacityRuleDocument extends Record<string, unknown> {
  resources?: string[];
  scope?: 'invocation' | 'selectedCandidate';
}

export interface PlacementGlobalLatencyDocument extends Record<string, unknown> {
  metric?: InternalReference;
  includeExecution?: boolean;
  exclusive?: 'routing' | 'condition';
  parallel?: 'max' | 'sum';
}

export interface BimSpecDocument extends Record<string, unknown> {
  profile?: string;
  resources?: Record<string, Record<string, unknown>>;
  tasks?: Record<string, TaskDocument>;
  metrics?: Record<string, MetricDocument>;
  metricBindings?: Record<string, InternalReference>;
  candidates?: Record<string, CandidateDocument>;
  constraints?: Record<string, ConstraintDocument>;
  type?: 'MONO' | 'MULTI' | 'MANY';
  mode?: 'satisfy' | 'weighted' | 'lexicographic' | 'pareto';
  terms?: OptimizationTermDocument[];
  penalties?: OptimizationPenaltyDocument[];
  workflow?: unknown;
  uniform?: true;
  entries?: RoutingEntryDocument[];
  pools?: Record<string, PlacementPoolDocument>;
  defaults?: NumberMap;
  groups?: Record<string, PlacementGroupDocument>;
  demands?: PlacementDemandDocument[];
  network?: PlacementNetworkDocument[];
  networkMode?: 'directed' | 'symmetric';
  events?: Record<string, PlacementEventDocument>;
  transitions?: Record<string, PlacementTransitionDocument>;
  capacityRules?: PlacementCapacityRuleDocument[];
  globalLatency?: PlacementGlobalLatencyDocument;
}

export interface BimDocument extends Record<string, unknown> {
  apiVersion?: string;
  kind?: string;
  metadata?: BimMetadataDocument;
  spec?: BimSpecDocument;
}

export interface BindingDecision extends Record<string, unknown> {
  kind?: string;
  binding?: Record<string, InternalReference>;
}

export interface BindingSolution extends Record<string, unknown> {
  decision?: BindingDecision;
  metrics?: unknown;
  objectives?: unknown;
  penalties?: unknown;
  violations?: unknown;
  evaluation?: unknown;
}

export interface BindingResult extends Record<string, unknown> {
  termination?: string;
  solutions?: BindingSolution[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJson(source: string | undefined): BimDocument | null {
  if (!source) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed as BimDocument : null;
  } catch {
    return null;
  }
}

export function isRegisteredResourceRef(value: unknown): value is RegisteredResourceRef {
  return isRecord(value)
    && typeof value.namespace === 'string'
    && typeof value.name === 'string'
    && typeof value.version === 'string'
    && (typeof value.digest === 'string' || typeof value.versionDigest === 'string');
}

function kindForLocalResource(path: string, files: WorkspaceFiles): string {
  const document = parseJson(files[path]);
  if (typeof document?.kind === 'string') return document.kind;
  if (path.toLowerCase().endsWith('.bpmn') || path.toLowerCase().endsWith('.xml')) return 'BPMN';
  return 'Unknown';
}

/** What the instance document points to, role by role: a file of the package or a registered resource. */
export function instanceResources(root: BimDocument | null, files: WorkspaceFiles): ResourceEntry[] {
  const groups = root?.spec?.resources;
  if (!isRecord(groups)) return [];
  return Object.keys(groups).flatMap((role) => {
    const group = groups[role];
    if (!isRecord(group)) return [];
    return Object.entries(group).map(([id, target]): ResourceEntry => {
      if (typeof target === 'string') return { id, role, path: target, kind: kindForLocalResource(target, files) };
      if (isRegisteredResourceRef(target)) return { id, role, registered: target, kind: 'Registered' };
      return { id, role, kind: 'Invalid target' };
    });
  });
}

export function registeredResourceLabel(reference: RegisteredResourceRef): string {
  return `${reference.namespace}/${reference.name}@${reference.version}`;
}

export function errorDiagnostics(error: unknown, fallbackCode: string): Diagnostic[] {
  if (isRecord(error) && Array.isArray(error.diagnostics) && error.diagnostics.length) {
    return error.diagnostics.filter(isRecord) as Diagnostic[];
  }
  return [{ code: fallbackCode, message: error instanceof Error ? error.message : String(error) }];
}

function isBimResourceRef(value: unknown): value is BimResourceRef {
  return isRecord(value)
    && typeof value.namespace === 'string'
    && typeof value.name === 'string'
    && typeof value.version === 'string'
    && typeof value.digest === 'string';
}

/** Every engine mode the analysis listed, runnable or not: a row for each. */
export function allModesFromAnalysis(value: unknown): CompatibleMode[] {
  if (!isRecord(value) || !Array.isArray(value.compatibleModes)) return [];
  return value.compatibleModes.filter((item): item is CompatibleMode => isRecord(item)
    && isBimResourceRef(item.engine) && isBimResourceRef(item.registration) && typeof item.mode === 'string');
}

/** Only the modes the gateway says can run the package. */
export function modesFromAnalysis(value: unknown): CompatibleMode[] {
  return allModesFromAnalysis(value).filter((item) => item.compatible === true);
}

export function executionKey(item: CompatibleMode): string {
  return [
    item.engine.namespace,
    item.engine.name,
    item.engine.version,
    item.engine.digest,
    item.registration.namespace,
    item.registration.name,
    item.registration.version,
    item.registration.digest,
    item.mode,
  ].join('|');
}

export function resourcePathForDiagnostic(resources: ResourceEntry[], item: Diagnostic): string | undefined {
  const explicit = item.resourcePath || item.path;
  const direct = resources.find((resource) => resource.path === explicit);
  if (direct) return direct.path;
  const id = item.resource || explicit;
  return resources.find((resource) => resource.id === id)?.path;
}

export function diagnosticSelection(source: string, item: Diagnostic): { anchor: number; head: number } | undefined {
  const start = item.span?.start ?? item.start;
  const end = item.span?.end ?? item.end;
  if (typeof start === 'number') return { anchor: start, head: typeof end === 'number' ? end : start };
  const pointer = item.pointer || item.jsonPointer;
  if (!pointer) return undefined;
  const token = pointer.split('/').filter(Boolean).at(-1)?.replace(/~1/g, '/').replace(/~0/g, '~');
  if (!token) return undefined;
  const needle = JSON.stringify(token);
  const offset = source.indexOf(needle);
  return offset >= 0 ? { anchor: offset, head: offset + needle.length } : undefined;
}

const BINARY_EXPRESSION_OPERATORS = new Set([
  'and', 'or', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'add', 'sub', 'mul', 'div', 'pow', 'scale', 'power',
]);
const UNARY_EXPRESSION_OPERATORS = new Set(['not', 'negate']);
const CALL_EXPRESSION_OPERATORS = new Set(['has', 'min', 'max', 'sum', 'product', 'weightedSum', 'weightedProduct']);
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
export const DEFAULT_AST_ASSERTION = { op: 'gte', left: { path: 'metrics.latency' }, right: { literal: 0 } };

export function isSourceExpression(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value === 'string' || typeof value === 'boolean') return depth <= 32;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && 'literal' in value) {
    const literal = value.literal;
    return literal === null || typeof literal === 'string' || typeof literal === 'boolean'
      || (typeof literal === 'number' && Number.isFinite(literal));
  }
  if (keys.length === 1 && 'path' in value) {
    return (typeof value.path === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value.path))
      || (Array.isArray(value.path) && value.path.length > 0 && value.path.every((segment) => typeof segment === 'string' && segment.length > 0));
  }
  if (typeof value.op !== 'string') return false;
  if (BINARY_EXPRESSION_OPERATORS.has(value.op)) {
    return keys.length === 3 && 'left' in value && 'right' in value
      && isSourceExpression(value.left, depth + 1) && isSourceExpression(value.right, depth + 1);
  }
  if (UNARY_EXPRESSION_OPERATORS.has(value.op)) {
    return keys.length === 2 && 'value' in value && isSourceExpression(value.value, depth + 1);
  }
  if (CALL_EXPRESSION_OPERATORS.has(value.op)) {
    return keys.length === 2 && Array.isArray(value.args) && value.args.length >= 1 && value.args.length <= 16
      && value.args.every((argument) => isSourceExpression(argument, depth + 1));
  }
  return false;
}

export function nextIdentifier(values: Record<string, unknown>, prefix: string): string {
  let index = Object.keys(values).length + 1;
  while (values[`${prefix}${index}`]) index += 1;
  return `${prefix}${index}`;
}

export function optionalNumber(value: string): number | undefined {
  if (value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
