import { describe, expect, it } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { DEFAULT_FILES, instanceResources, parseJson, type CompatibleMode } from './bimDocuments';
import {
  complexityCeiling, engineRows, filesHaveRanges, goalTerms, isRangeRefusal, loadRefusalText, packageFileList, rangePointers, refusalMarker, refusalOf,
  refusalText, refusesRanges, saveRefusalText, whyNot, workbenchDraftScope,
} from './workbenchModel';

const failure = (status: number, code?: string, diagnostics?: unknown[]) => Object.assign(new HttpError(status, 'No'), { code, diagnostics });

describe('ranges in a package', () => {
  const ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
  const REGISTRATION = { namespace: 'bim.builtin', name: 'deployment', version: '1', digest: 'sha256-r' };
  const mode = (over: Partial<CompatibleMode>): CompatibleMode => ({ engine: ENGINE, registration: REGISTRATION, mode: 'seeded', compatible: false, ...over });
  const catalog = (candidates: unknown) => JSON.stringify({ kind: 'CandidateCatalog', spec: { candidates } });

  it('sees a range in any candidate of any catalog, under features', () => {
    expect(filesHaveRanges({ 'a.json': catalog({ x: { features: { latency: 5 } } }) })).toBe(false);
    expect(filesHaveRanges({ 'a.json': catalog({ x: { features: { latency: { min: null, max: 5 } } } }) })).toBe(true);
    expect(filesHaveRanges({ 'a.json': catalog({ x: { features: { latency: { min: 1, max: null } } } }) })).toBe(true);
    expect(filesHaveRanges({ 'a.json': catalog([{ features: { latency: { min: null, max: null } } }]) })).toBe(true);
    expect(filesHaveRanges({ 'a.json': catalog({ x: { features: { latency: 1 } } }), 'b.json': catalog({ y: { features: { cost: {} } } }) })).toBe(true);
  });

  it('ignores other kinds, other files and text that is not JSON', () => {
    expect(filesHaveRanges({ 'a.json': JSON.stringify({ kind: 'Application', spec: { candidates: { x: { features: { l: { min: 1, max: 2 } } } } } }) })).toBe(false);
    expect(filesHaveRanges({ 'a.bpmn': '<xml/>', 'b.json': 'not json', 'c.txt': catalog({ x: { features: { l: { min: 1, max: 2 } } } }) })).toBe(false);
    expect(filesHaveRanges({})).toBe(false);
  });

  it('gives the one sentence for a mode the gateway turned down because of ranges', () => {
    const byCode = mode({ diagnostics: [{ code: 'unsupported_capability_value', message: 'whatever' }] });
    const byWords = mode({ diagnostics: [{ message: 'The package carries an interval the mode does not declare.' }] });
    for (const refused of [byCode, byWords]) {
      expect(refusesRanges(refused)).toBe(true);
      expect(whyNot(refused)).toBe('This package has range features; this engine only accepts single values');
    }
    expect(engineRows([byCode])[0]).toMatchObject({ runnable: false, why: 'This package has range features; this engine only accepts single values' });
  });

  it('keeps any other reason as the gateway sent it, and never calls a runnable mode a refusal', () => {
    const other = mode({ diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] });
    expect(refusesRanges(other)).toBe(false);
    expect(whyNot(other)).toBe('It cannot read a RoutingOverlay.');
    expect(refusesRanges(mode({ compatible: true, diagnostics: [{ code: 'unsupported_capability_value' }] }))).toBe(false);
    expect(whyNot(mode({}))).toBe('Its declared capabilities don’t cover this package.');
  });

  it('recognises a run that ended for ranges by code, diagnostic or message, and lists where the gateway pointed', () => {
    expect(isRangeRefusal(failure(422, 'unsupported_capability_value'))).toBe(true);
    expect(isRangeRefusal(failure(422, 'engine_mode_incompatible', [{ code: 'unsupported_capability_value', pointer: '/spec/a' }]))).toBe(true);
    expect(isRangeRefusal(new Error('unsupported_capability_value (unsupported: ["interval"])'))).toBe(true);
    expect(isRangeRefusal(failure(422, 'invalid_package'))).toBe(false);
    expect(isRangeRefusal(new Error('The deployment didn’t answer.'))).toBe(false);
    expect(rangePointers(failure(422, 'unsupported_capability_value', [{ pointer: '/spec/a' }, { pointer: '/spec/b' }, { message: 'no pointer' }])))
      .toBe(' The gateway pointed at /spec/a, /spec/b.');
    expect(rangePointers(new Error('x'))).toBe('');
  });

  it('reads the real refusal: engine_mode_incompatible with the range among its diagnostics, with or without a pointer', () => {
    const range = { code: 'unsupported_capability_value', category: 'featureValues', unsupported: ['interval'], allowed: ['scalar'], message: 'm' };
    const other = { code: 'engine_limit', message: 'too many', pointer: '/spec/other' };
    expect(isRangeRefusal(failure(422, 'engine_mode_incompatible', [other, range]))).toBe(true);
    expect(isRangeRefusal(failure(422, 'engine_mode_incompatible', [other]))).toBe(false);
    // Only the range diagnostic is read, by pointer (inside its resource), else by irPath, else nothing.
    expect(rangePointers(failure(422, 'engine_mode_incompatible', [other, { ...range, resource: 'candidates.json', pointer: '/spec/candidates/a/features/latency', irPath: '/spec/candidates/c/candidates/a/features/latency' }])))
      .toBe(' The gateway pointed at candidates.json#/spec/candidates/a/features/latency.');
    expect(rangePointers(failure(422, 'engine_mode_incompatible', [other, { ...range, pointer: '/spec/a' }]))).toBe(' The gateway pointed at /spec/a.');
    expect(rangePointers(failure(422, 'engine_mode_incompatible', [other, { ...range, irPath: '/spec/candidates/c/candidates/a/features/latency' }])))
      .toBe(' The gateway pointed at /spec/candidates/c/candidates/a/features/latency.');
    expect(rangePointers(failure(422, 'engine_mode_incompatible', [other, range]))).toBe('');
  });
});

describe('how a refusal is sorted', () => {
  it('reads a 402 as too big for the plan, with the allowance it names', () => {
    const refusal = refusalOf(new QuotaError('instance_complexity', 'too complex', { limit_id: 'maxInstanceComplexityLog10', limit: 9 }));
    expect(refusal).toMatchObject({ kind: 'too-big', status: 402, code: 'instance_complexity', limitId: 'maxInstanceComplexityLog10', limit: 9 });
  });

  it.each([
    [401, 'session'], [403, 'key'], [413, 'too-large'], [415, 'unsupported'], [422, 'invalid'], [429, 'busy'], [503, 'unavailable'], [404, 'other'], [409, 'other'],
  ])('reads a %i as %s', (status, kind) => {
    expect(refusalOf(failure(status))).toMatchObject({ kind, status, message: 'No' });
  });

  it('keeps the diagnostics of a 422 and drops the ones that are not objects', () => {
    const refusal = refusalOf(failure(422, 'invalid_package', [{ code: 'a', message: 'one' }, 'junk', null]));
    expect(refusal.diagnostics).toEqual([{ code: 'a', message: 'one' }]);
    expect(refusal.code).toBe('invalid_package');
  });

  it('reads a request that never got an answer as the service being unreachable, and anything else by its message', () => {
    expect(refusalOf(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'unavailable' });
    expect(refusalOf(new Error('Job failed'))).toEqual({ kind: 'other', message: 'Job failed', diagnostics: [] });
    expect(refusalOf('odd')).toEqual({ kind: 'other', message: 'odd', diagnostics: [] });
  });

  it('writes the status and the code the way people quote them', () => {
    expect(refusalMarker({ status: 422 })).toBe(' (422)');
    expect(refusalMarker({ status: 403, code: 'api_key_boundary' })).toBe(' (403 · api_key_boundary)');
    expect(refusalMarker({})).toBe('');
  });
});

describe('the words for a refusal', () => {
  it('says what was left undone and never blames the package for a service that did not answer', () => {
    expect(refusalText(refusalOf(failure(503)), 'nothing was checked')).toBe(
      'A service OpenBinding depends on isn’t answering (503), so nothing was checked. This says nothing about your package; try again in a moment.',
    );
    expect(refusalText(refusalOf(failure(429)), 'x')).toBe('Too many requests (429). Wait a moment and try again.');
    expect(refusalText(refusalOf(failure(415)), 'x')).toBe('The gateway doesn’t take this kind of file (415). Use a .bim.zip package.');
    expect(refusalText(refusalOf(failure(401)), 'x')).toContain('Log in again');
  });

  it('uses the message alone when the failure has no status, such as a job that failed', () => {
    expect(refusalText(refusalOf(new Error('The deployment did not answer.')), 'the run did not finish')).toBe('The deployment did not answer.');
  });

  it('words the refusals of saving a revision, each ending in nothing being saved', () => {
    expect(saveRefusalText(refusalOf(failure(403, 'forbidden')))).toBe(
      'You need MEMBER in the organization to save a revision, and an API key needs projects:write (403 · forbidden). Nothing was saved.',
    );
    expect(saveRefusalText(refusalOf(failure(404)))).toBe('That case no longer exists, or you’re not in its organization (404). Nothing was saved.');
    expect(saveRefusalText(refusalOf(failure(422)))).toContain('The gateway refused to seal a revision from this package (422).');
    expect(saveRefusalText(refusalOf(new QuotaError('instance_complexity', 'x')))).toContain('bigger than your plan can compile (402');
    expect(saveRefusalText(refusalOf(failure(401)))).toContain('Nothing was saved.');
  });

  it('words a case revision that could not be opened', () => {
    expect(loadRefusalText(refusalOf(failure(404)))).toBe(
      'That case revision doesn’t exist any more, or you’re not in the organization it belongs to (404). The package was not loaded.',
    );
    expect(loadRefusalText(refusalOf(failure(503)))).toContain('the package was not loaded');
  });
});

describe('the plan’s ceiling', () => {
  it('prefers what the account reports and falls back to the plan', () => {
    expect(complexityCeiling(20, 15)).toBe(20);
    expect(complexityCeiling(undefined, 15)).toBe(15);
    expect(complexityCeiling(null, null)).toBeNull();
  });
});

describe('the package in plain words', () => {
  const resources = instanceResources(parseJson(DEFAULT_FILES['instance.json']), DEFAULT_FILES);

  it('describes each file by what it holds, instance first', () => {
    const list = packageFileList(DEFAULT_FILES, resources);
    expect(list.map((file) => [file.path, file.kind, file.tile])).toEqual([
      ['instance.json', 'Instance', 'IN'], ['application.json', 'Application', 'AP'], ['candidates.json', 'CandidateCatalog', 'CA'],
      ['optimization.json', 'Optimization', 'OP'], ['workflow.bpmn', 'BPMN', 'WF'],
    ]);
    expect(list.map((file) => file.what)).toEqual([
      'Root of the package · 4 resources', '1 task and 1 quality metric', '1 candidate with 1 quality column', 'Goal · 1 criterion', 'Workflow diagram · 1 task',
    ]);
  });

  it('counts the criteria of the goal across the optimization documents', () => {
    expect(goalTerms(DEFAULT_FILES, resources)).toBe(1);
    expect(goalTerms({ 'instance.json': '{}' }, [])).toBe(0);
  });

  it('describes a file that is not a document by its place in the package', () => {
    const list = packageFileList({ 'instance.json': '{"kind":"Instance","spec":{}}', 'notes.txt': 'hello', 'broken.json': '{' }, []);
    expect(list.find((file) => file.path === 'notes.txt')).toMatchObject({ kind: 'File', what: 'Not a JSON document' });
    expect(list.find((file) => file.path === 'broken.json')).toMatchObject({ what: 'Not a JSON document' });
    expect(list[0]).toMatchObject({ path: 'instance.json', what: 'Root of the package · 0 resources' });
  });
});

describe('the engines of an analysis', () => {
  const engine = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
  const registration = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1', digest: 'sha256-r' };

  it('gives a row to every mode with the reason it can or cannot run the package', () => {
    const modes: CompatibleMode[] = [
      { engine, registration, mode: 'seeded', compatible: true },
      { engine: { ...engine, namespace: 'lucia-vega', name: 'edge-solver' }, registration, mode: 'placement', compatible: false, diagnostics: [{ message: 'No placement.' }, { detail: 'Needs pools.' }] },
      { engine, registration, mode: 'exact', compatible: false },
    ];
    const rows = engineRows(modes);
    expect(rows.map((row) => [row.name, row.mode, row.runnable, row.registered])).toEqual([
      ['random-search 1.0.0', 'seeded', true, false], ['edge-solver 1.0.0', 'placement', false, true], ['random-search 1.0.0', 'exact', false, false],
    ]);
    expect(rows[0].why).toBe('Runs through bim.builtin/random-search-deployment@1.');
    expect(rows[1].why).toBe('No placement. Needs pools.');
    expect(rows[2].why).toBe('Its declared capabilities don’t cover this package.');
  });
});

describe('where the unsaved edits of a workspace are kept', () => {
  it('keeps them per person, per address and per case revision', () => {
    expect(workbenchDraftScope('user-1', '/app/a/b/workbench', null, null)).toBe('user-1:/app/a/b/workbench::');
    expect(workbenchDraftScope('user-1', '/app/a/b/workbench', 'checkout', 'rev-2')).toBe('user-1:/app/a/b/workbench:checkout:rev-2');
    expect(workbenchDraftScope(undefined, '/x', null, null)).toBe('anonymous:/x::');
  });
});
