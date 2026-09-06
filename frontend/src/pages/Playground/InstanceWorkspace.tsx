import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, FileArchive, History, RotateCcw, ShieldCheck, Waypoints } from 'lucide-react';
import { Liquid } from 'liquid-gooey';
import { apiClient, type BimResourceRef } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { packageFiles, unzipPackage, zipStore } from '../../utils/bimZip';
import { loadDraft, saveDraft, type WorkspaceFiles } from '../../utils/workspaceDraft';
import { sourceDiff, toYaml } from '../../utils/workspaceViews';
import './Playground.css';

const CodeEditor = lazy(() => import('../../components/CodeEditor/CodeEditor').then((module) => ({ default: module.CodeEditor })));
const BpmnModeler = lazy(() => import('./BpmnModeler').then((module) => ({ default: module.BpmnModeler })));

function EditorLoading() {
  return <div className="editor-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading editing surface…</div>;
}

const DEFAULT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
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

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const DEFAULT_FILES: WorkspaceFiles = {
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
      candidates: { 'service-a': { provides: 'http', metrics: { latency: 10 } } },
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

const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string; bpmnOnly?: boolean; jsonOnly?: boolean }> = [
  { id: 'resources', label: 'Resources' },
  { id: 'form', label: 'Form' },
  { id: 'expert', label: 'JSON source' },
  { id: 'yaml', label: 'YAML view', jsonOnly: true },
  { id: 'workflow', label: 'Workflow JSON' },
  { id: 'bpmn', label: 'BPMN modeler', bpmnOnly: true },
  { id: 'bpmnXml', label: 'BPMN XML', bpmnOnly: true },
  { id: 'ir', label: 'Compiled IR' },
  { id: 'diff', label: 'Source diff' },
];

type WorkspaceStatus = 'idle' | 'validating' | 'valid' | 'queued' | 'completed' | 'failed';
type WorkspaceTab = 'resources' | 'form' | 'expert' | 'yaml' | 'workflow' | 'bpmn' | 'bpmnXml' | 'ir' | 'diff';

interface CompiledIr {
  snapshot: string;
  digest: string;
  document: Record<string, unknown>;
}

interface ResourceEntry {
  id: string;
  role: ResourceRole;
  kind: string;
  path?: string;
  registered?: RegisteredResourceRef;
}

type ResourceRole = string;

interface RegisteredResourceRef {
  namespace: string;
  name: string;
  version: string;
  digest: string;
}

const RESOURCE_ROLE_LABELS: Record<string, string> = {
  application: 'Application',
  candidateCatalog: 'Candidate catalogs',
  constraintSet: 'Constraint sets',
  optimization: 'Optimization',
};

interface Diagnostic {
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

interface CompatibleMode {
  engine: BimResourceRef;
  registration: BimResourceRef;
  mode: string;
  compatible: boolean;
  diagnostics?: Diagnostic[];
}

interface BimMetadataDocument extends Record<string, unknown> {
  name?: string;
  version?: string;
  description?: string;
}

interface InternalReference extends Record<string, unknown> {
  resource?: string;
  id?: string;
}

type TaskDocument = string | {
  kind?: 'service' | 'local';
  requires?: string | { type?: string; predicate?: unknown };
  [key: string]: unknown;
};

interface MetricDocument extends Record<string, unknown> {
  type?: 'number';
  unit?: string;
  domain?: string | { kind?: string; minimum?: number; maximum?: number };
  direction?: 'minimize' | 'maximize';
  scope?: 'invocation' | 'selectedCandidate';
  aggregation?: unknown;
  neutral?: number;
}

type ScalarValue = string | number | boolean | null;
type ScalarMap = Record<string, ScalarValue>;
type CapabilityDocument = string | { type?: string; properties?: ScalarMap };

interface CandidateDocument extends Record<string, unknown> {
  provides?: CapabilityDocument | CapabilityDocument[];
  provider?: InternalReference;
  properties?: ScalarMap;
  metrics?: Record<string, number>;
}

interface ConstraintDocument extends Record<string, unknown> {
  assert: unknown;
  enforcement: 'hard' | 'soft';
  penalty?: unknown;
}

interface NormalizeDocument extends Record<string, unknown> {
  min: number;
  max: number;
  clamp?: boolean;
}

interface OptimizationTermDocument extends Record<string, unknown> {
  metric?: InternalReference;
  direction?: 'minimize' | 'maximize';
  weight?: number;
  normalize?: NormalizeDocument;
}

interface OptimizationPenaltyDocument extends Record<string, unknown> {
  constraint?: InternalReference;
  weight?: number;
}

type NumberMap = Record<string, number>;

interface RoutingEntryDocument extends Record<string, unknown> {
  target?: InternalReference;
  probability?: number;
}

interface PlacementPoolDocument extends Record<string, unknown> {
  name?: string;
  kind?: string;
  capacity?: NumberMap;
  properties?: Record<string, unknown>;
}

interface PlacementGroupDocument extends Record<string, unknown> {
  pool?: InternalReference;
  capability?: string;
  candidates?: InternalReference[];
  resources?: NumberMap;
}

interface PlacementDemandDocument extends Record<string, unknown> {
  candidate?: InternalReference;
  pool?: InternalReference;
  resources?: NumberMap;
}

interface PlacementNetworkDocument extends Record<string, unknown> {
  from?: InternalReference;
  to?: InternalReference;
  latency?: number;
}

interface PlacementEventLatencyDocument extends Record<string, unknown> {
  pool?: InternalReference;
  latency?: number;
}

interface PlacementEventDocument extends Record<string, unknown> {
  pool?: InternalReference;
  latency?: PlacementEventLatencyDocument[];
}

interface PlacementTransitionDocument extends Record<string, unknown> {
  from?: InternalReference;
  to?: InternalReference;
  metric?: InternalReference;
  maximum?: number;
  enforcement?: 'hard' | 'soft';
  penalty?: number;
}

interface PlacementCapacityRuleDocument extends Record<string, unknown> {
  resources?: string[];
  scope?: 'invocation' | 'selectedCandidate';
}

interface PlacementGlobalLatencyDocument extends Record<string, unknown> {
  metric?: InternalReference;
  includeExecution?: boolean;
  exclusive?: 'routing' | 'condition';
  parallel?: 'max' | 'sum';
}

interface BimSpecDocument extends Record<string, unknown> {
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

interface BimDocument extends Record<string, unknown> {
  apiVersion?: string;
  kind?: string;
  metadata?: BimMetadataDocument;
  spec?: BimSpecDocument;
}

interface BindingDecision extends Record<string, unknown> {
  kind?: string;
  binding?: Record<string, InternalReference>;
}

interface BindingSolution extends Record<string, unknown> {
  decision?: BindingDecision;
  metrics?: unknown;
  objectives?: unknown;
  penalties?: unknown;
  violations?: unknown;
  evaluation?: unknown;
}

interface BindingResult extends Record<string, unknown> {
  termination?: string;
  solutions?: BindingSolution[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(source: string | undefined): BimDocument | null {
  if (!source) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed as BimDocument : null;
  } catch {
    return null;
  }
}

function isRegisteredResourceRef(value: unknown): value is RegisteredResourceRef {
  return isRecord(value)
    && typeof value.namespace === 'string'
    && typeof value.name === 'string'
    && typeof value.version === 'string'
    && typeof value.digest === 'string';
}

function kindForLocalResource(path: string, files: WorkspaceFiles): string {
  const document = parseJson(files[path]);
  if (typeof document?.kind === 'string') return document.kind;
  if (path.toLowerCase().endsWith('.bpmn') || path.toLowerCase().endsWith('.xml')) return 'BPMN';
  return 'Unknown';
}

function instanceResources(root: BimDocument | null, files: WorkspaceFiles): ResourceEntry[] {
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

function registeredResourceLabel(reference: RegisteredResourceRef): string {
  return `${reference.namespace}/${reference.name}@${reference.version}`;
}

function errorDiagnostics(error: unknown, fallbackCode: string): Diagnostic[] {
  if (isRecord(error) && Array.isArray(error.diagnostics) && error.diagnostics.length) {
    return error.diagnostics.filter(isRecord) as Diagnostic[];
  }
  return [{ code: fallbackCode, message: error instanceof Error ? error.message : String(error) }];
}

function modesFromAnalysis(value: unknown): CompatibleMode[] {
  if (!isRecord(value) || !Array.isArray(value.compatibleModes)) return [];
  return value.compatibleModes.filter((item): item is CompatibleMode => isRecord(item) && item.compatible === true
    && isBimResourceRef(item.engine) && isBimResourceRef(item.registration) && typeof item.mode === 'string');
}

function isBimResourceRef(value: unknown): value is BimResourceRef {
  return isRecord(value)
    && typeof value.namespace === 'string'
    && typeof value.name === 'string'
    && typeof value.version === 'string'
    && typeof value.digest === 'string';
}

function executionKey(item: CompatibleMode): string {
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

function resourcePathForDiagnostic(resources: ResourceEntry[], item: Diagnostic): string | undefined {
  const explicit = item.resourcePath || item.path;
  const direct = resources.find((resource) => resource.path === explicit);
  if (direct) return direct.path;
  const id = item.resource || explicit;
  return resources.find((resource) => resource.id === id)?.path;
}

function diagnosticSelection(source: string, item: Diagnostic): { anchor: number; head: number } | undefined {
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
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_AST_ASSERTION = { op: 'gte', left: { path: 'metrics.latency' }, right: { literal: 0 } };

function RenameField({
  label,
  ariaLabel,
  value,
  validate,
  onCommit,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  validate?: (nextValue: string) => string | undefined;
  onCommit: (nextValue: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const errorId = useId();

  const commit = (nextValue = draft) => {
    if (nextValue === value) {
      setError('');
      return;
    }
    const issue = !IDENTIFIER_PATTERN.test(nextValue)
      ? 'Start with a letter and use only letters, numbers, dots, underscores, or hyphens.'
      : validate?.(nextValue);
    if (issue) {
      setDraft(value);
      setError(issue);
      return;
    }
    setError('');
    onCommit(nextValue);
  };

  return <label className="rename-field">
    {label}
    <input
      aria-label={ariaLabel}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? errorId : undefined}
      value={draft}
      pattern="[A-Za-z][A-Za-z0-9_.-]*"
      onChange={(event) => {
        setDraft(event.target.value);
        setError('');
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
          setError('');
        }
      }}
    />
    {error && <small id={errorId} role="alert">{error}</small>}
  </label>;
}

function isSourceExpression(value: unknown, depth = 0): boolean {
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

function nextIdentifier(values: Record<string, unknown>, prefix: string): string {
  let index = Object.keys(values).length + 1;
  while (values[`${prefix}${index}`]) index += 1;
  return `${prefix}${index}`;
}

function optionalNumber(value: string): number | undefined {
  if (value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface CommonResourceFormProps {
  document: BimDocument;
  onChange: (next: BimDocument) => void;
  availablePaths: string[];
}

function FormSection({
  eyebrow,
  title,
  description,
  count,
  children,
  className = '',
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  count?: number | string;
  children: ReactNode;
  className?: string;
}) {
  return <section className={`form-section ${className}`.trim()}>
    <header className="form-section-heading">
      <div>
        {eyebrow && <span className="micro-label">{eyebrow}</span>}
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {count !== undefined && <span className="form-count" aria-label={`${count} items`}>{count}</span>}
    </header>
    <div className="form-section-body">{children}</div>
  </section>;
}

function FormCard({
  title,
  eyebrow,
  summary,
  children,
  actions,
  className = '',
}: {
  title: ReactNode;
  eyebrow?: string;
  summary?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <article className={`form-card ${className}`.trim()}>
    <header className="form-card-heading">
      <div>
        {eyebrow && <span className="micro-label">{eyebrow}</span>}
        <h4>{title}</h4>
        {summary && <p>{summary}</p>}
      </div>
      {actions && <div className="form-card-actions">{actions}</div>}
    </header>
    <div className="form-card-body">{children}</div>
  </article>;
}

function EmptyFormState({ children }: { children: ReactNode }) {
  return <p className="form-empty">{children}</p>;
}

function ReferenceEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: InternalReference | undefined;
  onChange: (next: InternalReference) => void;
}) {
  return <fieldset className="reference-editor">
    <legend>{label}</legend>
    <div className="form-grid form-grid-compact">
      <label>Resource<input aria-label={`${id} ${label} resource`} value={value?.resource || ''} onChange={(event) => onChange({ ...value, resource: event.target.value })} placeholder="resource id" /></label>
      <label>Element<input aria-label={`${id} ${label} id`} value={value?.id || ''} onChange={(event) => onChange({ ...value, id: event.target.value })} placeholder="element id" /></label>
    </div>
  </fieldset>;
}

function CommonResourceForm({ document, onChange, availablePaths }: CommonResourceFormProps) {
  const setName = (name: string) => onChange({ ...document, metadata: { ...document.metadata, name } });
  const setOptionalMetadata = (key: 'description' | 'version', value: string) => {
    const metadata = { ...document.metadata };
    if (value) metadata[key] = value;
    else delete metadata[key];
    onChange({ ...document, metadata });
  };
  return (
    <div className="resource-form">
      <FormSection eyebrow="Document" title="Resource identity" description="Stable metadata used in diagnostics, packages and registry references." className="form-section-identity">
        <div className="form-grid">
          <label>Name<input value={document.metadata?.name || ''} onChange={(event) => setName(event.target.value)} /></label>
          <label>Version<input value={document.metadata?.version || ''} onChange={(event) => setOptionalMetadata('version', event.target.value)} placeholder="Optional…" /></label>
          <label className="form-field-wide">Description<textarea value={document.metadata?.description || ''} onChange={(event) => setOptionalMetadata('description', event.target.value)} placeholder="What role does this resource play?" /></label>
        </div>
      </FormSection>
      <SpecificResourceForm document={document} onChange={onChange} availablePaths={availablePaths} />
    </div>
  );
}

function ConstraintExpressionEditor({ id, label, value, onChange }: { id: string; label: string; value: unknown; onChange: (next: unknown) => void }) {
  const language = typeof value === 'string' ? 'cel' : 'ast';
  const [draft, setDraft] = useState<string>(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    setError('');
  }, [language, value]);

  const changeLanguage = (nextLanguage: string) => {
    if (nextLanguage === 'cel') onChange('metrics.latency >= 0');
    else onChange(DEFAULT_AST_ASSERTION);
  };

  const updateDraft = (source: string) => {
    setDraft(source);
    if (language === 'cel') {
      setError('');
      onChange(source);
      return;
    }
    try {
      const parsed = JSON.parse(source);
      if (!isSourceExpression(parsed) || typeof parsed === 'string') throw new Error('invalid AST');
      setError('');
      onChange(parsed);
    } catch {
      setError('Enter a BIM expression AST using literal, path, op/left/right, op/value, or op/args.');
    }
  };

  return <div className="constraint-expression">
    <div className="form-grid">
      <label>{label} language<select aria-label={`${id} ${label} language`} value={language} onChange={(event) => changeLanguage(event.target.value)}><option value="cel">CEL</option><option value="ast">JSON AST</option></select></label>
    </div>
    <label><span>{label}</span><textarea aria-label={`${id} ${label}`} aria-invalid={Boolean(error)} value={draft} onChange={(event) => updateDraft(event.target.value)} /></label>
    {error && <small role="alert">{error}</small>}
  </div>;
}

function ConstraintSetForm({ spec, updateSpec }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void }) {
  const constraints = spec.constraints ?? {};
  const updateConstraint = (id: string, next: ConstraintDocument) => updateSpec({ ...spec, constraints: { ...constraints, [id]: next } });
  const removeConstraint = (id: string) => {
    const next = { ...constraints };
    delete next[id];
    updateSpec({ ...spec, constraints: next });
  };
  const addConstraint = (assertion: unknown) => {
    const id = nextIdentifier(constraints, 'constraint');
    updateSpec({ ...spec, constraints: { ...constraints, [id]: { assert: assertion, enforcement: 'hard' } } });
  };

  return <FormSection eyebrow="Policy" title="Constraints" description="Declare hard feasibility gates and soft preferences. Each card keeps its assertion and penalty together." count={Object.keys(constraints).length}>
    {Object.keys(constraints).length === 0 && <EmptyFormState>No constraints. The binding is governed only by candidate eligibility and optimization.</EmptyFormState>}
    <div className="form-card-list constraint-list">{Object.entries(constraints).map(([id, constraint], index) => <FormCard
      key={id}
      eyebrow={`Rule ${String(index + 1).padStart(2, '0')}`}
      title={<code>{id}</code>}
      summary={constraint.enforcement === 'soft' ? 'Preference with an explicit cost when violated.' : 'Required for every feasible solution.'}
      actions={<Button variant="ghost" size="sm" onClick={() => removeConstraint(id)}>Remove constraint</Button>}
    >
      <div className="form-grid form-grid-compact">
        <label>Enforcement<select aria-label={`${id} enforcement`} value={constraint.enforcement} onChange={(event) => {
          const enforcement = event.target.value as ConstraintDocument['enforcement'];
          const next: ConstraintDocument = { ...constraint, enforcement };
          if (event.target.value === 'soft' && next.penalty === undefined) next.penalty = { literal: 1 };
          if (event.target.value === 'hard') delete next.penalty;
          updateConstraint(id, next);
        }}><option value="hard">hard · must hold</option><option value="soft">soft · may be penalized</option></select></label>
      </div>
      <ConstraintExpressionEditor id={id} label="assertion" value={constraint.assert} onChange={(assertion) => updateConstraint(id, { ...constraint, assert: assertion })} />
      {constraint.enforcement === 'soft' && <ConstraintExpressionEditor id={id} label="penalty" value={constraint.penalty ?? { literal: 1 }} onChange={(penalty) => updateConstraint(id, { ...constraint, penalty })} />}
    </FormCard>)}</div>
    <div className="form-add-bar">
      <div><strong>Add a rule</strong><small>CEL is concise; AST is portable and structurally validated.</small></div>
      <div className="inline-actions"><Button variant="secondary" onClick={() => addConstraint('metrics.latency >= 0')}>Add CEL constraint</Button><Button variant="secondary" onClick={() => addConstraint(DEFAULT_AST_ASSERTION)}>Add AST constraint</Button></div>
    </div>
  </FormSection>;
}

function OptimizationForm({ spec, updateSpec }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void }) {
  const terms = spec.terms ?? [];
  const penalties = spec.penalties ?? [];
  const objectiveType: NonNullable<BimSpecDocument['type']> = spec.type || (
    spec.mode === 'pareto' ? terms.length >= 3 ? 'MANY' : terms.length === 2 ? 'MULTI' : 'MONO' : 'MONO'
  );
  const minimumTerms = objectiveType === 'MANY' ? 3 : objectiveType === 'MULTI' ? 2 : spec.mode === 'satisfy' ? 0 : 1;
  const maximumTerms = objectiveType === 'MULTI' ? 3 : Number.POSITIVE_INFINITY;
  const defaultTerm = (): OptimizationTermDocument => ({ metric: { resource: 'application', id: 'latency' }, weight: 1 });
  const withMinimumTerms = (items: OptimizationTermDocument[], minimum: number) => {
    const next = [...items];
    while (next.length < minimum) next.push(defaultTerm());
    return next;
  };
  const updateTerm = (index: number, term: OptimizationTermDocument) => updateSpec({ ...spec, terms: terms.map((current, itemIndex) => itemIndex === index ? term : current) });
  const updatePenalty = (index: number, penalty: OptimizationPenaltyDocument) => updateSpec({ ...spec, penalties: penalties.map((current, itemIndex) => itemIndex === index ? penalty : current) });
  const updateMode = (mode: string) => {
    const next: BimSpecDocument = { ...spec, mode: mode as BimSpecDocument['mode'] };
    if (mode === 'satisfy') {
      next.type = 'MONO';
      next.terms = [];
    } else next.terms = withMinimumTerms(terms, objectiveType === 'MANY' ? 3 : objectiveType === 'MULTI' ? 2 : 1);
    updateSpec(next);
  };
  const updateType = (type: NonNullable<BimSpecDocument['type']>) => {
    const next: BimSpecDocument = { ...spec, type };
    const minimum = type === 'MANY' ? 3 : type === 'MULTI' ? 2 : spec.mode === 'satisfy' ? 0 : 1;
    if (type !== 'MONO' && next.mode === 'satisfy') next.mode = 'pareto';
    next.terms = withMinimumTerms(terms, minimum);
    if (type === 'MULTI') next.terms = next.terms.slice(0, 3);
    updateSpec(next);
  };

  return <>
    <FormSection eyebrow="Contract" title="Optimization shape" description="Objective type controls cardinality; strategy controls how those objectives are compared.">
      <div className="objective-contract">
        <div className="form-grid">
          <label>Objective type<select aria-label="Objective type" value={objectiveType} onChange={(event) => updateType(event.target.value as NonNullable<BimSpecDocument['type']>)}><option value="MONO">MONO · 1 or more utility terms</option><option value="MULTI">MULTI · 2 to 3 terms</option><option value="MANY">MANY · 3 or more terms</option></select></label>
          <label>Strategy<select aria-label="Strategy" value={spec.mode || 'satisfy'} onChange={(event) => updateMode(event.target.value)}><option value="satisfy">satisfy · feasibility only</option><option value="weighted">weighted sum</option><option value="lexicographic">lexicographic order</option><option value="pareto">Pareto frontier</option></select></label>
        </div>
        <div className="objective-readout" aria-live="polite">
          <strong>{objectiveType}</strong>
          <span>{terms.length} objective{terms.length === 1 ? '' : 's'}</span>
          <small>{spec.mode === 'satisfy' ? 'Feasibility mode uses no terms.' : objectiveType === 'MULTI' ? 'Valid range: 2–3.' : objectiveType === 'MANY' ? 'Valid range: 3 or more.' : 'Valid range: 1 or more.'}</small>
        </div>
      </div>
    </FormSection>

    <FormSection eyebrow="Utility" title="Objective terms" description="Reference application metrics, then optionally override direction, relative weight and normalization." count={terms.length}>
      {terms.length === 0 && <EmptyFormState>Satisfy mode has no objective terms. Choose another strategy to optimize metrics.</EmptyFormState>}
      <div className="form-card-list">{terms.map((term, index) => <FormCard
        key={index}
        eyebrow={`Objective ${String(index + 1).padStart(2, '0')}`}
        title={<>{term.metric?.id || 'Unnamed metric'} <span className="form-title-muted">from {term.metric?.resource || 'resource'}</span></>}
        actions={<Button variant="ghost" size="sm" disabled={terms.length <= minimumTerms} onClick={() => updateSpec({ ...spec, terms: terms.filter((_, itemIndex) => itemIndex !== index) })}>Remove term</Button>}
      >
        <div className="form-grid">
          <label>Metric resource<input aria-label={`Term ${index + 1} metric resource`} value={term.metric?.resource || ''} onChange={(event) => updateTerm(index, { ...term, metric: { ...term.metric, resource: event.target.value } })} /></label>
          <label>Metric id<input aria-label={`Term ${index + 1} metric id`} value={term.metric?.id || ''} onChange={(event) => updateTerm(index, { ...term, metric: { ...term.metric, id: event.target.value } })} /></label>
          <label>Direction<select aria-label={`Term ${index + 1} direction`} value={term.direction || ''} onChange={(event) => {
            const next = { ...term };
            if (event.target.value) next.direction = event.target.value as OptimizationTermDocument['direction'];
            else delete next.direction;
            updateTerm(index, next);
          }}><option value="">metric default</option><option value="minimize">minimize</option><option value="maximize">maximize</option></select></label>
          <label>Weight<input aria-label={`Term ${index + 1} weight`} type="number" min="0" step="any" value={term.weight ?? ''} onChange={(event) => {
            const next = { ...term };
            const weight = optionalNumber(event.target.value);
            if (weight !== undefined && weight > 0) next.weight = weight;
            else delete next.weight;
            updateTerm(index, next);
          }} placeholder="relative" /></label>
        </div>
        <label className="check-field"><input aria-label={`Term ${index + 1} normalize`} type="checkbox" checked={Boolean(term.normalize)} onChange={(event) => {
          const next = { ...term };
          if (event.target.checked) next.normalize = { min: 0, max: 1, clamp: false };
          else delete next.normalize;
          updateTerm(index, next);
        }} /> Normalize this metric explicitly</label>
        {term.normalize && <div className="form-grid nested-fields">
          <label>Minimum<input aria-label={`Term ${index + 1} normalization minimum`} type="number" step="any" value={term.normalize.min} onChange={(event) => {
            const minimum = optionalNumber(event.target.value);
            if (minimum !== undefined) updateTerm(index, { ...term, normalize: { min: minimum, max: term.normalize!.max, clamp: term.normalize!.clamp } });
          }} /></label>
          <label>Maximum<input aria-label={`Term ${index + 1} normalization maximum`} type="number" step="any" value={term.normalize.max} onChange={(event) => {
            const maximum = optionalNumber(event.target.value);
            if (maximum !== undefined) updateTerm(index, { ...term, normalize: { min: term.normalize!.min, max: maximum, clamp: term.normalize!.clamp } });
          }} /></label>
          <label className="check-field"><input aria-label={`Term ${index + 1} normalization clamp`} type="checkbox" checked={Boolean(term.normalize.clamp)} onChange={(event) => updateTerm(index, { ...term, normalize: { min: term.normalize!.min, max: term.normalize!.max, clamp: event.target.checked } })} /> Clamp outside values</label>
        </div>}
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Expand the objective</strong><small>{objectiveType === 'MULTI' ? `${Math.max(0, 3 - terms.length)} slot${3 - terms.length === 1 ? '' : 's'} remaining.` : 'Add another metric utility term.'}</small></div><Button variant="secondary" disabled={spec.mode === 'satisfy' || terms.length >= maximumTerms} onClick={() => updateSpec({ ...spec, terms: [...terms, defaultTerm()] })}>Add objective term</Button></div>
    </FormSection>

    <FormSection eyebrow="Policy cost" title="Soft-constraint penalties" description="Optional weights link soft constraint violations into the optimization utility." count={penalties.length}>
      {penalties.length === 0 && <EmptyFormState>No explicit penalty weights. Constraint defaults remain in effect.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{penalties.map((penalty, index) => <FormCard
        key={index}
        eyebrow={`Penalty ${String(index + 1).padStart(2, '0')}`}
        title={<code>{penalty.constraint?.id || 'constraint'}</code>}
        actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, penalties: penalties.filter((_, itemIndex) => itemIndex !== index) })}>Remove penalty</Button>}
      >
        <div className="form-grid">
          <label>Constraint resource<input aria-label={`Penalty ${index + 1} constraint resource`} value={penalty.constraint?.resource || ''} onChange={(event) => updatePenalty(index, { ...penalty, constraint: { ...penalty.constraint, resource: event.target.value } })} /></label>
          <label>Constraint id<input aria-label={`Penalty ${index + 1} constraint id`} value={penalty.constraint?.id || ''} onChange={(event) => updatePenalty(index, { ...penalty, constraint: { ...penalty.constraint, id: event.target.value } })} /></label>
          <label>Weight<input aria-label={`Penalty ${index + 1} weight`} type="number" min="0" step="any" value={penalty.weight ?? ''} onChange={(event) => {
            const next = { ...penalty };
            const weight = optionalNumber(event.target.value);
            if (weight !== undefined && weight > 0) next.weight = weight;
            else delete next.weight;
            updatePenalty(index, next);
          }} placeholder="relative" /></label>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Link a soft rule</strong><small>Use the resource id and constraint id declared in the package.</small></div><Button variant="secondary" onClick={() => updateSpec({ ...spec, penalties: [...penalties, { constraint: { resource: 'constraints', id: 'constraint1' }, weight: 1 }] })}>Add penalty</Button></div>
    </FormSection>
  </>;
}

function InstanceForm({ spec, updateSpec, availablePaths }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void; availablePaths: string[] }) {
  const resources = isRecord(spec.resources) ? spec.resources : {};
  const entries = Object.entries(resources).flatMap(([role, group]) => isRecord(group)
    ? Object.entries(group).map(([id, target]) => ({ role, id, target }))
    : []);
  const [newRole, setNewRole] = useState('constraintSet');
  const [newId, setNewId] = useState('resource1');
  const [newPath, setNewPath] = useState(availablePaths[0] || 'resource.json');

  useEffect(() => {
    if (availablePaths.length > 0 && !availablePaths.includes(newPath)) setNewPath(availablePaths[0]);
  }, [availablePaths, newPath]);

  const replaceEntry = (role: string, id: string, nextRole: string, nextId: string, target: unknown) => {
    if (!IDENTIFIER_PATTERN.test(nextRole) || !IDENTIFIER_PATTERN.test(nextId)) return;
    const nextResources: Record<string, Record<string, unknown>> = {};
    Object.entries(resources).forEach(([groupRole, group]) => {
      if (isRecord(group)) nextResources[groupRole] = { ...group };
    });
    if ((nextRole !== role || nextId !== id) && nextResources[nextRole]?.[nextId] !== undefined) return;
    delete nextResources[role]?.[id];
    if (nextResources[role] && Object.keys(nextResources[role]).length === 0) delete nextResources[role];
    nextResources[nextRole] = { ...(nextResources[nextRole] || {}), [nextId]: target };
    updateSpec({ ...spec, resources: nextResources });
  };

  const removeEntry = (role: string, id: string) => {
    if (entries.length <= 1) return;
    const nextResources: Record<string, Record<string, unknown>> = {};
    Object.entries(resources).forEach(([groupRole, group]) => {
      if (isRecord(group)) nextResources[groupRole] = { ...group };
    });
    delete nextResources[role]?.[id];
    if (Object.keys(nextResources[role] || {}).length === 0) delete nextResources[role];
    updateSpec({ ...spec, resources: nextResources });
  };

  const addLocalEntry = () => {
    if (!IDENTIFIER_PATTERN.test(newRole) || !IDENTIFIER_PATTERN.test(newId) || !newPath || isRecord(resources[newRole]) && newId in resources[newRole]) return;
    updateSpec({ ...spec, resources: { ...resources, [newRole]: { ...(isRecord(resources[newRole]) ? resources[newRole] : {}), [newId]: newPath } } });
    setNewId(`resource${entries.length + 2}`);
  };

  return <>
    <FormSection eyebrow="Language" title="Profile" description="The profile defines the core vocabulary and compatible dialect set for this package.">
      <div className="form-grid"><label>Profile identifier<input aria-label="Profile" value={spec.profile || ''} pattern="[A-Za-z][A-Za-z0-9_.-]*/v[1-9][0-9]*" onChange={(event) => updateSpec({ ...spec, profile: event.target.value })} /></label></div>
    </FormSection>
    <FormSection eyebrow="Package graph" title="Resource index" description="Every logical id resolves either to a file in this package or to an immutable registry object." count={entries.length}>
    <div className="form-card-list">{entries.map(({ role, id, target }, index) => {
      const local = typeof target === 'string';
      const registered = isRegisteredResourceRef(target) ? target : { namespace: '', name: '', version: '', digest: '' };
      const localOptions = local && !availablePaths.includes(target) ? [target, ...availablePaths] : availablePaths;
      return <FormCard
        key={`${role}/${id}`}
        eyebrow={`Reference ${String(index + 1).padStart(2, '0')} · ${role}`}
        title={<code>{id}</code>}
        summary={local ? `Local package file · ${target}` : `Registered · ${registered.namespace}/${registered.name}@${registered.version}`}
        actions={<Button variant="ghost" size="sm" disabled={entries.length <= 1} onClick={() => removeEntry(role, id)}>Remove reference</Button>}
      >
        <div className="form-grid form-grid-compact">
          <RenameField
            label="Role"
            ariaLabel={`${role}/${id} role`}
            value={role}
            validate={(nextRole) => nextRole !== role && isRecord(resources[nextRole]) && resources[nextRole][id] !== undefined
              ? `The ${nextRole}/${id} reference already exists.`
              : undefined}
            onCommit={(nextRole) => replaceEntry(role, id, nextRole, id, target)}
          />
          <RenameField
            label="Resource id"
            ariaLabel={`${role}/${id} resource id`}
            value={id}
            validate={(nextId) => nextId !== id && isRecord(resources[role]) && resources[role][nextId] !== undefined
              ? `The ${role}/${nextId} reference already exists.`
              : undefined}
            onCommit={(nextId) => replaceEntry(role, id, role, nextId, target)}
          />
          <label>Reference type<select aria-label={`${role}/${id} reference type`} value={local ? 'local' : 'registered'} onChange={(event) => replaceEntry(role, id, role, id, event.target.value === 'local'
            ? availablePaths[0] || 'resource.json'
            : { namespace: 'example', name: id, version: '1.0.0', digest: `sha256-${'0'.repeat(64)}` })}><option value="local">package file</option><option value="registered">registered resource</option></select></label>
        </div>
        {local ? <div className="form-grid nested-fields"><label>Package file<select aria-label={`${role}/${id} package file`} value={target} onChange={(event) => replaceEntry(role, id, role, id, event.target.value)}>{localOptions.map((path) => <option value={path} key={path}>{path}</option>)}</select></label></div> : <div className="form-grid nested-fields">
          <label>Namespace<input aria-label={`${role}/${id} namespace`} value={registered.namespace} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, namespace: event.target.value })} /></label>
          <label>Name<input aria-label={`${role}/${id} registered name`} value={registered.name} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, name: event.target.value })} /></label>
          <label>Version<input aria-label={`${role}/${id} registered version`} value={registered.version} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, version: event.target.value })} /></label>
          <label className="form-field-wide">SHA-256 digest<input aria-label={`${role}/${id} digest`} value={registered.digest} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, digest: event.target.value })} /></label>
        </div>}
      </FormCard>;
    })}</div>
    <div className="form-add-bar form-add-bar-fields">
      <div><strong>Add package reference</strong><small>Choose a semantic role, stable id and an existing file.</small></div>
      <div className="form-grid">
        <label>Role<input aria-label="New resource role" value={newRole} pattern="[A-Za-z][A-Za-z0-9_.-]*" onChange={(event) => setNewRole(event.target.value)} /></label>
        <label>Resource id<input aria-label="New resource id" value={newId} pattern="[A-Za-z][A-Za-z0-9_.-]*" onChange={(event) => setNewId(event.target.value)} /></label>
        <label>Package file<select aria-label="New resource package file" value={newPath} onChange={(event) => setNewPath(event.target.value)}>{availablePaths.map((path) => <option value={path} key={path}>{path}</option>)}</select></label>
      </div>
      <Button variant="secondary" disabled={!availablePaths.length || !IDENTIFIER_PATTERN.test(newRole) || !IDENTIFIER_PATTERN.test(newId) || Boolean(isRecord(resources[newRole]) && resources[newRole][newId] !== undefined)} onClick={addLocalEntry}>Add local reference</Button>
    </div>
    </FormSection>
  </>;
}

function JsonObjectEditor({
  id,
  label,
  value,
  onChange,
  scalarOnly = true,
}: {
  id: string;
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
  scalarOnly?: boolean;
}) {
  const serialized = JSON.stringify(value || {}, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(serialized);
    setError('');
  }, [serialized]);

  const update = (source: string) => {
    setDraft(source);
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isRecord(parsed) || scalarOnly && Object.values(parsed).some((item) => (
        item !== null && (
          !['string', 'number', 'boolean'].includes(typeof item)
          || typeof item === 'number' && !Number.isFinite(item)
        )
      ))) {
        throw new Error('not a scalar map');
      }
      setError('');
      onChange(parsed);
    } catch {
      setError(scalarOnly
        ? 'Enter a JSON object whose values are strings, finite numbers, booleans, or null.'
        : 'Enter a valid JSON object.');
    }
  };

  return <details className="advanced-editor">
    <summary>{label}</summary>
    <label><span className="sr-only">{label}</span>
      <textarea aria-label={`${id} ${label}`} aria-invalid={Boolean(error)} value={draft} onChange={(event) => update(event.target.value)} />
      {error && <small role="alert">{error}</small>}
    </label>
  </details>;
}

function NumberMapEditor({
  id,
  label,
  value,
  onChange,
  emptyLabel = 'No resource dimensions configured.',
}: {
  id: string;
  label: string;
  value: NumberMap | undefined;
  onChange: (next: NumberMap) => void;
  emptyLabel?: string;
}) {
  const entries = Object.entries(value || {});
  const rename = (key: string, nextKey: string) => {
    if (nextKey === key || !IDENTIFIER_PATTERN.test(nextKey) || value?.[nextKey] !== undefined) return;
    onChange(Object.fromEntries(entries.map(([entryKey, amount]) => [entryKey === key ? nextKey : entryKey, amount])));
  };
  const remove = (key: string) => onChange(Object.fromEntries(entries.filter(([entryKey]) => entryKey !== key)));
  const add = () => {
    const key = nextIdentifier(value || {}, 'resource');
    onChange({ ...value, [key]: 0 });
  };

  return <fieldset className="number-map-editor">
    <legend>{label}</legend>
    {entries.length === 0 && <EmptyFormState>{emptyLabel}</EmptyFormState>}
    <div className="number-map-list">{entries.map(([key, amount]) => <div className="number-map-row" key={key}>
      <RenameField
        label="Dimension"
        ariaLabel={`${id} ${label} ${key} dimension`}
        value={key}
        validate={(nextKey) => nextKey !== key && value?.[nextKey] !== undefined
          ? `The ${nextKey} dimension already exists.`
          : undefined}
        onCommit={(nextKey) => rename(key, nextKey)}
      />
      <label>Amount<input aria-label={`${id} ${label} ${key} amount`} type="number" min="0" step="any" value={amount} onChange={(event) => {
        const nextAmount = optionalNumber(event.target.value);
        if (nextAmount !== undefined && nextAmount >= 0) onChange({ ...value, [key]: nextAmount });
      }} /></label>
      <Button variant="ghost" size="sm" onClick={() => remove(key)}>Remove</Button>
    </div>)}</div>
    <Button variant="secondary" size="sm" onClick={add}>Add dimension</Button>
  </fieldset>;
}

function ReferenceListEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: InternalReference[] | undefined;
  onChange: (next: InternalReference[]) => void;
}) {
  const references = value || [];
  return <fieldset className="reference-list-editor">
    <legend>{label}</legend>
    {references.length === 0 && <EmptyFormState>No references yet.</EmptyFormState>}
    <div className="reference-list">{references.map((reference, index) => <div className="reference-list-row" key={index}>
      <ReferenceEditor id={`${id} reference ${index + 1}`} label={`Reference ${index + 1}`} value={reference} onChange={(next) => onChange(references.map((item, itemIndex) => itemIndex === index ? next : item))} />
      <Button variant="ghost" size="sm" disabled={references.length <= 1} onClick={() => onChange(references.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
    </div>)}</div>
    <Button variant="secondary" size="sm" onClick={() => onChange([...references, { resource: 'catalog', id: 'candidate' }])}>Add reference</Button>
  </fieldset>;
}

function ApplicationForm({ spec, updateSpec }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void }) {
  const tasks = spec.tasks || {};
  const metrics = spec.metrics || {};
  const [newMetricId, setNewMetricId] = useState('metric');
  const updateTask = (id: string, next: TaskDocument) => updateSpec({ ...spec, tasks: { ...tasks, [id]: next } });
  const updateMetric = (id: string, next: MetricDocument) => updateSpec({ ...spec, metrics: { ...metrics, [id]: next } });
  const removeTask = (id: string) => {
    if (Object.keys(tasks).length <= 1) return;
    const next = { ...tasks };
    delete next[id];
    updateSpec({ ...spec, tasks: next });
  };
  const removeMetric = (id: string) => {
    const next = { ...metrics };
    delete next[id];
    updateSpec({ ...spec, metrics: next });
  };
  const setMetricField = (id: string, metric: MetricDocument, key: keyof MetricDocument, value: unknown) => {
    const next = { ...metric };
    if (value === '' || value === undefined) delete next[key];
    else next[key] = value as never;
    updateMetric(id, next);
  };

  return <>
    <FormSection eyebrow="Composition" title="Tasks" description="Service tasks select candidates by capability; local tasks stay inside the workflow and require no binding." count={Object.keys(tasks).length}>
    <div className="form-card-list">
      {Object.entries(tasks).map(([id, task]) => {
        const taskObject = typeof task === 'string' ? {} : task;
        const kind = typeof task === 'string' ? 'service' : task.kind || 'service';
        const requirement = typeof task === 'string' ? task : task.requires;
        const capability = typeof requirement === 'string' ? requirement : requirement?.type || '';
        const predicate = typeof requirement === 'object' ? requirement.predicate : undefined;
        return <FormCard
          key={id}
          eyebrow={kind === 'local' ? 'Local step' : 'Bound service'}
          title={<code>{id}</code>}
          summary={kind === 'local' ? 'Executed without candidate selection.' : `Requires ${capability || 'an unspecified capability'}.`}
          actions={<Button variant="ghost" size="sm" disabled={Object.keys(tasks).length <= 1} onClick={() => removeTask(id)}>Remove task</Button>}
        >
          <div className="form-grid form-grid-compact">
            <label>Kind<select aria-label={`${id} kind`} value={kind} onChange={(event) => {
              if (event.target.value === 'local') {
                const next = { ...taskObject, kind: 'local' as const };
                delete next.requires;
                updateTask(id, next);
              } else {
                updateTask(id, { ...taskObject, kind: 'service', requires: capability || 'service/new' });
              }
            }}><option value="service">service</option><option value="local">local</option></select></label>
            <label>Capability type<input disabled={kind === 'local'} aria-label={`${id} capability`} value={capability} onChange={(event) => {
              const type = event.target.value;
              if (predicate === undefined && typeof task === 'string') updateTask(id, type);
              else updateTask(id, {
                ...taskObject,
                kind: 'service',
                requires: predicate === undefined ? type : { type, predicate },
              });
            }} placeholder="capability type" /></label>
          </div>
          {kind === 'service' && <>
            <label className="check-field"><input aria-label={`${id} predicate enabled`} type="checkbox" checked={predicate !== undefined} onChange={(event) => {
              updateTask(id, {
                ...taskObject,
                kind: 'service',
                requires: event.target.checked
                  ? { type: capability || 'service/new', predicate: 'candidate.properties.enabled == true' }
                  : capability || 'service/new',
              });
            }} /> Filter candidates with a typed predicate</label>
            {predicate !== undefined && <ConstraintExpressionEditor id={id} label="predicate" value={predicate} onChange={(nextPredicate) => updateTask(id, {
              ...taskObject,
              kind: 'service',
              requires: { type: capability || 'service/new', predicate: nextPredicate },
            })} />}
          </>}
        </FormCard>;
      })}
    </div>
    <div className="form-add-bar"><div><strong>Add composition task</strong><small>The new task starts as a bindable service requirement.</small></div><Button variant="secondary" onClick={() => {
      const id = nextIdentifier(tasks, 'task');
      updateSpec({ ...spec, tasks: { ...tasks, [id]: `service/${id}` } });
    }}>Add task</Button></div>
    </FormSection>

    <FormSection eyebrow="Quality model" title="Metrics" description="Define units and aggregation once; catalogs provide candidate values through metric bindings." count={Object.keys(metrics).length}>
    {Object.keys(metrics).length === 0 && <EmptyFormState>No quality metrics are declared.</EmptyFormState>}
    <div className="form-card-list">
      {Object.entries(metrics).map(([id, metric]) => {
        const domain = typeof metric.domain === 'string' ? metric.domain : isRecord(metric.domain) ? 'custom' : '';
        const aggregation = typeof metric.aggregation === 'string' ? metric.aggregation : isRecord(metric.aggregation) ? 'custom' : '';
        return <FormCard
          key={id}
          eyebrow={`${metric.direction || 'profile direction'} · ${metric.scope || 'profile scope'}`}
          title={<code>{id}</code>}
          summary={`${metric.unit || 'unit not set'} · ${aggregation || 'aggregation not set'}`}
          actions={<Button variant="ghost" size="sm" onClick={() => removeMetric(id)}>Remove metric</Button>}
        >
          <div className="form-grid">
            <label>Unit<input aria-label={`${id} unit`} value={metric.unit || ''} onChange={(event) => setMetricField(id, metric, 'unit', event.target.value)} placeholder="For example, ms…" /></label>
            <label>Direction<select aria-label={`${id} direction`} value={metric.direction || ''} onChange={(event) => setMetricField(id, metric, 'direction', event.target.value)}><option value="">profile default</option><option value="minimize">minimize</option><option value="maximize">maximize</option></select></label>
            <label>Scope<select aria-label={`${id} scope`} value={metric.scope || ''} onChange={(event) => setMetricField(id, metric, 'scope', event.target.value)}><option value="">profile default</option><option value="invocation">per invocation</option><option value="selectedCandidate">once per selected candidate</option></select></label>
            <label>Domain<select aria-label={`${id} domain`} value={domain} onChange={(event) => {
              if (event.target.value !== 'custom') setMetricField(id, metric, 'domain', event.target.value);
            }}><option value="">unspecified</option><option value="real">real</option><option value="integer">integer</option><option value="ratio">ratio</option>{domain === 'custom' && <option value="custom">custom (expert source)</option>}</select></label>
            <label>Aggregation<select aria-label={`${id} aggregation`} value={aggregation} onChange={(event) => {
              if (event.target.value !== 'custom') setMetricField(id, metric, 'aggregation', event.target.value);
            }}><option value="">unspecified</option><option value="sum">sum</option><option value="product">product</option><option value="min">minimum</option><option value="max">maximum</option>{aggregation === 'custom' && <option value="custom">custom (expert source)</option>}</select></label>
            <label>Neutral value<input aria-label={`${id} neutral`} type="number" step="any" value={metric.neutral ?? ''} onChange={(event) => setMetricField(id, metric, 'neutral', optionalNumber(event.target.value))} /></label>
          </div>
        </FormCard>;
      })}
    </div>
    <div className="form-add-bar form-add-bar-fields">
      <div><strong>Add quality metric</strong><small>Identifiers become stable references in catalogs, constraints and objectives.</small></div>
      <div className="form-grid"><label>New metric id<input aria-label="New metric id" value={newMetricId} pattern="[A-Za-z][A-Za-z0-9_.-]*" onChange={(event) => setNewMetricId(event.target.value)} /></label></div>
      <Button variant="secondary" disabled={!IDENTIFIER_PATTERN.test(newMetricId) || Boolean(metrics[newMetricId])} onClick={() => {
      updateSpec({
        ...spec,
        metrics: {
          ...metrics,
          [newMetricId]: { type: 'number', unit: '1', domain: 'real', direction: 'minimize', scope: 'invocation', aggregation: 'sum' },
        },
      });
      setNewMetricId(nextIdentifier({ ...metrics, [newMetricId]: {} }, 'metric'));
      }}>Add metric</Button>
    </div>
    </FormSection>

    <FormSection eyebrow="Control flow" title="Workflow" description="The workflow orders task invocations and feeds metric aggregation.">
      {isRecord(spec.workflow) && isRecord(spec.workflow.bpmn)
        ? <ReferenceEditor id="application workflow" label="BPMN process" value={spec.workflow.bpmn as InternalReference} onChange={(bpmn) => updateSpec({ ...spec, workflow: { ...spec.workflow as Record<string, unknown>, bpmn } })} />
        : <div className="workflow-form-summary"><strong>Structured BIM workflow</strong><p>Edit its nested sequence, parallel, exclusive and repeat nodes in the dedicated Workflow JSON tab.</p></div>}
    </FormSection>
  </>;
}

function capabilityItems(value: CandidateDocument['provides']): CapabilityDocument[] {
  if (Array.isArray(value)) return value.length ? value : ['service/new'];
  return value === undefined ? ['service/new'] : [value];
}

function capabilityType(value: CapabilityDocument): string {
  return typeof value === 'string' ? value : value.type || '';
}

function CandidateCatalogForm({ spec, updateSpec }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void }) {
  const candidates = spec.candidates || {};
  const metricBindings = spec.metricBindings || {};
  const [newMetricAlias, setNewMetricAlias] = useState('metric');
  const updateCandidate = (id: string, next: CandidateDocument) => updateSpec({ ...spec, candidates: { ...candidates, [id]: next } });
  const updateBinding = (alias: string, next: InternalReference) => updateSpec({ ...spec, metricBindings: { ...metricBindings, [alias]: next } });

  const replaceMetricAlias = (alias: string, nextAlias: string) => {
    if (nextAlias === alias || !IDENTIFIER_PATTERN.test(nextAlias) || metricBindings[nextAlias]) return;
    const nextBindings = Object.fromEntries(Object.entries(metricBindings).map(([key, value]) => [key === alias ? nextAlias : key, value]));
    const nextCandidates = Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => {
      const metrics = { ...(candidate.metrics || {}) };
      if (alias in metrics) {
        metrics[nextAlias] = metrics[alias];
        delete metrics[alias];
      }
      return [id, { ...candidate, metrics }];
    }));
    updateSpec({ ...spec, metricBindings: nextBindings, candidates: nextCandidates });
  };

  const removeMetricBinding = (alias: string) => {
    const nextBindings = { ...metricBindings };
    delete nextBindings[alias];
    const nextCandidates = Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => {
      const metrics = { ...(candidate.metrics || {}) };
      delete metrics[alias];
      return [id, { ...candidate, metrics }];
    }));
    updateSpec({ ...spec, metricBindings: nextBindings, candidates: nextCandidates });
  };

  return <>
    <FormSection eyebrow="Metric bridge" title="Metric bindings" description="Aliases connect every candidate QoS column to a metric declared by the Application." count={Object.keys(metricBindings).length}>
    {Object.keys(metricBindings).length === 0 && <EmptyFormState>No metric aliases. Candidates can still be selected, but they provide no QoS values.</EmptyFormState>}
    <div className="form-card-list form-card-list-compact">{Object.entries(metricBindings).map(([alias, reference], index) => <FormCard
      key={alias}
      eyebrow={`Binding ${String(index + 1).padStart(2, '0')}`}
      title={<code>{alias}</code>}
      summary={`${reference.resource || 'resource'}/${reference.id || 'metric'}`}
      actions={<Button variant="ghost" size="sm" onClick={() => removeMetricBinding(alias)}>Remove metric binding</Button>}
    >
      <div className="form-grid">
        <RenameField
          label="Alias"
          ariaLabel={`${alias} metric alias`}
          value={alias}
          validate={(nextAlias) => nextAlias !== alias && nextAlias in metricBindings
            ? `The ${nextAlias} metric alias already exists.`
            : undefined}
          onCommit={(nextAlias) => replaceMetricAlias(alias, nextAlias)}
        />
        <label>Metric resource<input aria-label={`${alias} metric resource`} value={reference.resource || ''} onChange={(event) => updateBinding(alias, { ...reference, resource: event.target.value })} /></label>
        <label>Metric id<input aria-label={`${alias} metric id`} value={reference.id || ''} onChange={(event) => updateBinding(alias, { ...reference, id: event.target.value })} /></label>
      </div>
    </FormCard>)}</div>
    <div className="form-add-bar form-add-bar-fields">
      <div><strong>Add metric alias</strong><small>The alias becomes a QoS column on every candidate card.</small></div>
      <div className="form-grid"><label>New metric alias<input aria-label="New metric alias" value={newMetricAlias} onChange={(event) => setNewMetricAlias(event.target.value)} /></label></div>
      <Button variant="secondary" disabled={!IDENTIFIER_PATTERN.test(newMetricAlias) || Boolean(metricBindings[newMetricAlias])} onClick={() => {
        updateSpec({ ...spec, metricBindings: { ...metricBindings, [newMetricAlias]: { resource: 'application', id: newMetricAlias } } });
        setNewMetricAlias(nextIdentifier({ ...metricBindings, [newMetricAlias]: {} }, 'metric'));
      }}>Add metric binding</Button>
    </div>
    </FormSection>

    <FormSection eyebrow="Supply" title="Candidates" description="Capabilities determine eligibility; QoS values let engines compare the eligible implementations." count={Object.keys(candidates).length}>
    {Object.keys(candidates).length === 0 && <EmptyFormState>No candidate implementations are available.</EmptyFormState>}
    <div className="form-card-list candidate-list">{Object.entries(candidates).map(([id, candidate], candidateIndex) => {
      const capabilities = capabilityItems(candidate.provides);
      const aliases = Array.from(new Set([...Object.keys(metricBindings), ...Object.keys(candidate.metrics || {})]));
      const setCapabilities = (next: CapabilityDocument[]) => updateCandidate(id, {
        ...candidate,
        provides: Array.isArray(candidate.provides) || next.length > 1 ? next : next[0],
      });
      return <FormCard
        key={id}
        eyebrow={`Candidate ${String(candidateIndex + 1).padStart(2, '0')} · ${capabilities.length} capabilit${capabilities.length === 1 ? 'y' : 'ies'}`}
        title={<code>{id}</code>}
        summary={aliases.length ? `${aliases.length} QoS field${aliases.length === 1 ? '' : 's'} available.` : 'No QoS fields are bound.'}
        actions={<Button variant="ghost" size="sm" disabled={Object.keys(candidates).length <= 1} onClick={() => {
          const next = { ...candidates };
          delete next[id];
          updateSpec({ ...spec, candidates: next });
        }}>Remove candidate</Button>}
      >
        <div className="form-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Eligibility</span><h5>Capabilities</h5></div><Button variant="secondary" size="sm" onClick={() => setCapabilities([...capabilities, 'service/new'])}>Add capability</Button></div>
          <div className="nested-card-list">{capabilities.map((capability, index) => <div className="nested-card" key={index}>
            <div className="form-grid form-grid-compact"><label>Capability type<input aria-label={`${id} capability ${index + 1} type`} value={capabilityType(capability)} onChange={(event) => {
              const next = [...capabilities];
              next[index] = typeof capability === 'string' ? event.target.value : { ...capability, type: event.target.value };
              setCapabilities(next);
            }} /></label></div>
            <JsonObjectEditor id={`${id} capability ${index + 1}`} label="properties" value={typeof capability === 'string' ? {} : capability.properties} onChange={(properties) => {
              const next = [...capabilities];
              next[index] = { type: capabilityType(capability), properties: properties as ScalarMap };
              setCapabilities(next);
            }} />
            <Button variant="ghost" size="sm" disabled={capabilities.length <= 1} onClick={() => setCapabilities(capabilities.filter((_, itemIndex) => itemIndex !== index))}>Remove capability</Button>
          </div>)}</div>
        </div>
        <div className="form-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Ownership</span><h5>Provider</h5></div></div>
          <div className="form-grid">
          <label>Provider resource<input aria-label={`${id} provider resource`} value={candidate.provider?.resource || ''} onChange={(event) => {
            const next = { ...candidate };
            const resource = event.target.value;
            if (resource || candidate.provider?.id) next.provider = { resource, id: candidate.provider?.id || '' };
            else delete next.provider;
            updateCandidate(id, next);
          }} /></label>
          <label>Provider id<input aria-label={`${id} provider id`} value={candidate.provider?.id || ''} onChange={(event) => {
            const next = { ...candidate };
            const providerId = event.target.value;
            if (providerId || candidate.provider?.resource) next.provider = { resource: candidate.provider?.resource || '', id: providerId };
            else delete next.provider;
            updateCandidate(id, next);
          }} /></label>
          </div>
          <JsonObjectEditor id={id} label="properties" value={candidate.properties} onChange={(properties) => updateCandidate(id, { ...candidate, properties: properties as ScalarMap })} />
        </div>
        <div className="form-subgroup qos-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Quality values</span><h5>QoS matrix</h5></div></div>
          {aliases.length === 0 && <EmptyFormState>Add a metric binding to expose QoS inputs.</EmptyFormState>}
          <div className="form-grid">{aliases.map((alias) => <label key={alias}>{alias}<input aria-label={`${id} QoS ${alias}`} type="number" step="any" value={candidate.metrics?.[alias] ?? ''} onChange={(event) => {
          const metrics = { ...(candidate.metrics || {}) };
          const value = optionalNumber(event.target.value);
          if (value === undefined) delete metrics[alias];
          else metrics[alias] = value;
          updateCandidate(id, { ...candidate, metrics });
          }} /></label>)}</div>
        </div>
      </FormCard>;
    })}</div>
    <div className="form-add-bar"><div><strong>Add implementation</strong><small>Create a candidate, then declare its capabilities and QoS values.</small></div><Button variant="secondary" onClick={() => {
      const id = nextIdentifier(candidates, 'candidate');
      updateSpec({ ...spec, candidates: { ...candidates, [id]: { provides: 'service/new', metrics: {} } } });
    }}>Add candidate</Button></div>
    </FormSection>
  </>;
}

function RoutingOverlayForm({ spec, updateSpec }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void }) {
  const explicit = Array.isArray(spec.entries);
  const entries = spec.entries || [];
  const total = entries.reduce((sum, entry) => sum + (typeof entry.probability === 'number' ? entry.probability : 0), 0);
  const balanced = Math.abs(total - 1) < 1e-9;
  const updateEntry = (index: number, next: RoutingEntryDocument) => updateSpec({ ...spec, entries: entries.map((entry, itemIndex) => itemIndex === index ? next : entry) });
  const setMode = (mode: 'uniform' | 'explicit') => {
    const next = { ...spec };
    if (mode === 'uniform') {
      next.uniform = true;
      delete next.entries;
    } else {
      delete next.uniform;
      next.entries = entries.length ? entries : [
        { target: { resource: 'application', id: 'branch1' }, probability: 0.5 },
        { target: { resource: 'application', id: 'branch2' }, probability: 0.5 },
      ];
    }
    updateSpec(next);
  };

  return <>
    <FormSection eyebrow="Control-flow weights" title="Routing policy" description="Use uniform branch weights, or list the exact probability for each exclusive branch.">
      <div className="routing-mode-grid">
        <label className={`choice-card ${!explicit ? 'is-selected' : ''}`}><input type="radio" name="routing-mode" value="uniform" checked={!explicit} onChange={() => setMode('uniform')} /><span><strong>Uniform</strong><small>The compiler distributes probability equally inside every XOR.</small></span></label>
        <label className={`choice-card ${explicit ? 'is-selected' : ''}`}><input type="radio" name="routing-mode" value="explicit" checked={explicit} onChange={() => setMode('explicit')} /><span><strong>Explicit ledger</strong><small>Every routed branch receives a declared decimal probability.</small></span></label>
      </div>
    </FormSection>
    {explicit && <FormSection eyebrow="Probability ledger" title="Branch entries" description="Targets are exclusive branch ids (or BPMN sequenceFlow ids). Analyze verifies every XOR independently." count={entries.length}>
      <div className={`routing-balance ${balanced ? 'is-balanced' : 'is-open'}`}>
        <div><span>Listed total</span><strong>Σ {total.toFixed(3)}</strong></div>
        <p>{balanced ? 'The listed entries form one complete probability distribution.' : 'This total is not one. That can be valid only when entries span multiple XOR groups; Analyze checks each group.'}</p>
      </div>
      <div className="form-card-list form-card-list-compact">{entries.map((entry, index) => <FormCard
        key={index}
        eyebrow={`Route ${String(index + 1).padStart(2, '0')}`}
        title={<code>{entry.target?.id || 'branch'}</code>}
        summary={`${((entry.probability || 0) * 100).toFixed(1)}% of this branch group`}
        actions={<Button variant="ghost" size="sm" disabled={entries.length <= 1} onClick={() => updateSpec({ ...spec, entries: entries.filter((_, itemIndex) => itemIndex !== index) })}>Remove route</Button>}
      >
        <div className="form-grid">
          <label>Target resource<input aria-label={`Route ${index + 1} target resource`} value={entry.target?.resource || ''} onChange={(event) => updateEntry(index, { ...entry, target: { ...entry.target, resource: event.target.value } })} /></label>
          <label>Target branch<input aria-label={`Route ${index + 1} target id`} value={entry.target?.id || ''} onChange={(event) => updateEntry(index, { ...entry, target: { ...entry.target, id: event.target.value } })} /></label>
          <label>Probability<input aria-label={`Route ${index + 1} probability`} type="number" min="0" max="1" step="any" value={entry.probability ?? 0} onChange={(event) => {
            const probability = optionalNumber(event.target.value);
            if (probability !== undefined && probability >= 0 && probability <= 1) updateEntry(index, { ...entry, probability });
          }} /></label>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add routed branch</strong><small>Remember to keep every XOR group complete and normalized.</small></div><Button variant="secondary" onClick={() => updateSpec({ ...spec, entries: [...entries, { target: { resource: 'application', id: `branch${entries.length + 1}` }, probability: 0 }] })}>Add route</Button></div>
    </FormSection>}
  </>;
}

function PlacementForm({ spec, updateSpec }: { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void }) {
  const pools = spec.pools || {};
  const groups = spec.groups || {};
  const demands = spec.demands || [];
  const network = spec.network || [];
  const events = spec.events || {};
  const transitions = spec.transitions || {};
  const capacityRules = spec.capacityRules || [];
  const firstPool = Object.keys(pools)[0] || 'pool1';
  const removeKey = <T,>(values: Record<string, T>, id: string) => Object.fromEntries(Object.entries(values).filter(([key]) => key !== id)) as Record<string, T>;

  return <>
    <FormSection eyebrow="Topology workbench" title="Placement overview" description="Infrastructure, resource demand and latency stay optional for the instance, but explicit and inspectable when present." className="placement-overview-section">
      <div className="placement-overview">
        <div><strong>{Object.keys(pools).length}</strong><span>Pools</span></div>
        <div><strong>{Object.keys(groups).length + demands.length}</strong><span>Demand rules</span></div>
        <div><strong>{network.length}</strong><span>Network links</span></div>
        <div><strong>{Object.keys(transitions).length}</strong><span>Transitions</span></div>
      </div>
      <NumberMapEditor id="placement defaults" label="Default candidate demand" value={spec.defaults} onChange={(defaults) => updateSpec({ ...spec, defaults })} emptyLabel="No default demand; candidates consume only explicitly declared resources." />
    </FormSection>

    <FormSection eyebrow="Infrastructure" title="Pools" description="Pools are placement destinations with finite capacity and optional descriptive properties." count={Object.keys(pools).length}>
      <div className="form-card-list topology-card-list">{Object.entries(pools).map(([id, pool], index) => <FormCard
        key={id}
        eyebrow={`Pool ${String(index + 1).padStart(2, '0')} · ${pool.kind || 'untyped'}`}
        title={<code>{id}</code>}
        summary={`${Object.keys(pool.capacity || {}).length} capacity dimension${Object.keys(pool.capacity || {}).length === 1 ? '' : 's'}`}
        actions={<Button variant="ghost" size="sm" disabled={Object.keys(pools).length <= 1} onClick={() => updateSpec({ ...spec, pools: removeKey(pools, id) })}>Remove pool</Button>}
      >
        <div className="form-grid">
          <label>Display name<input aria-label={`${id} pool name`} value={pool.name || ''} onChange={(event) => updateSpec({ ...spec, pools: { ...pools, [id]: { ...pool, name: event.target.value } } })} placeholder="Optional label" /></label>
          <label>Kind<input aria-label={`${id} pool kind`} value={pool.kind || ''} onChange={(event) => {
            const next = { ...pool };
            if (event.target.value) next.kind = event.target.value;
            else delete next.kind;
            updateSpec({ ...spec, pools: { ...pools, [id]: next } });
          }} placeholder="edge, fog, cloud…" /></label>
        </div>
        <NumberMapEditor id={`${id} pool`} label="Capacity" value={pool.capacity} onChange={(capacity) => updateSpec({ ...spec, pools: { ...pools, [id]: { ...pool, capacity } } })} emptyLabel="This pool has no finite resource dimensions." />
        <JsonObjectEditor id={`${id} pool`} label="Advanced pool properties" value={pool.properties} scalarOnly={false} onChange={(properties) => updateSpec({ ...spec, pools: { ...pools, [id]: { ...pool, properties } } })} />
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add destination pool</strong><small>Start with an empty capacity map, then add dimensions such as CPU or memory.</small></div><Button variant="secondary" onClick={() => {
        const id = nextIdentifier(pools, 'pool');
        updateSpec({ ...spec, pools: { ...pools, [id]: { capacity: {} } } });
      }}>Add pool</Button></div>
    </FormSection>

    <FormSection eyebrow="Demand templates" title="Candidate groups" description="Apply one resource demand to a capability family or to an explicit list of candidates." count={Object.keys(groups).length}>
      {Object.keys(groups).length === 0 && <EmptyFormState>No grouped demand templates. Individual candidate demands can still be declared below.</EmptyFormState>}
      <div className="form-card-list">{Object.entries(groups).map(([id, group], index) => {
        const usesCandidates = Array.isArray(group.candidates);
        return <FormCard
          key={id}
          eyebrow={`Group ${String(index + 1).padStart(2, '0')}`}
          title={<code>{id}</code>}
          summary={usesCandidates ? `${group.candidates?.length || 0} explicit candidate references` : `Capability · ${group.capability || 'not set'}`}
          actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, groups: removeKey(groups, id) })}>Remove group</Button>}
        >
          <ReferenceEditor id={`${id} group`} label="Target pool" value={group.pool} onChange={(pool) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, pool } } })} />
          <div className="form-grid form-grid-compact"><label>Selection rule<select aria-label={`${id} group selection`} value={usesCandidates ? 'candidates' : 'capability'} onChange={(event) => {
            const next = { ...group };
            if (event.target.value === 'candidates') {
              delete next.capability;
              next.candidates = group.candidates?.length ? group.candidates : [{ resource: 'catalog', id: 'candidate' }];
            } else {
              delete next.candidates;
              next.capability = group.capability || 'service/new';
            }
            updateSpec({ ...spec, groups: { ...groups, [id]: next } });
          }}><option value="capability">capability family</option><option value="candidates">explicit candidates</option></select></label>
          {!usesCandidates && <label>Capability<input aria-label={`${id} group capability`} value={group.capability || ''} onChange={(event) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, capability: event.target.value } } })} /></label>}</div>
          {usesCandidates && <ReferenceListEditor id={`${id} group candidates`} label="Candidates" value={group.candidates} onChange={(candidates) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, candidates } } })} />}
          <NumberMapEditor id={`${id} group`} label="Resources per selected candidate" value={group.resources} onChange={(resources) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, resources } } })} />
        </FormCard>;
      })}</div>
      <div className="form-add-bar"><div><strong>Add grouped demand</strong><small>Useful when many candidates share the same pool and resource footprint.</small></div><Button variant="secondary" onClick={() => {
        const id = nextIdentifier(groups, 'group');
        updateSpec({ ...spec, groups: { ...groups, [id]: { pool: { resource: 'placement', id: firstPool }, capability: 'service/new', resources: {} } } });
      }}>Add candidate group</Button></div>
    </FormSection>

    <FormSection eyebrow="Demand matrix" title="Individual demands" description="Pin a candidate to a pool and override its default resource consumption." count={demands.length}>
      {demands.length === 0 && <EmptyFormState>No individual candidate-to-pool demands.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{demands.map((demand, index) => <FormCard
        key={index}
        eyebrow={`Demand ${String(index + 1).padStart(2, '0')}`}
        title={<code>{demand.candidate?.id || 'candidate'}</code>}
        summary={`Placed in ${demand.pool?.id || 'pool'}`}
        actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, demands: demands.filter((_, itemIndex) => itemIndex !== index) })}>Remove demand</Button>}
      >
        <div className="reference-pair">
          <ReferenceEditor id={`demand ${index + 1}`} label="Candidate" value={demand.candidate} onChange={(candidate) => updateSpec({ ...spec, demands: demands.map((item, itemIndex) => itemIndex === index ? { ...item, candidate } : item) })} />
          <ReferenceEditor id={`demand ${index + 1}`} label="Pool" value={demand.pool} onChange={(pool) => updateSpec({ ...spec, demands: demands.map((item, itemIndex) => itemIndex === index ? { ...item, pool } : item) })} />
        </div>
        <NumberMapEditor id={`demand ${index + 1}`} label="Resource override" value={demand.resources} onChange={(resources) => updateSpec({ ...spec, demands: demands.map((item, itemIndex) => itemIndex === index ? { ...item, resources } : item) })} />
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add individual demand</strong><small>Use an empty resource map to inherit defaults.</small></div><Button variant="secondary" onClick={() => updateSpec({ ...spec, demands: [...demands, { candidate: { resource: 'catalog', id: 'candidate' }, pool: { resource: 'placement', id: firstPool }, resources: {} }] })}>Add demand</Button></div>
    </FormSection>

    <FormSection eyebrow="Topology" title="Network latency" description="Edges connect pools. Symmetric mode mirrors every declared link; directed mode does not." count={network.length}>
      <div className="form-grid form-grid-compact"><label>Network mode<select aria-label="Network mode" value={spec.networkMode || 'directed'} onChange={(event) => updateSpec({ ...spec, networkMode: event.target.value as BimSpecDocument['networkMode'] })}><option value="directed">directed links</option><option value="symmetric">symmetric links</option></select></label></div>
      {network.length === 0 && <EmptyFormState>No inter-pool latency links.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{network.map((link, index) => <FormCard
        key={index}
        eyebrow={`Link ${String(index + 1).padStart(2, '0')}`}
        title={<><code>{link.from?.id || 'from'}</code><span className="topology-arrow">→</span><code>{link.to?.id || 'to'}</code></>}
        summary={`${link.latency ?? 0} latency units`}
        actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, network: network.filter((_, itemIndex) => itemIndex !== index) })}>Remove link</Button>}
      >
        <div className="reference-pair">
          <ReferenceEditor id={`network ${index + 1}`} label="From pool" value={link.from} onChange={(from) => updateSpec({ ...spec, network: network.map((item, itemIndex) => itemIndex === index ? { ...item, from } : item) })} />
          <ReferenceEditor id={`network ${index + 1}`} label="To pool" value={link.to} onChange={(to) => updateSpec({ ...spec, network: network.map((item, itemIndex) => itemIndex === index ? { ...item, to } : item) })} />
        </div>
        <div className="form-grid form-grid-compact"><label>Latency<input aria-label={`Network ${index + 1} latency`} type="number" min="0" step="any" value={link.latency ?? 0} onChange={(event) => {
          const latency = optionalNumber(event.target.value);
          if (latency !== undefined && latency >= 0) updateSpec({ ...spec, network: network.map((item, itemIndex) => itemIndex === index ? { ...item, latency } : item) });
        }} /></label></div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add network link</strong><small>Self-links can make zero-latency placement explicit.</small></div><Button variant="secondary" onClick={() => updateSpec({ ...spec, network: [...network, { from: { resource: 'placement', id: firstPool }, to: { resource: 'placement', id: firstPool }, latency: 0 }] })}>Add link</Button></div>
    </FormSection>

    <FormSection eyebrow="Ingress" title="External events" description="Event sources originate at one pool and may override latency to other pools." count={Object.keys(events).length}>
      {Object.keys(events).length === 0 && <EmptyFormState>No external ingress events.</EmptyFormState>}
      <div className="form-card-list">{Object.entries(events).map(([id, event], index) => <FormCard
        key={id}
        eyebrow={`Event ${String(index + 1).padStart(2, '0')}`}
        title={<code>{id}</code>}
        summary={`Origin · ${event.pool?.id || 'pool'} · ${event.latency?.length || 0} overrides`}
        actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, events: removeKey(events, id) })}>Remove event</Button>}
      >
        <ReferenceEditor id={`${id} event`} label="Origin pool" value={event.pool} onChange={(pool) => updateSpec({ ...spec, events: { ...events, [id]: { ...event, pool } } })} />
        <div className="form-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Overrides</span><h5>Pool latency</h5></div><Button variant="secondary" size="sm" onClick={() => updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: [...(event.latency || []), { pool: { resource: 'placement', id: firstPool }, latency: 0 }] } } })}>Add latency</Button></div>
          {(event.latency || []).length === 0 && <EmptyFormState>No event-specific latency overrides.</EmptyFormState>}
          <div className="nested-card-list">{(event.latency || []).map((override, overrideIndex) => <div className="nested-card" key={overrideIndex}>
            <ReferenceEditor id={`${id} event latency ${overrideIndex + 1}`} label="Destination pool" value={override.pool} onChange={(pool) => updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: (event.latency || []).map((item, itemIndex) => itemIndex === overrideIndex ? { ...item, pool } : item) } } })} />
            <div className="form-grid form-grid-compact"><label>Latency<input aria-label={`${id} event latency ${overrideIndex + 1}`} type="number" min="0" step="any" value={override.latency ?? 0} onChange={(changeEvent) => {
              const latency = optionalNumber(changeEvent.target.value);
              if (latency !== undefined && latency >= 0) updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: (event.latency || []).map((item, itemIndex) => itemIndex === overrideIndex ? { ...item, latency } : item) } } });
            }} /></label></div>
            <Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: (event.latency || []).filter((_, itemIndex) => itemIndex !== overrideIndex) } } })}>Remove latency</Button>
          </div>)}</div>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add ingress source</strong><small>Transitions can connect this event id to an application task.</small></div><Button variant="secondary" onClick={() => {
        const id = nextIdentifier(events, 'event');
        updateSpec({ ...spec, events: { ...events, [id]: { pool: { resource: 'placement', id: firstPool }, latency: [] } } });
      }}>Add event</Button></div>
    </FormSection>

    <FormSection eyebrow="Latency policy" title="Transitions" description="Bound end-to-end hops between events or tasks, with hard limits or weighted soft penalties." count={Object.keys(transitions).length}>
      {Object.keys(transitions).length === 0 && <EmptyFormState>No transition-specific latency bounds.</EmptyFormState>}
      <div className="form-card-list">{Object.entries(transitions).map(([id, transition], index) => <FormCard
        key={id}
        eyebrow={`Transition ${String(index + 1).padStart(2, '0')} · ${transition.enforcement || 'hard'}`}
        title={<code>{id}</code>}
        summary={`${transition.from?.id || 'source'} → ${transition.to?.id || 'target'} · max ${transition.maximum ?? 0}`}
        actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, transitions: removeKey(transitions, id) })}>Remove transition</Button>}
      >
        <div className="reference-pair">
          <ReferenceEditor id={`${id} transition`} label="From" value={transition.from} onChange={(from) => updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, from } } })} />
          <ReferenceEditor id={`${id} transition`} label="To" value={transition.to} onChange={(to) => updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, to } } })} />
        </div>
        <ReferenceEditor id={`${id} transition`} label="Latency metric" value={transition.metric} onChange={(metric) => updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, metric } } })} />
        <div className="form-grid">
          <label>Maximum<input aria-label={`${id} transition maximum`} type="number" min="0" step="any" value={transition.maximum ?? 0} onChange={(event) => {
            const maximum = optionalNumber(event.target.value);
            if (maximum !== undefined && maximum >= 0) updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, maximum } } });
          }} /></label>
          <label>Enforcement<select aria-label={`${id} transition enforcement`} value={transition.enforcement || 'hard'} onChange={(event) => {
            const next = { ...transition, enforcement: event.target.value as PlacementTransitionDocument['enforcement'] };
            if (event.target.value === 'soft') next.penalty = transition.penalty ?? 1;
            else delete next.penalty;
            updateSpec({ ...spec, transitions: { ...transitions, [id]: next } });
          }}><option value="hard">hard limit</option><option value="soft">soft limit</option></select></label>
          {(transition.enforcement === 'soft') && <label>Penalty<input aria-label={`${id} transition penalty`} type="number" min="0" step="any" value={transition.penalty ?? 1} onChange={(event) => {
            const penalty = optionalNumber(event.target.value);
            if (penalty !== undefined && penalty >= 0) updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, penalty } } });
          }} /></label>}
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add latency transition</strong><small>References may point to application tasks or placement events.</small></div><Button variant="secondary" onClick={() => {
        const id = nextIdentifier(transitions, 'transition');
        updateSpec({ ...spec, transitions: { ...transitions, [id]: { from: { resource: 'application', id: 'task1' }, to: { resource: 'application', id: 'task2' }, metric: { resource: 'application', id: 'latency' }, maximum: 0 } } });
      }}>Add transition</Button></div>
    </FormSection>

    <FormSection eyebrow="Capacity semantics" title="Capacity rules" description="Choose which demand dimensions accumulate per invocation or once per selected candidate." count={capacityRules.length}>
      {capacityRules.length === 0 && <EmptyFormState>No explicit capacity accounting rules.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{capacityRules.map((rule, index) => <FormCard
        key={index}
        eyebrow={`Rule ${String(index + 1).padStart(2, '0')}`}
        title={rule.resources?.join(', ') || 'resources'}
        summary={rule.scope === 'invocation' ? 'Charged for every workflow invocation.' : 'Charged once for each selected candidate.'}
        actions={<Button variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, capacityRules: capacityRules.filter((_, itemIndex) => itemIndex !== index) })}>Remove rule</Button>}
      >
        <div className="form-grid">
          <label>Resource dimensions<input aria-label={`Capacity rule ${index + 1} resources`} value={(rule.resources || []).join(', ')} onChange={(event) => updateSpec({ ...spec, capacityRules: capacityRules.map((item, itemIndex) => itemIndex === index ? { ...item, resources: Array.from(new Set(event.target.value.split(',').map((value) => value.trim()).filter(Boolean))) } : item) })} placeholder="memory, cpu" /></label>
          <label>Accounting scope<select aria-label={`Capacity rule ${index + 1} scope`} value={rule.scope || 'selectedCandidate'} onChange={(event) => updateSpec({ ...spec, capacityRules: capacityRules.map((item, itemIndex) => itemIndex === index ? { ...item, scope: event.target.value as PlacementCapacityRuleDocument['scope'] } : item) })}><option value="selectedCandidate">once per selected candidate</option><option value="invocation">per invocation</option></select></label>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add accounting rule</strong><small>List one or more comma-separated resource dimensions.</small></div><Button variant="secondary" onClick={() => updateSpec({ ...spec, capacityRules: [...capacityRules, { resources: ['memory'], scope: 'selectedCandidate' }] })}>Add capacity rule</Button></div>
    </FormSection>

    <FormSection eyebrow="End-to-end model" title="Global latency" description="Optionally derive one workflow-level latency metric from execution time, routing and pool topology.">
      <label className="choice-card global-latency-toggle"><input type="checkbox" aria-label="Enable global latency" checked={Boolean(spec.globalLatency)} onChange={(event) => {
        const next = { ...spec };
        if (event.target.checked) next.globalLatency = { metric: { resource: 'application', id: 'latency' }, includeExecution: true, exclusive: 'routing', parallel: 'max' };
        else delete next.globalLatency;
        updateSpec(next);
      }} /><span><strong>Compute global latency</strong><small>Fold placement and workflow timing into the selected metric.</small></span></label>
      {spec.globalLatency && <div className="global-latency-panel">
        <ReferenceEditor id="global latency" label="Output metric" value={spec.globalLatency.metric} onChange={(metric) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, metric } })} />
        <div className="form-grid">
          <label className="check-field"><input aria-label="Global latency include execution" type="checkbox" checked={Boolean(spec.globalLatency.includeExecution)} onChange={(event) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, includeExecution: event.target.checked } })} /> Include candidate execution latency</label>
          <label>Exclusive branches<select aria-label="Global latency exclusive" value={spec.globalLatency.exclusive || 'routing'} onChange={(event) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, exclusive: event.target.value as PlacementGlobalLatencyDocument['exclusive'] } })}><option value="routing">probability-weighted routing</option><option value="condition">static conditions</option></select></label>
          <label>Parallel branches<select aria-label="Global latency parallel" value={spec.globalLatency.parallel || 'max'} onChange={(event) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, parallel: event.target.value as PlacementGlobalLatencyDocument['parallel'] } })}><option value="max">critical path maximum</option><option value="sum">sum all branches</option></select></label>
        </div>
      </div>}
    </FormSection>
  </>;
}

function SpecificResourceForm({ document, onChange, availablePaths }: CommonResourceFormProps) {
  const spec = document.spec || {};
  const updateSpec = (nextSpec: BimSpecDocument) => onChange({ ...document, spec: nextSpec });

  if (document.kind === 'Application') {
    return <ApplicationForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.kind === 'CandidateCatalog') {
    return <CandidateCatalogForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.kind === 'ConstraintSet') {
    return <ConstraintSetForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.kind === 'Optimization') {
    return <OptimizationForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.kind === 'RoutingOverlay') {
    return <RoutingOverlayForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.kind === 'Placement') {
    return <PlacementForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.kind === 'Instance') {
    return <InstanceForm spec={spec} updateSpec={updateSpec} availablePaths={availablePaths} />;
  }

  return <p className="workspace-hint">This dialect is edited in expert mode so its versioned contract remains explicit.</p>;
}

function DecisionView({ decision }: { decision: BindingDecision | undefined }) {
  if (decision?.kind === 'binding' && decision.binding && typeof decision.binding === 'object') {
    return <table className="decision-table"><thead><tr><th>Task</th><th>Candidate resource</th><th>Candidate</th></tr></thead><tbody>{Object.entries(decision.binding).map(([task, candidate]) => <tr key={task}><td>{task}</td><td>{candidate?.resource}</td><td>{candidate?.id}</td></tr>)}</tbody></table>;
  }
  return <pre>{JSON.stringify(decision, null, 2)}</pre>;
}

async function workspaceFromArchive(archive: ArrayBuffer): Promise<{ files: WorkspaceFiles; response: Awaited<ReturnType<typeof apiClient.analyzeBimPackage>> }> {
  const candidateFiles = await unzipPackage(archive);
  const candidateRoot = parseJson(candidateFiles['instance.json']);
  if (candidateRoot?.apiVersion !== 'bim/v1' || candidateRoot?.kind !== 'Instance') {
    throw new Error('The package root must be a bim/v1 Instance.');
  }
  const canonicalFiles = packageFiles(candidateFiles);
  const response = await apiClient.analyzeBimPackage(zipStore(canonicalFiles));
  if (!response.valid) {
    const error = new Error('The BIM package did not pass analysis.') as Error & { diagnostics: Diagnostic[] };
    error.diagnostics = (response.diagnostics || []) as Diagnostic[];
    throw error;
  }
  return { files: canonicalFiles, response };
}

export function InstanceWorkspace() {
  const [files, setFiles] = useState<WorkspaceFiles>(DEFAULT_FILES);
  const [selectedPath, setSelectedPath] = useState('instance.json');
  const [status, setStatus] = useState<WorkspaceStatus>('idle');
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [result, setResult] = useState<BindingResult | null>(null);
  const [compatibleModes, setCompatibleModes] = useState<CompatibleMode[]>([]);
  const [selectedMode, setSelectedMode] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [tab, setTab] = useState<WorkspaceTab>('resources');
  const [bpmnDraft, setBpmnDraft] = useState(DEFAULT_BPMN);
  const [focusedBpmnElement, setFocusedBpmnElement] = useState<string | null>(null);
  const [editorSelection, setEditorSelection] = useState<{ anchor: number; head: number } | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [compiledIr, setCompiledIr] = useState<CompiledIr | null>(null);
  const [irLoading, setIrLoading] = useState(false);
  const [irError, setIrError] = useState<string | null>(null);
  const historyRef = useRef<WorkspaceFiles[]>([]);
  const baselineRef = useRef<WorkspaceFiles>(DEFAULT_FILES);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestedExample = useMemo(() => new URLSearchParams(window.location.search).get('example') || '', []);

  const root = useMemo(() => parseJson(files['instance.json']), [files]);
  const resources = useMemo(() => instanceResources(root, files), [root, files]);
  const selectedDocument = useMemo(() => parseJson(files[selectedPath]), [files, selectedPath]);
  const applicationResource = resources.find((resource) => resource.role === 'application' && resource.kind === 'Application');
  const application = applicationResource?.path ? parseJson(files[applicationResource.path]) : null;
  const bpmnResource = resources.find((resource) => resource.kind === 'BPMN');
  const bpmnPath = bpmnResource?.path;
  const workflowText = pretty(application?.spec?.workflow || {});
  const selectedCompatibility = compatibleModes.find((item) => executionKey(item) === selectedMode);
  const groupedResources = Object.keys(root?.spec?.resources || {}).map((role) => ({
    role,
    resources: resources.filter((resource) => resource.role === role),
  }));
  const selectedResource = resources.find((resource) => resource.path === selectedPath);
  const selectedKind = selectedPath === 'instance.json' ? 'Instance' : selectedResource?.kind || selectedDocument?.kind || 'Unknown';
  const selectedYaml = useMemo(() => selectedDocument ? toYaml(selectedDocument) : null, [selectedDocument]);
  const selectedDiff = useMemo(
    () => sourceDiff(baselineRef.current[selectedPath] || '', files[selectedPath] || ''),
    [files, selectedPath],
  );
  const selectedChanged = baselineRef.current[selectedPath] !== files[selectedPath];
  const progressIndex = status === 'completed' ? 4 : status === 'queued' ? 3 : status === 'valid' ? 2 : status === 'validating' ? 1 : 0;
  const exampleTransitionName = requestedExample ? `example-${requestedExample.replace(/[^a-z0-9]+/gi, '-')}` : undefined;

  useEffect(() => {
    void (async () => {
      if (requestedExample) {
        try {
          setStatus('validating');
          const archive = await apiClient.getBimExamplePackage(requestedExample);
          const prepared = await workspaceFromArchive(archive);
          setFiles(prepared.files);
          baselineRef.current = prepared.files;
          const nextBpmn = Object.keys(prepared.files).find((path) => path.endsWith('.bpmn'));
          setBpmnDraft(nextBpmn ? prepared.files[nextBpmn] : DEFAULT_BPMN);
          const modes = modesFromAnalysis(prepared.response);
          setCompatibleModes(modes);
          setSelectedMode(modes[0] ? executionKey(modes[0]) : '');
          setStatus('valid');
        } catch (reason: unknown) {
          setStatus('failed');
          setDiagnostics(errorDiagnostics(reason, 'example'));
        }
      } else {
        const draft = await loadDraft();
        if (draft && parseJson(draft['instance.json'])?.apiVersion === 'bim/v1') {
          setFiles(draft);
          baselineRef.current = draft;
          const path = Object.keys(draft).find((item) => item.endsWith('.bpmn'));
          if (path) setBpmnDraft(draft[path]);
        }
      }
      setHydrated(true);
    })();
    void apiClient.getBimExamples().then(setExamples).catch(() => setExamples([]));
  }, [requestedExample]);

  useEffect(() => {
    if (hydrated) void saveDraft(files);
  }, [files, hydrated]);

  const replaceWorkspace = (nextFiles: WorkspaceFiles) => {
    historyRef.current = [...historyRef.current.slice(-39), files];
    setHistoryDepth(historyRef.current.length);
    baselineRef.current = nextFiles;
    setFiles(nextFiles);
    setSelectedPath('instance.json');
    const nextBpmn = Object.keys(nextFiles).find((path) => path.endsWith('.bpmn'));
    setBpmnDraft(nextBpmn ? nextFiles[nextBpmn] : DEFAULT_BPMN);
    setCompatibleModes([]);
    setSelectedMode('');
    setResult(null);
    setCompiledIr(null);
    setIrError(null);
    setDiagnostics([]);
    setStatus('idle');
  };

  const updateWorkspace = (updater: (current: WorkspaceFiles) => WorkspaceFiles) => {
    setFiles((current) => {
      historyRef.current = [...historyRef.current.slice(-39), current];
      setHistoryDepth(historyRef.current.length);
      return updater(current);
    });
    setStatus('idle');
    setDiagnostics([]);
    setCompatibleModes([]);
    setSelectedMode('');
    setResult(null);
    setCompiledIr(null);
    setIrError(null);
  };

  const undoWorkspace = () => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setFiles(previous);
    setHistoryDepth(historyRef.current.length);
    const previousBpmn = Object.keys(previous).find((path) => path.endsWith('.bpmn'));
    setBpmnDraft(previousBpmn ? previous[previousBpmn] : DEFAULT_BPMN);
    setStatus('idle');
    setDiagnostics([]);
    setCompatibleModes([]);
    setSelectedMode('');
    setResult(null);
    setCompiledIr(null);
    setIrError(null);
  };

  const resetWorkspace = () => {
    const baseline = baselineRef.current;
    historyRef.current = [...historyRef.current.slice(-39), files];
    setHistoryDepth(historyRef.current.length);
    setFiles(baseline);
    const baselineBpmn = Object.keys(baseline).find((path) => path.endsWith('.bpmn'));
    setBpmnDraft(baselineBpmn ? baseline[baselineBpmn] : DEFAULT_BPMN);
    setSelectedPath('instance.json');
    setTab('resources');
    setStatus('idle');
    setDiagnostics([]);
    setCompatibleModes([]);
    setSelectedMode('');
    setResult(null);
    setCompiledIr(null);
    setIrError(null);
  };

  const moveWorkspaceTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const available = WORKSPACE_TABS.map((item, itemIndex) => ({ item, itemIndex })).filter(({ item }) =>
      (!item.bpmnOnly || Boolean(bpmnPath)) && (!item.jsonOnly || Boolean(selectedDocument)));
    const currentAvailableIndex = available.findIndex(({ itemIndex }) => itemIndex === index);
    const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (currentAvailableIndex + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
    const target = available[targetIndex];
    if (!target) return;
    setTab(target.item.id);
    tabRefs.current[target.itemIndex]?.focus();
  };

  const analyze = async (candidateFiles = files) => {
    setStatus('validating');
    setDiagnostics([]);
    setResult(null);
    try {
      const response = await apiClient.analyzeBimPackage(zipStore(packageFiles(candidateFiles)));
      const modes = modesFromAnalysis(response);
      setCompatibleModes(modes);
      setSelectedMode((current) => modes.some((item) => executionKey(item) === current)
        ? current
        : modes[0] ? executionKey(modes[0]) : '');
      setStatus(response.valid ? 'valid' : 'failed');
      setDiagnostics(response.diagnostics || []);
      return response;
    } catch (error: unknown) {
      setStatus('failed');
      setDiagnostics(errorDiagnostics(error, 'analysis'));
      throw error;
    }
  };

  const run = async () => {
    let mode = selectedCompatibility;
    if (!mode) {
      try {
        const analysis = await analyze();
        mode = modesFromAnalysis(analysis)[0];
      } catch {
        return;
      }
    }
    if (!mode) {
      setStatus('failed');
      setDiagnostics([{ code: 'engine', message: 'No engine mode is compatible with this BIM instance.' }]);
      return;
    }
    setStatus('queued');
    setDiagnostics([]);
    try {
      const snapshot = compiledIr ?? await apiClient.createBimSnapshot(zipStore(packageFiles(files)));
      const snapshotId = 'snapshot' in snapshot ? snapshot.snapshot : snapshot.id;
      const receipt = await apiClient.createBimJob(snapshotId, mode.engine, mode.registration, mode.mode);
      for (;;) {
        const job = await apiClient.getV1Job(receipt.id);
        if (job.status === 'completed') {
          setResult(isRecord(job.result) ? job.result as BindingResult : null);
          setStatus('completed');
          return;
        }
        if (job.status === 'failed') throw new Error(job.error || 'Job failed');
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    } catch (error: unknown) {
      setStatus('failed');
      setDiagnostics(errorDiagnostics(error, 'job'));
    }
  };

  const compileIr = async () => {
    setIrLoading(true);
    setIrError(null);
    try {
      const snapshot = await apiClient.createBimSnapshot(zipStore(packageFiles(files)));
      const document = await apiClient.getBimSnapshotIr(snapshot.id);
      setCompiledIr({ snapshot: snapshot.id, digest: snapshot.irDigest, document });
    } catch (error: unknown) {
      setIrError(error instanceof Error ? error.message : 'The current package could not be compiled.');
    } finally {
      setIrLoading(false);
    }
  };

  const importArchive = async (archive: ArrayBuffer) => {
    try {
      setStatus('validating');
      const prepared = await workspaceFromArchive(archive);
      replaceWorkspace(prepared.files);
      const modes = modesFromAnalysis(prepared.response);
      setCompatibleModes(modes);
      if (modes[0]) setSelectedMode(executionKey(modes[0]));
      setStatus('valid');
    } catch (error: unknown) {
      setStatus('failed');
      setDiagnostics(errorDiagnostics(error, 'import'));
    }
  };

  const loadExample = async (path: string) => {
    if (!path) return;
    try {
      await importArchive(await apiClient.getBimExamplePackage(path));
    } catch (error: unknown) {
      setStatus('failed');
      setDiagnostics(errorDiagnostics(error, 'example'));
    }
  };

  const exportPackage = () => {
    try {
      const archive = zipStore(files);
      const archiveBuffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([archiveBuffer], { type: 'application/vnd.bim+zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${root?.metadata?.name || 'instance'}.bim.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      setStatus('failed');
      setDiagnostics(errorDiagnostics(error, 'export'));
    }
  };

  const updateSelectedDocument = (document: BimDocument) => updateWorkspace((current) => ({ ...current, [selectedPath]: pretty(document) }));

  const updateWorkflow = (value: string) => {
    if (!applicationResource?.path || !application) return;
    try {
      const workflow = JSON.parse(value);
      updateWorkspace((current) => ({ ...current, [applicationResource.path!]: pretty({ ...application, spec: { ...application.spec, workflow } }) }));
    } catch {
      // The expert editor keeps the unfinished value without corrupting a valid document.
    }
  };

  const acceptBpmn = (xml: string) => {
    if (!bpmnPath) return;
    const normalized = xml.replace(/\r\n?/g, '\n');
    if (files[bpmnPath] !== normalized) updateWorkspace((current) => ({ ...current, [bpmnPath]: normalized }));
    setBpmnDraft(xml);
    setDiagnostics((current) => current.filter((item) => item.code !== 'bpmn-editor'));
  };

  const updateBpmnDraft = (xml: string) => {
    setBpmnDraft(xml);
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const parserError = parsed.getElementsByTagName('parsererror')[0];
    setDiagnostics((current) => {
      const retained = current.filter((item) => item.code !== 'bpmn-editor');
      if (!parserError) return retained;
      const detail = parserError.textContent?.replace(/\s+/g, ' ').trim() || 'invalid XML';
      return [...retained, {
        code: 'bpmn-editor',
        message: `BPMN XML was not applied: ${detail}`,
      }];
    });
  };

  const openDiagnostic = (item: Diagnostic) => {
    const element = item.bpmnElement || item.element;
    if (element && bpmnPath) {
      setFocusedBpmnElement(element);
      setTab('bpmn');
      return;
    }
    const path = resourcePathForDiagnostic(resources, item);
    if (path && files[path] !== undefined) {
      setSelectedPath(path);
      setEditorSelection(diagnosticSelection(files[path], item));
    } else {
      setEditorSelection(diagnosticSelection(files[selectedPath] || '', item));
    }
    setTab('expert');
  };

  return (
    <div className="playground-container instance-workspace">
      <header className="playground-header">
        <div className="playground-title-block" style={exampleTransitionName ? { viewTransitionName: exampleTransitionName } as CSSProperties : undefined}>
          <span className="kicker">04 · Experiment with a complete package</span>
          <h1>BIM Instance Workspace</h1>
          <p>Compose Profile-directed resources, inspect exact source, compile, match an Engine mode and verify the result.</p>
          {requestedExample && <span className="loaded-example"><Check aria-hidden="true" /> Loaded lesson <code>{requestedExample}</code></span>}
        </div>
        <div className="playground-actions">
          <div className="workspace-history-actions">
            <button type="button" onClick={undoWorkspace} disabled={!historyDepth}><History aria-hidden="true" /> Undo edit</button>
            <button type="button" onClick={resetWorkspace}><RotateCcw aria-hidden="true" /> Reset workspace</button>
          </div>
          <div className="workspace-package-actions">
            <label><span className="sr-only">Load backend example</span><select aria-label="Load backend example" defaultValue="" onChange={(event) => { void loadExample(event.target.value); event.currentTarget.value = ''; }}><option value="">Load example…</option>{examples.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
            <label className="workspace-file-button"><FileArchive aria-hidden="true" /><span>Import .bim.zip</span><input className="sr-only" type="file" accept=".zip,.bim.zip,application/zip,application/vnd.bim+zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.arrayBuffer().then(importArchive); event.currentTarget.value = ''; }} /></label>
            <Button variant="secondary" onClick={exportPackage}>Export .bim.zip</Button>
          </div>
          <Liquid className="workspace-run-cluster" blur={5} contrast={20} fill="var(--color-accent)" shadow="0 8px 18px rgba(92,38,20,.18)" filterPadding={16}>
            <Liquid.Item transition="snappy"><Button className="liquid-run-action" onClick={() => { void analyze(); }} disabled={status === 'validating'}>{status === 'validating' ? 'Analyzing…' : 'Analyze'}</Button></Liquid.Item>
            <Liquid.Item x={status === 'valid' || status === 'completed' ? -3 : 0} transition="snappy"><Button className="liquid-run-action" variant="primary" onClick={() => { void run(); }} disabled={status === 'queued'}>{status === 'queued' ? 'Running…' : 'Solve'}</Button></Liquid.Item>
          </Liquid>
        </div>
      </header>

      <ol className="workspace-progress" aria-label="BIM package lifecycle">
        {[
          ['Compose', 'Edit source resources'],
          ['Analyze', 'Validate and compile'],
          ['Match', 'Find exact compatible modes'],
          ['Solve', 'Send compiled IR'],
          ['Verify', 'Reevaluate the decision'],
        ].map(([label, detail], index) => <li key={label} className={index < progressIndex ? 'is-complete' : index === progressIndex ? 'is-current' : ''} aria-current={index === progressIndex ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span><strong>{label}</strong><small>{detail}</small></li>)}
      </ol>

      <div className="workspace-toolbar">
        <label><span>Compatible engine mode</span><select aria-label="Compatible engine mode" value={selectedMode} onChange={(event) => setSelectedMode(event.target.value)} disabled={!compatibleModes.length}><option value="">Analyze to select…</option>{compatibleModes.map((item) => { const value = executionKey(item); return <option key={value} value={value}>{item.engine.name} · {item.mode} · {item.registration.name}@{item.registration.version}</option>; })}</select></label>
        <div className="workspace-toolbar-explanation"><Waypoints aria-hidden="true" /><p>Analysis returns exact <strong>Engine + Registration + mode</strong> pins after Profile, IR, features and limits match.</p></div>
        <div className="workspace-status" aria-live="polite"><span>Package state</span><Badge variant={status === 'failed' ? 'error' : status === 'completed' || status === 'valid' ? 'success' : 'default'}>{status}</Badge></div>
      </div>

      <div className="workspace-layout">
        <nav className="resource-sidebar" aria-label="BIM resources">
          <header><span>Package index</span><strong>{resources.length + 1} documents</strong></header>
          <button type="button" className={selectedPath === 'instance.json' ? 'selected' : ''} onClick={() => { setSelectedPath('instance.json'); setTab('form'); }}><span>Instance root</span><code>instance.json</code></button>
          {groupedResources.map(({ role, resources: roleResources }) => <section className="resource-group" key={role}>
            <h2>{RESOURCE_ROLE_LABELS[role] || role}<small>{roleResources.length}</small></h2>
            {roleResources.map((resource) => resource.path
              ? <button type="button" key={resource.id} className={selectedPath === resource.path ? 'selected' : ''} onClick={() => { setSelectedPath(resource.path!); setTab(resource.kind === 'BPMN' ? 'bpmn' : 'form'); }}><span>{resource.kind}</span><strong>{resource.id}</strong><code>{resource.path}</code></button>
              : <div className="registered-resource" key={resource.id}><span>{resource.kind}</span><strong>{resource.id}</strong><code>{resource.registered ? registeredResourceLabel(resource.registered) : 'invalid target'}</code></div>)}
          </section>)}
          <Link className="resource-examples-link" to="/examples" viewTransition>Browse guided examples <ArrowRight aria-hidden="true" /></Link>
        </nav>

        <section className="workspace-main" aria-label="Resource editor">
          <div className="workspace-tabs" role="tablist" aria-label="Resource views">
            {WORKSPACE_TABS.map((item, index) => <button
              key={item.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              type="button"
              id={`workspace-tab-${item.id}`}
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`workspace-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => moveWorkspaceTab(event, index)}
              className={tab === item.id ? 'active' : ''}
              disabled={(item.bpmnOnly && !bpmnPath) || (item.jsonOnly && !selectedDocument)}
            >{item.label}</button>)}
          </div>
          <Card className="workspace-editor" padding="none">
            <section id="workspace-panel-resources" role="tabpanel" aria-labelledby="workspace-tab-resources" hidden={tab !== 'resources'} className="workspace-pane resource-overview"><div className="pane-heading"><span className="micro-label">Instance → Profile roles → resources</span><h2>Composable resources</h2><p>Application, candidate catalogs, constraint sets and optimization are independent source documents. RoutingOverlay, BPMN and Placement are typed resources in the application role; Placement is supplied by its installed Dialect.</p></div>{resources.map((resource) => <div className="resource-row" key={`${resource.role}/${resource.id}`}><strong>{resource.role}</strong><span>{resource.kind}</span><code>{resource.id}</code><code>{resource.path || (resource.registered ? registeredResourceLabel(resource.registered) : 'invalid target')}</code></div>)}</section>
            <section id="workspace-panel-form" role="tabpanel" aria-labelledby="workspace-tab-form" hidden={tab !== 'form'} className="workspace-pane">{selectedDocument ? <CommonResourceForm document={selectedDocument} onChange={updateSelectedDocument} availablePaths={Object.keys(files).filter((path) => path !== 'instance.json' && /\.(?:json|bpmn|xml)$/i.test(path))} /> : <Alert type="error">{selectedPath} is not valid JSON. Repair it in JSON source.</Alert>}</section>
            <section id="workspace-panel-expert" role="tabpanel" aria-labelledby="workspace-tab-expert" hidden={tab !== 'expert'} className="workspace-pane"><div className="editor-heading"><div><span className="micro-label">Exact package source</span><h2>{selectedPath}</h2></div><Badge>{selectedDocument?.kind || (selectedPath.endsWith('.bpmn') ? 'BPMN' : 'text')}</Badge></div>{tab === 'expert' && <Suspense fallback={<EditorLoading />}><CodeEditor key={selectedPath} ariaLabel={`${selectedPath} expert source`} language={selectedPath.endsWith('.json') ? 'json' : selectedPath.endsWith('.bpmn') ? 'xml' : 'text'} value={files[selectedPath] || ''} selection={editorSelection} onChange={(value) => { setEditorSelection(undefined); updateWorkspace((current) => ({ ...current, [selectedPath]: value })); }} minHeight="600px" maxHeight="70vh" /></Suspense>}</section>
            <section id="workspace-panel-yaml" role="tabpanel" aria-labelledby="workspace-tab-yaml" hidden={tab !== 'yaml'} className="workspace-pane"><div className="editor-heading"><div><span className="micro-label">YAML 1.2 projection</span><h2>{selectedPath}</h2></div><span>The canonical package remains JSON; this deterministic view is safe to copy into YAML-oriented tooling.</span></div>{tab === 'yaml' && selectedYaml ? <Suspense fallback={<EditorLoading />}><CodeEditor ariaLabel={`${selectedPath} YAML view`} language="text" value={selectedYaml} onChange={() => undefined} readOnly minHeight="600px" maxHeight="70vh" /></Suspense> : null}</section>
            <section id="workspace-panel-workflow" role="tabpanel" aria-labelledby="workspace-tab-workflow" hidden={tab !== 'workflow'} className="workspace-pane"><div className="editor-heading"><div><span className="micro-label">qos-binding/v1 source</span><h2>Native workflow</h2></div><span>Compact structured blocks</span></div>{tab === 'workflow' && <Suspense fallback={<EditorLoading />}><CodeEditor ariaLabel="Workflow JSON" value={workflowText} onChange={updateWorkflow} minHeight="600px" maxHeight="70vh" /></Suspense>}</section>
            <section id="workspace-panel-bpmn" role="tabpanel" aria-labelledby="workspace-tab-bpmn" hidden={tab !== 'bpmn'} className="workspace-pane bpmn-pane">{tab === 'bpmn' ? (bpmnPath ? <Suspense fallback={<EditorLoading />}><BpmnModeler candidateXml={bpmnDraft} fallbackXml={files[bpmnPath]} focusElement={focusedBpmnElement} onValidXml={acceptBpmn} onError={(message) => { setDiagnostics((current) => [...current.filter((item) => item.code !== 'bpmn-editor'), { code: 'bpmn-editor', message }]); }} /></Suspense> : <Alert type="info">This Instance does not declare a BPMN resource.</Alert>) : null}</section>
            <section id="workspace-panel-bpmnXml" role="tabpanel" aria-labelledby="workspace-tab-bpmnXml" hidden={tab !== 'bpmnXml'} className="workspace-pane"><div className="editor-heading"><div><span className="micro-label">omg/bpmn/2.0.2 source</span><h2>{bpmnPath || 'workflow.bpmn'}</h2></div><span>Only valid XML replaces the last valid diagram.</span></div>{tab === 'bpmnXml' && <Suspense fallback={<EditorLoading />}><CodeEditor ariaLabel="BPMN XML" language="xml" value={bpmnDraft} onChange={updateBpmnDraft} minHeight="600px" maxHeight="70vh" /></Suspense>}</section>
            <section id="workspace-panel-ir" role="tabpanel" aria-labelledby="workspace-tab-ir" hidden={tab !== 'ir'} className="workspace-pane"><div className="editor-heading"><div><span className="micro-label">Authoritative compiler output</span><h2>Binding problem IR</h2></div><Button variant="secondary" onClick={() => void compileIr()} disabled={irLoading}>{irLoading ? 'Compiling…' : compiledIr ? 'Recompile IR' : 'Compile IR'}</Button></div><div aria-live="polite">{irError && <Alert type="error">{irError}</Alert>}{compiledIr ? <><dl className="ir-provenance"><div><dt>Snapshot</dt><dd><code>{compiledIr.snapshot}</code></dd></div><div><dt>IR digest</dt><dd><code>{compiledIr.digest}</code></dd></div></dl><Suspense fallback={<EditorLoading />}><CodeEditor ariaLabel="Compiled binding problem IR" value={pretty(compiledIr.document)} onChange={() => undefined} readOnly minHeight="520px" maxHeight="65vh" /></Suspense></> : !irLoading && !irError ? <Alert type="info">Compile the current package to inspect the exact normalized IR sent to a compatible engine.</Alert> : null}</div></section>
            <section id="workspace-panel-diff" role="tabpanel" aria-labelledby="workspace-tab-diff" hidden={tab !== 'diff'} className="workspace-pane"><div className="editor-heading"><div><span className="micro-label">Current source against loaded baseline</span><h2>{selectedPath}</h2></div><Badge variant={selectedChanged ? 'accent' : 'success'}>{selectedChanged ? 'Modified' : 'Unchanged'}</Badge></div>{selectedChanged ? <pre className="source-diff" aria-label={`Changes to ${selectedPath}`}><code>{selectedDiff.map((line, index) => <span className={`diff-${line.kind}`} key={`${line.kind}-${index}`}><b aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</b>{line.value || ' '}</span>)}</code></pre> : <Alert type="info">This resource matches the baseline loaded into the workbench.</Alert>}</section>
          </Card>
        </section>

        <aside className="feedback-rail" aria-label="Package feedback">
          <section className={`feedback-state state-${status}`}>
            <span className="micro-label">Immediate feedback</span>
            <div><i className="status-dot" /><h2>{status === 'failed' ? 'Needs attention' : status === 'completed' ? 'Decision verified' : status === 'valid' ? 'Package compiled' : status === 'queued' ? 'Engine is running' : status === 'validating' ? 'Compiling package' : 'Unanalyzed changes'}</h2></div>
            <p>{status === 'idle' ? 'Edit freely, then Analyze to validate schemas, roles and semantics before selecting a solver.' : status === 'valid' ? `${compatibleModes.length} exact compatible execution path${compatibleModes.length === 1 ? '' : 's'} found.` : status === 'completed' ? 'The gateway has reevaluated the returned binding.' : status === 'failed' ? `${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} available below.` : 'The current operation does not block editing other local source.'}</p>
          </section>
          <section className="feedback-selection">
            <span className="micro-label">Selected source</span>
            <h3>{selectedKind}</h3>
            <code>{selectedPath}</code>
            <dl><div><dt>Profile</dt><dd>{root?.spec?.profile || 'unresolved'}</dd></div><div><dt>Role</dt><dd>{selectedResource?.role || 'container'}</dd></div><div><dt>Representation</dt><dd>{selectedPath.endsWith('.bpmn') ? 'XML Dialect' : 'JSON'}</dd></div></dl>
            <button type="button" className="feedback-source-button" onClick={() => setTab('expert')}>Expert source</button>
          </section>
          <section className="feedback-compatibility">
            <span className="micro-label">Compatible execution paths</span>
            {compatibleModes.length ? <ul>{compatibleModes.slice(0, 4).map((item) => <li key={executionKey(item)} className={executionKey(item) === selectedMode ? 'is-selected' : ''}><strong>{item.engine.name} · {item.mode}</strong><small>{item.registration.namespace}/{item.registration.name}@{item.registration.version}</small></li>)}</ul> : <p>Analyze to compare the compiled IR against Engine mode selectors and Registration pins.</p>}
            {compatibleModes.length > 4 && <small>+{compatibleModes.length - 4} more compatible paths</small>}
          </section>
          {diagnostics.length > 0 ? <Alert type="error"><h2>Diagnostics</h2><ul className="diagnostic-list">{diagnostics.map((item, index) => <li key={`${item.code}-${index}`}><button type="button" onClick={() => openDiagnostic(item)}><code>{item.code || 'diagnostic'}</code> {item.message || item.detail || JSON.stringify(item)} {(item.pointer || item.jsonPointer) && <small>{item.pointer || item.jsonPointer}</small>}</button></li>)}</ul></Alert> : <section className="feedback-trust"><ShieldCheck aria-hidden="true" /><p>Analysis and results stay authoritative: source and compiled artifacts are pinned separately, and engines never validate themselves.</p></section>}
        </aside>
      </div>

      {result && <section className="workspace-result-surface"><header><div><span className="micro-label">Gateway-reevaluated output</span><h2>Authoritative result</h2></div><p className="workspace-result-summary">{result.solutions?.length || 0} solution(s) · <strong>{result.termination || 'UNKNOWN'}</strong></p></header>{result.solutions?.map((solution, index) => <section className="workspace-decision" key={index}><div className="decision-heading"><Badge>{solution.decision?.kind || 'unknown'}</Badge><span>objectives: {JSON.stringify(solution.objectives || {})}</span></div><DecisionView decision={solution.decision} /><details><summary>Evaluation, penalties and violations</summary><pre>{JSON.stringify({ metrics: solution.metrics, objectives: solution.objectives, penalties: solution.penalties, violations: solution.violations, evaluation: solution.evaluation }, null, 2)}</pre></details></section>)}</section>}
    </div>
  );
}
