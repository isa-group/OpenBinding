/**
 * What a composition adds up to before it is created, read from the sealed contents of the library versions picked for it.
 * The gateway compiles the real thing when the revision is created; this is the estimate behind the live size meter and the
 * preview, so it is tolerant: a content that doesn't look as expected counts as nothing and is never an error.
 */

export interface CompositionContents {
  applications: unknown[];
  catalogs: unknown[];
  constraintSets: unknown[];
  optimizations: unknown[];
}

export interface CompositionStats {
  tasks: number;
  serviceTasks: number;
  candidates: number;
  must: number;
  should: number;
  criteria: number;
  /** log10 of the number of possible bindings (an upper bound); `null` while a task has no provider or nothing is picked. */
  log10: number | null;
  /** Capabilities some task asks for and no picked catalog offers. */
  missing: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const specOf = (document: unknown) => record(record(document).spec);

/** A capability as the sources write it: a plain string or `{ type }`. */
function capabilityType(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (isRecord(value) && typeof value.type === 'string' && value.type.trim()) return value.type;
  return null;
}

/** The capability each service task asks for, by task id. */
function serviceTasks(applications: readonly unknown[]): Map<string, string | null> {
  const tasks = new Map<string, string | null>();
  for (const application of applications) {
    for (const [id, raw] of Object.entries(record(specOf(application).tasks))) {
      if (isRecord(raw) && raw.kind === 'local') continue;
      tasks.set(id, typeof raw === 'string' ? capabilityType(raw) : capabilityType(record(raw).requires));
    }
  }
  return tasks;
}

function allTasks(applications: readonly unknown[]): number {
  return applications.reduce<number>((total, application) => total + Object.keys(record(specOf(application).tasks)).length, 0);
}

/** How many candidates of the picked catalogs offer each capability. */
function offers(catalogs: readonly unknown[]): { byCapability: Map<string, number>; total: number } {
  const byCapability = new Map<string, number>();
  let total = 0;
  for (const catalog of catalogs) {
    const candidates = specOf(catalog).candidates;
    const entries = isRecord(candidates) ? Object.values(candidates) : Array.isArray(candidates) ? candidates : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      total += 1;
      const provides = Array.isArray(entry.provides) ? entry.provides : [entry.provides];
      const types = new Set(provides.map(capabilityType).filter((type): type is string => type !== null));
      for (const type of types) byCapability.set(type, (byCapability.get(type) ?? 0) + 1);
    }
  }
  return { byCapability, total };
}

function ruleList(constraintSets: readonly unknown[]): Array<Record<string, unknown>> {
  return constraintSets.flatMap((set) => {
    const raw = specOf(set).constraints;
    const entries = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : [];
    return entries.filter(isRecord);
  });
}

export function estimateComposition(contents: CompositionContents): CompositionStats {
  const tasks = serviceTasks(contents.applications);
  const { byCapability, total } = offers(contents.catalogs);
  const rules = ruleList(contents.constraintSets);
  const should = rules.filter((rule) => rule.enforcement === 'soft' || (rule.enforcement === undefined && rule.penalty !== undefined)).length;
  const criteria = contents.optimizations.reduce<number>((count, optimization) => {
    const items = specOf(optimization).criteria;
    return count + (Array.isArray(items) ? items.length : 0);
  }, 0);

  const missing = new Set<string>();
  let log10 = 0;
  for (const [id, capability] of tasks) {
    const count = capability ? byCapability.get(capability) ?? 0 : 0;
    if (count === 0) missing.add(capability ?? id);
    else log10 += Math.log10(count);
  }
  const sized = tasks.size > 0 && contents.catalogs.length > 0 && missing.size === 0;
  return {
    tasks: allTasks(contents.applications),
    serviceTasks: tasks.size,
    candidates: total,
    must: rules.length - should,
    should,
    criteria,
    log10: sized ? log10 : null,
    missing: contents.catalogs.length > 0 ? [...missing] : [],
  };
}
