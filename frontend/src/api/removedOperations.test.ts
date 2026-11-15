import { describe, expect, it } from 'vitest';
import { apiClient } from './client';
import { jobsApi } from './jobs';
import { libraryApi } from './library';
import { platformApi } from './platform';

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
  'libraryApi.drafts',
  'adminTransferSponsor',
  'listMySponsorProposals',
  'listOrganizationSponsorProposals',
  'acceptSponsorProposal',
  'declineSponsorProposal',
  'cancelSponsorProposal',
  // F0b B4: the account's run history screen is gone, and with it the call that read it for that screen.
  'jobsApi.history',
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
  'jobsApi.ir',
  'jobsApi.instance',
  'getProfiles',
  'getDialects',
  'validatePackage',
  'getBimExamples',
  'getBimExamplePackage',
  'getBimSnapshotIr',
  'createBimJob',
  'createConfiguredBimJob',
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
];

const KEPT_BINDINGS = [
  'platformApi.resources',
  'platformApi.resourceRevisions',
  'libraryItemsApi.list',
  'libraryItemsApi.versions',
  'libraryItemsApi.content',
  'libraryItemsApi.resolve',
  'libraryApi.list',
  'libraryApi.versions',
  'libraryApi.content',
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS: [string, RegExp][] = [
  ...REMOVED_BINDINGS.map((binding): [string, RegExp] => [binding, new RegExp(`(?<![\\w$])${escapeRegExp(binding)}\\b`)]),
  ...REMOVED_PATHS,
];

/** Every line of the sources that names a removed binding or path, as `file:line  name`. */
function findings(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    text.split('\n').flatMap((line, index) =>
      PATTERNS.filter(([, pattern]) => pattern.test(line)).map(([name]) => `${file}:${index + 1}  ${name}`)));
}

const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.*', '!/src/test/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('removed operations (M9.6, F0b)', () => {
  it('lists the 33 bindings and 3 paths of M9.6, and the 25 bindings and 6 paths F0b B5 removed', () => {
    expect(REMOVED_BINDINGS).toHaveLength(58);
    expect(new Set(REMOVED_BINDINGS).size).toBe(58);
    expect(REMOVED_PATHS).toHaveLength(9);
  });

  it('finds no binding or path of a removed operation in the application sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(sources)).toContain('/src/api/client.ts');
    expect(findings(sources)).toEqual([]);
  });

  it('names the file and the binding when one comes back', () => {
    const client = 'export class ApiClient {\n  listMySponsorProposals() {\n    return this.request(`/v1/users/me/sponsor-proposals`);\n  }\n}\n';
    expect(findings({ '/src/api/client.ts': client })).toEqual([
      '/src/api/client.ts:2  listMySponsorProposals',
      '/src/api/client.ts:3  sponsor-proposals',
    ]);
    expect(findings({ '/src/pages/Admin/Transfer.tsx': 'fetch(`/v1/admin/organizations/${org}/sponsor`)' })).toEqual([
      '/src/pages/Admin/Transfer.tsx:1  /v1/admin/organizations/…/sponsor',
    ]);
  });

  it('does not report the kept bindings', () => {
    expect(findings({ '/src/kept.ts': KEPT_BINDINGS.map((binding) => `${binding}(org);`).join('\n') })).toEqual([]);
  });

  it('leaves none of the removed members on the client objects', () => {
    const objects = new Map<string, object>([['platformApi', platformApi], ['libraryApi', libraryApi], ['apiClient', apiClient], ['jobsApi', jobsApi]]);
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

  it('has no analysis archive module and no library item editor module', () => {
    expect(Object.keys(import.meta.glob(['/src/analysis/archive.ts', '/src/api/analysis/**', '/src/api/libraryItems.ts']))).toEqual([]);
  });
});
