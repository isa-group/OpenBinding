export interface PipelineStage {
  id: string;
  step: string;
  title: string;
  short: string;
  long: string;
  /** What the stage pins, so that its output can be verified. */
  pin: string;
  href: string;
  cta: string;
}

export const PIPELINE: readonly PipelineStage[] = [
  { id: 'package', step: '01', title: 'Package', short: '.bim.zip of BIM v1 resources', long: 'A portable package of modular BIM v1 resources: the application workflow, candidate catalogs, constraints and the optimization objective.', pin: 'instance.json + resource digests', href: '/examples', cta: 'Browse example packages' },
  { id: 'validation', step: '02', title: 'Validation', short: 'Localized diagnostics', long: 'Every problem is reported where it lives: the resource, a JSON Pointer, a CEL span or a BPMN element, with a suggested fix.', pin: 'diagnostics with JSON Pointer paths', href: '/workbench', cta: 'Validate a package' },
  { id: 'profile', step: '03', title: 'Profile & dialects', short: 'Roles and resource types', long: 'The Profile fixes which roles the instance must fill and with what cardinality; installed dialects contribute resource types and IR features.', pin: 'schema + adapter digests', href: '/language', cta: 'Open the language guide' },
  { id: 'problem', step: '04', title: 'Binding problem', short: 'IR with its own digest', long: 'The instance is compiled into a BindingProblem IR. Its digest identifies exactly what any engine was asked to solve.', pin: 'bim/v1 BindingProblem digest', href: '/language/schemas/BindingProblem', cta: 'See the BindingProblem schema' },
  { id: 'engine', step: '05', title: 'Engine', short: 'Exact revision and mode', long: 'Engines are addressed by namespace, name, version and digest, and run in a declared mode with options that carry units.', pin: 'Engine + Registration + mode', href: '/engines', cta: 'Browse engines' },
  { id: 'reevaluation', step: '06', title: 'Re-evaluation', short: 'The gateway re-checks', long: 'The gateway re-evaluates every binding an engine returns, so objectives, penalties and violations don’t depend on the engine’s own report.', pin: 'decision + evaluator provenance', href: '/explore', cta: 'See published results' },
];

export const LAYERS = [
  { id: 'core', label: 'Stable BIM core', title: 'Container & identity', copy: 'Envelopes, role indexes, immutable references, schemas, digests, diagnostics and provenance.', note: 'Never owns task, metric, workflow or objective meaning.' },
  { id: 'profile', label: 'Problem Profile', title: 'Semantic frame', copy: 'Roles, cardinalities, output IR, capability vocabulary, limits, determinism and adapter.', note: '' },
  { id: 'dialect', label: 'Source Dialects', title: 'Replaceable vocabulary', copy: 'Exact resource types or inline extension points with schema-pinned lowering.', note: 'QoS JSON, BPMN and Placement are independently versioned.' },
  { id: 'engine', label: 'Engine modes', title: 'Truthful execution', copy: 'Exact Profile/IR support, feature selectors, options, ceilings and guarantees.', note: 'No wildcard promise over an open extension vocabulary.' },
] as const;

export const EXTENSION_ROUTES = [
  { index: 'A', title: 'Add a compatible Dialect', tag: 'Reuse the Profile + IR', copy: 'Introduce a whole typed resource or a schema-pinned inline vocabulary in a role the Profile already opens. The installed adapter must lower it deterministically and declare the IR features it emits.' },
  { index: 'B', title: 'Define an explicit specialization', tag: 'Reuse contracts, narrow the frame', copy: 'A new Profile may reuse compatible resource identities and shared Dialects while declaring stricter roles, cardinalities or feature vocabularies. Its manifest is complete: BIM has no implicit extends shortcut.' },
  { index: 'C', title: 'Open a new problem family', tag: 'Change semantics + IR', copy: 'When the decision meaning, determinism, roles or output contract changes, define a separate Profile and matching Engine modes without changing the stable Instance container.' },
] as const;

export const WORKFLOW_OPTIONS = {
  native: { label: 'Native JSON', status: 'Installed', source: 'qos-binding/v1 · Application', adapter: 'qos-binding adapter', detail: 'Compact structured workflow blocks live in the Application resource.' },
  bpmn: { label: 'BPMN 2.0.2', status: 'Installed', source: 'omg/bpmn/2.0.2 · BPMN', adapter: 'bpmn-workflow/v1 adapter', detail: 'Normative BPMN XML keeps its QName and enters the application role as a typed resource.' },
  vendor: { label: 'Vendor language', status: 'Extension contract', source: 'vendor.example/v1 · Workflow', adapter: 'reviewed vendor adapter', detail: 'A vendor can supply another source vocabulary only after its exact schema and lowering adapter are installed. Packages cannot install code.' },
} as const;

export type WorkflowOption = keyof typeof WORKFLOW_OPTIONS;

export const COMPATIBILITY_GATE = [
  { name: 'Profile', rule: 'exact versioned id', value: 'qos-binding/v1' },
  { name: 'IR', rule: 'exact apiVersion + kind', value: 'bim/v1 · BindingProblem' },
  { name: 'Features', rule: 'actual lowered values ⊆ selectors', value: 'none · only · all*' },
  { name: 'Limits', rule: 'problem size within ceilings', value: 'Profile vocabulary' },
  { name: 'Deployment', rule: 'immutable registration + protocol', value: 'bim-engine/v1' },
] as const;
