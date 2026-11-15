import { describe, expect, it } from 'vitest';
import type { CompositionVersionView, CompositionView, ProblemFacts } from '../../shared/api/types';
import ambiguousVersion from '../../test/fixtures/core/ambiguous.version.json';
import fmsFacts from '../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../test/fixtures/core/fms.version.json';
import { compositionViewModel } from './viewModel';

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
  version_count: 2,
  ...overrides,
});

const version = () => structuredClone(fmsVersion) as CompositionVersionView;
const facts = fmsFacts as ProblemFacts;

/** The version as a reader who is not a member gets it (the A3 and A6 redaction). */
function publicVersion(): CompositionVersionView {
  const redacted = version();
  redacted.created_by_id = null;
  redacted.problem!.problem = { ...redacted.problem!.problem, id: null, name: null };
  redacted.problem!.revision.id = null;
  redacted.problem!.linked_compilation.id = null;
  redacted.derivation!.revision.id = null;
  redacted.evaluations = redacted.evaluations.map((evaluation) => ({
    ...evaluation, binding: null, diagnostics: [], violations: [], compilation: evaluation.compilation && { ...evaluation.compilation, id: null },
  }));
  return redacted;
}

/** The version as an author who declared the values sealed it: no problem, no evaluation by the toolchain. */
function declaredVersion(): CompositionVersionView {
  const declared = version();
  declared.values_status = 'declared';
  declared.verified = false;
  declared.problem = null;
  declared.derivation = null;
  declared.current_evaluation = { ...declared.current_evaluation!, basis: 'declared', outcome: 'declared', compilation: null };
  declared.evaluations = declared.evaluations.map((evaluation) => ({ ...evaluation, basis: 'declared' as const, outcome: 'declared' as const, binding: null, compilation: null }));
  delete (declared.document as Record<string, unknown>).problem;
  return declared;
}

describe('compositionViewModel for a member', () => {
  const model = compositionViewModel({ composition: composition(), version: version(), facts, reader: 'member' });

  it('names the composition and the version', () => {
    expect(model.identity).toEqual({
      org: 'isa-demo', orgName: 'ISA demo', slug: 'fms', name: 'Fleet management', description: 'Routes a fleet.',
      kind: 'application', visibility: 'private', archived: false,
    });
    expect(model.reader).toBe('member');
    expect(model.version).toMatchObject({ label: '1.0.0', ordinal: 1, createdAt: '2026-01-01T00:00:02Z', syntaxVersion: '1.0', basedOn: null, forkedFrom: null });
    expect(model.version?.derivation).toEqual(fmsVersion.derivation);
  });

  it('says the values are verified on the problem the document names, and readable', () => {
    expect(model.status).toEqual({
      values: 'verified', outcome: 'verified', compilationDrift: false, problemRef: 'fixtures/problems/fms@1', problemReadable: true,
    });
  });

  it('draws the document workflow and lists its tasks with what each is bound to', () => {
    expect(model.workflow.tasks).toEqual(['T1', 'T2', 'T3', 'node_classic_routing', 'T5', 'T6']);
    expect(model.tasks[0]).toEqual({ id: 'T1', local: false, candidate: 'cand_t1_aws', from: null, provider: 'amazon' });
    expect(model.tasks[3]).toEqual({ id: 'node_classic_routing', local: true, candidate: null, from: null, provider: null });
  });

  it('selects each task candidate by the key the evaluation gave the toolchain', () => {
    expect(model.selection).toEqual(fmsVersion.evaluations[0].binding);
  });

  it('draws the candidates of the problem from the facts, with the evaluated candidate of each task selected', () => {
    expect(model.matrix?.rows.map((row) => row.task)).toEqual(facts.tasks.map((task) => task.id));
    const t1 = model.matrix?.rows.find((row) => row.task === 'T1');
    expect(t1?.candidates.map((candidate) => [candidate.key, candidate.selected])).toEqual([['catalog/cand_t1_aws', true], ['catalog/cand_t1_google_cloud', false]]);
    expect(compositionViewModel({ composition: composition(), version: version(), reader: 'member' }).matrix).toBeNull();
  });

  it('carries the counts the gateway stored for the document', () => {
    expect(model.analytics).toMatchObject({ tasks: 6, boundTasks: 5, localTasks: 1, upstreamPricings: 0, hasOffering: false });
  });

  it('places the gateway values as they are, computing none', () => {
    expect(model.values).toEqual(Object.entries(fmsVersion.values).map(([name, { value, unit }]) => ({ name, value, unit, status: 'verified' })));
    for (const value of model.values) expect(value.value).toBe(fmsVersion.values[value.name as keyof typeof fmsVersion.values].value);
  });

  it('carries the evidence the document records', () => {
    expect(model.evidence).toEqual(fmsVersion.document.evidence);
  });

  it('offers the calculator and the configurator on a linked problem it may read', () => {
    expect(model.modes).toEqual(['catalog', 'architecture', 'workflow', 'comparison', 'calculator', 'configurator']);
  });

  it('locates what the evaluation found in the text when it is given, and at the file otherwise', () => {
    const found = version();
    found.evaluations[0].diagnostics = [{
      code: 'c2y_value_differs', message: 'The declared cost differs.', severity: 'warning', path: 'values.cost', pointer: '/values/cost',
      span: { line: 2, column: 1, end_line: 2, end_column: 5 },
    }];
    const located = compositionViewModel({ composition: composition(), version: found, reader: 'member', content: 'a: 1\ncost: 2\n' });
    expect(located.diagnostics[0].where).toEqual({ kind: 'text', file: 'composition.yaml', from: 5, to: 9, line: 2, column: 1 });
    const unplaced = compositionViewModel({ composition: composition(), version: found, reader: 'member' });
    expect(unplaced.diagnostics[0]).toMatchObject({ code: 'c2y_value_differs', where: { kind: 'file', file: 'composition.yaml' }, path: 'values.cost' });
  });

  it('keeps candidate names as the document writes them and keys as the evaluation gave them', () => {
    const ambiguous = compositionViewModel({ composition: composition({ slug: 'ambiguous' }), version: ambiguousVersion as CompositionVersionView, reader: 'member' });
    expect(ambiguous.tasks.map((task) => task.candidate)).toEqual(['catalog/c1a', 'c2a', 'c3a']);
    expect(ambiguous.selection).toEqual({ t1: 'catalog/c1a', t2: 'catalog/c2a', t3: 'catalog/c3a' });
    expect(ambiguous.tasks.every((task) => task.provider === null)).toBe(true);
  });
});

describe('compositionViewModel for a public reader', () => {
  const model = compositionViewModel({ composition: composition({ visibility: 'public', created_by_id: null }), version: publicVersion(), reader: 'public' });

  it('shows the problem as the document names it, but not as something to open', () => {
    expect(model.status.problemRef).toBe('fixtures/problems/fms@1');
    expect(model.status.problemReadable).toBe(false);
  });

  it('has no selection, no findings and no modes that need the problem', () => {
    expect(model.selection).toEqual({});
    expect(compositionViewModel({ composition: composition(), version: publicVersion(), facts, reader: 'public' }).matrix).toBeNull();
    expect(model.diagnostics).toEqual([]);
    expect(model.modes).toEqual(['catalog', 'architecture', 'workflow', 'comparison', 'showcase']);
  });

  it('still shows the values the bytes carry', () => {
    expect(model.values.map((value) => value.name)).toEqual(Object.keys(fmsVersion.values));
    expect(model.status.values).toBe('verified');
  });

  it('has no selection when the evaluation names no binding, whoever reads it', () => {
    expect(compositionViewModel({ composition: composition(), version: publicVersion(), reader: 'member' }).selection).toEqual({});
  });
});

describe('the status of the values', () => {
  it('is declared, with no problem, for a declared version', () => {
    const model = compositionViewModel({ composition: composition(), version: declaredVersion(), reader: 'member' });
    expect(model.status).toEqual({ values: 'declared', outcome: 'declared', compilationDrift: false, problemRef: null, problemReadable: false });
    expect(model.values.every((value) => value.status === 'declared')).toBe(true);
    expect(model.modes).not.toContain('calculator');
  });

  it('is unverified after the toolchain found that the semantics changed', () => {
    const changed = version();
    changed.verified = false;
    changed.current_evaluation!.outcome = 'semantics_changed';
    const model = compositionViewModel({ composition: composition(), version: changed, reader: 'member' });
    expect(model.status.values).toBe('unverified');
    expect(model.status.outcome).toBe('semantics_changed');
    expect(model.values.every((value) => value.status === 'unverified')).toBe(true);
  });

  it('drifts when the evaluation was made on another compilation than the one linked', () => {
    const drifted = version();
    drifted.current_evaluation!.compilation!.semantic_digest = 'sd-another';
    expect(compositionViewModel({ composition: composition(), version: drifted, reader: 'member' }).status.compilationDrift).toBe(true);
    expect(compositionViewModel({ composition: composition(), version: declaredVersion(), reader: 'member' }).status.compilationDrift).toBe(false);
  });
});

describe('the offering', () => {
  const offered = (offering: Record<string, string> | null) => {
    const value = version();
    value.offering = offering;
    return compositionViewModel({ composition: composition(), version: value, reader: 'public' }).offering;
  };

  it('reads each of the three forms as a reference', () => {
    expect(offered({ sphere: 'acme/shop' })).toEqual({ source: 'sphere', label: 'acme/shop', href: null });
    expect(offered({ sphere: 'acme/shop', registry: 'lab' })).toEqual({ source: 'registry', label: 'acme/shop on lab', href: null });
    expect(offered({ url: 'https://pricings.example.org/shop/pricing.yml' })).toEqual({
      source: 'url', label: 'https://pricings.example.org/shop/pricing.yml', href: 'https://pricings.example.org/shop/pricing.yml',
    });
    expect(offered(null)).toBeNull();
  });
});

describe('a composition without versions', () => {
  it('has nothing but the catalog', () => {
    const model = compositionViewModel({ composition: composition({ version_count: 0, latest_version: null }), version: null, reader: 'member' });
    expect(model.version).toBeNull();
    expect(model.status).toEqual({ values: null, outcome: null, compilationDrift: false, problemRef: null, problemReadable: false });
    expect(model.workflow.root).toEqual({ kind: 'empty' });
    expect(model.tasks).toEqual([]);
    expect(model.values).toEqual([]);
    expect(model.evidence).toBeNull();
    expect(model.matrix).toBeNull();
    expect(model.analytics).toBeNull();
    expect(model.modes).toEqual(['catalog']);
  });
});
