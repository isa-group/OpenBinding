import { describe, expect, it } from 'vitest';
import { ENGINE_DOCUMENT, QOS_PROFILE } from '../Engines/fixtures';
import {
  BUILTIN_VOCABULARY, buildManifest, bumpPatch, draftFromManifest, issueAt, newDraft, newMode, newOption, validateDraft, vocabulariesFrom,
} from './engineDraft';

const VOCABULARIES = [BUILTIN_VOCABULARY];

describe('the engine form’s starting point', () => {
  it('is a manifest the gateway’s schema accepts: every dimension of the profile is named, scalarizations are required', () => {
    const draft = newDraft(BUILTIN_VOCABULARY);
    expect(validateDraft(draft, VOCABULARIES)).toEqual([]);
    const manifest = buildManifest(draft, 'alice', VOCABULARIES);
    expect(manifest).toMatchObject({ apiVersion: 'bim/v1', kind: 'Engine', metadata: { namespace: 'alice', name: 'my-engine', version: '1.0.0' } });
    const [mode] = manifest.spec.modes;
    const capabilities = mode.capabilities as unknown as Record<string, unknown>;
    expect(Object.keys(capabilities)).toEqual(BUILTIN_VOCABULARY.dimensions.map((dimension) => dimension.id));
    expect(capabilities.featureValues).toEqual({ selector: 'only', values: ['scalar'] });
    expect(capabilities.irExtensions).toEqual({ selector: 'none' });
    expect(capabilities.workflowNodes).toEqual({ selector: 'all' });
    expect(capabilities.scalarizations).toEqual({ selector: 'only', values: [{ id: 'weighted-sum', objectiveTypes: ['SINGLE'], weightPolicy: 'required' }] });
    expect(mode.ir).toEqual({ apiVersion: 'bim/v1', kind: 'BindingProblem' });
    expect(mode.guarantees).toEqual({ termination: ['FEASIBLE', 'UNKNOWN'], exact: false });
    expect(mode.limits).toEqual({ maxTimeBudgetMs: 3600000 });
    expect(mode.optionsSchema).toEqual({
      type: 'object',
      properties: { time_budget_ms: { type: 'integer', minimum: 1, maximum: 3600000, default: 60000 } },
      additionalProperties: false,
    });
  });

  it('always puts the account’s namespace in the manifest', () => {
    const draft = { ...newDraft(BUILTIN_VOCABULARY), description: '  Edge placement  ' };
    expect(buildManifest(draft, 'alice', VOCABULARIES).metadata).toEqual({ namespace: 'alice', name: 'my-engine', version: '1.0.0', description: 'Edge placement' });
  });
});

describe('validating the draft', () => {
  it('says which field is wrong, in the schema’s own terms', () => {
    const draft = newDraft(BUILTIN_VOCABULARY);
    draft.name = '-bad';
    draft.version = '0.1.0';
    draft.modes[0].id = '';
    draft.modes[0].algorithm = ' ';
    draft.modes[0].termination = [];
    draft.modes[0].scalarizations = [];
    draft.modes[0].limits = { maxTimeBudgetMs: '0' };
    draft.modes[0].capabilities.irExtensions = { selector: 'all', values: [] };
    draft.modes[0].capabilities.expressions = { selector: 'only', values: [] };
    const issues = validateDraft(draft, VOCABULARIES);
    expect(issueAt(issues, 'name')).toMatch(/Start with a letter or digit/);
    expect(issueAt(issues, 'version')).toMatch(/starting at 1/);
    expect(issueAt(issues, 'modes.0.id')).toBe('Give the mode a name.');
    expect(issueAt(issues, 'modes.0.algorithm')).toBe('Say which algorithm it runs.');
    expect(issueAt(issues, 'modes.0.termination')).toBe('Pick at least one way a run can end.');
    expect(issueAt(issues, 'modes.0.scalarizations')).toBeDefined();
    expect(issueAt(issues, 'modes.0.limits.maxTimeBudgetMs')).toBe('Use a whole number of 1 or more.');
    expect(issueAt(issues, 'modes.0.capabilities.irExtensions')).toMatch(/open/);
    expect(issueAt(issues, 'modes.0.capabilities.expressions')).toMatch(/at least one value/);
  });

  it('checks options: names, whole numbers, an empty range and a default outside it', () => {
    const draft = newDraft(BUILTIN_VOCABULARY);
    draft.modes[0].options = [
      newOption('a', { minimum: '5', maximum: '1' }),
      newOption('a', { minimum: '1.5' }),
      newOption('', { type: 'number', minimum: '0', maximum: '1', default: '2' }),
      newOption('flag', { type: 'boolean', default: 'maybe' }),
    ];
    const issues = validateDraft(draft, VOCABULARIES);
    expect(issueAt(issues, 'modes.0.options.0.maximum')).toBe('The maximum is below the minimum.');
    expect(issueAt(issues, 'modes.0.options.1.name')).toBe('Two options can’t share a name.');
    expect(issueAt(issues, 'modes.0.options.1.minimum')).toBe('Use a whole number.');
    expect(issueAt(issues, 'modes.0.options.2.name')).toBe('Name the option.');
    expect(issueAt(issues, 'modes.0.options.2.default')).toBe('The default is outside the range.');
    expect(issueAt(issues, 'modes.0.options.3.default')).toBe('Use true or false.');
  });

  it('refuses two modes with one name, and an engine with no mode', () => {
    const draft = newDraft(BUILTIN_VOCABULARY);
    draft.modes.push(newMode(BUILTIN_VOCABULARY, 'default'));
    expect(issueAt(validateDraft(draft, VOCABULARIES), 'modes.1.id')).toBe('Two modes can’t share a name.');
    expect(issueAt(validateDraft({ ...draft, modes: [] }, VOCABULARIES), 'modes')).toBe('An engine needs at least one mode.');
  });
});

describe('the profile’s vocabulary', () => {
  it('is read from the installed profile, with the dimensions that accept any value marked open', () => {
    const [vocabulary] = vocabulariesFrom([QOS_PROFILE]);
    expect(vocabulary).toMatchObject({ profile: 'qos-binding/v1', source: 'gateway', ir: { kind: 'BindingProblem' }, limits: ['maxTasks', 'maxIterations', 'maxTimeBudgetMs'] });
    expect(vocabulary.dimensions.find((dimension) => dimension.id === 'irExtensions')).toMatchObject({ open: true });
    expect(vocabulary.dimensions.find((dimension) => dimension.id === 'featureValues')?.values).toEqual(['scalar', 'interval']);
  });

  it('falls back to the standard one when no profile can be read', () => {
    expect(vocabulariesFrom([])).toEqual([BUILTIN_VOCABULARY]);
  });
});

describe('an engine manifest in the form and back', () => {
  const [gateway] = vocabulariesFrom([QOS_PROFILE]);

  it('keeps what the manifest declares: ranges, scalarizations, fixed options, ceilings and guarantees', () => {
    const draft = draftFromManifest(ENGINE_DOCUMENT, [gateway]);
    expect(draft).not.toBeNull();
    const built = buildManifest(draft!, 'lucia.vega', [gateway]);
    const [mode] = built.spec.modes;
    const capabilities = mode.capabilities as unknown as Record<string, unknown>;
    expect(capabilities.featureValues).toEqual({ selector: 'only', values: ['scalar', 'interval'] });
    expect((capabilities.scalarizations as { values: unknown[] }).values).toHaveLength(2);
    expect(mode.optionsSchema.properties.algorithm).toEqual({ const: 'tabu', default: 'tabu' });
    expect(mode.optionsSchema.required).toEqual(['time_budget_ms']);
    expect(mode.limits).toEqual({ maxIterations: 100000, maxTimeBudgetMs: 3600000 });
    expect(mode.guarantees).toEqual({ termination: ['FEASIBLE', 'UNKNOWN'], exact: false, deterministicWithoutTimeBudget: true });
    expect(mode.algorithm).toBe('tabu-search');
    // Nothing else is wrong with it; only its 0.x version, which the Engine schema refuses (the major version starts at 1).
    expect(validateDraft(draft!, [gateway]).map((issue) => issue.path)).toEqual(['version']);
    expect(validateDraft({ ...draft!, version: bumpPatch('1.3.0') }, [gateway])).toEqual([]);
  });

  it('keeps labels, annotations and extensions it does not edit', () => {
    const draft = draftFromManifest({
      metadata: { name: 'x', version: '1.0.0', labels: { team: 'edge' }, annotations: { note: 1 } },
      spec: { modes: [{ id: 'm' }], extensions: { vendor: { a: true } } },
    }, [gateway]);
    const built = buildManifest(draft!, 'alice', [gateway]);
    expect(built.metadata).toMatchObject({ labels: { team: 'edge' }, annotations: { note: 1 } });
    expect(built.spec.extensions).toEqual({ vendor: { a: true } });
  });

  it('does not take what is not an engine', () => {
    expect(draftFromManifest({ spec: {} }, [gateway])).toBeNull();
    expect(draftFromManifest('text', [gateway])).toBeNull();
  });
});

describe('versions', () => {
  it('bumps the patch number and leaves anything else alone', () => {
    expect(bumpPatch('1.0.9')).toBe('1.0.10');
    expect(bumpPatch('2.3.0-rc.1')).toBe('2.3.1-rc.1');
    expect(bumpPatch('latest')).toBe('latest');
  });
});
