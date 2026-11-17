import { describe, expect, it } from 'vitest';
import { apiClient } from '../modules/core/api/http';
import { runsApi } from '../modules/run/api/runsClient';
import { organizationClient } from '../modules/organization/api/organizationClient';

// M9.6 removed these operations from the gateway: no source of the application may bind them again.

const REMOVED_BINDINGS = [
  'analysisApi',
  'platformApi.report',
  'platformApi.createReport',
  'platformApi.freezeReport',
  'platformApi.createReportDraft',
  'platformApi.updateReport',
  'platformApi.deleteReport',
  'platformApi.publishReport',
  'platformApi.createResource',
  'platformApi.createResourceRevision',
  'platformApi.resource',
  'platformApi.updateResource',
  'platformApi.deleteResource',
  'libraryItemsApi.create',
  'libraryItemsApi.item',
  'libraryItemsApi.rename',
  'libraryItemsApi.drafts',
  'libraryItemsApi.createDraft',
  'libraryItemsApi.saveDraft',
  'libraryItemsApi.seal',
  'libraryItemsApi.publish',
  'libraryItemsApi.withdraw',
  'libraryItemsApi.associate',
  'libraryItemsApi.projectItems',
  'libraryItemsApi.dissociate',
  'adminTransferSponsor',
  'listMySponsorProposals',
  'listOrganizationSponsorProposals',
  'acceptSponsorProposal',
  'declineSponsorProposal',
  'cancelSponsorProposal',
  // F0b B4 removed `jobsApi.history` (the account's run history screen); B5 `jobsApi.ir` and `jobsApi.instance`; B6 the whole object.
  'jobsApi',
  // F0b B5: problems belong to the organization; snapshots, instances, profiles, dialects, examples and the project package are gone.
  'workbenchApi',
  'casesApi',
  'platformApi.cases',
  'platformApi.case',
  'platformApi.revisions',
  'platformApi.caseRevisions',
  'platformApi.deleteCase',
  'platformApi.artifacts',
  'platformApi.uploadArtifact',
  'platformApi.downloadArtifact',
  'platformApi.deleteArtifact',
  'platformApi.snapshot',
  'platformApi.snapshotArchive',
  'platformApi.exportPackage',
  'platformApi.importPackage',
  'getProfiles',
  'getDialects',
  'validatePackage',
  'getBimExamples',
  'getBimExamplePackage',
  'getBimSnapshotIr',
  'createBimJob',
  'createConfiguredBimJob',
  // F0b B6: runs belong to the organization (`runsApi`); the account's and the project's run lists are gone.
  'platformApi.projectJobs',
  'listOwnJobs',
  'getBindingNeighborhood',
  'getJobStatus',
  'getV1Job',
  'pollJob',
  // F0b B7: study runs freeze their definitions; the artifact library and the project resources are gone.
  'libraryApi',
  'platformApi.resources',
  'platformApi.resourceRevisions',
];

const REMOVED_PATHS: [string, RegExp][] = [
  ['/v1/analysis/', /\/v1\/analysis\//],
  ['sponsor-proposals', /sponsor-proposals/],
  ['/v1/admin/organizations/…/sponsor', /\/v1\/admin\/organizations\/.*\/sponsor/],
  ['/v1/instances', /\/v1\/instances\b/],
  ['/v1/snapshots', /\/v1\/snapshots\b/],
  ['/v1/profiles', /\/v1\/profiles\b/],
  ['/v1/dialects', /\/v1\/dialects\b/],
  ['/v1/examples', /\/v1\/examples\b/],
  ['/v1/validate', /\/v1\/validate\b/],
  // F0b B6. An engine's own `/internal/v1/jobs/{id}` is the engine protocol, not the gateway's runs.
  ['/v1/jobs', /(?<!\/internal)\/v1\/jobs\b/],
  ['/v1/users/me/jobs', /\/v1\/users\/me\/jobs\b/],
  // F0b B7.
  ['/v1/artifacts', /\/v1\/artifacts\b/],
];

const KEPT_BINDINGS = [
  'libraryItemsApi.list',
  'libraryItemsApi.versions',
  'libraryItemsApi.content',
  'libraryItemsApi.resolve',
  'platformApi.studies',
  'platformApi.studyRuns',
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS: [string, RegExp][] = [
  ...REMOVED_BINDINGS.map((binding): [string, RegExp] => [
    binding,
    new RegExp(`(?<![\\w$])${escapeRegExp(binding)}\\b`),
  ]),
  ...REMOVED_PATHS,
];

/** Every line of the sources that names a removed binding or path, as `file:line  name`. */
function findings(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    text
      .split('\n')
      .flatMap((line, index) =>
        PATTERNS.filter(([, pattern]) => pattern.test(line)).map(
          ([name]) => `${file}:${index + 1}  ${name}`
        )
      )
  );
}

const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.*', '!/src/test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('removed operations (M9.6, F0b)', () => {
  it('lists the bindings and paths of M9.6 and F0b (B4, B5, B6 and B7)', () => {
    expect(REMOVED_BINDINGS).toHaveLength(64);
    expect(new Set(REMOVED_BINDINGS).size).toBe(64);
    expect(REMOVED_PATHS).toHaveLength(12);
  });

  it('finds no binding or path of a removed operation in the application sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(sources)).toContain('/src/modules/core/api/http.ts');
    expect(findings(sources)).toEqual([]);
  });

  it('names the file and the binding when one comes back', () => {
    const client =
      'export class ApiClient {\n  listMySponsorProposals() {\n    return this.request(`/v1/users/me/sponsor-proposals`);\n  }\n}\n';
    expect(findings({ '/src/api/client.ts': client })).toEqual([
      '/src/api/client.ts:2  listMySponsorProposals',
      '/src/api/client.ts:3  sponsor-proposals',
    ]);
    expect(
      findings({
        '/src/pages/Admin/Transfer.tsx': 'fetch(`/v1/admin/organizations/${org}/sponsor`)',
      })
    ).toEqual(['/src/pages/Admin/Transfer.tsx:1  /v1/admin/organizations/…/sponsor']);
  });

  it('does not report the kept bindings', () => {
    expect(
      findings({ '/src/kept.ts': KEPT_BINDINGS.map(binding => `${binding}(org);`).join('\n') })
    ).toEqual([]);
  });

  it('leaves none of the removed members on the client objects', () => {
    const objects = new Map<string, object>([
      // The old `platformApi` became the organization's client when `api/platform.ts` was split.
      ['platformApi', organizationClient],
      ['apiClient', apiClient],
      ['runsApi', runsApi],
    ]);
    for (const binding of REMOVED_BINDINGS) {
      const dot = binding.indexOf('.');
      const owner = binding.slice(0, Math.max(dot, 0));
      const member = binding.slice(dot + 1);
      if (owner === 'libraryItemsApi') continue; // its module is gone, see below
      // A dotted binding is looked for on its object; a bare name on every one of them.
      const targets = owner ? [objects.get(owner)] : [...objects.values()];
      for (const target of targets) {
        expect(target, binding).toBeDefined();
        expect(member in (target as object), binding).toBe(false);
      }
    }
  });

  it('has no analysis archive module, no library item editor module and no library module', () => {
    expect(
      Object.keys(
        import.meta.glob([
          '/src/analysis/archive.ts',
          '/src/api/analysis/**',
          '/src/api/libraryItems.ts',
          '/src/api/library.ts',
          '/src/components/Artifacts/**',
        ])
      )
    ).toEqual([]);
  });
});
