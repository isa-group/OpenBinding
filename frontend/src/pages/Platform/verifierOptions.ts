export interface KindOption {
  value: string;
  label: string;
  category: string;
  description: string;
}

export const KIND_OPTIONS: KindOption[] = [
  { value: 'case-revision', label: 'Binding Case Revision', category: 'Projects', description: 'Versioned allocation problem and case specification' },
  { value: 'resource-revision', label: 'Project Resource Revision', category: 'Projects', description: 'Candidate catalog, constraint sets, or QoS objectives' },
  { value: 'collection-revision', label: 'Collection Revision', category: 'Projects', description: 'Curated collection of benchmark suites and problem variants' },
  { value: 'report', label: 'Empirical Study Report', category: 'Projects', description: 'Frozen report with results, metrics, and Pareto analyses' },
  { value: 'artifact', label: 'Binary Artifact (CAS)', category: 'Projects', description: 'Raw dataset, CSV trace, or ZIP reproducibility archive' },
  { value: 'engine', label: 'Engine Revision', category: 'Platform BIM', description: 'Versioned solver registration or metaheuristic container' },
  { value: 'dialect', label: 'BIM Dialect Revision', category: 'Platform BIM', description: 'Modeling language adapter or domain extension' },
  { value: 'registered-resource', label: 'Registered Resource', category: 'Platform BIM', description: 'Global immutable resource pinned for exact references' },
  { value: 'instance-snapshot', label: 'Instance Snapshot', category: 'Platform BIM', description: 'Immutable file-level capture of instance package' },
  { value: 'binding-ir', label: 'Binding Problem IR Snapshot', category: 'Platform BIM', description: 'Normalized intermediate representation consumed by engines' },
];
