import { describe, expect, it } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { DEFAULT_FILES, instanceResources, parseJson, type CompatibleMode } from './bimDocuments';
import {
  engineRows, goalTerms, loadRefusalText, packageFileList, refusalMarker, refusalOf, refusalText, refusesRanges, saveRefusalText,
  whyNot,
} from './workbenchModel';

const failure = (status: number, code?: string, diagnostics?: unknown[]) => Object.assign(new HttpError(status, 'No'), { code, diagnostics });

describe('ranges in a package', () => {
  const ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
  const REGISTRATION = { namespace: 'bim.builtin', name: 'deployment', version: '1', digest: 'sha256-r' };
  const mode = (over: Partial<CompatibleMode>): CompatibleMode => ({ engine: ENGINE, registration: REGISTRATION, mode: 'seeded', compatible: false, ...over });

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
});

describe('how a refusal is sorted', () => {
  it('reads a 402 as an allowance of the plan used up, with the allowance it names', () => {
    const refusal = refusalOf(new QuotaError('quota_exceeded', 'used up', { limit_id: 'maxRepositoryStorage', limit: 500 }));
    expect(refusal).toMatchObject({ kind: 'quota', status: 402, code: 'quota_exceeded', limitId: 'maxRepositoryStorage', limit: 500 });
    expect(refusalText(refusal, 'nothing was checked')).toBe('Your plan’s storage is used up (402 · quota_exceeded), so nothing was checked. Free some, or see your plan.');
    expect(saveRefusalText(refusal)).toBe('Your plan has no room for this (402 · quota_exceeded): it counts your problems and the storage your packages take. Nothing was saved.');
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
    expect(refusalOf(new Error('Run failed'))).toEqual({ kind: 'other', message: 'Run failed', diagnostics: [] });
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

  it('words the refusals of saving a problem version, each ending in nothing being saved', () => {
    expect(saveRefusalText(refusalOf(failure(403, 'forbidden')))).toBe(
      'You need MEMBER in the organization to save, and an API key needs problems:write (403 · forbidden). Nothing was saved.',
    );
    expect(saveRefusalText(refusalOf(failure(409, 'slug_conflict')))).toBe(
      'That address is already used by another problem in this organization (409 · slug_conflict). Pick another one. Nothing was saved.',
    );
    expect(saveRefusalText(refusalOf(failure(404)))).toBe('That problem no longer exists, or you’re not in its organization (404). Nothing was saved.');
    expect(saveRefusalText(refusalOf(failure(422)))).toContain('The gateway refused to seal this package (422).');
    expect(saveRefusalText(refusalOf(new QuotaError('quota_exceeded', 'x')))).toBe('Your plan has no room for this (402 · quota_exceeded): it counts your problems and the allowance your packages take. Nothing was saved.');
    expect(saveRefusalText(refusalOf(failure(401)))).toContain('Nothing was saved.');
  });

  it('words a problem version that could not be opened', () => {
    expect(loadRefusalText(refusalOf(failure(404)))).toBe(
      'That problem version doesn’t exist any more, or you’re not in the organization it belongs to (404). The package was not loaded.',
    );
    expect(loadRefusalText(refusalOf(failure(503)))).toContain('the package was not loaded');
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
