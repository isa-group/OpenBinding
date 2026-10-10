import { describe, expect, it } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError, type CorpusGeneratedResponse, type InstanceGeneratedResponse } from '../../api/client';
import {
  DEFAULT_SETTINGS, checkSettings, combinationsLog10, instanceParams, labRefusal, latencyHistogram, outputFacts, powerText, readObservations, seedOf,
  workspaceFilesOf, type LabSettings, type Output,
} from './generatorModel';

const settings = (over: Partial<LabSettings> = {}): LabSettings => ({ ...DEFAULT_SETTINGS, ...over });
const digest = (char: string) => `sha256-${char.repeat(64)}`;
const generated = (over: Partial<InstanceGeneratedResponse> = {}): InstanceGeneratedResponse => ({
  name: 'generated_qaco', package_digest: digest('1'), instance_digest: digest('2'), compilation_digest: digest('3'), target_engines: [], workload_features: {}, files: {}, ...over,
});

describe('checking the settings before they are sent', () => {
  it('accepts the default settings for one instance and for a batch', () => {
    expect(checkSettings(settings(), 'instance')).toEqual({});
    expect(checkSettings(settings(), 'corpus')).toEqual({});
  });

  it('holds the sizes to what the contract takes', () => {
    expect(checkSettings(settings({ tasks: '1' }), 'instance').tasks).toBe('Tasks: a whole number from 2 to 1000.');
    expect(checkSettings(settings({ tasks: '1001' }), 'instance').tasks).toBeDefined();
    expect(checkSettings(settings({ tasks: '2.5' }), 'instance').tasks).toBeDefined();
    expect(checkSettings(settings({ tasks: '' }), 'instance').tasks).toBeDefined();
    expect(checkSettings(settings({ candidates: '101' }), 'instance').candidates).toBe('Candidates per task: a whole number from 2 to 100.');
    expect(checkSettings(settings({ controlFlow: '95' }), 'instance').controlFlow).toBeDefined();
    expect(checkSettings(settings({ maxNesting: '0' }), 'instance').maxNesting).toBeDefined();
  });

  it('counts the size of a batch only for a batch', () => {
    expect(checkSettings(settings({ count: '0' }), 'instance')).toEqual({});
    expect(checkSettings(settings({ count: '0' }), 'corpus').count).toBe('How many instances: a whole number from 1 to 100.');
    expect(checkSettings(settings({ count: '101' }), 'corpus').count).toBeDefined();
    expect(checkSettings(settings({ count: '100' }), 'corpus')).toEqual({});
  });

  it('wants a latency range that rises, a whole seed (or none) and a tightness between 0 and 1', () => {
    expect(checkSettings(settings({ latencyMin: '300', latencyMax: '300' }), 'instance').latencyMax).toBe('The highest latency must be above the lowest.');
    expect(checkSettings(settings({ latencyMax: 'fast' }), 'instance').latencyMax).toBeDefined();
    expect(checkSettings(settings({ latencyMin: '-1' }), 'instance').latencyMin).toBeDefined();
    expect(checkSettings(settings({ seed: 'abc' }), 'instance').seed).toBe('The seed is a whole number.');
    expect(checkSettings(settings({ seed: '' }), 'instance')).toEqual({});
    expect(checkSettings(settings({ tension: '1.5' }), 'instance').tension).toBe('Tightness is a number from 0 to 1.');
  });
});

describe('what the gateway is asked to generate', () => {
  it('sends the sizes, the seed and every feature, with the latency spread the person chose', () => {
    const params = instanceParams(settings(), 42);
    expect(params).toMatchObject({
      name: 'generated_qaco', tasks: 6, candidates: 5, control_flow: 50, loops: 30, branches: 30, parallel: 20, max_nesting: 3, iterations_per_loop: 5,
      constraints: 1, tension: 0.7, guarantee_feasibility: true, optimization_mode: 'weighted', seed: 42,
      target_engines: ['evolutionary-heuristics', 'minizinc-csp'],
    });
    expect(params.features.map((feature) => feature.id)).toEqual(['cost', 'latency', 'reliability', 'availability', 'security']);
    expect(params.features[1]).toMatchObject({ unit: 'ms', direction: 'minimize', scope: 'invocation', distribution: { kind: 'uniform', minimum: 50, maximum: 300 } });
  });

  it('turns a bell curve and “mostly fast” into normal distributions inside the range', () => {
    const bell = instanceParams(settings({ spread: 'normal' }), 1).features[1].distribution;
    expect(bell).toMatchObject({ kind: 'normal', minimum: 50, maximum: 300, mean: 175 });
    expect(bell.stddev).toBeCloseTo(250 / 6);
    const fast = instanceParams(settings({ spread: 'skewed' }), 1).features[1].distribution;
    expect(fast).toMatchObject({ kind: 'normal', mean: 112.5 });
  });

  it('leaves out what does not apply: control-flow shares without control flow, tightness without rules or a witness', () => {
    const plain = instanceParams(settings({ controlFlow: '0' }), 1);
    for (const key of ['loops', 'branches', 'parallel', 'max_nesting', 'iterations_per_loop']) expect(plain).not.toHaveProperty(key);
    expect(instanceParams(settings({ constraints: '0' }), 1)).not.toHaveProperty('tension');
    expect(instanceParams(settings({ guarantee: false }), 1)).not.toHaveProperty('tension');
    expect(instanceParams(settings({ name: '  ' }), 1).name).toBe('generated_instance');
  });

  it('uses the seed that was typed, or a fresh whole one when the field is empty', () => {
    expect(seedOf({ seed: '42' })).toBe(42);
    expect(seedOf({ seed: ' -7 ' })).toBe(-7);
    const fresh = seedOf({ seed: '' });
    expect(Number.isInteger(fresh)).toBe(true);
    expect(fresh).toBeGreaterThanOrEqual(0);
  });
});

describe('the shape of the latency', () => {
  it('draws twelve even bars for an even spread', () => {
    expect(latencyHistogram('uniform', 50, 300)).toEqual(Array(12).fill(100));
  });

  it('peaks in the middle for a bell curve and near the low end for “mostly fast”', () => {
    const bell = latencyHistogram('normal', 0, 100);
    expect(Math.max(...bell)).toBe(100);
    expect(bell[5]).toBe(100);
    expect(Math.abs(bell[0] - bell[11])).toBeLessThanOrEqual(1);
    expect(bell[0]).toBeLessThan(bell[5]);
    const fast = latencyHistogram('skewed', 0, 100);
    expect(Math.max(...fast)).toBe(100);
    expect(fast[0]).toBeGreaterThan(fast[11]);
    expect(Math.min(...fast)).toBeGreaterThanOrEqual(4);
  });
});

describe('the size of a problem', () => {
  it('multiplies the choices of every task and writes it as a power of ten', () => {
    expect(combinationsLog10(6, 5)).toBeCloseTo(4.194, 3);
    expect(powerText(combinationsLog10(6, 5))).toBe('≈ 10^4.2');
    expect(combinationsLog10(0, 5)).toBe(0);
  });
});

describe('what a result says about itself', () => {
  const params = instanceParams(settings(), 42);

  it('lists the figures of one instance, with the rules the server counted', () => {
    const output: Output = { kind: 'instance', params, response: generated({ actual_constraint_count: 1 }) };
    expect(outputFacts(output)).toEqual([
      { label: 'Tasks', value: '6' }, { label: 'Candidates', value: '30' }, { label: 'Combinations', value: '≈ 10^4.2' }, { label: 'Seed', value: '42' }, { label: 'Rules', value: '1' },
    ]);
    expect(outputFacts({ kind: 'instance', params, response: generated() }).map((fact) => fact.label)).not.toContain('Rules');
  });

  it('lists the figures of each instance of a batch', () => {
    const response: CorpusGeneratedResponse = { name: 'corpus', count: 20, instances: [] };
    expect(outputFacts({ kind: 'corpus', params, response, count: 20, name: 'corpus' })).toEqual([
      { label: 'Instances', value: '20' }, { label: 'Tasks each', value: '6' }, { label: 'Candidates each', value: '30' }, { label: 'Combinations each', value: '≈ 10^4.2' },
    ]);
  });

  it('lists the name, the files and the engines of a conversion', () => {
    const request = { raw_text: 'x' };
    expect(outputFacts({ kind: 'convert', request, response: generated({ name: 'legacy', files: { a: 1, b: 2 }, target_engines: ['minizinc-csp'] }) })).toEqual([
      { label: 'Name', value: 'legacy' }, { label: 'Files', value: '2' }, { label: 'Engines it suits', value: 'minizinc-csp' },
    ]);
    expect(outputFacts({ kind: 'convert', request, response: generated() })[2].value).toBe('any');
  });

  it('writes generated files the way the workspace holds them: text, objects as JSON', () => {
    expect(workspaceFilesOf({ 'instance.json': { kind: 'Instance' }, 'workflow.bpmn': '<xml/>' })).toEqual({
      'instance.json': '{\n  "kind": "Instance"\n}\n', 'workflow.bpmn': '<xml/>',
    });
  });
});

describe('the words for a refusal', () => {
  const failure = (status: number, code?: string, problem?: unknown) => Object.assign(new HttpError(status, 'No'), { code, problem });

  it('says what a 401, a 403 and a 404 mean when the lab was keeping something, and otherwise', () => {
    expect(labRefusal(failure(401), 'nothing was saved', 'keep')).toEqual({ kind: 'session', text: 'Saving to a project needs an account (401).' });
    expect(labRefusal(failure(403), 'nothing was saved', 'keep')).toEqual({ kind: 'forbidden', text: 'You can generate, but you don’t have permission to add to that project (403).' });
    expect(labRefusal(failure(404), 'nothing was saved', 'keep')).toEqual({ kind: 'missing', text: 'That project no longer exists or you lost access (404).' });
    expect(labRefusal(failure(401), 'nothing was generated').text).toBe('Your session has ended (401). Log in again to continue.');
    expect(labRefusal(failure(403, 'forbidden'), 'nothing was calibrated', 'runs').text).toBe('Your account can’t do this (403 · forbidden), so nothing was calibrated.');
  });

  it('says why the gateway refuses a calibration: a shared model needs a platform administrator, and a key that may administer', () => {
    expect(labRefusal(failure(403, 'platform_admin_required'), 'nothing was calibrated', 'runs')).toEqual({
      kind: 'forbidden',
      text: 'Only platform administrators can calibrate an engine (403 · platform_admin_required). The model is shared by everyone, so nothing was calibrated.',
    });
    expect(labRefusal(failure(403, 'insufficient_api_key_permission'), 'nothing was calibrated', 'runs')).toEqual({
      kind: 'forbidden',
      text: 'This API key can’t calibrate an engine (403 · insufficient_api_key_permission): it needs the admin:accounts:write permission. Nothing was calibrated.',
    });
  });

  it('reads a 422 as the settings, the text or the runs being rejected, and finds the field it names', () => {
    const problem = {
      code: 'validation_error',
      detail: 'Request validation failed: /tasks: Input should be greater than or equal to 2',
      diagnostics: [{ code: 'greater_than_equal', message: 'Input should be greater than or equal to 2', in: 'body', pointer: '/tasks', loc: ['body', 'tasks'] }],
    };
    expect(labRefusal(failure(422, undefined, problem), 'nothing was generated')).toEqual({
      kind: 'config',
      fields: { tasks: 'Input should be greater than or equal to 2' },
      text: 'These settings can’t be generated (422 · invalid generation config): the server rejected the combination.',
    });
    // The generic code of every malformed request adds nothing; the same fields are found from a pointer-less `loc`.
    expect(labRefusal(failure(422, 'validation_error', { diagnostics: [{ code: 'missing', message: 'Field required', loc: ['body', 'tasks'] }] }), 'nothing was generated')).toEqual({
      kind: 'config',
      fields: { tasks: 'Field required' },
      text: 'These settings can’t be generated (422 · invalid generation config): the server rejected the combination.',
    });
    expect(labRefusal(failure(422), 'x', 'text').text).toBe('That text can’t be converted (422 · invalid legacy instance): the server could not read it as an old-format instance.');
    expect(labRefusal(failure(422), 'x', 'runs').text).toBe('Those runs can’t be used to calibrate (422 · invalid observations): the server rejected them.');
    expect(labRefusal(failure(422, 'bad_seed'), 'x').text).toBe('These settings can’t be generated (422 · bad_seed): the server rejected the combination.');
  });

  it('names a plan with no room, a busy service, one that does not answer and a connection that fails', () => {
    expect(labRefusal(new QuotaError('plan_limit', 'x'), 'nothing was generated').text).toBe('Your plan has no room for this (402 · plan_limit), so nothing was generated.');
    expect(labRefusal(failure(429), 'x').kind).toBe('busy');
    expect(labRefusal(failure(503), 'nothing was generated')).toEqual({
      kind: 'unavailable', text: 'A service OpenBinding depends on isn’t answering (503), so nothing was generated. Try again in a moment.',
    });
    expect(labRefusal(failure(409), 'nothing was generated').text).toBe('That couldn’t be done (409), so nothing was generated.');
    expect(labRefusal(new TypeError('Failed to fetch'), 'nothing was generated').kind).toBe('unavailable');
    expect(labRefusal(new Error('boom'), 'x')).toEqual({ kind: 'other', text: 'boom' });
  });
});

describe('the observed runs of a calibration', () => {
  it('reads a list of runs', () => {
    expect(readObservations('[{"workload_features":{},"latency":1,"quality":1,"success":true}]')).toEqual({
      observations: [{ workload_features: {}, latency: 1, quality: 1, success: true }],
    });
    expect(readObservations('[]')).toEqual({ observations: [] });
  });

  it('refuses text that is not JSON and JSON that is not a list of runs', () => {
    expect(readObservations('not json')).toEqual({ error: 'The observations must be valid JSON: a list of runs.' });
    expect(readObservations('{}')).toHaveProperty('error');
    expect(readObservations('[1, 2]')).toHaveProperty('error');
    expect(readObservations('[[]]')).toHaveProperty('error');
  });
});
