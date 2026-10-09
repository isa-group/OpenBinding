import { BIM_SCHEMA_KINDS, type BimSchemaKind } from '../../api/client';

export type SchemaGroup = 'Core & compilation' | 'Profile resources' | 'Extension & execution';

export interface SchemaCatalogItem {
  kind: BimSchemaKind;
  title: string;
  group: SchemaGroup;
  description: string;
  boundary: string;
  connectsTo: BimSchemaKind[];
  /** An official example package that uses this kind, opened in the workbench. */
  example?: string;
}

export const SCHEMA_CATALOG: SchemaCatalogItem[] = [
  { kind: 'Instance', title: 'Instance', group: 'Core & compilation', description: 'Small portable root index: selects one installed Profile and maps logical ids to local or immutable registered resources by Profile role.', boundary: 'Portable source root', connectsTo: ['Profile', 'Application', 'CandidateCatalog', 'ConstraintSet', 'Optimization'], example: 'demo/01_simple_seq' },
  { kind: 'Profile', title: 'Profile', group: 'Core & compilation', description: 'Executable semantic frame: roles, cardinalities, output IR, capability and limit vocabularies, plus a pinned installed adapter.', boundary: 'Problem-family contract', connectsTo: ['Instance', 'Dialect', 'BindingProblem', 'Engine'] },
  { kind: 'BindingProblem', title: 'BindingProblem', group: 'Core & compilation', description: 'Closed compiled IR produced by qos-binding/v1. It is Profile output sent to engines, not another name for the source Instance package.', boundary: 'Compiled execution IR', connectsTo: ['Profile', 'Engine', 'engine-contract'], example: 'demo/05_multi_obj' },
  { kind: 'Application', title: 'Application', group: 'Profile resources', description: 'Tasks, typed metrics and the native or externally represented workflow for qos-binding/v1.', boundary: 'application role', connectsTo: ['Instance', 'BindingProblem'], example: 'demo/02_parallel' },
  { kind: 'CandidateCatalog', title: 'CandidateCatalog', group: 'Profile resources', description: 'Typed capabilities, provider/property data, metric bindings and deterministic finite scalar QoS values.', boundary: 'candidateCatalog role', connectsTo: ['Instance', 'Application', 'BindingProblem'], example: 'demo/08_dependencies' },
  { kind: 'ConstraintSet', title: 'ConstraintSet', group: 'Profile resources', description: 'Independent hard and soft assertions expressed as the BIM expression AST or restricted CEL.', boundary: 'constraintSet role', connectsTo: ['Instance', 'Optimization', 'BindingProblem'], example: 'demo/07_soft_constraints' },
  { kind: 'Optimization', title: 'Optimization', group: 'Profile resources', description: 'Exactly one satisfy, weighted, lexicographic or Pareto decision preference for the current Profile.', boundary: 'optimization role', connectsTo: ['Instance', 'ConstraintSet', 'BindingProblem'], example: 'demo/12_many_obj_pareto' },
  { kind: 'Placement', title: 'Placement', group: 'Profile resources', description: 'Optional qos-binding-placement/v1 resource for pools, demands, capacity, directed network effects, security and pricing constraints.', boundary: 'Dialect resource in application role', connectsTo: ['Dialect', 'Application', 'BindingProblem', 'Engine'], example: 'placement/01_small_placement' },
  { kind: 'RoutingOverlay', title: 'RoutingOverlay', group: 'Profile resources', description: 'Separate deterministic branch probabilities and expected-count values; workflow structure remains representation-neutral.', boundary: 'application role', connectsTo: ['Application', 'BindingProblem'], example: 'demo/03_xor_choice' },
  { kind: 'Dialect', title: 'Dialect', group: 'Extension & execution', description: 'Independently versioned source-language contract: compatible Profiles, exact resource types or extension points, emitted IR features and pinned adapter.', boundary: 'Replaceable source vocabulary', connectsTo: ['Profile', 'Application', 'BindingProblem', 'Engine'] },
  { kind: 'Engine', title: 'Engine', group: 'Extension & execution', description: 'Portable immutable execution resource with Profile/IR-targeted modes, feature selectors, closed options, limits and truthful guarantees.', boundary: 'Public capability declaration', connectsTo: ['Profile', 'BindingProblem', 'EngineRegistration'], example: 'demo/10_large_scale' },
  { kind: 'EngineRegistration', title: 'EngineRegistration', group: 'Extension & execution', description: 'Private deployment manifest pinned to one exact Engine revision, HTTPS endpoint and bim-engine/v1 protocol digest.', boundary: 'Deployment and federation', connectsTo: ['Engine', 'engine-contract'] },
  { kind: 'engine-contract', title: 'Engine protocol', group: 'Extension & execution', description: 'Pinned bim-engine/v1 OpenAPI protocol between the gateway and local or remote Engine deployments. Only compiled Profile IR crosses it.', boundary: 'Engine protocol', connectsTo: ['BindingProblem', 'EngineRegistration'] },
];

export const SCHEMA_GROUPS: SchemaGroup[] = ['Core & compilation', 'Profile resources', 'Extension & execution'];

/** The kind a URL segment names, ignoring case (`application` opens `Application`); `null` when there is no such kind. */
export function resolveSchemaKind(segment: string | undefined): BimSchemaKind | null {
  if (!segment) return null;
  const wanted = segment.trim().toLowerCase();
  return BIM_SCHEMA_KINDS.find((kind) => kind.toLowerCase() === wanted) ?? null;
}

/** Where a kind's field reference lives. */
export function schemaPath(kind: string): string {
  return `/language/schemas/${encodeURIComponent(kind)}`;
}

/** The address of a kind when it is one the reference knows, or `null`. */
export function schemaPathFor(kind: string): string | null {
  const known = resolveSchemaKind(kind);
  return known ? schemaPath(known) : null;
}
