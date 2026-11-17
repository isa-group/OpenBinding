import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../api/client';
import type { Organization } from '../../../organization/api/organizationsApi';
import { addressNow } from '../../../../test/moduleKit';
import {
  memberOf,
  problemGateway,
  problemOf,
  renderProblemPage,
  versionOf,
} from '../../../../test/problemPage';
import ProblemCardPage from '../../pages/card';
import { checkoutFacts, digestOf } from '../../utils/fixtures';

const problems = vi.hoisted(() => ({
  revision: vi.fn(),
  compilation: vi.fn(),
  source: vi.fn(),
}));
const facts = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../../core/utils/problem/facts', async actual => ({
  ...(await actual<typeof import('../../../core/utils/problem/facts')>()),
  problemFactsApi: facts,
}));

const viewer = memberOf('isa-demo', 'VIEWER', 'ISA Demo Group');
const member = memberOf('isa-demo', 'MEMBER', 'ISA Demo Group');
const checkout = problemOf('flujo-checkout', 'Flujo de checkout');
const r1 = versionOf(checkout, 1);
const r2 = versionOf(checkout, 2, { origin: 'editor' });
const root = '/problems/isa-demo';

const refusal = (status: number, code = 'refused') =>
  Object.assign(new HttpError(status, 'refused'), { code });
const compilationOf = (revision: string) => ({
  id: `compilation-${revision}`,
  revision_id: `rev-${revision}`,
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '1',
  created_at: '2026-08-20T10:05:00Z',
  current: true,
  toolchain: {},
  analysis: { tasks: 1, candidates: 1, constraints: 0, placement: false, bindingSpace: '1' },
  resources: {},
  compatible_modes: [],
});

const zipOf = (instance: string) =>
  new JSZip()
    .file('instance.json', instance)
    .file('application.json', '{"kind":"Application"}')
    .generateAsync({ type: 'arraybuffer' });

/** The Versions tab of the problem page, which compares the pair named by `from` and `to`. */
function renderVersions(query = '', organization: Organization = viewer, revisions = [r1, r2]) {
  return renderProblemPage(<ProblemCardPage />, {
    url: `${root}/flujo-checkout/versions${query}`,
    organizations: [organization],
    gateway: problemGateway('isa-demo', checkout, revisions),
  });
}

describe('Versions tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.compilation.mockImplementation(
      async (_org: string, _problem: string, revision: string) => compilationOf(String(revision))
    );
    facts.get.mockImplementation(async (_org: string, _problem: string, revision: string) =>
      checkoutFacts(String(revision) === '1' ? 5 : 8)
    );
    problems.revision.mockImplementation(
      async (_org: string, _problem: string, revision: string) => ({
        ...(String(revision) === '1' ? r1 : r2),
        document: { apiVersion: 'bim/v1', kind: 'Instance' },
        files: [],
        resource_digests: {},
        compilations: [{ ...compilationOf(String(revision)), binding_space: '4096' }],
      })
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('lists the versions newest first, each with where it came from, its size and its links', async () => {
    renderVersions('', member);

    const list = await screen.findByRole('list', { name: 'Versions of Flujo de checkout' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Version 2', 'Version 1']);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(within(rows[0]).getByText('Latest')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Problem editor')).toBeInTheDocument();
    expect(await within(rows[0]).findByText(/≈ 10\^3\.6 combinations/)).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link', { name: 'Run' })).toHaveAttribute(
      'href',
      '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2'
    );
    expect(within(rows[1]).getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      `${root}/flujo-checkout/source?version=1`
    );
    fireEvent.click(
      within(rows[1]).getByRole('button', { name: 'Copy exact reference of version 1' })
    );
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `flujo-checkout@1 ${r1.package_digest}`
      )
    );
  });

  it('compares the previous version with the latest when asked', async () => {
    renderVersions();

    fireEvent.click(await screen.findByRole('button', { name: 'Compare versions' }));
    await waitFor(() => expect(addressNow()).toContain('from=1&to=2'));
    expect(screen.getByLabelText('Base version')).toHaveValue('1');
    expect(screen.getByLabelText('Compared with')).toHaveValue('2');
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(cell => cell.textContent)
    ).toEqual(['What', 'Version 1', 'Version 2', 'Change']);
    const row = within(table).getByRole('row', { name: /Candidates for pay-card/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map(cell => cell.textContent)
    ).toEqual(['5', '8', 'Changed']);
    expect(within(table).getByRole('row', { name: /Workflow/ })).toHaveTextContent('Same');
    expect(screen.getByRole('link', { name: 'Open version 2' })).toHaveAttribute(
      'href',
      `${root}/flujo-checkout?version=2`
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide comparison' }));
    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument());
  });

  it('counts the changes per category in the summary tiles and narrows the table to one of them', async () => {
    renderVersions('?from=1&to=2');
    await screen.findByRole('table');

    const summary = screen.getByRole('region', { name: 'Summary' });
    const counts = within(summary)
      .getAllByRole('button')
      .map(button => button.textContent);
    expect(counts).toEqual([
      'All changes3changed',
      'Providers3changed',
      'Tasks0no change',
      'Rules0no change',
      'Goal0no change',
    ]);
    expect(within(summary).getByRole('button', { name: /^All changes/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(within(summary).getByRole('button', { name: /^Providers/ }));
    expect(within(summary).getByRole('button', { name: /^Providers/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(
      rows.every(
        row =>
          row.textContent?.includes('Candidates') || row.textContent?.includes('Providers in total')
      )
    ).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('prints both sizes side by side, as the gateway measured them', async () => {
    renderVersions('?from=1&to=2');

    const section = await screen.findByRole('region', { name: 'Possible combinations' });
    expect(within(section).getByText('Version 1')).toBeInTheDocument();
    expect(await within(section).findByText('10^2.8 → 10^3.3')).toBeInTheDocument();
    expect(facts.get).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '1', 'compilation-1');
  });

  it('chooses the pair from the address and swaps it', async () => {
    renderVersions('?from=2&to=1');

    await screen.findByRole('table');
    expect(screen.getByLabelText('Base version')).toHaveValue('2');
    expect(screen.getByLabelText('Compared with')).toHaveValue('1');
    expect(await screen.findByText('10^3.3 → 10^2.8')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap versions' }));
    await waitFor(() => expect(screen.getByLabelText('Base version')).toHaveValue('1'));
    expect(screen.getByLabelText('Compared with')).toHaveValue('2');
  });

  it('copies a one-line summary of the change', async () => {
    renderVersions('?from=1&to=2');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(text).toContain('flujo-checkout v1 → v2:');
    expect(text).toContain('Candidates for pay-card 5 → 8');
    expect(await screen.findByRole('button', { name: 'Summary copied' })).toBeInTheDocument();
  });

  it('shows a file of the two packages side by side, instance.json first', async () => {
    problems.source.mockImplementation(async (_org: string, _problem: string, revision: number) =>
      zipOf(`{"kind":"Instance","version":${revision}}`)
    );
    renderVersions('?from=1&to=2&diff=file');

    const file = await screen.findByLabelText('File');
    expect(file).toHaveValue('instance.json');
    expect(
      within(file)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['instance.json', 'application.json']);
    expect(await screen.findByText('1 line removed')).toBeInTheDocument();
    expect(screen.getByText('1 line added')).toBeInTheDocument();
    fireEvent.change(file, { target: { value: 'application.json' } });
    expect(await screen.findByText('The two files are identical')).toBeInTheDocument();
    expect(addressNow()).toContain('file=application.json');
  });

  it('has nothing to compare when both sides are the same version', async () => {
    renderVersions('?from=2&to=2');

    expect(
      await screen.findByText(
        'Both sides are the same version, so there’s nothing to compare. Choose two different versions.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when one of the versions does not exist (404)', async () => {
    renderVersions('?from=1&to=7');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One of these versions doesn’t exist (404). Pick another pair.'
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Base version')).toBeInTheDocument();
  });

  it('offers no comparison before there are two versions', async () => {
    renderVersions('', member, [r1]);

    expect(
      await screen.findByText(
        'Flujo de checkout has one sealed version so far. Seal another one to compare them.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compare versions' })).not.toBeInTheDocument();
  });

  it('says what it cannot compare when a compiled form cannot be read', async () => {
    problems.compilation.mockImplementation(
      async (_org: string, _problem: string, revision: string) => {
        if (String(revision) === '1') throw refusal(422, 'revision_not_recompilable');
        return compilationOf(String(revision));
      }
    );
    renderVersions('?from=1&to=2');

    expect(
      await screen.findByText(
        /Providers, tasks, rules and goal are compared from the compilation of each version, and version 1 has none that can be read\. The two packages differ\./
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Possible combinations' })).not.toBeInTheDocument();
  });
});
