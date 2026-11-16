import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { DEFAULT_FILES, instanceResources, parseJson } from '../../features/bim-editor/documents';
import { refusalOf } from '../../shared/api/refusals';
import { goalTerms, loadRefusalText, packageFileList } from './workbenchModel';

const failure = (status: number, code?: string, diagnostics?: unknown[]) => Object.assign(new HttpError(status, 'No'), { code, diagnostics });

describe('the words for a refusal', () => {
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
