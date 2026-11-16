import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compositionViewModel } from '../../utils/composition/viewModel';
import type { TaskModel } from '../../utils/composition/viewModel';
import type { CompositionVersionView, CompositionView, ProblemFacts } from '../../api/types';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import { ProviderMap } from './ProviderMap';
import { providerGroups } from './providerGroups';

const composition = {
  id: 'composition-fms',
  slug: 'fms',
  name: 'Fleet management',
  description: '',
  kind: 'application',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA demo' },
  created_by_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version_count: 1,
} as CompositionView;

const tasksOf = (facts?: ProblemFacts) =>
  compositionViewModel({
    composition,
    version: structuredClone(fmsVersion) as CompositionVersionView,
    facts,
    reader: 'member',
  }).tasks;

const task = (id: string, over: Partial<TaskModel> = {}): TaskModel => ({
  id,
  local: false,
  candidate: `${id}-candidate`,
  from: null,
  provider: null,
  ...over,
});

const group = (name: string) => screen.getByRole('list', { name: new RegExp(`^${name}`) });

describe('providerGroups', () => {
  it('groups the tasks by the provider the facts name, in workflow order, with the in-house tasks last', () => {
    const groups = providerGroups(tasksOf(fmsFacts as ProblemFacts));
    expect(groups.map(item => [item.kind, item.name, item.tasks.map(entry => entry.id)])).toEqual([
      ['provider', 'amazon', ['T1', 'T5']],
      ['provider', 'radius', ['T2']],
      ['provider', 'google', ['T3']],
      ['provider', 'paypal', ['T6']],
      ['in-house', '', ['node_classic_routing']],
    ]);
  });

  it('falls back to the SPHERE pricing a candidate comes from, then to an unknown provider', () => {
    const brevo = { sphere: 'brevo/brevo', version: 'v1', plan: 'STARTER' };
    const groups = providerGroups([
      task('signIn', { local: true, candidate: null }),
      task('notify', { from: brevo }),
      task('archive'),
      task('digest', { from: { ...brevo, plan: 'BUSINESS' } }),
      task('mirror', { from: { ...brevo, registry: 'lab' } }),
      task('idle', { candidate: null }),
    ]);
    expect(groups.map(item => [item.kind, item.name, item.tasks.map(entry => entry.id)])).toEqual([
      ['pricing', 'brevo/brevo', ['notify', 'digest']],
      ['pricing', 'brevo/brevo on lab', ['mirror']],
      ['unknown', '', ['archive', 'idle']],
      ['in-house', '', ['signIn']],
    ]);
  });

  it('prefers the provider of the facts to the pricing a candidate names', () => {
    const groups = providerGroups([
      task('notify', {
        provider: 'brevo',
        from: { sphere: 'brevo/brevo', version: 'v1', plan: 'STARTER' },
      }),
    ]);
    expect(groups).toMatchObject([{ kind: 'provider', name: 'brevo' }]);
  });
});

describe('ProviderMap', () => {
  it('lists each provider with its tasks and candidates, and the in-house tasks apart', () => {
    render(<ProviderMap tasks={tasksOf(fmsFacts as ProblemFacts)} upstreamPricings={0} />);
    const amazon = group('amazon');
    expect(
      within(amazon)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual(['T1→cand_t1_aws', 'T5→cand_t5_amazon_braket']);
    expect(screen.getByRole('heading', { level: 3, name: 'amazon 2 tasks' })).toBeInTheDocument();
    expect(within(group('In-house')).getByText('node_classic_routing')).toBeInTheDocument();
    expect(
      screen.getByText('No candidate names the SPHERE pricing it comes from.')
    ).toBeInTheDocument();
  });

  it('shows each task’s SPHERE plan, pinned version and add-ons, and the gateway’s count of upstream pricings', () => {
    render(
      <ProviderMap
        tasks={[
          task('notify', {
            from: { sphere: 'brevo/brevo', version: '665f1c2e', plan: 'STARTER', addons: ['SMS'] },
          }),
          task('pick', {
            provider: 'acme',
            from: { sphere: 'acme/picking', registry: 'lab', version: 'v7', plan: 'Pro' },
          }),
          task('archive'),
        ]}
        upstreamPricings={2}
      />
    );
    expect(screen.getByText('The candidates come from 2 SPHERE pricings.')).toBeInTheDocument();
    expect(group('brevo/brevo')).toHaveTextContent('plan STARTER · version 665f1c2e · add-ons SMS');
    expect(group('acme')).toHaveTextContent('acme/picking on lab · plan Pro · version v7');
    expect(
      screen.getByRole('heading', { level: 3, name: 'Provider not known 1 task' })
    ).toBeInTheDocument();
  });

  it('says nothing about upstream pricings when the version carries no counts', () => {
    render(<ProviderMap tasks={tasksOf()} upstreamPricings={null} />);
    expect(screen.queryByText(/SPHERE pricing/)).toBeNull();
    expect(within(group('Provider not known')).getAllByRole('listitem')).toHaveLength(5);
  });
});
