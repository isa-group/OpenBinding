// The landing's content (SPHERE keeps it in frontend/src/modules/presentation/pages/home/data.ts): OpenBinding's pipeline and
// the layers of BIM, moved from the old home page (pages/Home/homeContent.ts).

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
  {
    id: 'package',
    step: '01',
    title: 'Package',
    short: '.bim.zip of BIM v1 resources',
    long: 'A portable package of modular BIM v1 resources: the application workflow, candidate catalogs, constraints and the optimization objective.',
    pin: 'instance.json + resource digests',
    href: '/problem-editor',
    cta: 'Try an example package',
  },
  {
    id: 'validation',
    step: '02',
    title: 'Validation',
    short: 'Localized diagnostics',
    long: 'Every problem is reported where it lives: the resource, a JSON Pointer, a CEL span or a BPMN element, with a suggested fix.',
    pin: 'diagnostics with JSON Pointer paths',
    href: '/problem-editor',
    cta: 'Validate a package',
  },
  {
    id: 'profile',
    step: '03',
    title: 'Profile & dialects',
    short: 'Roles and resource types',
    long: 'The Profile fixes which roles the instance must fill and with what cardinality; installed dialects contribute resource types and IR features.',
    pin: 'schema + adapter digests',
    href: '/problem-editor',
    cta: 'Inspect a compiled package',
  },
  {
    id: 'problem',
    step: '04',
    title: 'Binding problem',
    short: 'IR with its own digest',
    long: 'The instance is compiled into a BindingProblem IR. Its digest identifies exactly what any engine was asked to solve.',
    pin: 'bim/v1 BindingProblem digest',
    href: '/problem-editor',
    cta: 'Compile an example package',
  },
  {
    id: 'engine',
    step: '05',
    title: 'Engine',
    short: 'Exact revision and mode',
    long: 'Engines are addressed by namespace, name, version and digest, and run in a declared mode with options that carry units.',
    pin: 'Engine + Registration + mode',
    href: '/engines',
    cta: 'Browse engines',
  },
  {
    id: 'reevaluation',
    step: '06',
    title: 'Re-evaluation',
    short: 'The gateway re-checks',
    long: 'The gateway re-evaluates every binding an engine returns, so objectives, penalties and violations don’t depend on the engine’s own report.',
    pin: 'decision + evaluator provenance',
    href: '/about',
    cta: 'About OpenBinding',
  },
  {
    id: 'composition',
    step: '07',
    title: 'Composition',
    short: 'The binding you keep',
    long: 'A chosen binding becomes a composition: a Composition2Yaml document, sealed as versions, evaluated against the problem it links, rendered and compared version by version.',
    pin: 'Composition2Yaml version + its evaluation',
    href: '/compositions',
    cta: 'Explore compositions',
  },
];

export const LAYERS = [
  {
    id: 'core',
    label: 'Stable BIM core',
    title: 'Container & identity',
    copy: 'Envelopes, role indexes, immutable references, schemas, digests, diagnostics and provenance.',
    note: 'Never owns task, metric, workflow or objective meaning.',
  },
  {
    id: 'profile',
    label: 'Problem Profile',
    title: 'Semantic frame',
    copy: 'Roles, cardinalities, output IR, capability vocabulary, limits, determinism and adapter.',
    note: '',
  },
  {
    id: 'dialect',
    label: 'Source Dialects',
    title: 'Replaceable vocabulary',
    copy: 'Exact resource types or inline extension points with schema-pinned lowering.',
    note: 'QoS JSON, BPMN and Placement are independently versioned.',
  },
  {
    id: 'engine',
    label: 'Engine modes',
    title: 'Truthful execution',
    copy: 'Exact Profile/IR support, feature selectors, options, ceilings and guarantees.',
    note: 'No wildcard promise over an open extension vocabulary.',
  },
] as const;
