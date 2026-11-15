import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { compositionViewModel, type Reader } from '../../../entities/composition/viewModel';
import type { CompositionVersionView, CompositionView } from '../../../shared/api/types';
import fmsVersion from '../../../test/fixtures/core/fms.version.json';
import { CompositionRenderer } from '../CompositionRenderer';
import type { Section } from '../presets';

const composition = (overrides: Partial<CompositionView> = {}): CompositionView => ({
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'fms',
  name: 'Fleet management',
  description: 'Routes a fleet.',
  kind: 'application',
  archived: false,
  visibility: 'private',
  organization: { id: '00000000-0000-4000-8000-000000000002', slug: 'isa-demo', name: 'ISA demo' },
  created_by_id: '00000000-0000-4000-8000-000000000003',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:02Z',
  version_count: 1,
  ...overrides,
});

const linked = () => structuredClone(fmsVersion) as CompositionVersionView;

/** The version as an author who declared the values sealed it: no problem, no evaluation by the toolchain. */
function declared(): CompositionVersionView {
  const version = linked();
  version.values_status = 'declared';
  version.verified = false;
  version.problem = null;
  version.derivation = null;
  version.current_evaluation = { ...version.current_evaluation!, basis: 'declared', outcome: 'declared', compilation: null };
  version.evaluations = version.evaluations.map((evaluation) => ({ ...evaluation, basis: 'declared' as const, outcome: 'declared' as const, binding: null, compilation: null }));
  const document = version.document as Record<string, unknown>;
  delete document.problem;
  document.evidence = { evaluatedBy: 'declared' };
  document.binding = { ...(document.binding as object), T1: { candidate: 'cand_t1_aws', from: { sphere: 'aws/aws', version: '2026-01', plan: 'BASIC', addons: ['support'] } } };
  document.offering = { sphere: 'acme/fleet' };
  return version;
}

/** The toolchain found that the problem changed meaning since the values were computed. */
function semanticsChanged(): CompositionVersionView {
  const version = linked();
  version.verified = false;
  version.current_evaluation = { ...version.current_evaluation!, outcome: 'semantics_changed' };
  version.evaluations = version.evaluations.map((evaluation) => ({
    ...evaluation, outcome: 'semantics_changed' as const,
    diagnostics: [{ code: 'c2y_semantics_changed', message: 'The problem changed.', severity: 'warning' as const, path: 'problem', pointer: '/problem', span: null }],
  }));
  return version;
}

/** The current evaluation was made on another compilation than the one the version links. */
function drifted(): CompositionVersionView {
  const version = linked();
  version.current_evaluation!.compilation!.semantic_digest = `sha256-${'f'.repeat(64)}`;
  return version;
}

function renderCatalog(version: CompositionVersionView | null, options: { reader?: Reader; hide?: Section[]; problemHref?: string } = {}) {
  const model = compositionViewModel({ composition: composition(), version, reader: options.reader ?? 'member' });
  return render(
    <MemoryRouter>
      <CompositionRenderer
        model={model}
        mode="catalog"
        hideSections={options.hide}
        problemHref={options.problemHref ?? '/app/isa-demo/problems/fms?version=1'}
        runHref={(run) => `/app/isa-demo/runs/${run}`}
      />
    </MemoryRouter>,
  );
}

const section = (name: string) => screen.getByRole('region', { name });

describe('the catalog mode', () => {
  it('names the composition and its kind', () => {
    renderCatalog(linked());
    expect(screen.getByRole('heading', { level: 2, name: 'Fleet management' })).toBeInTheDocument();
    expect(screen.getByText('Application · ISA demo')).toBeInTheDocument();
    expect(screen.getByText('Routes a fleet.')).toBeInTheDocument();
  });

  it('marks values the toolchain verified, and places them as the gateway gave them', () => {
    renderCatalog(linked());
    const status = section('Value status');
    expect(within(status).getByText('Verified')).toBeInTheDocument();
    expect(within(status).getByText(/evaluated this binding against the problem/)).toBeInTheDocument();
    expect(within(status).queryByText('Evaluated on another compilation')).toBeNull();
    const values = section('Values');
    expect(within(values).getByText('cost').nextSibling).toHaveTextContent('3,060 USD/month');
    expect(within(values).getByText('security').nextSibling).toHaveTextContent('4 score');
    expect(within(values).getByText('reliability').nextSibling).toHaveTextContent('0.976706');
  });

  it('marks declared values, the provenance of a candidate and an offering of SPHERE as references', () => {
    renderCatalog(declared());
    expect(within(section('Value status')).getByText('Declared')).toBeInTheDocument();
    expect(within(section('Value status')).getByText(/author wrote these values/)).toBeInTheDocument();
    const binding = within(section('Binding'));
    expect(binding.getByText('From aws/aws · plan BASIC · version 2026-01 · add-ons support')).toBeInTheDocument();
    expect(binding.getByText('In-house')).toBeInTheDocument();
    expect(within(section('Offering')).getByText('acme/fleet')).toBeInTheDocument();
    expect(within(section('Offering')).queryByRole('link')).toBeNull();
    expect(within(section('Evidence')).getByText('Declared by the author.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Problem' })).toBeNull();
  });

  it('marks values that are no longer verified, and lists what the evaluation found for a member', () => {
    renderCatalog(semanticsChanged());
    expect(within(section('Value status')).getByText('Unverified')).toBeInTheDocument();
    expect(within(section('Value status')).getByText(/changed meaning since the values were computed/)).toBeInTheDocument();
    expect(within(section('Evaluation findings')).getByText('The problem changed.')).toBeInTheDocument();
    // Read-only: the catalog lists findings, it does not jump anywhere.
    expect(screen.queryByRole('button', { name: /The problem changed/ })).toBeNull();
  });

  it('says so when the values were evaluated on another compilation than the one linked', () => {
    renderCatalog(drifted());
    expect(within(section('Value status')).getByText('Evaluated on another compilation')).toBeInTheDocument();
  });

  it('links the problem and the evidence for a member', () => {
    renderCatalog(linked());
    expect(within(section('Problem')).getByRole('link', { name: 'fixtures/problems/fms@1' })).toHaveAttribute('href', '/app/isa-demo/problems/fms?version=1');
    const evidence = within(section('Evidence'));
    expect(evidence.getByText(/Evaluated by the gateway/)).toHaveTextContent('Evaluated by the gateway with bim-core 0.2.0.');
    expect(evidence.getByText('Derived from a binding of problem version 1.')).toBeInTheDocument();
  });

  it('names the problem as text for a public reader, and shows no findings', () => {
    renderCatalog(semanticsChanged(), { reader: 'public' });
    const problem = within(section('Problem'));
    expect(problem.queryByRole('link')).toBeNull();
    expect(problem.getByText('fixtures/problems/fms@1')).toBeInTheDocument();
    expect(problem.getByText(/the problem itself is not shared/)).toBeInTheDocument();
    expect(screen.queryByText('The problem changed.')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Evaluation findings' })).toBeNull();
  });

  it('leaves out the sections a screen hides', () => {
    renderCatalog(linked(), { hide: ['identity', 'diagnostics'] });
    expect(screen.queryByRole('heading', { name: 'Fleet management' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Evaluation findings' })).toBeNull();
    expect(section('Values')).toBeInTheDocument();
  });

  it('says there is no version yet', () => {
    renderCatalog(null);
    expect(screen.getByText(/No version yet/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Values' })).toBeNull();
  });
});
