import type { BimAdapter, BimDialect, BimProfile, RegisteredResource } from '../../api/client';

export const BUILTIN_NAMESPACE = 'bim.builtin';

export type Provenance = 'builtin' | 'community';

export interface ProvenanceInfo {
  kind: Provenance;
  label: string;
  text: string;
}

/** Where an extension comes from: installed with the gateway, or submitted by an account and approved by an administrator. */
export function provenanceOf(namespace: string): ProvenanceInfo {
  return namespace === BUILTIN_NAMESPACE
    ? { kind: 'builtin', label: 'Built in', text: 'Installed with the gateway.' }
    : { kind: 'community', label: 'Approved', text: `Submitted by ${namespace} and approved by an administrator.` };
}

export interface DialectRow {
  key: string;
  namespace: string;
  name: string;
  version: string;
  description: string | null;
  digest: string;
  provenance: ProvenanceInfo;
  profiles: string[];
  resourceTypes: BimDialect['spec']['resourceTypes'];
  extensionPoints: BimDialect['spec']['extensionPoints'];
  irFeatures: BimDialect['spec']['irFeatures'];
  adapter: BimAdapter;
  document: BimDialect;
}

export function dialectRows(dialects: BimDialect[]): DialectRow[] {
  return dialects.map((dialect) => {
    const { metadata, spec } = dialect;
    return {
      key: `${metadata.namespace}/${metadata.name}@${metadata.version}#${dialect.digest}`,
      namespace: metadata.namespace,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description ?? null,
      digest: dialect.digest,
      provenance: provenanceOf(metadata.namespace),
      profiles: spec.compatibleProfiles ?? [],
      resourceTypes: spec.resourceTypes ?? [],
      extensionPoints: spec.extensionPoints ?? [],
      irFeatures: spec.irFeatures ?? [],
      adapter: spec.adapter,
      document: dialect,
    };
  });
}

export interface AdapterUse {
  kind: 'Dialect' | 'Profile';
  label: string;
}

export interface AdapterRow {
  key: string;
  id: string;
  version: string;
  binaryDigest: string;
  usedBy: AdapterUse[];
}

/** The adapters behind the installed dialects and profiles: one row per adapter build, with everything that relies on it. */
export function adapterRows(dialects: BimDialect[], profiles: BimProfile[]): AdapterRow[] {
  const rows = new Map<string, AdapterRow>();
  const add = (adapter: BimAdapter | undefined, use: AdapterUse) => {
    if (!adapter) return;
    const key = `${adapter.id}@${adapter.version}#${adapter.binaryDigest}`;
    const row = rows.get(key) ?? { key, id: adapter.id, version: adapter.version, binaryDigest: adapter.binaryDigest, usedBy: [] };
    row.usedBy.push(use);
    rows.set(key, row);
  };
  for (const dialect of dialects) {
    add(dialect.spec.adapter, { kind: 'Dialect', label: `${dialect.metadata.name} ${dialect.metadata.version}` });
  }
  for (const profile of profiles) {
    add(profile.spec.adapter, { kind: 'Profile', label: profile.id });
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
}

export interface ResourceRow {
  key: string;
  namespace: string;
  name: string;
  version: string;
  digest: string;
  role: string;
  kind: string;
  dialect: string;
  mediaType: string;
  provenance: ProvenanceInfo;
}

export function resourceRows(resources: RegisteredResource[]): ResourceRow[] {
  return resources.map((resource) => ({
    key: `${resource.namespace}/${resource.name}@${resource.version}#${resource.digest}`,
    namespace: resource.namespace,
    name: resource.name,
    version: resource.version,
    digest: resource.digest,
    role: resource.role,
    kind: resource.kind,
    dialect: resource.dialect,
    mediaType: resource.mediaType,
    provenance: provenanceOf(resource.namespace),
  }));
}

const MEDIA_LABELS: Record<string, string> = {
  'application/json': 'JSON',
  'application/xml': 'XML',
  'application/vnd.omg.bpmn+xml': 'BPMN (XML)',
  'application/yaml': 'YAML',
};

export function mediaLabel(mediaType: string): string {
  return MEDIA_LABELS[mediaType] ?? mediaType;
}
