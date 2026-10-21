export type Shape = 'sequence' | 'parallel' | 'exclusive' | 'loop' | 'conflict' | 'objective' | 'shared' | 'placement' | 'research' | 'bpmn';

export interface LessonMeta {
  title: string;
  concept: string;
  outcome: string;
  shape: Shape;
  level: number;
  tags: string[];
  compatibility?: string;
}

/** What each official package teaches. The gateway lists paths only; this adds the lesson around each one. */
export const LESSONS: Record<string, LessonMeta> = {
  'demo/01_simple_seq': { title: 'A first binding', concept: 'Basic sequence', outcome: 'Connect one Application, one CandidateCatalog and one Optimization through explicit resource references.', shape: 'sequence', level: 1, tags: ['sequence', 'binding'] },
  'demo/02_parallel': { title: 'Parallel aggregation', concept: 'Parallel flow', outcome: 'See how deterministic metric aggregation follows a parallel workflow block.', shape: 'parallel', level: 1, tags: ['parallel', 'aggregation'] },
  'demo/03_xor_choice': { title: 'Probabilistic routing', concept: 'Exclusive branch', outcome: 'Add a separate RoutingOverlay with explicit probabilities while the workflow stays structural.', shape: 'exclusive', level: 2, tags: ['routing', 'probabilities'] },
  'demo/04_conflict': { title: 'Read an infeasible result', concept: 'Conflicting constraints', outcome: 'Trace a deliberately unsatisfiable package from analysis to an INFEASIBLE-compatible result.', shape: 'conflict', level: 2, tags: ['constraints', 'diagnostics'] },
  'demo/05_multi_obj': { title: 'Balance cost and latency', concept: 'Weighted objective', outcome: 'Encode a deterministic trade-off with explicit weighted terms and normalization.', shape: 'objective', level: 2, tags: ['weighted', 'optimization'] },
  'demo/06_loops': { title: 'Repeat with a declared count', concept: 'Loop semantics', outcome: 'Use repeat.count or repeat.expectedCount as deterministic aggregation multipliers.', shape: 'loop', level: 2, tags: ['repeat', 'aggregation'] },
  'demo/07_soft_constraints': { title: 'Prefer, do not forbid', concept: 'Soft constraints', outcome: 'Connect an explicit soft-constraint penalty to Optimization without weakening hard assertions.', shape: 'objective', level: 3, tags: ['soft constraint', 'penalty'] },
  'demo/08_dependencies': { title: 'Match typed capabilities', concept: 'Provider properties', outcome: 'Inspect typed capability matching and provider properties rather than task-to-candidate lists.', shape: 'sequence', level: 3, tags: ['capabilities', 'providers'] },
  'demo/09_mixed': { title: 'Compose the pieces', concept: 'Mixed structure', outcome: 'Combine sequence, exclusive routing and constraints in one modular package.', shape: 'exclusive', level: 3, tags: ['mixed', 'constraints'] },
  'demo/10_large_scale': { title: 'Push engine ceilings', concept: 'Scale and performance', outcome: 'Observe how problem size is checked against each compatible mode’s declared limits.', shape: 'parallel', level: 4, tags: ['limits', 'scale'], compatibility: 'Engine limits become part of the match.' },
  'demo/11_multi_obj_negative': { title: 'Normalize two objectives', concept: 'Multi-objective normalization', outcome: 'Inspect a two-term objective used to exercise normalization and mode compatibility.', shape: 'objective', level: 4, tags: ['normalization', 'multi-objective'] },
  'demo/17_analysis_tradeoffs': { title: 'Explore binding geometry', concept: 'Two-objective analysis', outcome: 'Cost and latency trade-offs with duplicate strategies. The development gallery retains all 36 evaluated bindings for Voronoi, neighbors and hypervolume.', shape: 'objective', level: 3, tags: ['analysis', 'voronoi', 'pareto'], compatibility: 'Requires optimization=pareto.' },
  'demo/18_analysis_constraints': { title: 'Explain constrained trade-offs', concept: 'Penalties and maximized quality', outcome: 'Inspect three objective components, a soft latency penalty and a hard budget constraint in the seeded analysis gallery.', shape: 'objective', level: 4, tags: ['analysis', 'constraints'], compatibility: 'Requires many-objective Pareto support.' },
  'demo/19_analysis_journey': { title: 'Replay optimization evidence', concept: 'Scalar search and preference sensitivity', outcome: 'Run a weighted solver, or open the seeded deterministic enumeration trace to explore actual incumbent improvements.', shape: 'objective', level: 3, tags: ['analysis', 'journey'], compatibility: 'Requires weighted optimization support.' },
  'demo/12_many_obj_pareto': { title: 'Explore a Pareto problem', concept: 'Many-objective optimization', outcome: 'Require a mode that explicitly advertises Pareto support; heuristic does not imply a complete front.', shape: 'objective', level: 4, tags: ['pareto', 'compatibility'], compatibility: 'Requires optimization=pareto.' },
  'demo/13_fms': { title: 'Bind a feature-model composition', concept: 'Feature-model structure', outcome: 'Study a composition derived from a feature model through the same Profile roles.', shape: 'parallel', level: 5, tags: ['feature model', 'composition'] },
  'demo/14_shared_candidates': { title: 'Share one selected candidate', concept: 'Selected-candidate scope', outcome: 'See one candidate serve multiple tasks with explicit selected-candidate metric semantics.', shape: 'shared', level: 5, tags: ['sharing', 'metric scope'], compatibility: 'Requires metricScopes=selectedCandidate.' },
  'demo/15_bpmn_complete': { title: 'Orchestrate a complete BPMN workflow', concept: 'BPMN + routing + placement', outcome: 'Follow nested AND/XOR gateways, an exact multi-instance task, four QoS dimensions and edge/fog/cloud placement as one modular package.', shape: 'bpmn', level: 5, tags: ['BPMN', 'routing', 'placement', 'multi-instance'], compatibility: 'Requires BPMN lowering and Placement extension support.' },
  'demo/16_json_complete': { title: 'Prove BPMN and JSON are equivalent', concept: 'Native JSON twin', outcome: 'Compare the complete BPMN lesson with the same workflow authored directly as BIM JSON; both compile to the same canonical IR.', shape: 'parallel', level: 5, tags: ['JSON', 'BPMN', 'IR', 'regression'], compatibility: 'Every compatible engine must return the same result as lesson 15.' },
  'placement/01_small_placement': { title: 'Add placement to binding', concept: 'Placement Dialect', outcome: 'Compose pools, capacity, network latency, security and pricing with the base binding resources.', shape: 'placement', level: 4, tags: ['placement', 'dialect'], compatibility: 'Requires placement=placement and irExtensions=qos-binding-placement/v1.' },
  'placement/02_stock_market_sample': { title: 'Place a larger stock workflow', concept: 'Placement at mid scale', outcome: 'Explore a pruned 50-node infrastructure sample with on-demand pricing and capacity constraints.', shape: 'placement', level: 5, tags: ['placement', 'scale'], compatibility: 'Requires explicit Placement extension support.' },
  'placement/03_cloud_only': { title: 'Compare a cloud-only package', concept: 'Placement variant', outcome: 'Hold the problem family stable while changing the placement-aware infrastructure resource.', shape: 'placement', level: 4, tags: ['placement', 'cloud'], compatibility: 'Placement-aware mode only.' },
  'placement/04_edge_heavy': { title: 'Compare an edge-heavy package', concept: 'Placement variant', outcome: 'Contrast infrastructure choices without changing the stable BIM container or Profile roles.', shape: 'placement', level: 4, tags: ['placement', 'edge'], compatibility: 'Placement-aware mode only.' },
  'literature/benatallah': { title: 'Travel solution', concept: 'Benatallah et al. scenario', outcome: 'Inspect a representative research workflow as a modular deterministic BIM package.', shape: 'research', level: 5, tags: ['literature', 'travel'] },
  'literature/bultan': { title: 'Warehouse conversation', concept: 'Bultan et al. scenario', outcome: 'Study an e-commerce conversation workflow represented in the executable QoS Profile.', shape: 'research', level: 5, tags: ['literature', 'e-commerce'] },
  'literature/cremaschi': { title: 'Healthcare monitoring', concept: 'Cremaschi et al. scenario', outcome: 'Explore a monitoring and emergency-response composition using deterministic scalar QoS.', shape: 'research', level: 5, tags: ['literature', 'healthcare'] },
  'literature/netedu': { title: 'Transport agency', concept: 'Netedu et al. scenario', outcome: 'Follow a transport-agency case through the same source-to-IR boundary.', shape: 'research', level: 5, tags: ['literature', 'transport'] },
  'literature/pautasso': { title: 'RESTful e-commerce', concept: 'Pautasso scenario', outcome: 'Inspect an e-commerce composition adapted into native v1 resources.', shape: 'research', level: 5, tags: ['literature', 'REST'] },
  'literature/zhang': { title: 'Entertainment planner', concept: 'Zhang et al. scenario', outcome: 'Explore a personal entertainment planner with explicit resources and deterministic metrics.', shape: 'research', level: 5, tags: ['literature', 'planner'] },
};

export interface Family {
  id: string;
  label: string;
  glyph: string;
  description: string;
}

const KNOWN_FAMILIES: Record<string, Pick<Family, 'label' | 'description'>> = {
  demo: { label: 'Demo', description: 'A progressive sequence from one binding to advanced compatibility features.' },
  placement: { label: 'Placement', description: 'The installed Placement Dialect adds source and IR features inside the application role.' },
  literature: { label: 'Literature', description: 'Representative service-composition cases expressed through the same deterministic Profile.' },
  bpmn: { label: 'BPMN', description: 'Workflows authored as BPMN diagrams and lowered by the BPMN Dialect.' },
  benchmark: { label: 'Benchmark', description: 'Packages sized to compare engines.' },
};

/** `placement/01_small_placement` belongs to the family `placement`; a package at the top level to `other`. */
export function familyIdOf(path: string): string {
  return path.includes('/') ? path.split('/')[0] : 'other';
}

export function familyOf(id: string): Family {
  const known = KNOWN_FAMILIES[id];
  const label = known?.label ?? (id === 'other' ? 'Other' : id.charAt(0).toUpperCase() + id.slice(1));
  return { id, label, glyph: label.slice(0, 2).toUpperCase(), description: known?.description ?? '' };
}

export function titleFromPath(path: string): string {
  return path.split('/').at(-1)?.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || path;
}

export function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'example';
}
