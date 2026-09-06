import { apiClient } from './client';

export type Visibility = 'private' | 'public';
export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

export interface Organization {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  billing_sponsor_user_id: string;
  effective_role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null;
  created_at: string;
}

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  role: OrganizationRole;
  created_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  email: string;
  role: OrganizationRole;
  expires_at: string;
  token: string;
}

export interface Project {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  visibility: Visibility;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface BindingCase {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  created_by_id: string;
  created_at: string;
}

export interface CaseRevision {
  id: string;
  binding_case_id: string;
  revision: number;
  digest: string;
  document: Record<string, unknown>;
  source_snapshot_id: string | null;
  created_at: string;
}

export interface ProjectResource {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  kind: string;
  created_by_id: string;
  created_at: string;
}

export interface ProjectResourceRevision {
  id: string;
  project_resource_id: string;
  revision: number;
  digest: string;
  document: Record<string, unknown>;
  created_at: string;
}

export interface CollectionItem {
  target_kind: 'case' | 'resource' | 'result' | 'report';
  target_digest: string;
  target_ref: Record<string, unknown>;
}

export interface Collection {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  created_by_id: string;
  created_at: string;
}

export interface CollectionRevision {
  id: string;
  collection_id: string;
  revision: number;
  digest: string;
  items: CollectionItem[];
  created_at: string;
}

export interface Artifact {
  id: string;
  organization_id: string;
  project_id: string;
  digest: string;
  media_type: string;
  size_bytes: number;
  public: boolean;
  expires_at: string | null;
  created_at: string;
}

export interface Report {
  id: string;
  project_id: string;
  study_run_id: string | null;
  slug: string;
  title: string;
  document: Record<string, unknown>;
  digest: string;
  state: 'draft' | 'frozen';
  created_at: string;
}

export interface Publication {
  id: string;
  project_id: string;
  report_id: string;
  slug: string;
  citation: Record<string, unknown>;
  published_at: string;
}

export interface Study {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  definition: {
    case_revision_ids: string[];
    engines: Array<Record<string, string>>;
    parameter_sets: Array<Record<string, unknown>>;
    seeds: number[];
  };
  state: string;
  created_by_id: string;
  created_at: string;
}

export interface StudyRun {
  id: string;
  study_id: string;
  run_number: number;
  state: RunState;
  matrix_digest: string;
  cells: number;
  summary: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
}

export interface StudyCell {
  id: string;
  study_run_id: string;
  ordinal: number;
  binding_case_revision_id: string;
  engine_ref: Record<string, string>;
  parameters: Record<string, unknown>;
  seed: number;
  fingerprint: string;
  job_id: string | null;
  state: RunState;
  metrics: Record<string, unknown>;
}

export interface Analytics {
  cells: number;
  completed: number;
  failed: number;
  feasible: number;
  infeasible: number;
  objective_distributions: Record<string, number[]>;
  runtimes_s: number[];
  pareto: Array<Record<string, number>>;
  stability: Record<string, { samples: number; distinct: number; repeatability: number }>;
}

export interface PricingRelease {
  id: string;
  version: string;
  digest: string;
  sphere_organization: 'OpenBinding';
  sphere_organization_id: string;
  sphere_slug: 'openbinding';
  sphere_state: 'PRIVATE_DRAFT' | 'PUBLIC_RELEASE';
  space_state: 'NOT_DEPLOYED' | 'ACTIVE' | 'DRAINING' | 'ARCHIVED';
  is_live: boolean;
  public_url: string | null;
  changelog: string;
  migration_manifest: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PricingControlRoom {
  identity: { organization: 'OpenBinding'; slug: 'openbinding' };
  sphere: Record<string, unknown> & { enabled: boolean; reachable: boolean };
  space: Record<string, unknown> & { enabled: boolean; reachable: boolean };
  live: string | null;
  releases: PricingRelease[];
  remoteVersions: Array<{ version: string; private: boolean }>;
  spaceVersions: { active: unknown[]; archived: unknown[] };
  divergence: { onlyInSphere: string[]; onlyLocal: string[] };
}

const root = (org: string, project?: string) =>
  `/v1/organizations/${encodeURIComponent(org)}${project ? `/projects/${encodeURIComponent(project)}` : ''}`;

export const platformApi = {
  organizations: () => apiClient.request<Organization[]>('/v1/organizations'),
  createOrganization: (value: { slug: string; name: string; parent_id?: string | null }) =>
    apiClient.request<Organization>('/v1/organizations', {
      method: 'POST', body: JSON.stringify(value),
    }),
  updateOrganization: (org: string, value: { name?: string; parent_id?: string | null; move_to_root?: boolean }) =>
    apiClient.request<Organization>(root(org), {
      method: 'PATCH', body: JSON.stringify(value),
    }),
  members: (org: string) =>
    apiClient.request<OrganizationMember[]>(`${root(org)}/members`),
  updateMember: (org: string, userId: string, role: OrganizationRole) =>
    apiClient.request<OrganizationMember>(`${root(org)}/members/${encodeURIComponent(userId)}`, {
      method: 'PUT', body: JSON.stringify({ user_id: userId, role }),
    }),
  removeMember: (org: string, userId: string) =>
    apiClient.request<void>(`${root(org)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  inviteMember: (org: string, value: { email: string; role: OrganizationRole }) =>
    apiClient.request<OrganizationInvitation>(`${root(org)}/invitations`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  projects: (org: string) => apiClient.request<Project[]>(`${root(org)}/projects`),
  createProject: (org: string, value: { slug: string; name: string; description: string; visibility: Visibility }) =>
    apiClient.request<Project>(`${root(org)}/projects`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  updateProject: (org: string, project: string, value: { name?: string; description?: string; visibility?: Visibility }) =>
    apiClient.request<Project>(root(org, project), {
      method: 'PATCH', body: JSON.stringify(value),
    }),
  cases: (org: string, project: string) =>
    apiClient.request<BindingCase[]>(`${root(org, project)}/cases`),
  createCase: (org: string, project: string, value: { slug: string; name: string; description: string }) =>
    apiClient.request<BindingCase>(`${root(org, project)}/cases`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  revisions: (org: string, project: string, bindingCase: string) =>
    apiClient.request<CaseRevision[]>(
      `${root(org, project)}/cases/${encodeURIComponent(bindingCase)}/revisions`,
    ),
  createRevision: (org: string, project: string, bindingCase: string, document: Record<string, unknown>, source_snapshot_id?: string | null) =>
    apiClient.request<CaseRevision>(
      `${root(org, project)}/cases/${encodeURIComponent(bindingCase)}/revisions`,
      { method: 'POST', body: JSON.stringify({ document, source_snapshot_id: source_snapshot_id ?? null }) },
    ),
  resources: (org: string, project: string) =>
    apiClient.request<ProjectResource[]>(`${root(org, project)}/resources`),
  createResource: (org: string, project: string, value: { slug: string; name: string; description: string; kind: string }) =>
    apiClient.request<ProjectResource>(`${root(org, project)}/resources`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  resourceRevisions: (org: string, project: string, resource: string) =>
    apiClient.request<ProjectResourceRevision[]>(
      `${root(org, project)}/resources/${encodeURIComponent(resource)}/revisions`,
    ),
  createResourceRevision: (org: string, project: string, resource: string, document: Record<string, unknown>) =>
    apiClient.request<ProjectResourceRevision>(
      `${root(org, project)}/resources/${encodeURIComponent(resource)}/revisions`,
      { method: 'POST', body: JSON.stringify({ document }) },
    ),
  collections: (org: string, project: string) =>
    apiClient.request<Collection[]>(`${root(org, project)}/collections`),
  createCollection: (org: string, project: string, value: { slug: string; name: string; description: string }) =>
    apiClient.request<Collection>(`${root(org, project)}/collections`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  collectionRevisions: (org: string, project: string, collection: string) =>
    apiClient.request<CollectionRevision[]>(`${root(org, project)}/collections/${encodeURIComponent(collection)}/revisions`),
  createCollectionRevision: (org: string, project: string, collection: string, items: CollectionItem[]) =>
    apiClient.request<CollectionRevision>(`${root(org, project)}/collections/${encodeURIComponent(collection)}/revisions`, {
      method: 'POST', body: JSON.stringify({ items }),
    }),
  studies: (org: string, project: string) =>
    apiClient.request<Study[]>(`${root(org, project)}/studies`),
  createStudy: (org: string, project: string, value: Pick<Study, 'slug' | 'name' | 'description' | 'definition'>) =>
    apiClient.request<Study>(`${root(org, project)}/studies`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  reports: (org: string, project: string) =>
    apiClient.request<Report[]>(`${root(org, project)}/reports`),
  createReport: (org: string, project: string, value: { slug: string; title: string; study_run_id: string | null; document: Record<string, unknown> }) =>
    apiClient.request<Report>(`${root(org, project)}/reports`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  freezeReport: (org: string, project: string, report: string) =>
    apiClient.request<Report>(`${root(org, project)}/reports/${encodeURIComponent(report)}/freeze`, { method: 'POST' }),
  publications: (org: string, project: string) =>
    apiClient.request<Publication[]>(`${root(org, project)}/publications`),
  publishReport: (org: string, project: string, value: { report_id: string; slug: string; citation: Record<string, unknown> }) =>
    apiClient.request<Publication>(`${root(org, project)}/publications`, {
      method: 'POST', body: JSON.stringify(value),
    }),
  artifacts: (org: string, project: string) =>
    apiClient.request<Artifact[]>(`${root(org, project)}/artifacts`),
  uploadArtifact: (org: string, project: string, file: File, makePublic: boolean) =>
    apiClient.request<Artifact>(`${root(org, project)}/artifacts?public=${makePublic}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  downloadArtifact: (org: string, project: string, digest: string) =>
    apiClient.requestBinary(`${root(org, project)}/artifacts/${encodeURIComponent(digest)}`),
  exportPackage: (org: string, project: string) =>
    apiClient.requestBinary(`${root(org, project)}/package`),
  importPackage: (org: string, project: string, file: File) =>
    apiClient.request<{ casesCreated: number; revisionsCreated: number }>(`${root(org, project)}/package`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    }),
  studyRuns: (org: string, project: string, study: string) =>
    apiClient.request<StudyRun[]>(`${root(org, project)}/studies/${encodeURIComponent(study)}/runs`),
  studyCells: (org: string, project: string, study: string, run: string) =>
    apiClient.request<StudyCell[]>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${run}/cells`,
    ),
  analytics: (org: string, project: string, study: string, run: string) =>
    apiClient.request<Analytics>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${run}/analytics`,
    ),
  runStudy: (org: string, project: string, study: string) =>
    apiClient.request<StudyRun>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs`,
      { method: 'POST' },
    ),
  cancelStudyRun: (org: string, project: string, study: string, run: string) =>
    apiClient.request<StudyRun>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cancel`,
      { method: 'POST' },
    ),
  retryStudyCell: (org: string, project: string, study: string, run: string, cell: string) =>
    apiClient.request<{ id: string; state: RunState; fingerprint: string }>(
      `${root(org, project)}/studies/${encodeURIComponent(study)}/runs/${encodeURIComponent(run)}/cells/${encodeURIComponent(cell)}/retry`,
      { method: 'POST' },
    ),
  publicProjects: () => apiClient.request<Array<{
    organization: { slug: string; name: string };
    project: { slug: string; name: string; description: string };
  }>>('/v1/explore/projects'),
  publicPublications: () => apiClient.request<Array<Record<string, unknown>>>('/v1/explore/publications'),
  pricingControlRoom: () => apiClient.request<PricingControlRoom>('/v1/admin/pricing/control-room'),
  validatePricing: (yaml: string) => apiClient.request<{
    valid: boolean; version: string | null; digest: string | null; plans: string[];
    add_ons: string[]; errors: string[]; warnings: string[];
  }>('/v1/admin/pricing/validate', { method: 'POST', body: JSON.stringify({ yaml }) }),
  createPricingDraft: (yaml: string, changelog: string, migration_manifest: Record<string, unknown>) =>
    apiClient.request<{ release: PricingRelease; message: string }>('/v1/admin/pricing/drafts', {
      method: 'POST', body: JSON.stringify({ yaml, changelog, migration_manifest }),
    }),
  previewPricing: (version: string) =>
    apiClient.requestText(`/v1/admin/pricing/versions/${encodeURIComponent(version)}/preview`),
  syncPricing: () => apiClient.request<{ created: number }>('/v1/admin/pricing/sync', { method: 'POST' }),
  forkPricing: (source: string, version: string, changelog: string) =>
    apiClient.request<{ release: PricingRelease; message: string }>(
      `/v1/admin/pricing/drafts/${encodeURIComponent(source)}/fork`,
      { method: 'POST', body: JSON.stringify({ version, changelog }) },
    ),
  publishPricing: (
    draft_version: string,
    version: string,
    changelog: string,
    migration_manifest: Record<string, unknown>,
  ) => apiClient.request<{ release: PricingRelease; message: string }>('/v1/admin/pricing/publish', {
    method: 'POST', body: JSON.stringify({ draft_version, version, changelog, migration_manifest }),
  }),
  pricingAction: (version: string, action: 'deploy' | 'activate' | 'drain') =>
    apiClient.request<{ release: PricingRelease; message: string }>(
      `/v1/admin/pricing/versions/${encodeURIComponent(version)}/${action}`,
      { method: 'POST' },
    ),
  archivePricing: (version: string, fallback: Record<string, unknown> = {}) =>
    apiClient.request<{ release: PricingRelease; message: string }>(
      `/v1/admin/pricing/versions/${encodeURIComponent(version)}/archive`,
      { method: 'POST', body: JSON.stringify({ fallback }) },
    ),
  deletePricingDraft: (version: string) => apiClient.request<void>(
    `/v1/admin/pricing/drafts/${encodeURIComponent(version)}`,
    { method: 'DELETE', body: JSON.stringify({ confirmation: version }) },
  ),
};
