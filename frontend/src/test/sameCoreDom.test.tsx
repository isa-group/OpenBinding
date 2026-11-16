import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openProblemEditor, showPane } from '../features/bim-editor/editorTestKit';
import { caseOf, org, renderOrgScreen, revisionOf } from '../features/workspace/testKit';
import { ProblemDetail } from '../pages/Problems/ProblemDetail';
import fmsFacts from './fixtures/core/fms.facts.json';
import fmsValidate from './fixtures/core/fms.validate.json';

// §10 F2, at the DOM: the problem page and the problem editor draw one problem with the same graph and the same matrix. The page
// is fed the stored facts of a compilation (`…/compilations/{c}/facts`), the editor the facts of the same package as a draft
// (`validate?include=facts`), both the gateway's own answers for the `fms` package (an exclusive choice and a local task).

const problems = vi.hoisted(() => ({
  get: vi.fn(), list: vi.fn(), revisions: vi.fn(), revision: vi.fn(), compilation: vi.fn(), ir: vi.fn(), source: vi.fn(), create: vi.fn(), createRevision: vi.fn(),
}));
const facts = vi.hoisted(() => ({ get: vi.fn() }));
const compositions = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), version: vi.fn() }));
const runs = vi.hoisted(() => ({ list: vi.fn() }));
const bim = vi.hoisted(() => ({ validate: vi.fn(), template: vi.fn(), templates: vi.fn() }));

vi.mock('../api/problems', () => ({ problemsApi: problems }));
vi.mock('../entities/problem/facts', async (actual) => ({ ...await actual<typeof import('../entities/problem/facts')>(), problemFactsApi: facts }));
vi.mock('../entities/composition/api', () => ({ compositionsApi: compositions }));
vi.mock('../api/runs', async () => ({ ...await vi.importActual<typeof import('../api/runs')>('../api/runs'), runsApi: runs }));
vi.mock('../api/bim', () => ({ bimApi: bim }));

const problem = caseOf('fms', 'FMS');
const revision = revisionOf(problem, 1);

/** Every candidate table as its rows of cell texts, by its name. */
function tables(): Record<string, string[][]> {
  const matrix = screen.getByRole('region', { name: 'Candidates of each task' });
  return Object.fromEntries(within(matrix).getAllByRole('region').map((region) => [
    region.getAttribute('aria-label') ?? '',
    within(region).getAllByRole('row').map((row) => Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent ?? '')),
  ]));
}

/** The accessible description of the workflow graph named `label`. */
function description(label: string): string {
  const graph = screen.getByRole('group', { name: label });
  return document.getElementById(graph.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
}

function renderProblemPage(tab: '' | '/candidates') {
  return renderOrgScreen(<ProblemDetail />, {
    path: '/app/:org/problems/:case/:tab?', url: `/app/isa-demo/problems/fms${tab}`, organizations: [org('isa-demo', { effective_role: 'MEMBER' })],
  });
}

describe('the problem page and the problem editor draw the same problem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(problem);
    problems.revisions.mockResolvedValue([revision]);
    problems.revision.mockResolvedValue({ ...revision, document: { apiVersion: 'bim/v1', kind: 'Instance' }, files: [], resource_digests: {}, compilations: [] });
    problems.compilation.mockResolvedValue({
      id: 'compilation-1', revision_id: revision.id, compilation_digest: 'sha256-c', compiler_digest: 'sha256-d', ir_digest: 'sha256-i', binding_space: '1',
      created_at: '2026-04-01T00:00:00Z', current: true, toolchain: {}, analysis: fmsValidate.analysis, resources: {}, compatible_modes: [],
    });
    problems.list.mockResolvedValue({ problems: [], total: 0, limit: 200, offset: 0 });
    facts.get.mockResolvedValue(structuredClone(fmsFacts));
    compositions.list.mockResolvedValue({ compositions: [], total: 0, limit: 200, offset: 0 });
    runs.list.mockResolvedValue({ runs: [], total: 0 });
    bim.validate.mockResolvedValue(structuredClone(fmsValidate));
    bim.templates.mockResolvedValue([]);
  });

  it('with the same rows and cells in every candidate table', async () => {
    const page = renderProblemPage('/candidates');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Candidates of each task' })).toBeInTheDocument());
    const onPage = tables();
    page.unmount();

    await openProblemEditor({ delay: 10 });
    await waitFor(() => expect(bim.validate).toHaveBeenCalled());
    showPane('Candidates');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Candidates of each task' })).toBeInTheDocument());
    const inEditor = tables();

    expect(Object.keys(onPage).length).toBeGreaterThan(2);
    expect(Object.values(onPage).flat().length).toBeGreaterThan(Object.keys(onPage).length);
    expect(inEditor).toEqual(onPage);
  });

  it('with the same accessible description of the workflow graph', async () => {
    const page = renderProblemPage('');
    await waitFor(() => expect(screen.getByRole('group', { name: 'Workflow' })).toBeInTheDocument());
    const onPage = description('Workflow');
    page.unmount();

    await openProblemEditor({ delay: 10 });
    await waitFor(() => expect(screen.getByRole('group', { name: 'Workflow of the package' })).toBeInTheDocument());
    expect(onPage.length).toBeGreaterThan(20);
    expect(description('Workflow of the package')).toBe(onPage);
  });
});
